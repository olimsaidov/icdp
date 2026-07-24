import { describe, expect, test, vi } from "vitest";

import {
  type FrameElementLike,
  IcdpHost,
  type IcdpHostOptions,
  type WindowLike,
} from "../src/host/index.ts";
import type { CdpMessage, HostToRelayMessage } from "../src/protocol.ts";

const FRAME_ORIGIN = "http://app.test";

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeWindow() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const win: WindowLike = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  return {
    win,
    emit(event: { data: unknown; origin: string; source: unknown }) {
      for (const listener of listeners) listener(event as MessageEvent);
    },
  };
}

type PostedMessage = { message: unknown; targetOrigin: string; transfer: Transferable[] };

function fakeIframe() {
  const posted: PostedMessage[] = [];
  const contentWindow = {
    postMessage(message: unknown, targetOrigin: string, transfer: Transferable[] = []) {
      posted.push({ message, targetOrigin, transfer });
    },
  };
  const loadListeners = new Set<() => void>();
  const iframe: FrameElementLike = {
    contentWindow,
    addEventListener: (_type, listener) => loadListeners.add(listener),
    removeEventListener: (_type, listener) => loadListeners.delete(listener),
  };
  return {
    iframe,
    posted,
    contentWindow,
    fireLoad: () => {
      for (const listener of loadListeners) listener();
    },
  };
}

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  readyState: number = WebSocket.CONNECTING;

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(message: unknown): void {
    this.raw(JSON.stringify(message));
  }

  raw(message: string): void {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}

/** Pair an iframe and complete the handshake; returns the frame-side port. */
async function connect(
  options: {
    origins?: string[] | "*";
    host?: Omit<IcdpHostOptions, "window">;
  } = {},
) {
  const { win, emit } = fakeWindow();
  const host = new IcdpHost({ ...options.host, window: win });
  const frame = fakeIframe();
  host.pair(frame.iframe, { targetId: "preview", origins: options.origins ?? [FRAME_ORIGIN] });

  emit({
    data: { icdp: "hello", v: 5, title: "App", url: `${FRAME_ORIGIN}/` },
    origin: FRAME_ORIGIN,
    source: frame.contentWindow,
  });

  const welcome = frame.posted.find(
    (post) => (post.message as { icdp?: string }).icdp === "welcome",
  );
  if (!welcome) throw new Error("no welcome posted");
  const framePort = welcome.transfer[0] as MessagePort;

  const received: Array<{
    kind?: string;
    sessionId?: string;
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    state?: {
      enabledDomains: string[];
      domainParams?: Record<string, Record<string, unknown>>;
    };
  }> = [];
  framePort.onmessage = (event) => received.push(JSON.parse(String(event.data)));
  await flush();

  return { host, emit, frame, framePort, received };
}

describe("handshake", () => {
  test("Host identity does not require crypto.randomUUID", () => {
    const { win } = fakeWindow();
    vi.stubGlobal("crypto", undefined);
    let host: IcdpHost | undefined;
    try {
      host = new IcdpHost(win);
      const socket = new FakeSocket();
      host.connectRelay({
        url: "ws://relay.test/icdp/host",
        webSocketFactory: () => socket as unknown as WebSocket,
      });
      socket.open();
      const ready = socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .find((message) => message.kind === "ready");
      expect(ready?.instanceId).toEqual(expect.stringMatching(/^icdp-host-/));
    } finally {
      host?.destroy();
      vi.unstubAllGlobals();
    }
  });

  test("pair() probes the iframe and reports a Target immediately", () => {
    const { win } = fakeWindow();
    const host = new IcdpHost(win);
    const frame = fakeIframe();
    host.pair(frame.iframe, { targetId: "preview", origins: "*" });
    expect((frame.posted[0]?.message as { icdp: string } | undefined)?.icdp).toBe("probe");
    expect(host.targets().map((target) => target.targetId)).toEqual(["preview"]);
  });

  test("hello from a non-allowlisted origin is ignored", () => {
    const { win, emit } = fakeWindow();
    const host = new IcdpHost(win);
    const frame = fakeIframe();
    host.pair(frame.iframe, { targetId: "preview", origins: [FRAME_ORIGIN] });
    emit({
      data: { icdp: "hello", v: 5, title: "Evil", url: "http://evil.test/" },
      origin: "http://evil.test",
      source: frame.contentWindow,
    });
    expect(
      frame.posted.some((post) => (post.message as { icdp?: string }).icdp === "welcome"),
    ).toBe(false);
  });

  test("hello from an unknown window is ignored", () => {
    const { win, emit } = fakeWindow();
    const host = new IcdpHost(win);
    const frame = fakeIframe();
    host.pair(frame.iframe, { targetId: "preview", origins: "*" });
    emit({
      data: { icdp: "hello", v: 5, title: "X", url: "http://x.test/" },
      origin: FRAME_ORIGIN,
      source: { not: "the iframe" },
    });
    expect(
      frame.posted.some((post) => (post.message as { icdp?: string }).icdp === "welcome"),
    ).toBe(false);
  });

  test("version-incompatible and incomplete hellos are ignored", () => {
    const { win, emit } = fakeWindow();
    const host = new IcdpHost(win);
    const frame = fakeIframe();
    host.pair(frame.iframe, { targetId: "preview", origins: [FRAME_ORIGIN] });

    for (const data of [
      { icdp: "hello", v: 6, title: "Future", url: `${FRAME_ORIGIN}/future` },
      { icdp: "hello", v: 5, title: "Missing URL" },
      { icdp: "hello", v: 5, url: `${FRAME_ORIGIN}/missing-title` },
    ]) {
      emit({ data, origin: FRAME_ORIGIN, source: frame.contentWindow });
    }

    expect(
      frame.posted.some((post) => (post.message as { icdp?: string }).icdp === "welcome"),
    ).toBe(false);
    expect(host.targets()).toEqual([{ targetId: "preview", title: "preview", url: "" }]);
  });

  test("welcome transfers a port and updates target info", async () => {
    const { host } = await connect();
    expect(host.targets()).toEqual([
      { targetId: "preview", title: "App", url: `${FRAME_ORIGIN}/` },
    ]);
  });
});

describe("local sessions", () => {
  test("commands round-trip over the port", async () => {
    const { host, framePort, received } = await connect();
    const session = host.attach("preview");
    const pending = session.send("DOM.getDocument", { depth: 1 });
    await flush();

    const command = received.find((message) => message.kind === "command");
    expect(command).toMatchObject({
      kind: "command",
      sessionId: "icdp-session-1",
      method: "DOM.getDocument",
    });
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: command?.sessionId,
        id: command?.id,
        result: { root: { nodeId: 1 } },
      }),
    );
    expect(await pending).toEqual({ root: { nodeId: 1 } });
  });

  test("frame errors reject the command promise", async () => {
    const { host, framePort, received } = await connect();
    const session = host.attach("preview");
    const pending = session.send("Page.navigate", { url: "http://other.test" });
    await flush();
    const command = received.find((message) => message.kind === "command");
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: command?.sessionId,
        id: command?.id,
        error: { code: -32000, message: "denied" },
      }),
    );
    await expect(pending).rejects.toThrow("denied");
  });

  test("Frame events reach only their originating local Session", async () => {
    const { host, framePort } = await connect();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const sessionA = host.attach("preview");
    const sessionB = host.attach("preview");
    sessionA.onEvent((method) => seenA.push(method));
    sessionB.onEvent((method) => seenB.push(method));

    framePort.postMessage(
      JSON.stringify({
        kind: "event",
        sessionId: "icdp-session-1",
        method: "Runtime.consoleAPICalled",
        params: { type: "log" },
      }),
    );
    await flush();
    expect(seenA).toEqual(["Runtime.consoleAPICalled"]);
    expect(seenB).toEqual([]);
  });

  test("command before the frame pairs fails fast", async () => {
    const { win } = fakeWindow();
    const host = new IcdpHost(win);
    const frame = fakeIframe();
    host.pair(frame.iframe, { targetId: "preview", origins: "*" });
    const session = host.attach("preview");
    await expect(session.send("DOM.getDocument")).rejects.toThrow("not connected");
  });

  test("detach rejects the session's pending commands", async () => {
    const { host, received } = await connect();
    const session = host.attach("preview");
    const pending = session.send("Runtime.evaluate", { expression: "1" });

    session.detach();

    await expect(pending).rejects.toThrow("Consumer detached");
    await expect(session.send("Runtime.evaluate", { expression: "2" })).rejects.toThrow(
      "Consumer detached",
    );
    await flush();
    expect(received.map((message) => message.kind)).toEqual(["attach", "command", "detach"]);
  });
});

