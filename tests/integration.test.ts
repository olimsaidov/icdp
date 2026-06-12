import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type FrameElementLike, IcdpHost, type WindowLike } from "../src/host/index.ts";
import type { CdpMessage } from "../src/protocol.ts";
import { type RelayServer, serveRelay } from "../src/relay/node.ts";

const FRAME_ORIGIN = "http://app.test";

async function until(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

function fakeIframe() {
  const posted: Array<{ message: unknown; transfer: Transferable[] }> = [];
  const contentWindow = {
    postMessage(message: unknown, _targetOrigin: string, transfer: Transferable[] = []) {
      posted.push({ message, transfer });
    },
  };
  const iframe: FrameElementLike = {
    contentWindow,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { iframe, posted, contentWindow };
}

/** A minimal CDP client over a real WebSocket. */
class TestClient {
  private socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, (message: CdpMessage) => void>();
  readonly events: CdpMessage[] = [];
  private opened: Promise<void>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve) => this.socket.addEventListener("open", () => resolve()));
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id != null) {
        const settle = this.pending.get(Number(message.id));
        this.pending.delete(Number(message.id));
        settle?.(message);
      } else {
        this.events.push(message);
      }
    });
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<CdpMessage> {
    await this.opened;
    const id = this.nextId++;
    const response = new Promise<CdpMessage>((resolve) => this.pending.set(id, resolve));
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return response;
  }

  close(): void {
    this.socket.close();
  }
}

describe("relay + host + frame, end to end", () => {
  let relay: RelayServer;
  const { win, emit } = fakeWindow();
  const host = new IcdpHost(win);
  const frame = fakeIframe();
  const cleanups: Array<() => unknown> = [() => host.destroy()];

  beforeAll(async () => {
    relay = await serveRelay({ product: "icdp-e2e" });
    cleanups.push(() => relay.stop());
  });

  afterAll(async () => {
    for (const cleanup of cleanups.toReversed()) await cleanup();
  });

  test("full command round-trip from a WebSocket client to the frame", async () => {
    host.pair(frame.iframe, { targetId: "preview", origins: [FRAME_ORIGIN] });
    emit({
      data: { icdp: "hello", v: 1, title: "App", url: `${FRAME_ORIGIN}/` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });
    const welcome = frame.posted.find(
      (post) => (post.message as { icdp?: string }).icdp === "welcome",
    );
    if (!welcome) throw new Error("no welcome posted");
    const framePort = welcome.transfer[0] as MessagePort;
    framePort.onmessage = (event) => {
      const command = JSON.parse(String(event.data)) as { id: number; method: string };
      if (command.method === "DOM.getDocument") {
        framePort.postMessage(JSON.stringify({ id: command.id, result: { root: { nodeId: 1 } } }));
      } else {
        framePort.postMessage(JSON.stringify({ id: command.id, result: {} }));
      }
    };

    const disconnect = host.connectRelay({ url: relay.hostWsUrl });
    cleanups.push(disconnect);
    await until(
      () => relay.core.status().hostConnected && relay.core.status().targets.length === 1,
      "host uplink",
    );

    const client = new TestClient(relay.browserWsUrl);
    cleanups.push(() => client.close());

    const version = await client.send("Browser.getVersion");
    expect((version.result as { product: string }).product).toBe("icdp-e2e");

    const targets = await client.send("Target.getTargets");
    const targetInfos = (
      targets.result as { targetInfos: Array<{ targetId: string; url: string }> }
    ).targetInfos;
    expect(targetInfos).toHaveLength(1);
    expect(targetInfos[0]?.targetId).toBe("preview");

    const attached = await client.send("Target.attachToTarget", {
      targetId: "preview",
      flatten: true,
    });
    const sessionId = (attached.result as { sessionId: string }).sessionId;
    expect(sessionId).toMatch(/^icdp-session-/);

    const document = await client.send("DOM.getDocument", { depth: 1 }, sessionId);
    expect(document.result).toEqual({ root: { nodeId: 1 } });
    expect(document.sessionId).toBe(sessionId);

    // Frame events reach the client tagged with its sessionId.
    framePort.postMessage(
      JSON.stringify({ method: "Runtime.consoleAPICalled", params: { type: "log" } }),
    );
    await until(
      () => client.events.some((event) => event.method === "Runtime.consoleAPICalled"),
      "console event",
    );
    const consoleEvent = client.events.find((event) => event.method === "Runtime.consoleAPICalled");
    expect(consoleEvent?.sessionId).toBe(sessionId);

    // A local session sees the same target without the relay in the path.
    const local = host.attach("preview");
    expect(await local.send("DOM.getDocument", { depth: 1 })).toEqual({ root: { nodeId: 1 } });
  });

  test("HTTP discovery endpoints describe the browser endpoint", async () => {
    const version = (await (await fetch(`http://127.0.0.1:${relay.port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
      Browser: string;
    };
    expect(version.Browser).toBe("icdp-e2e");
    expect(version.webSocketDebuggerUrl).toBe(relay.browserWsUrl);

    const list = (await (await fetch(`http://127.0.0.1:${relay.port}/json/list`)).json()) as Array<{
      id: string;
      webSocketDebuggerUrl: string;
    }>;
    expect(list[0]?.id).toBe("preview");
    expect(list[0]?.webSocketDebuggerUrl).toBe(relay.browserWsUrl);
  });
});
