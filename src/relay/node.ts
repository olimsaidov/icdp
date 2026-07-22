import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import { type WebSocket, WebSocketServer } from "ws";

import { RelayCore, type SocketLike } from "./core.ts";

export type BindKind = "client" | "host";

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

export type AttachRelayOptions = {
  clientPath?: string | null;
  hostPath?: string | null;
};

export type AttachedRelay = {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  detach(): void;
};

// The SocketLike for each ws is created once and reused via this map, so the
// core can compare connection identities.
const socketLikes = new WeakMap<WebSocket, SocketLike>();

function asSocketLike(ws: WebSocket): SocketLike {
  let like = socketLikes.get(ws);
  if (!like) {
    like = {
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
    socketLikes.set(ws, like);
  }
  return like;
}

export function bindWebSocket(core: RelayCore, ws: WebSocket, kind: BindKind): void {
  const like = asSocketLike(ws);
  if (kind === "host") core.hostConnected(like);
  else core.clientConnected(like);
  ws.on("message", (data) => {
    const raw = data.toString();
    if (process.env.ICDP_DEBUG === "1") console.log(`[icdp:${kind}]`, raw.slice(0, 400));
    if (kind === "host") core.hostMessage(like, raw);
    else core.clientMessage(like, raw);
  });
  ws.on("close", () => {
    if (kind === "host") core.hostDisconnected(like);
    else core.clientDisconnected(like);
  });
  ws.on("error", () => ws.close());
}

export function handleDiscoveryRequest(
  core: RelayCore,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const pathname = new URL(request.url ?? "/", "http://relay").pathname;
  if (pathname === "/json/version") {
    sendJson(response, core.jsonVersion());
    return true;
  }
  if (pathname === "/json" || pathname === "/json/list") {
    sendJson(response, core.jsonList());
    return true;
  }
  if (pathname === "/icdp/status") {
    sendJson(response, core.status());
    return true;
  }
  return false;
}

export function attachRelay(core: RelayCore, options: AttachRelayOptions = {}): AttachedRelay {
  const clientPath =
    options.clientPath === null ? null : (options.clientPath ?? "/devtools/browser");
  const hostPath = options.hostPath === null ? null : (options.hostPath ?? "/icdp/host");
  const wss = new WebSocketServer({ noServer: true });
  let detached = false;

  return {
    handleUpgrade(request, socket, head) {
      if (detached) return false;
      const pathname = new URL(request.url ?? "/", "http://relay").pathname;
      const kind: BindKind | null =
        pathname === clientPath ? "client" : pathname === hostPath ? "host" : null;
      if (!kind) return false;
      if (process.env.ICDP_DEBUG === "1") console.log(`[icdp:${kind}:http] UPGRADE ${pathname}`);
      wss.handleUpgrade(request, socket as Socket, head, (ws) => bindWebSocket(core, ws, kind));
      return true;
    },
    detach() {
      detached = true;
      for (const ws of wss.clients) ws.terminate();
      wss.close();
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

function rejectUnhandled(kind: BindKind, attachment: () => AttachedRelay | null) {
  return (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (attachment()?.handleUpgrade(request, socket, head)) return;
    if (process.env.ICDP_DEBUG === "1")
      console.log(`[icdp:${kind}:http] UPGRADE ${request.url} (reject)`);
    socket.destroy();
  };
}

/** Serve a Relay on Node. One Host uplink server, one Client CDP server. */
export async function serveRelay(options: ServeRelayOptions = {}): Promise<RelayServer> {
  const browserHostname = options.browserHostname ?? "127.0.0.1";
  const hostHostname = options.hostHostname ?? "127.0.0.1";
  const browserPath = options.browserPath ?? "/devtools/browser";
  const hostPath = options.hostPath ?? "/icdp/host";
  let core: RelayCore | null = null;
  let clientAttachment: AttachedRelay | null = null;
  let hostAttachment: AttachedRelay | null = null;

  const browserServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${browserHostname}`);
    if (process.env.ICDP_DEBUG === "1")
      console.log(`[icdp:browser:http] ${request.method} ${url.pathname}`);

    if (!core || !handleDiscoveryRequest(core, request, response)) return notFound(response);
  });

  const hostServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${hostHostname}`);
    if (process.env.ICDP_DEBUG === "1")
      console.log(`[icdp:host:http] ${request.method} ${url.pathname}`);

    if (options.fallback) return options.fallback(request, response);
    return notFound(response);
  });

  browserServer.on(
    "upgrade",
    rejectUnhandled("client", () => clientAttachment),
  );
  hostServer.on(
    "upgrade",
    rejectUnhandled("host", () => hostAttachment),
  );

  let browserPort = 0;
  let hostPort = 0;
  try {
    browserPort = await listen(browserServer, options.browserPort ?? 0, browserHostname);
    const browserWsUrl =
      options.browserWsUrl ?? `ws://${browserHostname}:${browserPort}${browserPath}`;
    core = new RelayCore({ product: options.product, browserWsUrl });
    clientAttachment = attachRelay(core, { clientPath: browserPath, hostPath: null });
    hostAttachment = attachRelay(core, { clientPath: null, hostPath });
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
        clientAttachment?.detach();
        hostAttachment?.detach();
        await Promise.all([closeServer(browserServer), closeServer(hostServer)]);
      },
    };
  } catch (error) {
    clientAttachment?.detach();
    hostAttachment?.detach();
    await Promise.allSettled([closeServer(browserServer), closeServer(hostServer)]);
    throw error;
  }
}