describe("per-Session domain state", () => {
  test("each Session's enable and disable reaches the Frame with its identity", async () => {
    const { host, framePort, received } = await connect();
    const sessionA = host.attach("preview");
    const sessionB = host.attach("preview");

    const enables = [sessionA.send("Runtime.enable"), sessionB.send("Runtime.enable")];
    await flush();
    const enableCommands = received.filter(
      (message) => message.kind === "command" && message.method === "Runtime.enable",
    );
    expect(enableCommands.map((message) => message.sessionId)).toEqual([
      "icdp-session-1",
      "icdp-session-2",
    ]);
    for (const command of enableCommands) {
      framePort.postMessage(
        JSON.stringify({
          kind: "response",
          sessionId: command.sessionId,
          id: command.id,
          result: {},
        }),
      );
    }
    await Promise.all(enables);

    const disabled = sessionA.send("Runtime.disable");
    await flush();
    const disableCommand = received.at(-1);
    expect(disableCommand).toMatchObject({
      kind: "command",
      sessionId: "icdp-session-1",
      method: "Runtime.disable",
    });
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: disableCommand?.sessionId,
        id: disableCommand?.id,
        result: {},
      }),
    );
    await disabled;
  });

  test("detach disposes only that Frame Session", async () => {
    const { host, framePort, received } = await connect();
    const session = host.attach("preview");
    const enable = session.send("Runtime.enable");
    await flush();
    const command = received.find((message) => message.kind === "command");
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: command?.sessionId,
        id: command?.id,
        result: {},
      }),
    );
    await enable;

    session.detach();
    await flush();
    expect(received.at(-1)).toEqual({
      kind: "detach",
      sessionId: "icdp-session-1",
    });
  });
});

describe("pairing lifecycle", () => {
  test("a reload retains the Session and restores its enabled domains", async () => {
    const { host, emit, frame, framePort, received } = await connect();
    const session = host.attach("preview");
    const enabled = session.send("Runtime.enable");
    await flush();
    const command = received.findLast((message) => message.kind === "command");
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: command?.sessionId,
        id: command?.id,
        result: {},
      }),
    );
    await enabled;

    emit({
      data: { icdp: "hello", v: 5, title: "App v2", url: `${FRAME_ORIGIN}/v2` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });
    const welcomes = frame.posted.filter(
      (post) => (post.message as { icdp?: string }).icdp === "welcome",
    );
    const nextPort = welcomes.at(-1)?.transfer[0] as MessagePort;
    const restored: Array<Record<string, unknown>> = [];
    nextPort.onmessage = (event) => restored.push(JSON.parse(String(event.data)));
    await flush();

    expect(restored).toContainEqual({
      kind: "attach",
      sessionId: command?.sessionId,
      state: { enabledDomains: ["Runtime"], domainParams: { Runtime: {} } },
    });
  });

  test("successful DOM.getDocument implicitly enables DOM for reload replay", async () => {
    const { host, emit, frame, framePort, received } = await connect();
    const session = host.attach("preview");
    const document = session.send("DOM.getDocument");
    await flush();
    const command = received.findLast((message) => message.kind === "command");
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: command?.sessionId,
        id: command?.id,
        result: { root: { nodeId: 1 } },
      }),
    );
    await document;

    emit({
      data: { icdp: "hello", v: 5, title: "App v2", url: `${FRAME_ORIGIN}/v2` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });
    const welcomes = frame.posted.filter(
      (post) => (post.message as { icdp?: string }).icdp === "welcome",
    );
    const nextPort = welcomes.at(-1)?.transfer[0] as MessagePort;
    const restored: Array<Record<string, unknown>> = [];
    nextPort.onmessage = (event) => restored.push(JSON.parse(String(event.data)));
    await flush();

    expect(restored).toContainEqual({
      kind: "attach",
      sessionId: command?.sessionId,
      state: { enabledDomains: ["DOM"], domainParams: { DOM: {} } },
    });
  });

  test("a reload replays successful domain enable parameters", async () => {
    const { host, emit, frame, framePort, received } = await connect();
    const session = host.attach("preview");
    const enabled = session.send("DOM.enable", { includeWhitespace: "all" });
    await flush();
    const command = received.findLast((message) => message.kind === "command");
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: command?.sessionId,
        id: command?.id,
        result: {},
      }),
    );
    await enabled;

    const repeated = session.send("DOM.enable", { includeWhitespace: "none" });
    await flush();
    const repeatedCommand = received.findLast((message) => message.kind === "command");
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: repeatedCommand?.sessionId,
        id: repeatedCommand?.id,
        result: {},
      }),
    );
    await repeated;

    emit({
      data: { icdp: "hello", v: 5, title: "App v2", url: `${FRAME_ORIGIN}/v2` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });
    const welcomes = frame.posted.filter(
      (post) => (post.message as { icdp?: string }).icdp === "welcome",
    );
    const nextPort = welcomes.at(-1)?.transfer[0] as MessagePort;
    const restored: Array<Record<string, unknown>> = [];
    nextPort.onmessage = (event) => restored.push(JSON.parse(String(event.data)));
    await flush();

    expect(restored).toContainEqual({
      kind: "attach",
      sessionId: command?.sessionId,
      state: {
        enabledDomains: ["DOM"],
        domainParams: { DOM: { includeWhitespace: "all" } },
      },
    });
  });

  test("a reload (second hello) fails in-flight commands and renews the channel", async () => {
    const { host, emit, frame, received } = await connect();
    const session = host.attach("preview");
    const pending = session.send("DOM.getDocument");
    await flush();
    expect(received.map((message) => message.kind)).toEqual(["attach", "command"]);

    emit({
      data: { icdp: "hello", v: 5, title: "App v2", url: `${FRAME_ORIGIN}/v2` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });

    await expect(pending).rejects.toThrow("Target reloaded");
    expect(host.targets()[0]?.url).toBe(`${FRAME_ORIGIN}/v2`);
    const welcomes = frame.posted.filter(
      (post) => (post.message as { icdp?: string }).icdp === "welcome",
    );
    expect(welcomes).toHaveLength(2);
  });

  test("a navigation load cannot invalidate the channel announced by its earlier hello", async () => {
    const { host, emit, frame } = await connect();
    frame.fireLoad();
    const session = host.attach("preview");

    emit({
      data: { icdp: "hello", v: 5, title: "App v2", url: `${FRAME_ORIGIN}/v2` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });
    const welcome = frame.posted.findLast(
      (post) => (post.message as { icdp?: string }).icdp === "welcome",
    );
    const nextPort = welcome?.transfer[0] as MessagePort;
    const restored: Array<Record<string, unknown>> = [];
    nextPort.onmessage = (event) => restored.push(JSON.parse(String(event.data)));
    await flush();

    frame.fireLoad();
    const pending = session.send("DOM.getDocument");
    await flush();
    const command = restored.findLast((message) => message.kind === "command");
    expect(command).toMatchObject({ method: "DOM.getDocument" });

    nextPort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: command?.sessionId,
        id: command?.id,
        result: {},
      }),
    );
    await expect(pending).resolves.toEqual({});
  });

  test("events queued on a stale Frame port are ignored after reload", async () => {
    const { host, emit, frame, framePort } = await connect();
    const session = host.attach("preview");
    const seen: string[] = [];
    session.onEvent((method) => seen.push(method));

    framePort.postMessage(
      JSON.stringify({
        kind: "event",
        sessionId: "icdp-session-1",
        method: "Runtime.consoleAPICalled",
        params: { type: "stale" },
      }),
    );
    emit({
      data: { icdp: "hello", v: 5, title: "App v2", url: `${FRAME_ORIGIN}/v2` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });
    const welcomes = frame.posted.filter(
      (post) => (post.message as { icdp?: string }).icdp === "welcome",
    );
    const nextPort = welcomes.at(-1)?.transfer[0] as MessagePort;

    nextPort.postMessage(
      JSON.stringify({
        kind: "event",
        sessionId: "icdp-session-1",
        method: "Runtime.executionContextCreated",
        params: { context: {} },
      }),
    );
    await flush();

    expect(seen).toEqual(["Runtime.executionContextCreated"]);
  });

  test("unpair destroys the Target and fails pending commands", async () => {
    const { host } = await connect();
    const events: string[] = [];
    host.onTargets((event) => events.push(event.kind));
    const session = host.attach("preview");
    const pending = session.send("DOM.getDocument");
    host.unpair("preview");
    await expect(pending).rejects.toThrow("Target destroyed");
    expect(events).toContain("targetDestroyed");
  });

  test("a load event does not re-probe (or reload) an already-connected Target", async () => {
    const { frame } = await connect();
    const countProbes = () =>
      frame.posted.filter((post) => (post.message as { icdp?: string }).icdp === "probe").length;
    const probesBefore = countProbes();
    const welcomesBefore = frame.posted.filter(
      (post) => (post.message as { icdp?: string }).icdp === "welcome",
    ).length;

    // The iframe's initial load fires *after* the boot hello already connected.
    // It must not re-probe — that would draw a second hello and fail in-flight work.
    frame.fireLoad();

    expect(countProbes()).toBe(probesBefore);
    expect(
      frame.posted.filter((post) => (post.message as { icdp?: string }).icdp === "welcome").length,
    ).toBe(welcomesBefore);
  });

  test("a later load invalidates the old document channel until the next hello", async () => {
    const { host, emit, frame, received } = await connect();
    const session = host.attach("preview");

    // Consume the initial load that can race with the boot hello.
    frame.fireLoad();
    const pending = session.send("DOM.getDocument");
    await flush();
    expect(received.at(-1)?.kind).toBe("command");

    frame.fireLoad();

    await expect(pending).rejects.toThrow("Target reloaded");
    await expect(session.send("DOM.getDocument")).rejects.toThrow("Target is not connected");
    expect(
      frame.posted.filter((post) => (post.message as { icdp?: string }).icdp === "probe"),
    ).toHaveLength(2);

    emit({
      data: { icdp: "hello", v: 5, title: "App v2", url: `${FRAME_ORIGIN}/v2` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });
    const welcome = frame.posted.findLast(
      (post) => (post.message as { icdp?: string }).icdp === "welcome",
    );
    const nextPort = welcome?.transfer[0] as MessagePort;
    const restored: Array<Record<string, unknown>> = [];
    nextPort.onmessage = (event) => restored.push(JSON.parse(String(event.data)));
    await flush();

    expect(restored).toContainEqual({
      kind: "attach",
      sessionId: "icdp-session-1",
      state: { enabledDomains: [], domainParams: {} },
    });
  });

  test("a load event re-probes while not yet connected (handshake backstop)", () => {
    const { win } = fakeWindow();
    const host = new IcdpHost(win);
    const frame = fakeIframe();
    host.pair(frame.iframe, { targetId: "preview", origins: "*" });
    const countProbes = () =>
      frame.posted.filter((post) => (post.message as { icdp?: string }).icdp === "probe").length;
    const before = countProbes();

    frame.fireLoad();

    // No channel yet, so the load is a chance to re-elicit the agent's hello.
    expect(countProbes()).toBe(before + 1);
  });
});

