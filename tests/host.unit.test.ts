import { describe, expect, test } from "bun:test";

import { type FrameElementLike, IcdpHost, type WindowLike } from "../src/host/index.ts";

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

/** Pair an iframe and complete the handshake; returns the frame-side port. */
async function connect(options: { origins?: string[] | "*" } = {}) {
  const { win, emit } = fakeWindow();
  const host = new IcdpHost(win);
  const frame = fakeIframe();
  host.pair(frame.iframe, { targetId: "preview", origins: options.origins ?? [FRAME_ORIGIN] });

  emit({
    data: { icdp: "hello", v: 1, title: "App", url: `${FRAME_ORIGIN}/` },
    origin: FRAME_ORIGIN,
    source: frame.contentWindow,
  });

  const welcome = frame.posted.find((post) => (post.message as { icdp?: string }).icdp === "welcome");
  if (!welcome) throw new Error("no welcome posted");
  const framePort = welcome.transfer[0] as MessagePort;

  const received: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  framePort.onmessage = (event) => received.push(JSON.parse(String(event.data)));
  await flush();

  return { host, emit, frame, framePort, received };
}

describe("handshake", () => {
  test("pair() probes the iframe and reports a Target immediately", () => {
    const { win } = fakeWindow();
    const host = new IcdpHost(win);
    const frame = fakeIframe();
    host.pair(frame.iframe, { targetId: "preview", origins: "*" });
    expect((frame.posted[0]?.message as { icdp: string }).icdp).toBe("probe");
    expect(host.targets().map((target) => target.targetId)).toEqual(["preview"]);
  });

  test("hello from a non-allowlisted origin is ignored", () => {
    const { win, emit } = fakeWindow();
    const host = new IcdpHost(win);
    const frame = fakeIframe();
    host.pair(frame.iframe, { targetId: "preview", origins: [FRAME_ORIGIN] });
    emit({
      data: { icdp: "hello", v: 1, title: "Evil", url: "http://evil.test/" },
      origin: "http://evil.test",
      source: frame.contentWindow,
    });
    expect(frame.posted.some((post) => (post.message as { icdp?: string }).icdp === "welcome")).toBe(false);
  });

  test("hello from an unknown window is ignored", () => {
    const { win, emit } = fakeWindow();
    const host = new IcdpHost(win);
    const frame = fakeIframe();
    host.pair(frame.iframe, { targetId: "preview", origins: "*" });
    emit({
      data: { icdp: "hello", v: 1, title: "X", url: "http://x.test/" },
      origin: FRAME_ORIGIN,
      source: { not: "the iframe" },
    });
    expect(frame.posted.some((post) => (post.message as { icdp?: string }).icdp === "welcome")).toBe(false);
  });

  test("welcome transfers a port and updates target info", async () => {
    const { host } = await connect();
    expect(host.targets()).toEqual([{ targetId: "preview", title: "App", url: `${FRAME_ORIGIN}/` }]);
  });
});

describe("local sessions", () => {
  test("commands round-trip over the port", async () => {
    const { host, framePort, received } = await connect();
    const session = host.attach("preview");
    const pending = session.send("DOM.getDocument", { depth: 1 });
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe("DOM.getDocument");
    framePort.postMessage(JSON.stringify({ id: received[0]?.id, result: { root: { nodeId: 1 } } }));
    expect(await pending).toEqual({ root: { nodeId: 1 } });
  });

  test("frame errors reject the command promise", async () => {
    const { host, framePort, received } = await connect();
    const session = host.attach("preview");
    const pending = session.send("Page.navigate", { url: "http://other.test" });
    await flush();
    framePort.postMessage(JSON.stringify({ id: received[0]?.id, error: { code: -32000, message: "denied" } }));
    expect(pending).rejects.toThrow("denied");
  });

  test("events are broadcast to all attached sessions", async () => {
    const { host, framePort } = await connect();
    const seenA: string[] = [];
    const seenB: string[] = [];
    host.attach("preview").onEvent((method) => seenA.push(method));
    host.attach("preview").onEvent((method) => seenB.push(method));

    framePort.postMessage(JSON.stringify({ method: "Runtime.consoleAPICalled", params: { type: "log" } }));
    await flush();
    expect(seenA).toEqual(["Runtime.consoleAPICalled"]);
    expect(seenB).toEqual(["Runtime.consoleAPICalled"]);
  });

  test("command before the frame pairs fails fast", async () => {
    const { win } = fakeWindow();
    const host = new IcdpHost(win);
    const frame = fakeIframe();
    host.pair(frame.iframe, { targetId: "preview", origins: "*" });
    const session = host.attach("preview");
    expect(session.send("DOM.getDocument")).rejects.toThrow("not connected");
  });
});

describe("enable ref-counting", () => {
  test("disable is swallowed while another session still holds the domain", async () => {
    const { host, framePort, received } = await connect();
    const sessionA = host.attach("preview");
    const sessionB = host.attach("preview");

    const enables = [sessionA.send("Runtime.enable"), sessionB.send("Runtime.enable")];
    await flush();
    for (const command of received) framePort.postMessage(JSON.stringify({ id: command.id, result: {} }));
    await Promise.all(enables);

    const before = received.length;
    await sessionA.send("Runtime.disable");
    expect(received.length).toBe(before);

    const lastDisable = sessionB.send("Runtime.disable");
    await flush();
    expect(received.at(-1)?.method).toBe("Runtime.disable");
    framePort.postMessage(JSON.stringify({ id: received.at(-1)?.id, result: {} }));
    await lastDisable;
  });

  test("detach releases held domains, disabling those held last", async () => {
    const { host, framePort, received } = await connect();
    const session = host.attach("preview");
    const enable = session.send("Runtime.enable");
    await flush();
    framePort.postMessage(JSON.stringify({ id: received[0]?.id, result: {} }));
    await enable;

    session.detach();
    await flush();
    expect(received.at(-1)?.method).toBe("Runtime.disable");
  });
});

describe("pairing lifecycle", () => {
  test("a reload (second hello) fails in-flight commands and renews the channel", async () => {
    const { host, emit, frame, received } = await connect();
    const session = host.attach("preview");
    const pending = session.send("DOM.getDocument");
    await flush();
    expect(received).toHaveLength(1);

    emit({
      data: { icdp: "hello", v: 1, title: "App v2", url: `${FRAME_ORIGIN}/v2` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });

    expect(pending).rejects.toThrow("Target reloaded");
    expect(host.targets()[0]?.url).toBe(`${FRAME_ORIGIN}/v2`);
    const welcomes = frame.posted.filter((post) => (post.message as { icdp?: string }).icdp === "welcome");
    expect(welcomes).toHaveLength(2);
  });

  test("unpair destroys the Target and fails pending commands", async () => {
    const { host } = await connect();
    const events: string[] = [];
    host.onTargets((event) => events.push(event.kind));
    const session = host.attach("preview");
    const pending = session.send("DOM.getDocument");
    host.unpair("preview");
    expect(pending).rejects.toThrow("Target destroyed");
    expect(events).toContain("targetDestroyed");
  });
});
