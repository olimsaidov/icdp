import { describe, expect, test, vi } from "vitest";

import type {
  BridgeBrowserRequest,
  CdpMessage,
  HostToRelayMessage,
  RelayToHostMessage,
} from "../src/protocol.ts";
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

/** Like setup(), but the Host advertises browser-level methods it handles itself. */
function setupWithHandles(handles: string[]) {
  const core = new RelayCore({ product: "icdp-test", browserWsUrl: "ws://test/devtools/browser" });
  const host = fakeSocket();
  core.hostConnected(host);
  core.hostMessage(
    host,
    JSON.stringify({
      kind: "ready",
      v: 1,
      targets: [{ targetId: "preview", title: "Preview", url: "http://app.test/" }],
      handles,
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
  core.clientMessage(
    client,
    JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId } }),
  );
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
    const infos = (lastResponse(client).result as { targetInfos: Array<{ targetId: string }> })
      .targetInfos;
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

    core.clientMessage(
      client,
      JSON.stringify({ id: 42, sessionId, method: "DOM.getDocument", params: { depth: 1 } }),
    );
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
    core.clientMessage(
      client,
      JSON.stringify({ id: 5, sessionId: "bogus", method: "DOM.getDocument" }),
    );
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
    expect(
      client.sent.filter((message) => message.method === "Target.targetCreated").length,
    ).toBeGreaterThanOrEqual(2);
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
      JSON.stringify({
        id: 1,
        method: "Target.setAutoAttach",
        params: { autoAttach: true, flatten: true },
      }),
    );
    expect(
      client.sent.filter((message) => message.method === "Target.attachedToTarget").length,
    ).toBe(1);

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "targetCreated",
        target: { targetId: "second", title: "Second", url: "http://app.test/2" },
      } satisfies HostToRelayMessage),
    );
    expect(
      client.sent.filter((message) => message.method === "Target.attachedToTarget").length,
    ).toBe(2);
  });
});

