---
description: "API reference for serveRelay (the Node adapter) and RelayCore (the runtime-agnostic core)."
---

# `@olimsaidov/icdp/relay` and `/relay/node`

The [Relay](/explanation/concepts) is the server that exposes a Chrome-compatible CDP endpoint to external [Clients](/explanation/concepts). It serves exactly one [Host](/explanation/concepts) at a time and forwards [Session](/explanation/concepts)-scoped commands to it.

Two entry points ship: `@olimsaidov/icdp/relay/node` is a ready-made Node `http` + `ws` server, and `@olimsaidov/icdp/relay` is the runtime-agnostic `RelayCore` it is built on. Use the Node adapter unless you are embedding the Relay in another runtime.

For the HTTP discovery routes and WebSocket upgrade paths this page references, see [/reference/http-endpoints](/reference/http-endpoints). For the on-the-wire bridge and CDP message shapes, see [/reference/protocol](/reference/protocol).

## Part 1 — `@olimsaidov/icdp/relay/node`

```ts
import { serveRelay } from "@olimsaidov/icdp/relay/node";

const relay = await serveRelay({ hostPort: 3000, browserPort: 9229 });
```

### `serveRelay(options?): Promise<RelayServer>`

Starts two `http` servers: one Host uplink server and one browser/CDP server. The Host server accepts the Host bridge WebSocket and optional fallback HTTP requests. The browser server answers CDP discovery routes and accepts Client WebSocket connections. Built on `node:http` and `ws`. Requires Node >= 22. The returned promise resolves once both servers are listening.

#### `ServeRelayOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hostPort` | `number` | `0` | Host uplink TCP port. `0` lets the OS assign a free port; read it back from `RelayServer.hostPort`. |
| `hostHostname` | `string` | `"127.0.0.1"` | Interface for the Host uplink server to bind. |
| `browserPort` | `number` | `0` | Browser/CDP TCP port. `0` lets the OS assign a free port; read it back from `RelayServer.browserPort`. |
| `browserHostname` | `string` | `"127.0.0.1"` | Interface for the browser/CDP server to bind. |
| `product` | `string` | `"icdp/0.1"` | Product string reported by `Browser.getVersion` and `/json/version`. Passed through to `RelayCore`. |
| `hostPath` | `string` | `"/icdp/host"` | Path the Host bridge connects to over WebSocket. |
| `browserPath` | `string` | `"/devtools/browser"` | Path Clients connect to over WebSocket, and the path advertised by `/json/version`. |
| `hostWsUrl` | `string` | built from `hostHostname`, `hostPort`, `hostPath` | Public Host uplink URL returned as `RelayServer.hostWsUrl`. Use this when an ingress/proxy URL differs from the bind address. |
| `browserWsUrl` | `string` | built from `browserHostname`, `browserPort`, `browserPath` | Public browser/CDP URL returned as `RelayServer.browserWsUrl` and advertised in `/json`. |
| `fallback` | `(request: IncomingMessage, response: ServerResponse) => void` | — | Handles ordinary HTTP requests on the Host server. With no `fallback` set, Host-server HTTP requests get `404`. |

#### `RelayServer`

The resolved object.

| Member | Type | Description |
| --- | --- | --- |
| `core` | `RelayCore` | The underlying core instance the adapter drives. |
| `hostServer` | `Server` | The Host uplink HTTP server. |
| `browserServer` | `Server` | The browser/CDP HTTP server. |
| `hostPort` | `number` | The bound Host uplink TCP port. |
| `browserPort` | `number` | The bound browser/CDP TCP port. |
| `hostWsUrl` | `string` | The Host uplink URL. The Host connects here. |
| `browserWsUrl` | `string` | The browser/CDP URL. Clients connect here. |
| `stop` | `() => Promise<void>` | Terminates all open sockets and closes both HTTP servers. Resolves once both servers have closed. |

Clients connect to `browserWsUrl`; the Host's `connectRelay` uplink connects to `hostWsUrl`. The browser/CDP server owns `/json/version`, `/json`, `/json/list`, `/icdp/status`, and the Client WebSocket. The Host server owns the Host WebSocket and optional `fallback`.

::: info Debug logging
With `ICDP_DEBUG=1` in the environment, the adapter logs every HTTP request, every WebSocket upgrade (with its resolved kind: `client`, `host`, or `reject`), and the first 400 characters of every WebSocket frame it receives from a Client or the Host.
:::

The HTTP routes (`/json/version`, `/json`, `/json/list`, `/icdp/status`) and the WebSocket upgrade behavior are documented in [/reference/http-endpoints](/reference/http-endpoints). For a runnable setup, see [/guides/run-a-relay](/guides/run-a-relay).

## Part 2 — `@olimsaidov/icdp/relay`

```ts
import { RelayCore } from "@olimsaidov/icdp/relay";

const core = new RelayCore({ browserWsUrl: "ws://127.0.0.1:9229/devtools/browser" });
```

### `class RelayCore`

