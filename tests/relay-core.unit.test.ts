import { describe, expect, test } from "vitest";

import type {
  CdpMessage,
  HostToRelayMessage,
  RelayToHostMessage,
  TargetSummary,
} from "../src/protocol.ts";
import { RelayCore, type SocketLike } from "../src/relay/core.ts";

type FakeSocket = SocketLike & {
  sent: unknown[];
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

function bridgeMessages(socket: FakeSocket): RelayToHostMessage[] {
  return socket.sent as RelayToHostMessage[];
}

function readyHost(
  core: RelayCore,
  host: FakeSocket,
  instanceId = "host-1",
  targets: TargetSummary[] = [],
  complete = true,
): void {
  core.hostConnected(host);
  core.hostMessage(
    host,
    JSON.stringify({
      kind: "ready",
      v: 4,
      instanceId,
      targets,
    } satisfies HostToRelayMessage),
  );
  if (complete) core.hostMessage(host, JSON.stringify({ kind: "readyComplete" }));
}

describe("Client transport", () => {
  test("direct Target Clients are identified to the Host", () => {
    const core = new RelayCore({
      browserWsUrl: "ws://test/devtools/browser",
      targetWsUrl: (targetId) => `ws://test/devtools/page/${targetId}`,
    });
    const host = fakeSocket();
    const client = fakeSocket();
    readyHost(core, host, "host-1", [{ targetId: "one", title: "One", url: "http://app.test/" }]);

    core.clientConnected(client, "one");

    const snapshot = bridgeMessages(host).at(-1);
    expect(snapshot).toEqual({
      kind: "clients",
      clientIds: [expect.stringMatching(/^icdp-client-/)],
      targetIds: {
        [snapshot?.kind === "clients" ? snapshot.clientIds[0]! : "missing"]: "one",
      },
    });

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "targetDestroyed",
        targetId: "one",
      } satisfies HostToRelayMessage),
    );
    expect(client.closed).toEqual({ code: 1001, reason: "Target closed" });
    expect(core.status().clients).toBe(0);
  });

  test("unknown direct Target Clients are rejected", () => {
    const core = new RelayCore();
    const client = fakeSocket();

    core.clientConnected(client, "missing");

    expect(client.closed).toEqual({ code: 1008, reason: "Target not found" });
    expect(core.status().clients).toBe(0);
  });

  test("Relay transports each Client's raw CDP messages without owning its Session", () => {
    const core = new RelayCore();
    const host = fakeSocket();
    const client = fakeSocket();

    readyHost(core, host);
    core.clientConnected(client);

    const clients = bridgeMessages(host).at(-1);
    expect(clients).toEqual({
      kind: "clients",
      clientIds: [expect.stringMatching(/^icdp-client-/)],
    });
    if (clients?.kind !== "clients") throw new Error("expected Client snapshot");
    const clientId = clients.clientIds[0];
    if (!clientId) throw new Error("expected a Client id");

    const raw = JSON.stringify({ id: 7, method: "Target.getTargets" });
    core.clientMessage(client, raw);
    expect(bridgeMessages(host).at(-1)).toEqual({
      kind: "clientMessage",
      clientId,
      message: raw,
    });

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "clientMessage",
        clientId,
        message: JSON.stringify({ id: 7, result: { targetInfos: [] } }),
      } satisfies HostToRelayMessage),
    );
    expect(client.sent.at(-1)).toEqual({ id: 7, result: { targetInfos: [] } });
  });

  test("Client snapshots remove disconnected Clients and survive reconnect of the same Host", () => {
    const core = new RelayCore();
    const firstHost = fakeSocket();
    const firstClient = fakeSocket();
    const secondClient = fakeSocket();
    core.clientConnected(firstClient);
    core.clientConnected(secondClient);
    readyHost(core, firstHost);

    const initial = bridgeMessages(firstHost).at(-1);
    if (initial?.kind !== "clients") throw new Error("expected Client snapshot");
    expect(initial.clientIds).toHaveLength(2);
    const [, secondClientId] = initial.clientIds;
    if (!secondClientId) throw new Error("expected second Client id");
    core.clientDisconnected(firstClient);
    expect(bridgeMessages(firstHost).at(-1)).toEqual({
      kind: "clients",
      clientIds: [secondClientId],
    });

    const nextHost = fakeSocket();
    core.hostDisconnected(firstHost);
    readyHost(core, nextHost, "host-1");
    expect(secondClient.closed).toBeNull();
    expect(bridgeMessages(nextHost).at(-1)).toEqual({
      kind: "clients",
      clientIds: [secondClientId],
    });
  });

  test("a same-Host reconnect closes direct Clients whose Target disappeared offline", () => {
    const core = new RelayCore();
    const firstHost = fakeSocket();
    const direct = fakeSocket();
    readyHost(core, firstHost, "host-1", [
      { targetId: "one", title: "One", url: "http://app.test/" },
    ]);
    core.clientConnected(direct, "one");
    const snapshot = bridgeMessages(firstHost).at(-1);
    if (snapshot?.kind !== "clients" || !snapshot.clientIds[0]) {
      throw new Error("expected direct Client snapshot");
    }
    const clientId = snapshot.clientIds[0];

    core.hostDisconnected(firstHost);
    const nextHost = fakeSocket();
    readyHost(core, nextHost, "host-1", [], false);

    expect(direct.closed).toBeNull();
    core.hostMessage(
      nextHost,
      JSON.stringify({
        kind: "clientMessage",
        clientId,
        message: JSON.stringify({ id: 1, result: { success: true } }),
      }),
    );
    expect(direct.sent.at(-1)).toEqual({ id: 1, result: { success: true } });
    core.hostMessage(nextHost, JSON.stringify({ kind: "readyComplete" }));
    expect(direct.closed).toEqual({ code: 1001, reason: "Target closed" });
    expect(core.status().clients).toBe(0);
    expect(bridgeMessages(nextHost).at(-1)).toEqual({ kind: "clients", clientIds: [] });
  });

  test("a genuinely different Host instance closes existing Clients", () => {
    const core = new RelayCore();
    const firstHost = fakeSocket();
    const client = fakeSocket();
    readyHost(core, firstHost, "host-1");
    core.clientConnected(client);

    const nextHost = fakeSocket();
    core.hostConnected(nextHost);

    expect(firstHost.closed).toBeNull();
    expect(client.closed).toBeNull();
    expect(core.status().hostConnected).toBe(true);

    core.hostMessage(
      nextHost,
      JSON.stringify({
        kind: "ready",
        v: 4,
        instanceId: "host-2",
        targets: [],
      } satisfies HostToRelayMessage),
    );

    expect(firstHost.closed?.code).toBe(1008);
    expect(client.closed).toEqual({ code: 1012, reason: "Host instance replaced" });
    expect(bridgeMessages(nextHost).at(-1)).toEqual({ kind: "clients", clientIds: [] });
    expect(core.status().clients).toBe(0);
  });

  test("an invalid contender cannot evict a healthy Host or its Clients", () => {
    const core = new RelayCore();
    const host = fakeSocket();
    const contender = fakeSocket();
    const client = fakeSocket();
    readyHost(core, host, "host-1", [{ targetId: "one", title: "One", url: "http://app.test/" }]);
    core.clientConnected(client);
    const snapshot = bridgeMessages(host).at(-1);
    if (snapshot?.kind !== "clients" || !snapshot.clientIds[0]) {
      throw new Error("expected Client snapshot");
    }

    core.hostConnected(contender);
    core.hostMessage(
      contender,
      JSON.stringify({ kind: "ready", v: 5, instanceId: "future", targets: [] }),
    );
    core.clientMessage(client, JSON.stringify({ id: 1, method: "Browser.getVersion" }));

    expect(contender.closed).toEqual({
      code: 1002,
      reason: "Incompatible host protocol",
    });
    expect(host.closed).toBeNull();
    expect(client.closed).toBeNull();
    expect(core.status()).toMatchObject({
      hostConnected: true,
      targets: [{ targetId: "one" }],
      clients: 1,
    });
    expect(bridgeMessages(host).at(-1)).toEqual({
      kind: "clientMessage",
      clientId: snapshot.clientIds[0],
      message: JSON.stringify({ id: 1, method: "Browser.getVersion" }),
    });
  });

  test("an unvalidated contender cannot send Host traffic", () => {
    const core = new RelayCore();
    const host = fakeSocket();
    const contender = fakeSocket();
    const client = fakeSocket();
    readyHost(core, host, "host-1", [{ targetId: "one", title: "One", url: "http://app.test/" }]);
    core.clientConnected(client);
    const snapshot = bridgeMessages(host).at(-1);
    if (snapshot?.kind !== "clients" || !snapshot.clientIds[0]) {
      throw new Error("expected Client snapshot");
    }
    const beforeClientMessages = client.sent.length;

    core.hostConnected(contender);
    for (const message of [
      {
        kind: "targetCreated",
        target: { targetId: "two", title: "Two", url: "http://app.test/two" },
      },
      { kind: "targetDestroyed", targetId: "one" },
      {
        kind: "clientMessage",
        clientId: snapshot.clientIds[0],
        message: JSON.stringify({ id: 1, result: { injected: true } }),
      },
    ] satisfies HostToRelayMessage[]) {
      core.hostMessage(contender, JSON.stringify(message));
    }

    expect(core.status().targets).toEqual([
      { targetId: "one", title: "One", url: "http://app.test/" },
    ]);
    expect(client.sent).toHaveLength(beforeClientMessages);
  });

  test("an incompatible Host bridge version is rejected before Client sync", () => {
    const core = new RelayCore();
    const host = fakeSocket();
    const client = fakeSocket();
    core.clientConnected(client);
    core.hostConnected(host);
    core.hostMessage(
      host,
      JSON.stringify({ kind: "ready", v: 5, instanceId: "future", targets: [] }),
    );

    expect(host.closed).toEqual({ code: 1002, reason: "Incompatible host protocol" });
    expect(bridgeMessages(host)).toEqual([]);
    expect(core.status().hostConnected).toBe(false);
  });

  test("different Relay instances never reuse Client identities", () => {
    const clientIdFrom = (core: RelayCore): string => {
      const host = fakeSocket();
      readyHost(core, host);
      core.clientConnected(fakeSocket());
      const snapshot = bridgeMessages(host).at(-1);
      if (snapshot?.kind !== "clients" || !snapshot.clientIds[0]) {
        throw new Error("expected Client snapshot");
      }
      return snapshot.clientIds[0];
    };

    expect(clientIdFrom(new RelayCore())).not.toBe(clientIdFrom(new RelayCore()));
  });

  test("messages for stale Client ids are ignored", () => {
    const core = new RelayCore();
    const host = fakeSocket();
    const client = fakeSocket();
    readyHost(core, host);
    core.clientConnected(client);
    const before = client.sent.length;

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "clientMessage",
        clientId: "gone",
        message: JSON.stringify({ id: 1, result: {} }),
      } satisfies HostToRelayMessage),
    );
    expect(client.sent).toHaveLength(before);
  });

  test("a failed Client socket write cannot break Host message processing", () => {
    const core = new RelayCore();
    const host = fakeSocket();
    const client = fakeSocket();
    readyHost(core, host);
    core.clientConnected(client);
    const snapshot = bridgeMessages(host).at(-1);
    const clientId = snapshot?.kind === "clients" ? snapshot.clientIds[0] : undefined;
    if (!clientId) {
      throw new Error("expected Client snapshot");
    }
    client.send = () => {
      throw new Error("socket is closed");
    };

    expect(() =>
      core.hostMessage(
        host,
        JSON.stringify({
          kind: "clientMessage",
          clientId,
          message: '{"id":1,"result":{}}',
        } satisfies HostToRelayMessage),
      ),
    ).not.toThrow();
  });

  test("a command fails promptly while no Host is connected", () => {
    const core = new RelayCore();
    const client = fakeSocket();
    core.clientConnected(client);
    core.clientMessage(
      client,
      JSON.stringify({ id: 9, sessionId: "s1", method: "DOM.getDocument" }),
    );

    expect(client.sent.at(-1) as CdpMessage).toEqual({
      id: 9,
      sessionId: "s1",
      error: { code: -32000, message: "Host is not connected" },
    });
  });

  test("no-Host failures still apply Chromium envelope parsing", () => {
    const core = new RelayCore();
    const client = fakeSocket();
    core.clientConnected(client);

    core.clientMessage(client, "{");
    core.clientMessage(client, '{"id":1.5,"method":"Browser.getVersion"}');

    expect(client.sent).toEqual([
      { error: { code: -32700, message: "Message must be valid JSON" } },
      {
        error: {
          code: -32600,
          message: "Message must have integer 'id' property",
        },
      },
    ]);
  });
});

