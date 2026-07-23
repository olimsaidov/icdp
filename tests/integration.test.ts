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
  readonly closed: Promise<CloseEvent>;
  private opened: Promise<void>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve) => this.socket.addEventListener("open", () => resolve()));
    this.closed = new Promise((resolve) =>
      this.socket.addEventListener("close", resolve, { once: true }),
    );
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
  let framePort: MessagePort;
  const frameMessages: Array<{
    kind: "attach" | "detach" | "command";
    sessionId: string;
    id?: number;
    method?: string;
  }> = [];
  const { win, emit } = fakeWindow();
  const host = new IcdpHost({
    window: win,
    product: "icdp-e2e",
    onCloseTarget: () => {},
  });
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
      data: { icdp: "hello", v: 4, title: "App", url: `${FRAME_ORIGIN}/` },
      origin: FRAME_ORIGIN,
      source: frame.contentWindow,
    });
    const welcome = frame.posted.find(
      (post) => (post.message as { icdp?: string }).icdp === "welcome",
    );
    if (!welcome) throw new Error("no welcome posted");
    framePort = welcome.transfer[0] as MessagePort;
    framePort.onmessage = (event) => {
      const command = JSON.parse(String(event.data)) as {
        kind: "attach" | "detach" | "command";
        sessionId: string;
        id?: number;
        method?: string;
      };
      frameMessages.push(command);
      if (command.kind !== "command" || command.id === undefined) return;
      if (command.method === "DOM.getDocument") {
        framePort.postMessage(
          JSON.stringify({
            kind: "response",
            sessionId: command.sessionId,
            id: command.id,
            result: { root: { nodeId: 1 } },
          }),
        );
      } else {
        framePort.postMessage(
          JSON.stringify({
            kind: "response",
            sessionId: command.sessionId,
            id: command.id,
            result: {},
          }),
        );
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
      JSON.stringify({
        kind: "event",
        sessionId,
        method: "Runtime.consoleAPICalled",
        params: { type: "log" },
      }),
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
    expect(relay.hostPort).not.toBe(relay.browserPort);

    const hostDiscovery = await fetch(`http://127.0.0.1:${relay.hostPort}/json/version`);
    expect(hostDiscovery.status).toBe(404);

    const hostStatus = await fetch(`http://127.0.0.1:${relay.hostPort}/icdp/status`);
    expect(hostStatus.status).toBe(404);

    const version = (await (
      await fetch(`http://127.0.0.1:${relay.browserPort}/json/version`)
    ).json()) as {
      webSocketDebuggerUrl: string;
      Browser: string;
    };
    expect(version.Browser).toBe("icdp-e2e");
    expect(version.webSocketDebuggerUrl).toBe(relay.browserWsUrl);

    const list = (await (
      await fetch(`http://127.0.0.1:${relay.browserPort}/json/list`)
    ).json()) as Array<{
      id: string;
      webSocketDebuggerUrl: string;
    }>;
    expect(list[0]?.id).toBe("preview");
    expect(list[0]?.webSocketDebuggerUrl).toBe(
      `ws://127.0.0.1:${relay.browserPort}/devtools/page/preview`,
    );

    const beforeAttach = frameMessages.length;
    const direct = new TestClient(list[0]!.webSocketDebuggerUrl);
    cleanups.push(() => direct.close());
    const document = await direct.send("DOM.getDocument", { depth: 1 });
    expect(document).toEqual({ id: 1, result: { root: { nodeId: 1 } } });

    await until(
      () => frameMessages.slice(beforeAttach).some((message) => message.kind === "attach"),
      "direct target attachment",
    );
    const directSessionId = frameMessages
      .slice(beforeAttach)
      .find((message) => message.kind === "attach")?.sessionId;
    if (!directSessionId) throw new Error("direct target Session was not attached");

    framePort.postMessage(
      JSON.stringify({
        kind: "event",
        sessionId: directSessionId,
        method: "Runtime.consoleAPICalled",
        params: { type: "log" },
      }),
    );
    await until(
      () => direct.events.some((event) => event.method === "Runtime.consoleAPICalled"),
      "direct target event",
    );
    expect(direct.events.at(-1)).toEqual({
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
    });

    const missing = new WebSocket(`ws://127.0.0.1:${relay.browserPort}/devtools/page/missing`);
    const closed = new Promise<CloseEvent>((resolve) =>
      missing.addEventListener("close", resolve, { once: true }),
    );
    expect((await closed).code).toBe(1008);

    const nested = await direct.send("Target.attachToTarget", {
      targetId: "preview",
      flatten: true,
    });
    const nestedSessionId = String((nested.result as { sessionId: string }).sessionId);
    const closeOutcome = await Promise.race([
      direct
        .send("Target.closeTarget", { targetId: "preview" })
        .then((response) => ({ kind: "response" as const, response })),
      direct.closed.then(() => ({ kind: "closed" as const })),
    ]);
    expect(closeOutcome).toEqual({
      kind: "response",
      response: { id: 3, result: { success: true } },
    });
    expect((await direct.closed).code).toBe(1001);
    expect(direct.events.filter((message) => message.method === "Inspector.detached")).toEqual([
      {
        method: "Inspector.detached",
        params: { reason: "Render process gone." },
      },
      {
        method: "Inspector.detached",
        params: { reason: "Render process gone." },
        sessionId: nestedSessionId,
      },
      {
        method: "Inspector.detached",
        params: { reason: "target_closed" },
      },
    ]);
    expect(direct.events.some((message) => message.method === "Target.detachedFromTarget")).toBe(
      false,
    );
  });
});
