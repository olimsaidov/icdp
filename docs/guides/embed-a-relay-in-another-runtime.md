---
description: "Use the runtime-agnostic RelayCore to serve a Relay on Deno, Bun, Cloudflare Workers, or any non-Node host."
---

# Embed a Relay in another runtime

You are not on Node and you want to expose a Chrome-compatible CDP endpoint that external [Clients](/explanation/concepts) attach to. The shipped [`serveRelay`](/reference/relay) adapter is built on `node:http` and `ws`, so it will not run on Deno, Bun, Cloudflare Workers, or an existing server you cannot replace.

`RelayCore` from `@olimsaidov/icdp/relay` carries all of the protocol logic with no I/O of its own. You bring the WebSocket and HTTP server; the core does the rest. This guide wires `RelayCore` into an arbitrary runtime.

::: info Prerequisites
This guide assumes you have already stood up a [Relay](/guides/run-a-relay) on Node and understand the topology. It only covers replacing the transport adapter.
:::

## What the core needs from you

`RelayCore` is runtime-agnostic. It never opens a socket or binds a port. You feed it two things:

1. **A `SocketLike` per WebSocket connection** — a minimal handle the core calls to send frames and close the socket.
2. **Adapter calls on the connection lifecycle** — open, message, close, separated by whether the peer is a [Host](/explanation/concepts) or a [Client](/explanation/concepts).

The `SocketLike` surface is just two methods:

```ts
type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
```

The core compares connections by `SocketLike` identity (for example, new-wins Host takeover). Create exactly one `SocketLike` per underlying WebSocket and reuse it for every call about that connection — do not allocate a fresh wrapper each time.

## Construct the core

```ts
import { RelayCore } from "@olimsaidov/icdp/relay";

const core = new RelayCore({
  // The absolute ws:// URL Clients will dial. Reported by /json/version
  // and /json/list so discovery tools know where to attach.
  browserWsUrl: "ws://127.0.0.1:9222/devtools/browser",
});
```

`RelayCoreOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `browserWsUrl` | `""` | Absolute `ws://` URL of the browser endpoint, echoed into the `/json` payloads. |
| `product` | `"icdp/0.1"` | Reported by `Browser.getVersion` and `/json/version`. |
| `browserRequestTimeoutMs` | `30000` | How long to wait for the Host to answer a forwarded browser-level request before failing the Client. |

Set `browserWsUrl` to the URL a Client actually reaches, including the path you serve the WebSocket upgrade on. It is data the core hands back in discovery payloads, not something it connects to.

## Wire the adapter methods

For each incoming WebSocket, decide whether the peer is a Host or a Client (by the upgrade path — see below), wrap it in a `SocketLike`, and forward its lifecycle to the matching trio of methods.

Host connection (the bridge uplink from [`IcdpHost`](/reference/host)):

```ts
core.hostConnected(socket);            // on open
core.hostMessage(socket, raw);         // on each text frame (raw is a JSON string)
core.hostDisconnected(socket);         // on close
```

Client connection (an external CDP tool):

```ts
core.clientConnected(socket);          // on open
core.clientMessage(socket, raw);       // on each text frame
core.clientDisconnected(socket);       // on close
```

`raw` is the WebSocket frame as a string. The core parses the JSON itself and ignores anything it cannot parse, so you do not pre-decode or validate. These six methods, plus the three HTTP payload builders below, are the entire adapter contract; do not reach for any other core members.

::: tip One Host, new-wins
`hostConnected` enforces the single-Host rule for you. If a Host is already attached, the previous one is dropped with close code `1008` and its [Targets](/explanation/concepts) are cleared. You do not track Host identity yourself — just route every host-path upgrade through `hostConnected`.
:::

## Serve the HTTP discovery routes

Discovery clients (and `chrome-remote-interface`, agent-browser) hit plain HTTP before they open a socket. The core builds each payload; you serialize it as JSON. See [HTTP endpoints](/reference/http-endpoints) for the full route list and response shapes.

| Route | Body |
| --- | --- |
| `GET /json/version` | `core.jsonVersion()` |
| `GET /json` and `GET /json/list` | `core.jsonList()` |
| `GET /icdp/status` | `core.status()` |