describe("relay uplink lifecycle", () => {
  test("malformed Relay control envelopes are ignored", async () => {
    const { host } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();

    expect(() => socket.message({ kind: "clients", clientIds: {} })).not.toThrow();
    expect(() =>
      socket.message({
        kind: "clientMessage",
        clientId: 42,
        message: JSON.stringify({ id: 1, method: "Browser.getVersion" }),
      }),
    ).not.toThrow();
    await flush();

    expect(
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage"),
    ).toEqual([]);
  });

  test("Host owns browser and Target dispatch for Relay Clients", async () => {
    const { host } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });
    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({ id: 7, method: "Target.getTargets" }),
    });
    await flush();

    const responseEnvelope = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .findLast((message) => message.kind === "clientMessage");
    expect(responseEnvelope?.clientId).toBe("client-1");
    expect(JSON.parse(String(responseEnvelope?.message))).toMatchObject({
      id: 7,
      result: {
        targetInfos: [{ targetId: "preview", type: "page" }],
      },
    });
  });

  test("Host maps a direct Target Client to one implicit Session", async () => {
    const { host, framePort, received } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({
      kind: "clients",
      clientIds: ["client-1"],
      targetIds: { "client-1": "preview" },
    });
    await flush();

    const attached = received.findLast((message) => message.kind === "attach");
    expect(attached?.sessionId).toMatch(/^icdp-session-/);
    expect(
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage"),
    ).toEqual([]);

    const messages = (): CdpMessage[] =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    const send = (
      id: number,
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      });

    const beforeRootCommands = received.length;
    send(1, "Browser.getVersion");
    send(2, "Target.getTargetInfo");
    send(3, "Target.getTargets");
    await flush();
    expect(messages().find((message) => message.id === 1)?.result).toMatchObject({
      protocolVersion: "1.3",
    });
    const targetInfo = messages().find((message) => message.id === 2)?.result as
      | { targetInfo: { targetId: string } }
      | undefined;
    expect(targetInfo?.targetInfo.targetId).toBe("preview");
    const targetInfos = messages().find((message) => message.id === 3)?.result as
      | { targetInfos: Array<{ targetId: string }> }
      | undefined;
    expect(targetInfos?.targetInfos).toEqual([expect.objectContaining({ targetId: "preview" })]);
    expect(received).toHaveLength(beforeRootCommands);

    send(7, "DOM.getDocument", { depth: 1 });
    await flush();

    const command = received.findLast((message) => message.kind === "command");
    expect(command).toMatchObject({
      method: "DOM.getDocument",
      sessionId: attached?.sessionId,
    });
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: attached?.sessionId,
        id: command?.id,
        result: { root: { nodeId: 1 } },
      }),
    );
    await flush();

    expect(messages().at(-1)).toEqual({
      id: 7,
      result: { root: { nodeId: 1 } },
    });

    framePort.postMessage(
      JSON.stringify({
        kind: "event",
        sessionId: attached?.sessionId,
        method: "Runtime.consoleAPICalled",
        params: { type: "log" },
      }),
    );
    await flush();
    expect(messages().at(-1)).toEqual({
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
    });

    send(8, "Target.detachFromTarget", { targetId: "preview" });
    await flush();
    expect(messages().find((message) => message.id === 8)?.error?.code).toBe(-32602);

    send(9, "Target.attachToTarget", { targetId: "preview", flatten: true });
    await flush();
    const nested = messages().find((message) => message.id === 9)?.result as
      | { sessionId: string }
      | undefined;
    if (!nested) throw new Error("nested attach response not received");
    const nestedSessionId = nested.sessionId;
    expect(nestedSessionId).toMatch(/^icdp-session-/);
    expect(messages()).toContainEqual(
      expect.objectContaining({
        method: "Target.attachedToTarget",
        params: expect.objectContaining({ sessionId: nestedSessionId }),
      }),
    );

    send(10, "DOM.getDocument", { depth: 1 }, nestedSessionId);
    await flush();
    const nestedCommand = received.findLast(
      (message) => message.kind === "command" && message.sessionId === nestedSessionId,
    );
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId: nestedSessionId,
        id: nestedCommand?.id,
        result: { root: { nodeId: 2 } },
      }),
    );
    await flush();
    expect(messages().find((message) => message.id === 10)).toEqual({
      id: 10,
      sessionId: nestedSessionId,
      result: { root: { nodeId: 2 } },
    });
  });

  test("direct Target teardown cannot publish sibling state after target_closed", async () => {
    const { host, emit } = await connect({
      host: { onCloseTarget: () => {} },
    });
    const sibling = fakeIframe();
    host.pair(sibling.iframe, { targetId: "sibling", origins: "*" });
    emit({
      data: {
        icdp: "hello",
        v: 5,
        title: "Sibling",
        url: `${FRAME_ORIGIN}/sibling`,
      },
      origin: FRAME_ORIGIN,
      source: sibling.contentWindow,
    });

    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({
      kind: "clients",
      clientIds: ["client-1"],
      targetIds: { "client-1": "preview" },
    });
    await flush();

    const messages = (): CdpMessage[] =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    const send = (
      id: number,
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      });

    send(1, "Target.setDiscoverTargets", { discover: true });
    send(2, "Target.attachToTarget", { targetId: "sibling", flatten: true });
    await flush();
    const child = (
      messages().find((message) => message.id === 2)?.result as { sessionId?: string } | undefined
    )?.sessionId;
    expect(child).toMatch(/^icdp-session-/);
    if (!child) throw new Error("child attach response not received");

    send(3, "Runtime.evaluate", { expression: "await new Promise(() => {})" }, child);
    await flush();
    expect(messages().some((message) => message.id === 3)).toBe(false);

    const beforeClose = messages().length;
    send(4, "Target.closeTarget", { targetId: "preview" });
    await flush();

    expect(messages().slice(beforeClose)).toEqual([
      { id: 4, result: { success: true } },
      {
        method: "Inspector.detached",
        params: { reason: "Render process gone." },
      },
      {
        method: "Inspector.detached",
        params: { reason: "target_closed" },
      },
    ]);
  });

  test("browser Target destruction publishes detached target state in Chromium order", async () => {
    const { host } = await connect({
      host: { onCloseTarget: () => {} },
    });
    const sibling = fakeIframe();
    host.pair(sibling.iframe, { targetId: "sibling", origins: "*" });

    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const messages = (): CdpMessage[] =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    const send = (
      id: number,
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      });
    const attachedSessionId = (id: number): string => {
      const response = messages().find((message) => message.id === id);
      if (!response) throw new Error(`attach response ${id} not received`);
      return String((response.result as { sessionId: string }).sessionId);
    };

    send(1, "Target.setDiscoverTargets", { discover: true });
    send(2, "Target.attachToTarget", { targetId: "preview", flatten: true });
    await flush();
    const parent = attachedSessionId(2);
    send(3, "Target.attachToTarget", { targetId: "sibling", flatten: true }, parent);
    await flush();
    attachedSessionId(3);

    const beforeClose = messages().length;
    send(4, "Target.closeTarget", { targetId: "preview" });
    await flush();

    expect(messages().slice(beforeClose)).toEqual([
      { id: 4, result: { success: true } },
      {
        method: "Inspector.detached",
        params: { reason: "Render process gone." },
        sessionId: parent,
      },
      {
        method: "Target.targetInfoChanged",
        params: {
          targetInfo: {
            targetId: "sibling",
            type: "page",
            title: "sibling",
            url: "",
            attached: false,
            canAccessOpener: false,
          },
        },
      },
      {
        method: "Target.targetInfoChanged",
        params: {
          targetInfo: {
            targetId: "preview",
            type: "page",
            title: "App",
            url: `${FRAME_ORIGIN}/`,
            attached: false,
            canAccessOpener: false,
          },
        },
      },
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: parent, targetId: "preview" },
      },
      {
        method: "Target.targetDestroyed",
        params: { targetId: "preview" },
      },
    ]);
  });

  test("an async Target command cannot respond after its Session is detached", async () => {
    let releaseClose: (() => void) | undefined;
    const closePending = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const { host } = await connect({
      host: { onCloseTarget: () => closePending },
    });
    const sibling = fakeIframe();
    host.pair(sibling.iframe, { targetId: "sibling", origins: "*" });

    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const messages = (): CdpMessage[] =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    const send = (
      id: number,
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      });

    send(1, "Target.attachToTarget", { targetId: "preview", flatten: true });
    await flush();
    const sessionId = (
      messages().find((message) => message.id === 1)?.result as { sessionId?: string } | undefined
    )?.sessionId;
    if (!sessionId) throw new Error("attach response not received");

    send(2, "Target.closeTarget", { targetId: "sibling" }, sessionId);
    await flush();
    expect(messages().some((message) => message.id === 2)).toBe(false);

    send(3, "Target.detachFromTarget", { sessionId });
    await flush();
    expect(messages().slice(-2)).toEqual([
      {
        method: "Target.detachedFromTarget",
        params: { sessionId, targetId: "preview" },
      },
      { id: 3, result: {} },
    ]);

    releaseClose?.();
    await flush();
    expect(messages().some((message) => message.id === 2)).toBe(false);
    expect(host.targets().some((target) => target.targetId === "sibling")).toBe(false);
  });

  test("Host does not advertise browser methods it cannot perform", async () => {
    const { host } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const unsupported = [
      "Browser.close",
      "Browser.setDownloadBehavior",
      "Browser.setWindowBounds",
      "Schema.getDomains",
      "Security.setIgnoreCertificateErrors",
      "Target.activateTarget",
      "Target.setRemoteLocations",
    ];
    unsupported.forEach((method, index) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({
          id: index + 1,
          method,
          params: method === "Target.setRemoteLocations" ? { locations: [] } : {},
        }),
      }),
    );
    await flush();

    const responses = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((message) => message.kind === "clientMessage")
      .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    expect(responses).toHaveLength(unsupported.length);
    expect(responses.map((message) => message.error?.code)).toEqual([
      -32601, -32601, -32601, -32601, -32601, -32601, -32000,
    ]);
  });

  test("Host ignores undeclared params before method selection", async () => {
    const { host } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });
    for (const [id, method] of [
      [1, "Browser.getVersion"],
      [2, "NoSuch.domain"],
    ] as const) {
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method, params: { filter: 42 } }),
      });
    }
    await flush();

    const responses = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((message) => message.kind === "clientMessage")
      .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    expect(responses.find((message) => message.id === 1)?.result).toMatchObject({
      protocolVersion: "1.3",
    });
    expect(responses.find((message) => message.id === 2)?.error).toEqual({
      code: -32601,
      message: "'NoSuch.domain' wasn't found",
    });
  });

  test("Target.getTargetInfo rejects an unknown target instead of fabricating one", async () => {
    const { host } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });
    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 1,
        method: "Target.getTargetInfo",
        params: { targetId: "missing" },
      }),
    });
    await flush();

    const envelope = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .findLast((message) => message.kind === "clientMessage");
    expect(JSON.parse(String(envelope?.message))).toEqual({
      id: 1,
      error: {
        code: -32602,
        message: "No target with given id found",
      },
    });
  });

  test("root Target.getTargetInfo defaults to the connection's browser target", async () => {
    const { host } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const send = (id: number, params: Record<string, unknown>) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method: "Target.getTargetInfo", params }),
      });
    const messages = () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);

    send(1, {});
    await flush();
    const browser = (
      messages().find((message) => message.id === 1)?.result as {
        targetInfo?: Record<string, unknown>;
      }
    )?.targetInfo;
    expect(browser).toMatchObject({
      targetId: expect.any(String),
      type: "browser",
      url: "",
      attached: true,
    });

    send(2, { targetId: browser?.targetId });
    await flush();
    expect(
      (
        messages().find((message) => message.id === 2)?.result as {
          targetInfo?: Record<string, unknown>;
        }
      )?.targetInfo,
    ).toEqual(browser);
  });

  test("browser target is discovered but never enumerated by getTargets", async () => {
    const { host } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const send = (id: number, method: string, params: Record<string, unknown>) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method, params }),
      });
    const messages = () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);

    send(1, "Target.getTargets", {});
    send(2, "Target.getTargets", { filter: [{ type: "browser" }] });
    send(3, "Target.setDiscoverTargets", {
      discover: true,
      filter: [{ type: "browser" }],
    });
    send(4, "Target.setDiscoverTargets", {
      discover: true,
      filter: [{ type: "browser" }],
    });
    await flush();

    const defaultTargets = (
      messages().find((message) => message.id === 1)?.result as
        | {
            targetInfos?: Array<Record<string, unknown>>;
          }
        | undefined
    )?.targetInfos;
    const filteredTargets = (
      messages().find((message) => message.id === 2)?.result as
        | {
            targetInfos?: Array<Record<string, unknown>>;
          }
        | undefined
    )?.targetInfos;
    const discovered = messages().filter((message) => message.method === "Target.targetCreated");

    expect(defaultTargets).toEqual([expect.objectContaining({ type: "page" })]);
    expect(filteredTargets).toEqual([]);
    expect(discovered).toEqual([
      expect.objectContaining({
        params: {
          targetInfo: expect.objectContaining({
            targetId: expect.any(String),
            type: "browser",
            attached: true,
          }),
        },
      }),
    ]);
  });

  test("Target.attachToTarget rejects legacy non-flattened Sessions", async () => {
    const { host, received } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });
    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: "preview", flatten: false },
      }),
    });
    await flush();

    const envelope = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .findLast((message) => message.kind === "clientMessage");
    expect(JSON.parse(String(envelope?.message))).toEqual({
      id: 1,
      error: {
        code: -32602,
        message: "Only flatten protocol is supported",
      },
    });
    expect(received).toEqual([]);
  });

  test("Host attaches Relay Sessions and preserves their identity through the Frame", async () => {
    const { host, framePort, received } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });
    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: "preview", flatten: true },
      }),
    });
    await flush();

    const relayMessages = () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as Record<string, unknown>);
    const attached = relayMessages().find((message) => message.id === 1);
    if (!attached) throw new Error("attach response not received");
    const sessionId = String((attached.result as { sessionId: string }).sessionId);
    expect(sessionId).toMatch(/^icdp-session-/);
    expect(received.at(-1)).toEqual({
      kind: "attach",
      sessionId,
      state: { enabledDomains: [], domainParams: {} },
    });

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 2,
        sessionId,
        method: "DOM.getDocument",
        params: { depth: 1 },
      }),
    });
    await flush();
    const command = received.at(-1);
    expect(command).toMatchObject({
      kind: "command",
      sessionId,
      method: "DOM.getDocument",
      params: { depth: 1 },
    });

    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId,
        id: command?.id,
        result: { root: { nodeId: 1 } },
      }),
    );
    await flush();
    expect(relayMessages().find((message) => message.id === 2)).toEqual({
      id: 2,
      sessionId,
      result: { root: { nodeId: 1 } },
    });
  });

  test("flattened Sessions use Host Browser and Target handlers before forwarding", async () => {
    const { host, received, emit } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });
    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: "preview", flatten: true },
      }),
    });
    await flush();

    const clientMessages = () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    const attached = clientMessages().find((message) => message.id === 1);
    if (!attached) throw new Error("attach response not received");
    const sessionId = String((attached.result as { sessionId: string }).sessionId);

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 2,
        sessionId,
        method: "Browser.getVersion",
      }),
    });
    await flush();

    expect(clientMessages()).toContainEqual({
      id: 2,
      sessionId,
      result: expect.objectContaining({ protocolVersion: "1.3" }),
    });
    expect(received.some((message) => message.method === "Browser.getVersion")).toBe(false);

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 3,
        sessionId,
        method: "Target.getTargets",
      }),
    });
    await flush();

    expect(clientMessages()).toContainEqual({
      id: 3,
      sessionId,
      result: {
        targetInfos: [
          expect.objectContaining({
            targetId: "preview",
            type: "page",
          }),
        ],
      },
    });
    expect(received.some((message) => message.method === "Target.getTargets")).toBe(false);

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 4,
        sessionId,
        method: "Target.setDiscoverTargets",
        params: { discover: true },
      }),
    });
    await flush();
    expect(clientMessages()).toContainEqual({ id: 4, sessionId, result: {} });
    expect(clientMessages()).toContainEqual({
      method: "Target.targetCreated",
      params: {
        targetInfo: expect.objectContaining({ targetId: "preview" }),
      },
      sessionId,
    });

    const attachedBeforePageAutoAttach = clientMessages().filter(
      (message) => message.method === "Target.attachedToTarget",
    ).length;
    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 5,
        sessionId,
        method: "Target.setAutoAttach",
        params: {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
      }),
    });
    await flush();
    expect(clientMessages()).toContainEqual({ id: 5, sessionId, result: {} });
    expect(
      clientMessages().filter((message) => message.method === "Target.attachedToTarget"),
    ).toHaveLength(attachedBeforePageAutoAttach);

    const sibling = fakeIframe();
    host.pair(sibling.iframe, { targetId: "sibling", origins: "*" });
    emit({
      data: {
        icdp: "hello",
        v: 5,
        title: "Sibling",
        url: `${FRAME_ORIGIN}/sibling`,
      },
      origin: FRAME_ORIGIN,
      source: sibling.contentWindow,
    });
    await flush();
    expect(
      clientMessages().filter((message) => message.method === "Target.attachedToTarget"),
    ).toHaveLength(attachedBeforePageAutoAttach);
    expect(clientMessages()).toContainEqual({
      method: "Target.targetCreated",
      params: {
        targetInfo: expect.objectContaining({ targetId: "sibling" }),
      },
      sessionId,
    });

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 6,
        sessionId,
        method: "Target.attachToTarget",
        params: { targetId: "sibling", flatten: true },
      }),
    });
    await flush();
    const nestedResponse = clientMessages().find((message) => message.id === 6);
    const nestedSessionId = String(
      (nestedResponse?.result as { sessionId?: string } | undefined)?.sessionId,
    );
    expect(nestedResponse).toEqual({
      id: 6,
      sessionId,
      result: { sessionId: nestedSessionId },
    });
    expect(clientMessages()).toContainEqual({
      method: "Target.attachedToTarget",
      params: {
        sessionId: nestedSessionId,
        targetInfo: expect.objectContaining({ targetId: "sibling" }),
        waitingForDebugger: false,
      },
      sessionId,
    });

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 7,
        sessionId: nestedSessionId,
        method: "Target.attachToTarget",
        params: { targetId: "preview", flatten: true },
      }),
    });
    await flush();
    const grandchildResponse = clientMessages().find((message) => message.id === 7);
    const grandchildSessionId = String(
      (grandchildResponse?.result as { sessionId?: string } | undefined)?.sessionId,
    );
    expect(grandchildResponse).toEqual({
      id: 7,
      sessionId: nestedSessionId,
      result: { sessionId: grandchildSessionId },
    });
    expect(clientMessages()).toContainEqual({
      method: "Target.attachedToTarget",
      params: {
        sessionId: grandchildSessionId,
        targetInfo: expect.objectContaining({ targetId: "preview" }),
        waitingForDebugger: false,
      },
      sessionId: nestedSessionId,
    });

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 8,
        sessionId: nestedSessionId,
        method: "Runtime.evaluate",
        params: { expression: "await new Promise(() => {})" },
      }),
    });
    await flush();
    expect(clientMessages().some((message) => message.id === 8)).toBe(false);

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 9,
        method: "Target.detachFromTarget",
        params: { sessionId: nestedSessionId },
      }),
    });
    await flush();
    expect(clientMessages().find((message) => message.id === 9)?.error?.code).toBe(-32602);

    const beforeDetach = clientMessages().length;
    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 10,
        sessionId,
        method: "Target.detachFromTarget",
        params: { sessionId: nestedSessionId },
      }),
    });
    await flush();
    expect(clientMessages().slice(beforeDetach)).toEqual([
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: nestedSessionId, targetId: "sibling" },
        sessionId,
      },
      {
        method: "Target.targetInfoChanged",
        params: {
          targetInfo: {
            targetId: "sibling",
            type: "page",
            title: "Sibling",
            url: `${FRAME_ORIGIN}/sibling`,
            attached: false,
            canAccessOpener: false,
          },
        },
        sessionId,
      },
      { id: 10, sessionId, result: {} },
    ]);
    expect(clientMessages().filter((message) => message.method === "Inspector.detached")).toEqual(
      [],
    );

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 11,
        sessionId,
        method: "Browser.close",
      }),
    });
    await flush();
    expect(clientMessages()).toContainEqual({
      id: 11,
      sessionId,
      error: {
        code: -32601,
        message: "'Browser.close' wasn't found",
      },
    });
    expect(received.some((message) => message.method === "Browser.close")).toBe(false);
  });

  test("Session-scoped create and close stay in the Host and close responds first", async () => {
    const { host, received } = await connect({
      host: { onCloseTarget: () => {} },
    });
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });
    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: "preview", flatten: true },
      }),
    });
    await flush();

    const bridgeMessages = () =>
      socket.sent.map((raw) => JSON.parse(raw) as HostToRelayMessage | Record<string, unknown>);
    const clientMessages = (): CdpMessage[] =>
      bridgeMessages()
        .filter((message) => message.kind === "clientMessage")
        .map((message) =>
          JSON.parse(String((message as { message: string }).message)),
        ) as CdpMessage[];
    const attached = clientMessages().find((message) => message.id === 1);
    if (!attached) throw new Error("attach response not received");
    const sessionId = String((attached.result as { sessionId: string }).sessionId);

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 2,
        sessionId,
        method: "Target.createTarget",
        params: { url: "http://app.test/new" },
      }),
    });
    await flush();
    expect(clientMessages()).toContainEqual({
      id: 2,
      sessionId,
      error: {
        code: -32000,
        message: "Target.createTarget is not handled by this Host",
      },
    });

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 3,
        sessionId,
        method: "Target.closeTarget",
        params: { targetId: "preview" },
      }),
    });
    await flush();

    const messages = bridgeMessages();
    const responseIndex = messages.findIndex(
      (message) =>
        message.kind === "clientMessage" &&
        JSON.parse(String((message as { message: string }).message)).id === 3,
    );
    const destroyedIndex = messages.findIndex((message) => message.kind === "targetDestroyed");
    expect(clientMessages()).toContainEqual({
      id: 3,
      sessionId,
      result: { success: true },
    });
    const closeMessages = clientMessages();
    const closeResponseIndex = closeMessages.findIndex((message) => message.id === 3);
    const inspectorDetachedIndex = closeMessages.findIndex(
      (message) =>
        message.method === "Inspector.detached" &&
        message.sessionId === sessionId &&
        message.params?.reason === "Render process gone.",
    );
    const targetDetachedIndex = closeMessages.findIndex(
      (message) =>
        message.method === "Target.detachedFromTarget" && message.params?.sessionId === sessionId,
    );
    expect(inspectorDetachedIndex).toBeGreaterThan(closeResponseIndex);
    expect(targetDetachedIndex).toBeGreaterThan(inspectorDetachedIndex);
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(destroyedIndex).toBeGreaterThan(responseIndex);
    expect(
      received.some(
        (message) =>
          message.method === "Target.createTarget" || message.method === "Target.closeTarget",
      ),
    ).toBe(false);
  });

  test("Target destruction batches Inspector events and notifies only surviving parents", async () => {
    const { host } = await connect({
      host: { onCloseTarget: () => {} },
    });
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const messages = (): CdpMessage[] =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((message) => JSON.parse(String(message.message)) as CdpMessage);
    const send = (
      id: number,
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      });
    const attachedSessionId = (id: number): string => {
      const response = messages().find((message) => message.id === id);
      if (!response) throw new Error(`attach response ${id} not received`);
      return String((response.result as { sessionId: string }).sessionId);
    };

    send(1, "Target.attachToTarget", { targetId: "preview", flatten: true });
    await flush();
    const first = attachedSessionId(1);
    send(2, "Target.attachToTarget", { targetId: "preview", flatten: true }, first);
    send(3, "Target.attachToTarget", { targetId: "preview", flatten: true });
    await flush();
    const child = attachedSessionId(2);
    const independent = attachedSessionId(3);

    const beforeClose = messages().length;
    send(4, "Target.closeTarget", { targetId: "preview" });
    await flush();
    const teardown = messages().slice(beforeClose);
    expect(teardown[0]).toEqual({ id: 4, result: { success: true } });
    const inspectors = teardown.filter((message) => message.method === "Inspector.detached");
    expect(inspectors).toEqual([
      {
        method: "Inspector.detached",
        params: { reason: "Render process gone." },
        sessionId: first,
      },
      {
        method: "Inspector.detached",
        params: { reason: "Render process gone." },
        sessionId: child,
      },
      {
        method: "Inspector.detached",
        params: { reason: "Render process gone." },
        sessionId: independent,
      },
    ]);
    const detached = teardown.filter((message) => message.method === "Target.detachedFromTarget");
    expect(detached).toEqual([
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: first, targetId: "preview" },
      },
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: independent, targetId: "preview" },
      },
    ]);
    expect(teardown.indexOf(inspectors.at(-1)!)).toBeLessThan(teardown.indexOf(detached[0]!));
  });

  test("Target.getTargetInfo defaults to the current flattened Session target", async () => {
    const { host, received } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });
    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: "preview", flatten: true },
      }),
    });
    await flush();

    const clientMessages = () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    const attached = clientMessages().find((message) => message.id === 1);
    if (!attached) throw new Error("attach response not received");
    const sessionId = String((attached.result as { sessionId: string }).sessionId);

    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 2,
        sessionId,
        method: "Target.getTargetInfo",
      }),
    });
    await flush();

    expect(clientMessages()).toContainEqual({
      id: 2,
      sessionId,
      result: {
        targetInfo: expect.objectContaining({
          targetId: "preview",
          type: "page",
        }),
      },
    });
    expect(received.some((message) => message.method === "Target.getTargetInfo")).toBe(false);
  });

  test("Frame events reach only the Relay Client that owns their Session", async () => {
    const { host, framePort } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1", "client-2"] });

    for (const [clientId, id] of [
      ["client-1", 1],
      ["client-2", 2],
    ] as const) {
      socket.message({
        kind: "clientMessage",
        clientId,
        message: JSON.stringify({
          id,
          method: "Target.attachToTarget",
          params: { targetId: "preview", flatten: true },
        }),
      });
    }
    await flush();

    const envelopes = () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as { kind?: string; clientId?: string; message?: string })
        .filter(
          (envelope): envelope is { kind: "clientMessage"; clientId: string; message: string } =>
            envelope.kind === "clientMessage",
        )
        .map((envelope) => ({
          clientId: envelope.clientId,
          message: JSON.parse(envelope.message) as CdpMessage,
        }));
    const firstAttach = envelopes().find(
      (envelope) => envelope.clientId === "client-1" && envelope.message.id === 1,
    );
    if (!firstAttach) throw new Error("attach response not received");
    const sessionId = String((firstAttach.message.result as { sessionId: string }).sessionId);

    const beforeMalformedEvent = envelopes().length;
    framePort.postMessage(
      JSON.stringify({
        kind: "event",
        sessionId,
        method: 42,
        params: {},
      }),
    );
    await flush();
    expect(envelopes()).toHaveLength(beforeMalformedEvent);

    framePort.postMessage(
      JSON.stringify({
        kind: "event",
        sessionId,
        method: "Runtime.consoleAPICalled",
        params: { type: "log" },
      }),
    );
    await flush();

    const consoleEvents = envelopes().filter(
      (envelope) => envelope.message.method === "Runtime.consoleAPICalled",
    );
    expect(consoleEvents).toEqual([
      {
        clientId: "client-1",
        message: {
          method: "Runtime.consoleAPICalled",
          params: { type: "log" },
          sessionId,
        },
      },
    ]);
  });

  test("discovery does not duplicate targetCreated and reports attached state changes", async () => {
    const { host } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const send = (id: number, method: string, params: Record<string, unknown>) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method, params }),
      });
    const messages = () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);

    send(1, "Target.setDiscoverTargets", { discover: true });
    send(2, "Target.setDiscoverTargets", { discover: true });
    await flush();
    expect(messages().filter((message) => message.method === "Target.targetCreated")).toHaveLength(
      1,
    );

    send(3, "Target.attachToTarget", { targetId: "preview", flatten: true });
    await flush();
    const attached = messages().find((message) => message.id === 3);
    const sessionId = String((attached?.result as { sessionId?: string })?.sessionId);
    const attachedStateIndex = messages().findIndex(
      (message) =>
        message.method === "Target.targetInfoChanged" &&
        (message.params?.targetInfo as { attached?: boolean })?.attached === true,
    );
    const attachedEventIndex = messages().findIndex(
      (message) =>
        message.method === "Target.attachedToTarget" && message.params?.sessionId === sessionId,
    );
    expect(attachedStateIndex).toBeGreaterThanOrEqual(0);
    expect(attachedStateIndex).toBeLessThan(attachedEventIndex);

    send(4, "Target.detachFromTarget", { sessionId: "", targetId: "preview" });
    await flush();
    expect(messages().find((message) => message.id === 4)?.error).toEqual({
      code: -32602,
      message: "No session with given id",
    });
    expect(
      messages().some(
        (message) =>
          message.method === "Target.detachedFromTarget" && message.params?.sessionId === sessionId,
      ),
    ).toBe(false);

    send(5, "Target.detachFromTarget", { sessionId });
    await flush();
    expect(
      messages().some(
        (message) =>
          message.method === "Target.targetInfoChanged" &&
          (message.params?.targetInfo as { attached?: boolean })?.attached === false,
      ),
    ).toBe(true);

    send(6, "Target.setDiscoverTargets", { discover: false });
    send(7, "Target.setDiscoverTargets", {
      discover: true,
      filter: [{ type: "page", exclude: true }, {}],
    });
    send(8, "Target.getTargets", {
      filter: [{ type: "page", exclude: true }, {}],
    });
    await flush();
    expect(messages().filter((message) => message.method === "Target.targetCreated")).toHaveLength(
      2,
    );
    expect(messages().find((message) => message.id === 8)?.result).toEqual({
      targetInfos: [],
    });
  });

  test("attached target state changes only on the first attach and last detach", async () => {
    const { host } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const send = (id: number, method: string, params: Record<string, unknown>) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method, params }),
      });
    const messages = () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    const attachedStateEvents = (attached: boolean) =>
      messages().filter(
        (message) =>
          message.method === "Target.targetInfoChanged" &&
          (message.params?.targetInfo as { attached?: boolean })?.attached === attached,
      );

    send(1, "Target.setDiscoverTargets", { discover: true });
    send(2, "Target.attachToTarget", { targetId: "preview", flatten: true });
    send(3, "Target.attachToTarget", { targetId: "preview", flatten: true });
    await flush();
    expect(attachedStateEvents(true)).toHaveLength(1);

    const firstSessionId = String(
      (messages().find((message) => message.id === 2)?.result as { sessionId?: string })?.sessionId,
    );
    const secondSessionId = String(
      (messages().find((message) => message.id === 3)?.result as { sessionId?: string })?.sessionId,
    );
    send(4, "Target.detachFromTarget", { sessionId: firstSessionId });
    await flush();
    expect(attachedStateEvents(false)).toHaveLength(0);

    send(5, "Target.detachFromTarget", { sessionId: secondSessionId });
    await flush();
    expect(attachedStateEvents(false)).toHaveLength(1);
  });

  test("a Client snapshot removal detaches its Frame Sessions", async () => {
    const { host, received } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });
    socket.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: "preview", flatten: true },
      }),
    });
    await flush();
    const sessionId = received.findLast((message) => message.kind === "attach")?.sessionId;

    socket.message({ kind: "clients", clientIds: [] });
    await flush();

    expect(received.at(-1)).toEqual({ kind: "detach", sessionId });
  });

  test("a transient Relay reconnect preserves Client Sessions and in-flight responses", async () => {
    const { host, framePort, received } = await connect();
    const sockets: FakeSocket[] = [];
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      reconnectDelayMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    const first = sockets[0];
    if (!first) throw new Error("first socket was not created");
    first.open();
    first.message({
      kind: "clients",
      clientIds: ["client-1"],
    });
    first.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: "preview", flatten: true },
      }),
    });
    await flush();
    const attachedEnvelope = first.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .findLast((message) => message.kind === "clientMessage");
    const attached = JSON.parse(String(attachedEnvelope?.message)) as {
      result: { sessionId: string };
    };
    const sessionId = attached.result.sessionId;

    first.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 2,
        sessionId,
        method: "Runtime.evaluate",
        params: { expression: "1" },
      }),
    });
    await flush();
    const evaluate = received.find((message) => message.method === "Runtime.evaluate");
    if (!evaluate) throw new Error("evaluate command did not reach the frame");

    first.close();
    await flush();

    const second = sockets[1];
    if (!second) throw new Error("second socket was not created");
    framePort.postMessage(
      JSON.stringify({
        kind: "response",
        sessionId,
        id: evaluate.id,
        result: { result: { type: "number", value: 1 } },
      }),
    );
    framePort.postMessage(
      JSON.stringify({
        kind: "event",
        sessionId,
        method: "Runtime.consoleAPICalled",
        params: { type: "log" },
      }),
    );
    await flush();

    second.open();
    second.message({ kind: "clients", clientIds: ["client-1"] });
    await flush();

    const firstReady = first.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((message) => message.kind === "ready");
    const secondReady = second.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((message) => message.kind === "ready");
    expect(firstReady?.instanceId).toEqual(expect.stringMatching(/^icdp-host-/));
    expect(secondReady?.instanceId).toBe(firstReady?.instanceId);

    const responseEnvelope = second.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((message) => message.kind === "clientMessage")
      .find((message) => (JSON.parse(String(message.message)) as CdpMessage).id === 2);
    expect(JSON.parse(String(responseEnvelope?.message))).toEqual({
      id: 2,
      sessionId,
      result: { result: { type: "number", value: 1 } },
    });
    expect(
      second.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage),
    ).toContainEqual({
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
      sessionId,
    });
    const reconnectMessages = second.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    const readyIndex = reconnectMessages.findIndex((message) => message.kind === "ready");
    const responseIndex = reconnectMessages.findIndex(
      (message) =>
        message.kind === "clientMessage" &&
        (JSON.parse(String(message.message)) as CdpMessage).id === 2,
    );
    const completeIndex = reconnectMessages.findIndex(
      (message) => message.kind === "readyComplete",
    );
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(responseIndex).toBeGreaterThan(readyIndex);
    expect(completeIndex).toBeGreaterThan(responseIndex);
  });

  test("setAutoAttach follows Chromium lifecycle semantics", async () => {
    const { host, received } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const send = (id: number, method: string, params: Record<string, unknown>) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method, params }),
      });
    send(0, "Target.attachToTarget", { targetId: "preview", flatten: true });
    await flush();

    const messages = () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    const explicitAttach = messages().find((message) => message.id === 0);
    if (!explicitAttach) throw new Error("explicit attach response not received");
    const explicitSessionId = String((explicitAttach.result as { sessionId: string }).sessionId);

    send(1, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await flush();

    const attached = messages().filter((message) => message.method === "Target.attachedToTarget");
    const sessionId = String(attached.at(-1)?.params?.sessionId);
    expect(sessionId).toMatch(/^icdp-session-/);
    expect(sessionId).not.toBe(explicitSessionId);
    expect(received).toContainEqual({
      kind: "attach",
      sessionId,
      state: { enabledDomains: [], domainParams: {} },
    });

    send(2, "Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await flush();

    expect(messages()).toContainEqual({
      method: "Target.detachedFromTarget",
      params: { sessionId, targetId: "preview" },
    });
    expect(received.at(-1)).toEqual({ kind: "detach", sessionId });
    expect(received).not.toContainEqual({ kind: "detach", sessionId: explicitSessionId });
  });

  test("setAutoAttach rejects unsupported waiting and honors Target filters", async () => {
    const { host, received } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const send = (id: number, params: Record<string, unknown>) =>
      socket.message({
        kind: "clientMessage",
        clientId: "client-1",
        message: JSON.stringify({ id, method: "Target.setAutoAttach", params }),
      });
    const messages = () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);

    send(1, {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    send(2, {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "page", exclude: true }, {}],
    });
    send(3, {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{}],
    });
    send(4, {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{}],
    });
    await flush();

    expect(messages().find((message) => message.id === 1)?.error).toEqual({
      code: -32000,
      message: "waitForDebuggerOnStart is not supported",
    });
    expect(messages().find((message) => message.id === 2)?.result).toEqual({});
    expect(messages().find((message) => message.id === 3)?.error).toEqual({
      code: -32602,
      message: "Target filter should be empty when disabling auto-attach",
    });
    expect(messages().find((message) => message.id === 4)?.error).toEqual({
      code: -32602,
      message:
        'Filter should not simultaneously allow "tab" and "page", page targets are attached via tab targets',
    });
    expect(received.filter((message) => message.kind === "attach")).toEqual([]);
    expect(messages().filter((message) => message.method === "Target.attachedToTarget")).toEqual(
      [],
    );
  });

  test("invalid browser commands receive Chromium protocol errors", async () => {
    const { host } = await connect();
    const socket = new FakeSocket();
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ kind: "clients", clientIds: ["client-1"] });

    const sendRaw = (message: string) =>
      socket.message({ kind: "clientMessage", clientId: "client-1", message });
    sendRaw("{");
    sendRaw(JSON.stringify({ id: 2 }));
    sendRaw(
      JSON.stringify({
        id: 3,
        method: "Target.setAutoAttach",
        params: { autoAttach: true },
      }),
    );
    sendRaw(JSON.stringify({ id: 4, method: "NoSuch.domain" }));
    sendRaw('{"id":5,"id":6,"method":"Browser.getVersion"}');
    sendRaw('{"id":1.5,"method":"Browser.getVersion"}');
    sendRaw('{"id":7,"method":"Browser.getVersion","sessionId":"ghost","params":[]}');
    sendRaw('{"id":8,"method":"Browser.getVersion","unknown":true}');
    sendRaw('{"id":9,"method":"Browser.getVersion","params":null}');
    sendRaw(
      '{"id":10,"method":"Runtime.evaluate","sessionId":"ghost","params":{"expression":"1"}}',
    );
    sendRaw('{"id":11,"method":"Target.createTarget","params":{}}');
    sendRaw('{"id":12,"method":"Target.closeTarget","params":{"targetId":42}}');
    sendRaw('{"id":13,"method":"Target.closeTarget","params":{"targetId":"missing"}}');
    sendRaw(
      '{"id":14,"method":"Target.createTarget","params":{"url":"about:blank","width":"wide"}}',
    );
    sendRaw(
      '{"id":15,"method":"Target.setRemoteLocations","params":{"locations":[{"host":1,"port":"9222"}]}}',
    );
    await flush();

    const responses = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((message) => message.kind === "clientMessage")
      .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage);
    expect(responses.map((message) => message.error?.code)).toEqual([
      -32700,
      -32600,
      -32602,
      -32601,
      -32700,
      -32600,
      -32600,
      -32600,
      undefined,
      -32001,
      -32602,
      -32602,
      -32602,
      -32602,
      -32602,
    ]);
    expect(responses[0]).toEqual({
      error: { code: -32700, message: "Message must be valid JSON" },
    });
    expect(responses[1]).toEqual({
      id: 2,
      error: {
        code: -32600,
        message: "Message must have string 'method' property",
      },
    });
    expect(responses[4]).toEqual({
      id: 5,
      error: {
        code: -32700,
        message: "Message has duplicate property 'id'",
      },
    });
    expect(responses[5]).toEqual({
      error: {
        code: -32600,
        message: "Message must have integer 'id' property",
      },
    });
    expect(responses[6]).toEqual({
      id: 7,
      error: {
        code: -32600,
        message: "Message may have object 'params' property",
      },
    });
    expect(responses[7]).toEqual({
      id: 8,
      error: {
        code: -32600,
        message: "Message has property other than 'id', 'method', 'sessionId', 'params'",
      },
    });
    expect(responses[8]).toMatchObject({
      id: 9,
      result: { protocolVersion: "1.3" },
    });
    expect(responses[9]).toEqual({
      id: 10,
      error: {
        code: -32001,
        message: "Session with given id not found.",
      },
    });
    expect(responses[3]).toEqual({
      id: 4,
      error: {
        code: -32601,
        message: "'NoSuch.domain' wasn't found",
      },
    });
    expect(responses.slice(10, 15)).toEqual([
      {
        id: 11,
        error: {
          code: -32602,
          message: "Invalid parameters",
          data: "Failed to deserialize params.url - BINDINGS: mandatory field missing at position 8",
        },
      },
      {
        id: 12,
        error: {
          code: -32602,
          message: "Invalid parameters",
          data: "Failed to deserialize params.targetId - BINDINGS: string value expected at position 17",
        },
      },
      {
        id: 13,
        error: { code: -32602, message: "No target with given id found" },
      },
      {
        id: 14,
        error: {
          code: -32602,
          message: "Invalid parameters",
          data: "Failed to deserialize params.width - BINDINGS: int32 value expected at position 30",
        },
      },
      {
        id: 15,
        error: {
          code: -32602,
          message: "Invalid parameters",
          data: "Failed to deserialize params.locations.host - BINDINGS: string value expected at position 39",
        },
      },
    ]);
  });

  test("an old disconnect callback cannot clear a replacement uplink's Clients", async () => {
    const { host } = await connect();
    const sockets: FakeSocket[] = [];
    const openRelay = () =>
      host.connectRelay({
        url: "ws://relay.test/icdp/host",
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });

    const disconnectOld = openRelay();
    sockets[0]?.open();
    const disconnectCurrent = openRelay();
    sockets[1]?.open();
    sockets[1]?.message({ kind: "clients", clientIds: ["client-current"] });
    disconnectOld();

    expect(sockets[1]?.readyState).toBe(WebSocket.OPEN);
    sockets[1]?.message({
      kind: "clientMessage",
      clientId: "client-current",
      message: JSON.stringify({ id: 1, method: "Browser.getVersion" }),
    });
    await flush();
    expect(
      sockets[1]?.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.kind === "clientMessage")
        .map((envelope) => JSON.parse(String(envelope.message)) as CdpMessage),
    ).toContainEqual(expect.objectContaining({ id: 1, result: expect.any(Object) }));
    disconnectCurrent();
    expect(sockets[1]?.readyState).toBe(WebSocket.CLOSED);
    host.destroy();
  });

  test("replacing an uplink preserves same-Host Client Sessions", async () => {
    const { host, received } = await connect();
    const sockets: FakeSocket[] = [];
    const openRelay = () =>
      host.connectRelay({
        url: "ws://relay.test/icdp/host",
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });

    openRelay();
    sockets[0]?.open();
    sockets[0]?.message({ kind: "clients", clientIds: ["client-1"] });
    sockets[0]?.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: "preview", flatten: true },
      }),
    });
    await flush();
    const sessionId = received.findLast((message) => message.kind === "attach")?.sessionId;

    openRelay();
    expect(received.some((message) => message.kind === "detach")).toBe(false);
    sockets[1]?.open();
    sockets[1]?.message({ kind: "clients", clientIds: ["client-1"] });
    sockets[1]?.message({
      kind: "clientMessage",
      clientId: "client-1",
      message: JSON.stringify({
        id: 2,
        sessionId,
        method: "DOM.getDocument",
      }),
    });
    await flush();

    expect(received.at(-1)).toMatchObject({
      kind: "command",
      sessionId,
      method: "DOM.getDocument",
    });
  });

  test("a Relay policy close does not reconnect a superseded Host", async () => {
    const { win } = fakeWindow();
    const host = new IcdpHost(win);
    const sockets: FakeSocket[] = [];
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      reconnectDelayMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    sockets[0]?.open();

    sockets[0]?.close(1008, "replaced by a newer host");
    await flush();

    expect(sockets).toHaveLength(1);
    host.destroy();
  });

  test("an incompatible Relay protocol close does not reconnect forever", async () => {
    const { win } = fakeWindow();
    const host = new IcdpHost(win);
    const sockets: FakeSocket[] = [];
    host.connectRelay({
      url: "ws://relay.test/icdp/host",
      reconnectDelayMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    sockets[0]?.open();

    sockets[0]?.close(1002, "Incompatible host protocol");
    await flush();

    expect(sockets).toHaveLength(1);
    host.destroy();
  });
});

