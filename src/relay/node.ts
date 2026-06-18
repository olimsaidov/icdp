import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { type WebSocket, WebSocketServer } from "ws";

import { RelayCore, type SocketLike } from "./core.ts";

export type ServeRelayOptions = {
  browserPort?: number;
  browserHostname?: string;
  hostPort?: number;
  hostHostname?: string;
  product?: string;
  /** Path Clients connect to. Advertised by /json/version. */
  browserPath?: string;
  /** Path the Host bridge connects to. */
  hostPath?: string;
  /** Advertised Client endpoint. Defaults to the bound browser host/port/path. */
  browserWsUrl?: string;
  /** Host uplink endpoint. Defaults to the bound host host/port/path. */
  hostWsUrl?: string;
  /** Handles non-WebSocket requests on the Host server. */
  fallback?: (request: IncomingMessage, response: ServerResponse) => void;
};

export type RelayServer = {
  core: RelayCore;
  browserServer: Server;
  hostServer: Server;
  browserPort: number;
  hostPort: number;
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

function notFound(response: ServerResponse): void {
  response.writeHead(404);
  response.end("not found");
}

async function listen(server: Server, port: number, hostname: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("relay server has no TCP address");
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Serve a Relay on Node. One Host uplink server, one Client CDP server. */
export async function serveRelay(options: ServeRelayOptions = {}): Promise<RelayServer> {
  const browserHostname = options.browserHostname ?? "127.0.0.1";
  const hostHostname = options.hostHostname ?? "127.0.0.1";
  const browserPath = options.browserPath ?? "/devtools/browser";
  const hostPath = options.hostPath ?? "/icdp/host";
  let core: RelayCore | null = null;

  const browserServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${browserHostname}`);
    if (process.env.ICDP_DEBUG === "1")
      console.log(`[icdp:browser:http] ${request.method} ${url.pathname}`);

    if (!core) return notFound(response);
    if (url.pathname === "/json/version") return sendJson(response, core.jsonVersion());
    if (url.pathname === "/json" || url.pathname === "/json/list")
      return sendJson(response, core.jsonList());
    if (url.pathname === "/icdp/status") return sendJson(response, core.status());
    return notFound(response);
  });

  const hostServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${hostHostname}`);
    if (process.env.ICDP_DEBUG === "1")
      console.log(`[icdp:host:http] ${request.method} ${url.pathname}`);

    if (options.fallback) return options.fallback(request, response);
    return notFound(response);
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

  const handleUpgrade = (
    kind: "client" | "host",
    expectedPath: string,
    hostname: string,
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    const url = new URL(request.url ?? "/", `http://${hostname}`);
    if (process.env.ICDP_DEBUG === "1") console.log(`[icdp:${kind}:http] UPGRADE ${url.pathname}`);
    if (url.pathname !== expectedPath || !core) {
      socket.destroy();
      return;
    }
    const activeCore = core;
    wss.handleUpgrade(request, socket as Socket, head, (ws) => {
      if (kind === "host") activeCore.hostConnected(wrap(ws));
      else activeCore.clientConnected(wrap(ws));
      ws.on("message", (data) => {
        const raw = data.toString();
        if (process.env.ICDP_DEBUG === "1") console.log(`[icdp:${kind}]`, raw.slice(0, 400));
        if (kind === "host") activeCore.hostMessage(wrap(ws), raw);
        else activeCore.clientMessage(wrap(ws), raw);
      });
      ws.on("close", () => {
        if (kind === "host") activeCore.hostDisconnected(wrap(ws));
        else activeCore.clientDisconnected(wrap(ws));
      });
      ws.on("error", () => ws.close());
    });
  };

  browserServer.on("upgrade", (request, socket, head) =>
    handleUpgrade("client", browserPath, browserHostname, request, socket as Socket, head),
  );
  hostServer.on("upgrade", (request, socket, head) =>
    handleUpgrade("host", hostPath, hostHostname, request, socket as Socket, head),
  );

  let browserPort = 0;
  let hostPort = 0;
  try {
    browserPort = await listen(browserServer, options.browserPort ?? 0, browserHostname);
    const browserWsUrl =
      options.browserWsUrl ?? `ws://${browserHostname}:${browserPort}${browserPath}`;
    core = new RelayCore({ product: options.product, browserWsUrl });
    hostPort = await listen(hostServer, options.hostPort ?? 0, hostHostname);
    const hostWsUrl = options.hostWsUrl ?? `ws://${hostHostname}:${hostPort}${hostPath}`;

    return {
      core,
      browserServer,
      hostServer,
      browserPort,
      hostPort,
      browserWsUrl,
      hostWsUrl,
      stop: async () => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        await Promise.all([closeServer(browserServer), closeServer(hostServer)]);
      },
    };
  } catch (error) {
    await Promise.allSettled([closeServer(browserServer), closeServer(hostServer)]);
    throw error;
  }
}
