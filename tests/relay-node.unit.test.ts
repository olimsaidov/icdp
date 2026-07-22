import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, test } from "vitest";

import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { RelayCore } from "../src/relay/core.ts";
import { attachRelay, handleDiscoveryRequest } from "../src/relay/node.ts";

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

describe("attachRelay", () => {
  test("serves a CDP Client and discovery on an existing http server", async () => {
    const core = new RelayCore({ product: "attach-test", browserWsUrl: "ws://advertised" });
    const server = createServer((request, response) => {
      if (handleDiscoveryRequest(core, request, response)) return;
      response.writeHead(200);
      response.end("app");
    });
    const attached = attachRelay(core, { server });
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
    const attached = attachRelay(core, { server });
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

  test("leaves upgrades for other paths to other listeners", async () => {
    const core = new RelayCore({ product: "attach-test", browserWsUrl: "ws://advertised" });
    const server = createServer();
    const attached = attachRelay(core, { server });
    let foreign = "";
    server.on("upgrade", (request, socket) => {
      if (!request.url?.startsWith("/other/")) return;
      foreign = request.url;
      socket.destroy();
    });
    const port = await listen(server);

    try {
      await new Promise<void>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/other/ws`);
        socket.onerror = () => resolve();
        socket.onclose = () => resolve();
      });
      expect(foreign).toBe("/other/ws");

      const host = await connect(`ws://127.0.0.1:${port}/icdp/host`);
      await until(() => core.status().hostConnected, "host connection");
      host.close();
    } finally {
      attached.detach();
      await stop(server);
    }
  });

  test("manual handleUpgrade composition with null paths disabling a role", async () => {
    const core = new RelayCore({ product: "attach-test", browserWsUrl: "ws://advertised" });
    const attached = attachRelay(core, { clientPath: null });
    const server = createServer();
    let unhandled = "";
    server.on("upgrade", (request, socket, head) => {
      if (attached.handleUpgrade(request, socket, head)) return;
      unhandled = request.url ?? "";
      socket.destroy();
    });
    const port = await listen(server);

    try {
      await new Promise<void>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser`);
        socket.onerror = () => resolve();
        socket.onclose = () => resolve();
      });
      expect(unhandled).toBe("/devtools/browser");

      const host = await connect(`ws://127.0.0.1:${port}/icdp/host`);
      await until(() => core.status().hostConnected, "host connection");
      host.close();
    } finally {
      attached.detach();
      await stop(server);
    }
  });

  test("detach unregisters the listener and terminates accepted sockets", async () => {
    const core = new RelayCore({ product: "attach-test", browserWsUrl: "ws://advertised" });
    const server = createServer();
    const attached = attachRelay(core, { server });
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

      let orphaned = "";
      server.on("upgrade", (request, socket) => {
        orphaned = request.url ?? "";
        socket.destroy();
      });
      await new Promise<void>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/icdp/host`);
        socket.onerror = () => resolve();
        socket.onclose = () => resolve();
      });
      expect(orphaned).toBe("/icdp/host");
      expect(core.status().hostConnected).toBe(false);
    } finally {
      await stop(server);
    }
  });
});
