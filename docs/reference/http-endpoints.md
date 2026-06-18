---
description: "The HTTP discovery routes and WebSocket upgrade paths the Relay serves."
---

# Relay HTTP endpoints

The [Relay](/explanation/concepts) exposes a Chrome-compatible HTTP discovery surface alongside its WebSocket endpoints. The Node adapter (`serveRelay`, in [src/relay/node.ts](https://github.com/olimsaidov/icdp/blob/master/src/relay/node.ts)) runs two HTTP servers: a browser/CDP server for Client discovery and CDP WebSocket traffic, and a Host server for the Host uplink WebSocket plus optional fallback HTTP. The JSON payloads themselves come from `RelayCore` (`jsonVersion()`, `jsonList()`, `status()`), so any runtime adapter built on [RelayCore](/reference/relay) serves the same shapes.

The four discovery routes below live on the browser/CDP server. They respond with `Content-Type: application/json; charset=utf-8` and HTTP status `200`; any other browser/CDP HTTP path returns `404`. The Host server does not serve these routes. Set `ICDP_DEBUG=1` to log every HTTP request and WebSocket upgrade.

## GET routes

| Path | Handler | Body |
| --- | --- | --- |
| `/json/version` | `RelayCore.jsonVersion()` | Browser version descriptor |
| `/json` | `RelayCore.jsonList()` | Array of target descriptors |
| `/json/list` | `RelayCore.jsonList()` | Same array as `/json` |
| `/icdp/status` | `RelayCore.status()` | Relay status snapshot |

Any other browser/CDP HTTP path is answered with HTTP `404` and the body `not found`. The optional `fallback` handler only runs on the Host server.

### `GET /json/version`

The browser version descriptor a [Client](/explanation/concepts) reads to discover the WebSocket endpoint.

```json
{
  "Browser": "icdp/0.1",
  "Protocol-Version": "1.3",
  "User-Agent": "icdp/0.1",
  "V8-Version": "synthetic",
  "WebKit-Version": "synthetic",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9229/devtools/browser"
}
```

| Field | Type | Value |
| --- | --- | --- |
| `Browser` | string | The `product` string (default `icdp/0.1`). |
| `Protocol-Version` | string | `"1.3"`, fixed. |
| `User-Agent` | string | The `product` string. |
| `V8-Version` | string | `"synthetic"`, fixed. |
| `WebKit-Version` | string | `"synthetic"`, fixed. |
| `webSocketDebuggerUrl` | string | Absolute URL of the browser WebSocket endpoint (`browserWsUrl`). |

### `GET /json` and `GET /json/list`

Both paths return the same array, one entry per [Target](/explanation/concepts) the Relay currently knows about.

```json
[
  {
    "description": "icdp iframe target",
    "devtoolsFrontendUrl": "",
    "id": "playground",
    "title": "Playground",
    "type": "page",
    "url": "http://127.0.0.1:3001/playground",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9229/devtools/browser"
  }
]
```

| Field | Type | Value |
| --- | --- | --- |
| `description` | string | `"icdp iframe target"`, fixed. |
| `devtoolsFrontendUrl` | string | `""`, fixed. |
| `id` | string | The `targetId`. |
| `title` | string | The Target's last-known title. |
| `type` | string | `"page"`, fixed. |
| `url` | string | The Target's last-known URL. |
| `webSocketDebuggerUrl` | string | The single browser endpoint (`browserWsUrl`) — the same value on every entry. |

::: info Every entry points at one URL
`webSocketDebuggerUrl` is the browser endpoint, not a per-target URL. icdp is flat-session only: there are no per-target WebSocket URLs. A Client connects once to the browser endpoint and attaches to a Target with `Target.attachToTarget`, then routes commands by `sessionId`. See [the flat-session protocol](/explanation/flat-session-protocol).
:::

### `GET /icdp/status`

A snapshot of Relay state, for health checks and the [playground](/) status page.

```json
{
  "hostConnected": true,
  "targets": [
    { "targetId": "playground", "title": "Playground", "url": "http://127.0.0.1:3001/playground" }
  ],
  "clients": 2
}
```

| Field | Type | Value |
| --- | --- | --- |
| `hostConnected` | boolean | `true` when a [Host](/explanation/concepts) uplink is attached. |
| `targets` | `TargetSummary[]` | Each entry is `{ targetId, title, url }`. See [protocol types](/reference/protocol). |
| `clients` | number | Count of connected Clients. |

## WebSocket upgrade paths

The Relay accepts WebSocket upgrades on exactly two paths, but they are on different servers. Both default values are configurable through `ServeRelayOptions`.

| Server | Path option | Default | Role | Adapter call |
| --- | --- | --- | --- | --- |
| browser/CDP | `browserPath` | `/devtools/browser` | Client connection (standard CDP) | `clientConnected` / `clientMessage` / `clientDisconnected` |
| Host | `hostPath` | `/icdp/host` | Host uplink (bridge protocol) | `hostConnected` / `hostMessage` / `hostDisconnected` |

An upgrade on any other path is rejected: the socket is destroyed without an HTTP response. Only one Host is served at a time; a new Host connection drops the previous one (new-wins). The browser path appears verbatim as the `webSocketDebuggerUrl` in `/json/version` and `/json`.

The full URLs are read back from the `RelayServer` returned by `serveRelay`:

```ts
import { serveRelay } from "@olimsaidov/icdp/relay/node";

const relay = await serveRelay({ hostPort: 3000, browserPort: 9229 });
relay.hostWsUrl;    // ws://127.0.0.1:3000/icdp/host          (Host uplink)
relay.browserWsUrl; // ws://127.0.0.1:9229/devtools/browser  (Clients)
```

See [the Relay reference](/reference/relay) for the `RelayCore` adapter API and the `ServeRelayOptions` fields that set ports, hostnames, paths, advertised URLs, `product`, and `fallback`.
