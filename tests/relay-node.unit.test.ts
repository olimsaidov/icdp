import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, test } from "vitest";

import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { RelayCore } from "../src/relay/core.ts";
import { type AttachedRelay, attachRelay, handleDiscoveryRequest } from "../src/relay/node.ts";

async function until(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error(`failed to connect ${url}`));
  });
}

function rejected(url: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.onerror = () => resolve();
    socket.onclose = () => resolve();
  });
}

function dispatch(
  server: Server,
  attached: AttachedRelay,
  unclaimed?: (url: string) => void,
): void {
  server.on("upgrade", (request, socket, head) => {
    if (attached.handleUpgrade(request, socket, head)) return;
    unclaimed?.(request.url ?? "");
    socket.destroy();
  });
}

describe("attachRelay", () => {
  test("serves a CDP Client and discovery on an existing http server", async () => {
    const core = new RelayCore({ product: "attach-test", browserWsUrl: "ws://advertised" });
    const server = createServer((request, response) => {
      if (handleDiscoveryRequest(core, request, response)) return;
      response.writeHead(200);
      response.end("app");
    });
    const attached = attachRelay(core);
    dispatch(server, attached);
    const port = await listen(server);

    try {
      const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
        Browser: string;
        webSocketDebuggerUrl: string;
      };
      expect(version.Browser).toBe("attach-test");
      expect(version.webSocketDebuggerUrl).toBe("ws://advertised");

      const status = (await (await fetch(`http://127.0.0.1:${port}/icdp/status`)).json()) as {
        hostConnected: boolean;
      };
      expect(status.hostConnected).toBe(false);

      const passthrough = await (await fetch(`http://127.0.0.1:${port}/anything-else`)).text();
      expect(passthrough).toBe("app");

      const client = await connect(`ws://127.0.0.1:${port}/devtools/browser`);
      const reply = new Promise<{ id: number; result: { targetInfos: unknown[] } }>((resolve) => {
        client.onmessage = (event) => resolve(JSON.parse(String(event.data)));
      });
      client.send(JSON.stringify({ id: 1, method: "Target.getTargets", params: {} }));
      expect((await reply).result.targetInfos).toEqual([]);
      client.close();
    } finally {
      attached.detach();
      await stop(server);
    }
  });

  test("registers the Host bridge with the core", async () => {
    const core = new RelayCore({ product: "attach-test", browserWsUrl: "ws://advertised" });
    const server = createServer();
    const attached = attachRelay(core);
    dispatch(server, attached);
    const port = await listen(server);

    try {
      const host = await connect(`ws://127.0.0.1:${port}/icdp/host`);
      await until(() => core.status().hostConnected, "host connection");
      host.send(JSON.stringify({ kind: "ready", v: PROTOCOL_VERSION, targets: [], handles: [] }));
      host.close();
      await until(() => !core.status().hostConnected, "host disconnection");
    } finally {
      attached.detach();
      await stop(server);
    }
  });

  test("declines upgrades for other paths so the dispatcher can route them", async () => {
    const core = new RelayCore({ product: "attach-test", browserWsUrl: "ws://advertised" });
    const server = createServer();
    const attached = attachRelay(core);
    let unclaimed = "";
    dispatch(server, attached, (url) => {
      unclaimed = url;
    });
    const port = await listen(server);

    try {
      await rejected(`ws://127.0.0.1:${port}/other/ws`);
      expect(unclaimed).toBe("/other/ws");

      const host = await connect(`ws://127.0.0.1:${port}/icdp/host`);
      await until(() => core.status().hostConnected, "host connection");
      host.close();
    } finally {
      attached.detach();
      await stop(server);
    }
  });

  test("null paths disable a role", async () => {
    const core = new RelayCore({ product: "attach-test", browserWsUrl: "ws://advertised" });
    const server = createServer();
    const attached = attachRelay(core, { clientPath: null });
    let unclaimed = "";
    dispatch(server, attached, (url) => {
      unclaimed = url;
    });
    const port = await listen(server);

    try {
      await rejected(`ws://127.0.0.1:${port}/devtools/browser`);
      expect(unclaimed).toBe("/devtools/browser");

      const host = await connect(`ws://127.0.0.1:${port}/icdp/host`);
      await until(() => core.status().hostConnected, "host connection");
      host.close();
    } finally {
      attached.detach();
      await stop(server);
    }
  });

  test("detach terminates accepted sockets and declines further upgrades", async () => {
    const core = new RelayCore({ product: "attach-test", browserWsUrl: "ws://advertised" });
    const server = createServer();
    const attached = attachRelay(core);
    let unclaimed = "";
    dispatch(server, attached, (url) => {
      unclaimed = url;
    });
    const port = await listen(server);

    try {
      const host = await connect(`ws://127.0.0.1:${port}/icdp/host`);
      await until(() => core.status().hostConnected, "host connection");

      const closed = new Promise<void>((resolve) => {
        host.onclose = () => resolve();
      });
      attached.detach();
      await closed;
      await until(() => !core.status().hostConnected, "host disconnection");

      await rejected(`ws://127.0.0.1:${port}/icdp/host`);
      expect(unclaimed).toBe("/icdp/host");
      expect(core.status().hostConnected).toBe(false);
    } finally {
      await stop(server);
    }
  });
});