describe("HTTP discovery cache", () => {
  test("Host target lifecycle messages are reflected without producing Client CDP events", () => {
    const core = new RelayCore({
      browserWsUrl: "ws://test/devtools/browser",
      targetWsUrl: (targetId) => `ws://test/devtools/page/${targetId}`,
    });
    const host = fakeSocket();
    const client = fakeSocket();
    readyHost(core, host, "host-1", [{ targetId: "one", title: "One", url: "http://app.test/1" }]);
    core.clientConnected(client);
    const before = client.sent.length;
    expect(core.jsonList()).toEqual([
      expect.objectContaining({
        id: "one",
        url: "http://app.test/1",
        webSocketDebuggerUrl: "ws://test/devtools/page/one",
      }),
    ]);

    core.hostMessage(
      host,
      JSON.stringify({
        kind: "targetInfoChanged",
        target: { targetId: "one", title: "One v2", url: "http://app.test/2" },
      } satisfies HostToRelayMessage),
    );
    expect(core.status().targets[0]?.url).toBe("http://app.test/2");
    expect(client.sent).toHaveLength(before);

    core.hostMessage(
      host,
      JSON.stringify({ kind: "targetDestroyed", targetId: "one" } satisfies HostToRelayMessage),
    );
    expect(core.jsonList()).toEqual([]);
  });

  test("Host disconnect clears stale discovery targets", () => {
    const core = new RelayCore();
    const host = fakeSocket();
    readyHost(core, host, "host-1", [{ targetId: "one", title: "One", url: "http://app.test/" }]);
    core.hostDisconnected(host);
    expect(core.status()).toMatchObject({ hostConnected: false, targets: [] });
  });
});