Each returns a plain object (or array) — `JSON.stringify` it with `Content-Type: application/json`. Anything else is your application's to handle, or a `404`.

## Worked example: a fetch-style runtime

Deno, Bun, and Cloudflare Workers all expose a `fetch` handler with a WebSocket upgrade. The shape is the same on each; this is the skeleton.

```ts
import { RelayCore, type SocketLike } from "@olimsaidov/icdp/relay";

const BROWSER_PATH = "/devtools/browser";
const HOST_PATH = "/icdp/host";

const core = new RelayCore({
  browserWsUrl: "ws://127.0.0.1:9222/devtools/browser",
});

// One SocketLike per live WebSocket, reused for identity.
const sockets = new WeakMap<WebSocket, SocketLike>();
function wrap(ws: WebSocket): SocketLike {
  let like = sockets.get(ws);
  if (!like) {
    like = {
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    };
    sockets.set(ws, like);
  }
  return like;
}

function handleSocket(ws: WebSocket, kind: "host" | "client") {
  const socket = wrap(ws);
  if (kind === "host") core.hostConnected(socket);
  else core.clientConnected(socket);

  ws.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : "";
    if (kind === "host") core.hostMessage(socket, raw);
    else core.clientMessage(socket, raw);
  });
  ws.addEventListener("close", () => {
    if (kind === "host") core.hostDisconnected(socket);
    else core.clientDisconnected(socket);
  });
}

function handle(request: Request): Response {
  const url = new URL(request.url);

  // HTTP discovery.
  if (url.pathname === "/json/version") return json(core.jsonVersion());
  if (url.pathname === "/json" || url.pathname === "/json/list") return json(core.jsonList());
  if (url.pathname === "/icdp/status") return json(core.status());

  // WebSocket upgrades: browser path -> Client, host path -> Host.
  const kind =
    url.pathname === BROWSER_PATH ? "client" : url.pathname === HOST_PATH ? "host" : null;
  if (kind && request.headers.get("upgrade") === "websocket") {
    // Replace this with your runtime's upgrade call (Deno.upgradeWebSocket,
    // Bun's server.upgrade, the WebSocketPair in Workers, ...).
    const { socket, response } = upgrade(request);
    handleSocket(socket, kind);
    return response;
  }

  return new Response("not found", { status: 404 });
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
```

The `upgrade(request)` call is the one runtime-specific piece. Each platform spells it differently (`Deno.upgradeWebSocket`, `server.upgrade` on Bun, a `WebSocketPair` on Workers), but every one yields a `WebSocket`-like object with `send`, `close`, and `message`/`close` events — enough to satisfy `SocketLike` and `handleSocket`.

## Copy the Node adapter as your reference

The Node adapter `serveRelay` in `src/relay/node.ts` is the canonical, working implementation of exactly this contract. Read it before you write your own — it is short and every line maps to a rule above:

- It routes `GET /json/version`, `/json`, `/json/list`, and `/icdp/status` to the matching `core.*` payload builder, and sends everything else to a `fallback` (or `404`).
- It routes WebSocket upgrades by path: the browser path becomes a Client, the host path becomes a Host, and any other upgrade is rejected (`socket.destroy()`).
- It wraps each `ws` once in a `SocketLike` and caches it in a `WeakMap`, so the core sees stable connection identity.
- It forwards `message` and `close` events to `hostMessage`/`clientMessage` and `hostDisconnected`/`clientDisconnected`.

Your adapter differs only in how it opens sockets and binds the port. The Host/Client split, the path routing, and the `SocketLike` caching carry over unchanged.

::: warning Flat-session protocol only
The core speaks the [flat-session protocol](/explanation/flat-session-protocol): there are no per-target WebSocket URLs. `jsonList()` advertises one `webSocketDebuggerUrl` — your `browserWsUrl` — for every Target. Clients attach with `Target.attachToTarget` and route by `sessionId`. Do not synthesize per-target URLs in your adapter.
:::

## Next steps

- [Relay reference](/reference/relay) — every method, default, and the methods the Relay answers itself.
- [Protocol reference](/reference/protocol) — the bridge message shapes that flow over the Host socket.
- [HTTP endpoints](/reference/http-endpoints) — the discovery routes and their bodies.
- [Run a Relay](/guides/run-a-relay) — the Node path, if you can use it after all.