describe("host-handled lifecycle methods", () => {
  test("createTarget is forwarded to the host when advertised", () => {
    const { core, host, client } = setupWithHandles(["Target.createTarget"]);
    core.clientMessage(
      client,
      JSON.stringify({
        id: 11,
        method: "Target.createTarget",
        params: { url: "http://app.test/new" },
      }),
    );

    // It must not be answered locally — instead a browserRequest goes to the Host.
    expect(client.sent).toHaveLength(0);
    const request = hostSent(host).at(-1);
    if (request?.kind !== "browserRequest") throw new Error("expected a browserRequest");
    expect(request.method).toBe("Target.createTarget");
    expect(request.params).toEqual({ url: "http://app.test/new" });

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "browserResult",
        id: request.id,
        result: { targetId: "tab-2" },
      } satisfies HostToRelayMessage),
    );
    const response = lastResponse(client);
    expect(response.id).toBe(11);
    expect(response.result).toEqual({ targetId: "tab-2" });
    // Browser-level results are not session-scoped.
    expect(response.sessionId).toBeUndefined();
  });

  test("createTarget falls back to the built-in error when not advertised", () => {
    const { core, host, client } = setup();
    core.clientMessage(
      client,
      JSON.stringify({ id: 12, method: "Target.createTarget", params: {} }),
    );
    expect(hostSent(host).some((message) => message.kind === "browserRequest")).toBe(false);
    const response = lastResponse(client);
    expect(response.id).toBe(12);
    expect(response.error?.message).toContain("not supported");
  });

  test("a host-rejected createTarget surfaces as a client error", () => {
    const { core, host, client } = setupWithHandles(["Target.createTarget"]);
    core.clientMessage(
      client,
      JSON.stringify({ id: 13, method: "Target.createTarget", params: {} }),
    );
    const request = hostSent(host).at(-1);
    if (request?.kind !== "browserRequest") throw new Error("expected a browserRequest");
    core.hostMessage(
      host,
      JSON.stringify({
        kind: "browserResult",
        id: request.id,
        error: { code: -32000, message: "popups disabled" },
      } satisfies HostToRelayMessage),
    );
    const response = lastResponse(client);
    expect(response.id).toBe(13);
    expect(response.error?.message).toBe("popups disabled");
  });

  test("closeTarget is forwarded to the host when advertised", () => {
    const { core, host, client } = setupWithHandles(["Target.closeTarget"]);
    core.clientMessage(
      client,
      JSON.stringify({ id: 14, method: "Target.closeTarget", params: { targetId: "preview" } }),
    );
    const request = hostSent(host).at(-1);
    if (request?.kind !== "browserRequest") throw new Error("expected a browserRequest");
    expect(request.method).toBe("Target.closeTarget");
    expect(request.params).toEqual({ targetId: "preview" });

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "browserResult",
        id: request.id,
        result: { success: true },
      } satisfies HostToRelayMessage),
    );
    expect(lastResponse(client).result).toEqual({ success: true });
  });

  test("closeTarget keeps its built-in success default when not advertised", () => {
    const { core, host, client } = setup();
    core.clientMessage(
      client,
      JSON.stringify({ id: 15, method: "Target.closeTarget", params: { targetId: "preview" } }),
    );
    expect(hostSent(host).some((message) => message.kind === "browserRequest")).toBe(false);
    const response = lastResponse(client);
    expect(response.id).toBe(15);
    // CDP's Target.closeTarget returns { success }, not {}.
    expect(response.result).toEqual({ success: true });
  });

  test("host disconnect fails an in-flight browser request", () => {
    const { core, host, client } = setupWithHandles(["Target.createTarget"]);
    core.clientMessage(
      client,
      JSON.stringify({ id: 16, method: "Target.createTarget", params: {} }),
    );
    expect(hostSent(host).at(-1)?.kind).toBe("browserRequest");

    core.hostDisconnected(host);
    const response = lastResponse(client);
    expect(response.id).toBe(16);
    expect(response.error?.message).toContain("Host disconnected");
  });

  test("a browserResult for an unknown id is ignored", () => {
    const { core, host, client } = setupWithHandles(["Target.createTarget"]);
    core.hostMessage(
      host,
      JSON.stringify({ kind: "browserResult", id: 999, result: {} } satisfies HostToRelayMessage),
    );
    expect(client.sent).toHaveLength(0);
  });

  test("concurrent createTargets correlate by bridge id regardless of reply order", () => {
    const { core, host, client } = setupWithHandles(["Target.createTarget"]);
    core.clientMessage(
      client,
      JSON.stringify({ id: 21, method: "Target.createTarget", params: { url: "a" } }),
    );
    core.clientMessage(
      client,
      JSON.stringify({ id: 22, method: "Target.createTarget", params: { url: "b" } }),
    );
    const requests = hostSent(host).filter(
      (message): message is BridgeBrowserRequest => message.kind === "browserRequest",
    );
    const [first, second] = requests;
    if (!first || !second) throw new Error("expected two browserRequests");
    expect(first.id).not.toBe(second.id);

    // Answer the SECOND request first — correlation must be by bridge id, not order.
    core.hostMessage(
      host,
      JSON.stringify({
        kind: "browserResult",
        id: second.id,
        result: { targetId: "b" },
      } satisfies HostToRelayMessage),
    );
    core.hostMessage(
      host,
      JSON.stringify({
        kind: "browserResult",
        id: first.id,
        result: { targetId: "a" },
      } satisfies HostToRelayMessage),
    );

    const byClientId = new Map(
      client.sent
        .filter((message) => message.id != null)
        .map((message) => [message.id, message.result]),
    );
    expect(byClientId.get(22)).toEqual({ targetId: "b" });
    expect(byClientId.get(21)).toEqual({ targetId: "a" });
  });

  test("a session-scoped createTarget is still forwarded to the host", () => {
    const { core, host, client } = setupWithHandles(["Target.createTarget"]);
    const sessionId = attach(core, client);
    core.clientMessage(
      client,
      JSON.stringify({ id: 31, sessionId, method: "Target.createTarget", params: {} }),
    );
    const request = hostSent(host).at(-1);
    if (request?.kind !== "browserRequest") throw new Error("expected a browserRequest");
    expect(request.method).toBe("Target.createTarget");

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "browserResult",
        id: request.id,
        result: { targetId: "tab-9" },
      } satisfies HostToRelayMessage),
    );
    const response = lastResponse(client);
    expect(response.id).toBe(31);
    expect(response.result).toEqual({ targetId: "tab-9" });
    // The Client scoped it to a session, so echo that sessionId back.
    expect(response.sessionId).toBe(sessionId);
  });

  test("client disconnect drops its in-flight browser request", () => {
    const { core, host, client } = setupWithHandles(["Target.createTarget"]);
    core.clientMessage(
      client,
      JSON.stringify({ id: 41, method: "Target.createTarget", params: {} }),
    );
    const request = hostSent(host).at(-1);
    if (request?.kind !== "browserRequest") throw new Error("expected a browserRequest");

    core.clientDisconnected(client);
    const before = client.sent.length;
    // A late result for the dropped request must be ignored (the entry is gone).
    core.hostMessage(
      host,
      JSON.stringify({
        kind: "browserResult",
        id: request.id,
        result: {},
      } satisfies HostToRelayMessage),
    );
    expect(client.sent.length).toBe(before);
  });

  test("a browser request times out if the host never answers", () => {
    vi.useFakeTimers();
    try {
      const core = new RelayCore({ browserRequestTimeoutMs: 50 });
      const host = fakeSocket();
      core.hostConnected(host);
      core.hostMessage(
        host,
        JSON.stringify({
          kind: "ready",
          v: 1,
          targets: [],
          handles: ["Target.createTarget"],
        } satisfies HostToRelayMessage),
      );
      const client = fakeSocket();
      core.clientConnected(client);
      core.clientMessage(
        client,
        JSON.stringify({ id: 51, method: "Target.createTarget", params: {} }),
      );
      expect(hostSent(host).at(-1)?.kind).toBe("browserRequest");

      vi.advanceTimersByTime(50);
      const response = lastResponse(client);
      expect(response.id).toBe(51);
      expect(response.error?.message).toContain("did not respond");
    } finally {
      vi.useRealTimers();
    }
  });
});
