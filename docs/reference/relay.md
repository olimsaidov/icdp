---
description: "Reference for the raw-CDP RelayCore transport and its Node adapter."
---

# `@olimsaidov/icdp/relay`

The Relay exposes one browser CDP WebSocket, direct Target WebSockets, one Host
uplink, and Chromium-style HTTP discovery routes. It is intentionally
protocol-blind: the Host owns CDP Targets and Sessions.

## Node adapter

```ts
import { serveRelay } from "@olimsaidov/icdp/relay/node";

const relay = await serveRelay({ hostPort: 3000, browserPort: 9229 });
```

`serveRelay(options?)` requires Node 22 or newer and returns a
`Promise<RelayServer>`.

### `ServeRelayOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `hostPort` | `0` | Host-uplink TCP port; `0` selects a free port. |
| `hostHostname` | `"127.0.0.1"` | Host-uplink bind address. |
| `browserPort` | `0` | Client/discovery TCP port; `0` selects a free port. |
| `browserHostname` | `"127.0.0.1"` | Client/discovery bind address. |
| `product` | `"icdp/0.5.0"` | Product shown in HTTP discovery. |
| `hostPath` | `"/icdp/host"` | Host WebSocket path. |
| `browserPath` | `"/devtools/browser"` | Client WebSocket path. |
| `targetPathPrefix` | `"/devtools/page/"` | Direct Target WebSocket prefix. |
| `hostWsUrl` | derived | Public Host-uplink URL returned to the caller. |
| `browserWsUrl` | derived | Public Client URL advertised by discovery. |
| `fallback` | none | Handler for ordinary HTTP requests on the Host server. |

### `RelayServer`

The result contains `core`, `hostServer`, `browserServer`, the two bound ports,
the Host and browser WebSocket URLs, `targetWsUrl(targetId)`, and
`stop(): Promise<void>`. `stop()` terminates open WebSockets and closes both
HTTP servers.

Set `ICDP_DEBUG=1` to log HTTP requests, upgrades, and the first 400 characters
of each WebSocket frame.

## `RelayCore`

```ts
import { RelayCore } from "@olimsaidov/icdp/relay";

const core = new RelayCore({
  product: "my-shell/1.0",
  browserWsUrl: "ws://127.0.0.1:9229/devtools/browser",
  targetWsUrl: (targetId) =>
    `ws://127.0.0.1:9229/devtools/page/${encodeURIComponent(targetId)}`,
});
```

`RelayCoreOptions` contains `product`, `browserWsUrl`, and the optional
`targetWsUrl(targetId)` formatter.

An adapter supplies stable `SocketLike` objects:

```ts
type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
```

### Adapter methods

| Method | Behavior |
| --- | --- |
| `hostConnected(socket)` | Registers the socket as the Host, or as a pending contender while a validated Host is healthy. |
| `hostDisconnected(socket)` | Removes the matching Host and clears cached Target summaries. |
| `hostMessage(socket, raw)` | Validates `ready`, promotes a contender, then applies Target-summary changes or routes one raw `clientMessage` to its Client. |
| `clientConnected(socket, targetId?)` | Assigns a Client id and syncs the complete Client list to the Host. A Target id creates a direct page connection and is rejected when unknown. |
| `clientDisconnected(socket)` | Removes the Client and syncs the complete Client list. |
| `clientMessage(socket, raw)` | Wraps raw CDP for the Host. With no Host, returns `-32000` to the Client when the request can be decoded. |

### Discovery builders

| Method | Result |
| --- | --- |
| `jsonVersion()` | `/json/version` payload and the browser WebSocket URL. |
| `jsonList()` | One discovery entry per cached Host Target, with its direct WebSocket when `targetWsUrl` is configured. |
| `status()` | `{ hostConnected, targets, clients }`. |

The Relay caches metadata only. `Browser.getVersion`, `Target.getTargets`,
attachments, Session validation, command errors, and event routing are all
implemented by the Host.

See [HTTP endpoints](/reference/http-endpoints) for concrete payloads and
[the flat-session protocol](/explanation/flat-session-protocol) for routing.
