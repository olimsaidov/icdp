import { describe, expect, test } from "bun:test";

import type { CdpMessage, HostToRelayMessage, RelayToHostMessage } from "../src/protocol.ts";
import { RelayCore, type SocketLike } from "../src/relay/core.ts";

type FakeSocket = SocketLike & {
  sent: CdpMessage[];
  sentRaw: string[];
  closed: { code?: number; reason?: string } | null;
};

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    sentRaw: [],
    closed: null,
    send(data: string) {
      socket.sentRaw.push(data);
      socket.sent.push(JSON.parse(data));
    },
    close(code?: number, reason?: string) {
      socket.closed = { code, reason };
    },
  };
  return socket;
}

function hostSent(socket: FakeSocket): RelayToHostMessage[] {
  return socket.sent as unknown as RelayToHostMessage[];
}

function setup() {
  const core = new RelayCore({ product: "icdp-test", browserWsUrl: "ws://test/devtools/browser" });
  const host = fakeSocket();
  core.hostConnected(host);
  core.hostMessage(
    host,
    JSON.stringify({
      kind: "ready",
      v: 1,
      targets: [{ targetId: "preview", title: "Preview", url: "http://app.test/" }],
    } satisfies HostToRelayMessage),
  );
  const client = fakeSocket();
  core.clientConnected(client);
  return { core, host, client };
}

function lastResponse(client: FakeSocket): CdpMessage {
  const message = client.sent.at(-1);
  if (!message) throw new Error("no message sent to client");
  return message;
}

function attach(core: RelayCore, client: FakeSocket, targetId = "preview"): string {
  core.clientMessage(client, JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId } }));
  const response = lastResponse(client);
  return (response.result as { sessionId: string }).sessionId;
}

describe("browser-level methods", () => {
  test("Browser.getVersion is answered locally", () => {
    const { core, client } = setup();
    core.clientMessage(client, JSON.stringify({ id: 7, method: "Browser.getVersion" }));
    const response = lastResponse(client);
    expect(response.id).toBe(7);
    expect((response.result as { product: string }).product).toBe("icdp-test");
  });

  test("Target.getTargets lists the host's targets", () => {
    const { core, client } = setup();
    core.clientMessage(client, JSON.stringify({ id: 1, method: "Target.getTargets" }));
    const infos = (lastResponse(client).result as { targetInfos: Array<{ targetId: string }> }).targetInfos;
    expect(infos.map((info) => info.targetId)).toEqual(["preview"]);
  });

  test("setDiscoverTargets replays existing targets as targetCreated", () => {
    const { core, client } = setup();
    core.clientMessage(
      client,
      JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } }),
    );
    const methods = client.sent.map((message) => message.method);
    expect(methods).toContain("Target.targetCreated");
  });

  test("non-session command that is not browser-level errors", () => {
    const { core, client } = setup();
    core.clientMessage(client, JSON.stringify({ id: 2, method: "DOM.getDocument" }));
    expect(lastResponse(client).error?.code).toBe(-32601);
  });

  test("attachToTarget on unknown target errors", () => {
    const { core, client } = setup();
    core.clientMessage(
      client,
      JSON.stringify({ id: 3, method: "Target.attachToTarget", params: { targetId: "nope" } }),
    );
    expect(lastResponse(client).error?.message).toContain("nope");
  });
});

describe("session routing", () => {
  test("attach returns a sessionId and emits attachedToTarget", () => {
    const { core, client } = setup();
    const sessionId = attach(core, client);
    expect(sessionId).toMatch(/^icdp-session-/);
    expect(client.sent.some((message) => message.method === "Target.attachedToTarget")).toBe(true);
  });

  test("session command round-trips through the host with id remapping", () => {
    const { core, host, client } = setup();
    const sessionId = attach(core, client);

    core.clientMessage(client, JSON.stringify({ id: 42, sessionId, method: "DOM.getDocument", params: { depth: 1 } }));
    const command = hostSent(host).at(-1);
    if (command?.kind !== "command") throw new Error("expected a bridge command");
    expect(command.targetId).toBe("preview");
    expect(command.method).toBe("DOM.getDocument");
    expect(command.id).not.toBe(42);

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "response",
        sessionId,
        id: command.id,
        result: { root: {} },
      } satisfies HostToRelayMessage),
    );
    const response = lastResponse(client);
    expect(response.id).toBe(42);
    expect(response.sessionId).toBe(sessionId);
    expect(response.result).toEqual({ root: {} });
  });

  test("events fan out to every session attached to the target", () => {
    const { core, host, client } = setup();
    const sessionA = attach(core, client);
    const clientB = fakeSocket();
    core.clientConnected(clientB);
    const sessionB = attach(core, clientB);

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "event",
        targetId: "preview",
        method: "Runtime.consoleAPICalled",
        params: { type: "log" },
      } satisfies HostToRelayMessage),
    );

    const eventA = client.sent.at(-1);
    const eventB = clientB.sent.at(-1);
    expect(eventA?.sessionId).toBe(sessionA);
    expect(eventB?.sessionId).toBe(sessionB);
    expect(eventA?.method).toBe("Runtime.consoleAPICalled");
  });

  test("command with unknown sessionId errors", () => {
    const { core, client } = setup();
    core.clientMessage(client, JSON.stringify({ id: 5, sessionId: "bogus", method: "DOM.getDocument" }));
    expect(lastResponse(client).error?.message).toContain("Session not found");
  });

  test("client disconnect notifies the host of detached sessions", () => {
    const { core, host, client } = setup();
    const sessionId = attach(core, client);
    core.clientDisconnected(client);
    const detached = hostSent(host).at(-1);
    if (detached?.kind !== "detached") throw new Error("expected a detached message");
    expect(detached.sessionId).toBe(sessionId);
  });
});

describe("host lifecycle", () => {
  test("new host wins: old socket closed, targets churned for clients", () => {
    const { core, host, client } = setup();
    core.clientMessage(
      client,
      JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } }),
    );
    const sessionId = attach(core, client);

    const newHost = fakeSocket();
    core.hostConnected(newHost);
    expect(host.closed?.code).toBe(1008);
    expect(client.sent.some((message) => message.method === "Target.targetDestroyed")).toBe(true);
    expect(
      client.sent.some(
        (message) =>
          message.method === "Target.detachedFromTarget" &&
          (message.params as { sessionId: string }).sessionId === sessionId,
      ),
    ).toBe(true);

    core.hostMessage(
      newHost,
      JSON.stringify({
        kind: "ready",
        v: 1,
        targets: [{ targetId: "preview", title: "Preview", url: "http://app.test/" }],
      } satisfies HostToRelayMessage),
    );
    expect(client.sent.filter((message) => message.method === "Target.targetCreated").length).toBeGreaterThanOrEqual(2);
  });

  test("host disconnect fails in-flight commands", () => {
    const { core, host, client } = setup();
    const sessionId = attach(core, client);
    core.clientMessage(client, JSON.stringify({ id: 9, sessionId, method: "DOM.getDocument" }));
    core.hostDisconnected(host);
    expect(client.sent.some((message) => message.id === 9 && message.error != null)).toBe(true);
  });

  test("auto-attach attaches existing and future targets", () => {
    const { core, host, client } = setup();
    core.clientMessage(
      client,
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true } }),
    );
    expect(client.sent.filter((message) => message.method === "Target.attachedToTarget").length).toBe(1);

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "targetCreated",
        target: { targetId: "second", title: "Second", url: "http://app.test/2" },
      } satisfies HostToRelayMessage),
    );
    expect(client.sent.filter((message) => message.method === "Target.attachedToTarget").length).toBe(2);
  });
});
