import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

import { RelayCore, type SocketLike } from "./core.ts";

export type ServeRelayOptions = {
  port?: number;
  hostname?: string;
  product?: string;
  /** Path Clients connect to. Advertised by /json/version. */
  browserPath?: string;
  /** Path the Host bridge connects to. */
  hostPath?: string;
  /** Handles requests the relay doesn't own (anything but its WS + /json + /icdp paths). */
  fallback?: (request: IncomingMessage, response: ServerResponse) => void;
};

export type RelayServer = {
  core: RelayCore;
  server: Server;
  port: number;
  browserWsUrl: string;
  hostWsUrl: string;
  stop(): Promise<void>;
};

function asSocketLike(ws: WebSocket): SocketLike {
  return {
    send: (data) => {
      try {
        ws.send(data);
      } catch {}
    },
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {}
    },
  };
}

function sendJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

/** Serve a Relay on Node. One Host, many Clients, flat-session protocol only. */
export async function serveRelay(options: ServeRelayOptions = {}): Promise<RelayServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const browserPath = options.browserPath ?? "/devtools/browser";
  const hostPath = options.hostPath ?? "/icdp/host";

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${hostname}`);
    if (process.env.ICDP_DEBUG === "1")
      console.log(`[icdp:http] ${request.method} ${url.pathname}`);

    if (url.pathname === "/json/version") return sendJson(response, core.jsonVersion());
    if (url.pathname === "/json" || url.pathname === "/json/list")
      return sendJson(response, core.jsonList());
    if (url.pathname === "/icdp/status") return sendJson(response, core.status());
    if (options.fallback) return options.fallback(request, response);
    response.writeHead(404);
    response.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  // The SocketLike for each ws is created once and reused via this map, so the
  // core can compare connection identities.
  const socketLikes = new WeakMap<WebSocket, SocketLike>();
  const wrap = (ws: WebSocket): SocketLike => {
    let like = socketLikes.get(ws);
    if (!like) {
      like = asSocketLike(ws);
      socketLikes.set(ws, like);
    }
    return like;
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${hostname}`);
    const kind =
      url.pathname === browserPath ? "client" : url.pathname === hostPath ? "host" : null;
    if (process.env.ICDP_DEBUG === "1")
      console.log(`[icdp:http] UPGRADE ${url.pathname} -> ${kind ?? "reject"}`);
    if (!kind) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket as Socket, head, (ws) => {
      if (kind === "host") core.hostConnected(wrap(ws));
      else core.clientConnected(wrap(ws));
      ws.on("message", (data) => {
        const raw = data.toString();
        if (process.env.ICDP_DEBUG === "1") console.log(`[icdp:${kind}]`, raw.slice(0, 400));
        if (kind === "host") core.hostMessage(wrap(ws), raw);
        else core.clientMessage(wrap(ws), raw);
      });
      ws.on("close", () => {
        if (kind === "host") core.hostDisconnected(wrap(ws));
        else core.clientDisconnected(wrap(ws));
      });
      ws.on("error", () => ws.close());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("relay server has no TCP address");
  const port = address.port;

  const browserWsUrl = `ws://${hostname}:${port}${browserPath}`;
  const core = new RelayCore({ product: options.product, browserWsUrl });

  return {
    core,
    server,
    port,
    browserWsUrl,
    hostWsUrl: `ws://${hostname}:${port}${hostPath}`,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