The transport-free Relay. It holds all Relay state — the connected Host, Clients, Sessions, Targets, and pending commands — and produces JSON frames, but it never touches a socket directly. A runtime adapter feeds it raw connection events and frames and supplies a `SocketLike` for each connection. The Node adapter above is one such adapter; write another to run the Relay where `node:http`/`ws` are unavailable. See [/guides/embed-a-relay-in-another-runtime](/guides/embed-a-relay-in-another-runtime).

#### `RelayCoreOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `product` | `string` | `"icdp/0.1"` | Reported by `Browser.getVersion` and `/json/version`. |
| `browserWsUrl` | `string` | `""` | Absolute WebSocket URL of the browser endpoint, emitted in the `/json` payloads as `webSocketDebuggerUrl`. |
| `browserRequestTimeoutMs` | `number` | `30000` | How long to wait for the Host to answer a forwarded browser-level request before failing the Client with `code -32000`. Backstops a silent or hung Host. |

#### `SocketLike`

The minimal per-connection surface an adapter must supply for every Host and Client socket.

| Member | Type | Description |
| --- | --- | --- |
| `send` | `(data: string) => void` | Send a JSON frame to the connection. |
| `close` | `(code?: number, reason?: string) => void` | Close the connection. The core calls this with `1008` when it drops a superseded Host. |

The core keeps `SocketLike` identity to track each connection, so an adapter must pass the *same* `SocketLike` instance for a given socket across all calls.

### Adapter API

The methods a runtime adapter calls to drive the core. Each is keyed by the `SocketLike` passed in.

| Method | Description |
| --- | --- |
| `hostConnected(socket)` | Registers the Host uplink. New-wins: any previous Host is dropped, its Targets removed, and its old socket closed with code `1008`. |
| `hostDisconnected(socket)` | Clears the Host (only if `socket` is the current Host), clears its advertised handles, fails any forwarded browser-level requests, and drops all Targets. |
| `hostMessage(socket, raw)` | Feeds one `HostToRelayMessage` JSON frame from the Host. Ignored unless `socket` is the current Host. |
| `clientConnected(socket)` | Registers a new Client connection. |
| `clientDisconnected(socket)` | Removes the Client, ends its Sessions, and drops any of its in-flight browser-level requests. |
| `clientMessage(socket, raw)` | Feeds one CDP JSON frame from a Client. Routes by `sessionId`, answers registry/housekeeping locally, or forwards to the Host. |

### HTTP payload builders

The core also produces the JSON bodies for the discovery routes. An adapter serves these over its own HTTP layer (the Node adapter wires them to `/json/version`, `/json` and `/json/list`, and `/icdp/status` respectively).

| Method | Returns | Description |
| --- | --- | --- |
| `jsonVersion()` | `Record<string, unknown>` | The `/json/version` body, including `webSocketDebuggerUrl` (the `browserWsUrl`) and the `product` string. |
| `jsonList()` | `Array<Record<string, unknown>>` | The `/json` and `/json/list` body: one entry per Target, each with `webSocketDebuggerUrl` set to the single browser endpoint. |
| `status()` | `{ hostConnected: boolean; targets: TargetSummary[]; clients: number }` | The `/icdp/status` body: a snapshot of Relay state. |

### Semantics

The core enforces these rules regardless of adapter:

- **One Host, new-wins.** A second `hostConnected` drops the previous Host (closed with code `1008`) along with its Targets. A `ready` bridge message also re-announces and replaces the Target set.
- **Flat-session protocol only.** There are no per-target WebSocket URLs. Clients discover and attach via `Target.getTargets` / `Target.attachToTarget` / `Target.setAutoAttach` / `Target.setDiscoverTargets` on the single browser endpoint, then route commands by `sessionId`. See [/explanation/flat-session-protocol](/explanation/flat-session-protocol).
- **The Relay answers registry and housekeeping methods itself.** `Browser.getVersion`, `Schema.getDomains`, `Target.getTargets`, `Target.getTargetInfo`, `Target.attachToTarget`, `Target.detachFromTarget`, `Target.setAutoAttach`, `Target.setDiscoverTargets`, `Target.activateTarget`, `Target.setRemoteLocations`, `Browser.close`, `Browser.setDownloadBehavior`, `Browser.setWindowBounds`, and `Security.setIgnoreCertificateErrors` are handled from the core's own session/target state. They are never forwarded to the Host or the Frame Agent.
- **Only two browser-level methods are forwardable.** By default `Target.createTarget` is rejected (`icdp targets are iframes paired by the Host`) and `Target.closeTarget` returns `{ success: true }` as a no-op. If — and only if — the Host advertised the method in its ready `handles`, the Relay forwards that method to the Host as a `browserRequest` and awaits the result, bounded by `browserRequestTimeoutMs`. `Target.createTarget` and `Target.closeTarget` are the only methods a Host may take ownership of; registry methods stay Relay-owned because they read the Relay's own state.
- **Frame events fan out per Target.** A `BridgeEvent` from one Target is delivered to every Session attached to that Target.

For why the Host owns the iframes and the Relay owns the registry, see [/explanation/architecture](/explanation/architecture). For the bridge message shapes named above, see [/reference/protocol](/reference/protocol).