describe("target lifecycle hooks", () => {
  test("onCreateTarget pairs an iframe and resolves only once it connects", async () => {
    const { win, emit } = fakeWindow();
    const frame = fakeIframe();
    let seenParams: unknown;
    const host = new IcdpHost({
      window: win,
      onCreateTarget: (params) => {
        seenParams = params;
        host.pair(frame.iframe, { targetId: "tab-2", origins: [FRAME_ORIGIN] });
        return "tab-2";
      },
    });

    const pending = host.handleBrowserRequest("Target.createTarget", { url: `${FRAME_ORIGIN}/x` });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    // The Target is paired but not connected yet, so createTarget must not resolve.
    expect(settled).toBe(false);
    expect(host.targets().map((target) => target.targetId)).toContain("tab-2");

    emit({
      data: { icdp: "hello", v: 5, title: "Tab 2", url: `${FRAME_ORIGIN}/x` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });
    await expect(pending).resolves.toEqual({ targetId: "tab-2" });
    expect(seenParams).toEqual({ url: `${FRAME_ORIGIN}/x` });
  });

  test("createTarget ignores attached-state changes until the Frame handshake", async () => {
    const { win, emit } = fakeWindow();
    const frame = fakeIframe();
    const host = new IcdpHost({
      window: win,
      onCreateTarget: () => {
        host.pair(frame.iframe, { targetId: "not-ready", origins: [FRAME_ORIGIN] });
        return "not-ready";
      },
    });

    const pending = host.handleBrowserRequest("Target.createTarget", { url: "about:blank" });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await flush();

    const session = host.attach("not-ready");
    session.detach();
    await flush();
    expect(settled).toBe(false);

    emit({
      data: { icdp: "hello", v: 5, title: "Ready", url: `${FRAME_ORIGIN}/ready` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });
    await expect(pending).resolves.toEqual({ targetId: "not-ready" });
  });

  test("createTarget rejects if the new Target is destroyed before connecting", async () => {
    const { win } = fakeWindow();
    const frame = fakeIframe();
    const host = new IcdpHost({
      window: win,
      onCreateTarget: () => {
        host.pair(frame.iframe, { targetId: "doomed", origins: [FRAME_ORIGIN] });
        return "doomed";
      },
    });
    const pending = host.handleBrowserRequest("Target.createTarget", { url: "about:blank" });
    await flush();
    host.unpair("doomed");
    await expect(pending).rejects.toThrow("destroyed before connecting");
  });

  test("createTarget rejects when no handler is configured", async () => {
    const { win } = fakeWindow();
    const host = new IcdpHost({ window: win });
    await expect(
      host.handleBrowserRequest("Target.createTarget", { url: "about:blank" }),
    ).rejects.toThrow("not handled");
  });

  test("createTarget rejects and tears the Target down if it never connects", async () => {
    vi.useFakeTimers();
    try {
      const { win } = fakeWindow();
      const frame = fakeIframe();
      const host = new IcdpHost({
        window: win,
        onCreateTarget: () => {
          // Pair an iframe whose Frame Agent never sends "hello".
          host.pair(frame.iframe, { targetId: "slow", origins: [FRAME_ORIGIN] });
          return "slow";
        },
      });
      const pending = host.handleBrowserRequest("Target.createTarget", { url: "about:blank" });
      const rejected = expect(pending).rejects.toThrow(/did not connect within 10000ms/);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      // The zombie Target must not survive a failed createTarget.
      expect(host.targets().map((target) => target.targetId)).not.toContain("slow");
    } finally {
      vi.useRealTimers();
    }
  });

  test("createTarget resolves immediately when the Target is already connected", async () => {
    const { win, emit } = fakeWindow();
    const frame = fakeIframe();
    const host = new IcdpHost({
      window: win,
      onCreateTarget: () => {
        host.pair(frame.iframe, { targetId: "fast", origins: [FRAME_ORIGIN] });
        // Complete the handshake synchronously, before returning the id.
        emit({
          data: { icdp: "hello", v: 5, title: "Fast", url: `${FRAME_ORIGIN}/f` },
          origin: FRAME_ORIGIN,
          source: frame.contentWindow,
        });
        return "fast";
      },
    });
    await expect(
      host.handleBrowserRequest("Target.createTarget", { url: `${FRAME_ORIGIN}/f` }),
    ).resolves.toEqual({ targetId: "fast" });
  });

  test("onCloseTarget tears the Target down", async () => {
    const closed: string[] = [];
    const { host } = await connect({
      host: {
        onCloseTarget: (id) => {
          closed.push(id);
        },
      },
    });
    await expect(
      host.handleBrowserRequest("Target.closeTarget", { targetId: "preview" }),
    ).resolves.toEqual({ success: true });
    expect(closed).toEqual(["preview"]);
    expect(host.targets()).toEqual([]);
  });

  test("a throwing or rejecting onCloseTarget surfaces as a rejection", async () => {
    const { win } = fakeWindow();
    const syncFrame = fakeIframe();
    const sync = new IcdpHost({
      window: win,
      onCloseTarget: () => {
        throw new Error("still in use");
      },
    });
    sync.pair(syncFrame.iframe, { targetId: "preview", origins: "*" });
    await expect(
      sync.handleBrowserRequest("Target.closeTarget", { targetId: "preview" }),
    ).rejects.toThrow("still in use");

    const asyncFrame = fakeIframe();
    const async = new IcdpHost({
      window: win,
      onCloseTarget: () => Promise.reject(new Error("busy")),
    });
    async.pair(asyncFrame.iframe, { targetId: "preview", origins: "*" });
    await expect(
      async.handleBrowserRequest("Target.closeTarget", { targetId: "preview" }),
    ).rejects.toThrow("busy");
  });

  test("closeTarget rejects unknown Targets before invoking the hook", async () => {
    const { win } = fakeWindow();
    const close = vi.fn();
    const host = new IcdpHost({ window: win, onCloseTarget: close });

    await expect(
      host.handleBrowserRequest("Target.closeTarget", { targetId: "missing" }),
    ).rejects.toThrow("No target with given id found");
    expect(close).not.toHaveBeenCalled();
  });
});
