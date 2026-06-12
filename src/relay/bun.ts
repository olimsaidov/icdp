import type { Server, ServerWebSocket } from "bun";

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
  fallback?: (request: Request) => Response | Promise<Response>;
};

export type RelayServer = {
  core: RelayCore;
  server: Server<SocketData>;
  browserWsUrl: string;
  hostWsUrl: string;
  stop(): void;
};

type SocketData = { kind: "client" | "host" };

function asSocketLike(ws: ServerWebSocket<SocketData>): SocketLike {
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

/** Serve a Relay on Bun. One Host, many Clients, flat-session protocol only. */
export function serveRelay(options: ServeRelayOptions = {}): RelayServer {
  const hostname = options.hostname ?? "127.0.0.1";
  const browserPath = options.browserPath ?? "/devtools/browser";
  const hostPath = options.hostPath ?? "/icdp/host";

  // The SocketLike for each ws is created once and reused via this map, so the
  // core can compare connection identities.
  const socketLikes = new WeakMap<ServerWebSocket<SocketData>, SocketLike>();
  const wrap = (ws: ServerWebSocket<SocketData>): SocketLike => {
    let like = socketLikes.get(ws);
    if (!like) {
      like = asSocketLike(ws);
      socketLikes.set(ws, like);
    }
    return like;
  };

  const server = Bun.serve<SocketData>({
    hostname,
    port: options.port ?? 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      const upgrade = request.headers.get("upgrade")?.toLowerCase();
      if (process.env.ICDP_DEBUG === "1")
        console.log(`[icdp:http] ${request.method} ${url.pathname} upgrade=${upgrade ?? "-"}`);

      if (upgrade === "websocket") {
        if (url.pathname === browserPath && srv.upgrade(request, { data: { kind: "client" } })) return;
        if (url.pathname === hostPath && srv.upgrade(request, { data: { kind: "host" } })) return;
        return new Response("unknown websocket endpoint", { status: 404 });
      }

      if (url.pathname === "/json/version") return Response.json(relay.core.jsonVersion());
      if (url.pathname === "/json" || url.pathname === "/json/list") return Response.json(relay.core.jsonList());
      if (url.pathname === "/icdp/status") return Response.json(relay.core.status());
      if (options.fallback) return options.fallback(request);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "host") relay.core.hostConnected(wrap(ws));
        else relay.core.clientConnected(wrap(ws));
      },
      message(ws, frame) {
        const raw = typeof frame === "string" ? frame : new TextDecoder().decode(frame);
        if (process.env.ICDP_DEBUG === "1") console.log(`[icdp:${ws.data.kind}]`, raw.slice(0, 400));
        if (ws.data.kind === "host") relay.core.hostMessage(wrap(ws), raw);
        else relay.core.clientMessage(wrap(ws), raw);
      },
      close(ws) {
        if (ws.data.kind === "host") relay.core.hostDisconnected(wrap(ws));
        else relay.core.clientDisconnected(wrap(ws));
      },
    },
  });

  const browserWsUrl = `ws://${hostname}:${server.port}${browserPath}`;
  const core = new RelayCore({ product: options.product, browserWsUrl });

  const relay: RelayServer = {
    core,
    server,
    browserWsUrl,
    hostWsUrl: `ws://${hostname}:${server.port}${hostPath}`,
    stop: () => server.stop(true),
  };
  return relay;
}
