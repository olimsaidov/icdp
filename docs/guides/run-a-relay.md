---
description: "Stand up the Node Relay so external CDP Clients can connect over WebSocket and uplink your Host to it."
---

# Run a Relay for external CDP tools

You have a [Host](/explanation/concepts) with paired
[Targets](/explanation/concepts) and want an external CDP tool to drive them
over WebSocket. The Host has no listening socket. The
[Relay](/explanation/concepts) supplies a browser-level CDP endpoint, one
direct endpoint per Target, and a separate raw-message uplink for the Host.

This guide assumes you already have a running Host that has paired at least one Target. If you do not, see [Pair an iframe](/guides/pair-an-iframe).

## Start the Relay

The Node adapter, `@olimsaidov/icdp/relay/node`, runs on `node:http` + `ws` and needs Node >= 22.

```ts
import { serveRelay } from "@olimsaidov/icdp/relay/node";

const relay = await serveRelay({ hostPort: 3000, browserPort: 9229 });

console.log(relay.hostWsUrl); //    ws://127.0.0.1:3000/icdp/host          <- the Host uplinks here
console.log(relay.browserWsUrl); // ws://127.0.0.1:9229/devtools/browser  <- Clients connect here
console.log(relay.targetWsUrl("preview")); // ws://127.0.0.1:9229/devtools/page/preview
```

`serveRelay` resolves to a `RelayServer` with these endpoint helpers:

- `relay.hostWsUrl` — the bridge endpoint. Hand this to `host.connectRelay`.
- `relay.browserWsUrl` — the browser-level CDP endpoint.
- `relay.targetWsUrl(targetId)` — the direct endpoint advertised for one Target.

The default `hostHostname` and `browserHostname` are `127.0.0.1`. The default
paths are `/icdp/host`, `/devtools/browser`, and `/devtools/page/<targetId>`.

::: tip
Pass `hostPort: 0` or `browserPort: 0` (the defaults) to let the OS assign free ports, then read the real values back from `relay.hostPort` and `relay.browserPort`.
:::

## Uplink the Host

The Relay serves exactly one Host. Point the Host at `relay.hostWsUrl`:

```ts
const disconnect = host.connectRelay({ url: relay.hostWsUrl });
```

The uplink carries Target summaries, Client-id snapshots, and raw CDP frames.
A local [console panel](/guides/local-console-panel) and remote Clients can
attach to the same Targets at once. `connectRelay` returns a disconnect
function and replaces any existing uplink. After an unexpected close the
uplink reconnects (default 500 ms; override with `reconnectDelayMs`).

::: warning One validated Host at a time
A newly connected Host is inert until its `ready` frame passes bridge
validation. It then takes over from the old Host: the Relay drops the previous
socket (close code `1008`) and replaces the cached Target set. If its stable
Host instance id differs, the Relay also closes connected Clients (code
`1012`) so they reconnect, rediscover, and attach without carrying stale
Session ids into the replacement Host. A transient reconnect by the same Host
keeps Client sockets and Sessions. Run a single Host per Relay.
:::

## Connect a Client

A multi-Target Client connects to `relay.browserWsUrl` and uses the
[flat-session protocol](/explanation/flat-session-protocol):
`Target.getTargets`, then `Target.attachToTarget` and `sessionId` routing.
Clients that expect a page socket can connect to the per-Target
`webSocketDebuggerUrl` returned by `/json/list`. See
[Connect a CDP Client](/guides/connect-a-cdp-client) for both forms.

## Discover Targets over HTTP

The Relay answers Chrome's HTTP discovery routes on the browser/CDP server, so existing CDP tooling can find the endpoint without exposing the Host uplink:

- `/json/version` — protocol and product info, including the `webSocketDebuggerUrl`.
- `/json` and `/json/list` — the current Target list.
- `/icdp/status` — the Relay's Host/Client/Target state.

Anything else on the browser/CDP server returns `404`. The optional `fallback` handler is only for ordinary HTTP requests on the Host server, useful when the same public port also serves your shell page. See [HTTP endpoints](/reference/http-endpoints) for the exact payloads.

## Stop the Relay

```ts
await relay.stop();
```

`stop()` terminates open WebSockets and closes both HTTP servers. It resolves once both servers have shut down.

## Debugging

Set `ICDP_DEBUG=1` to log every HTTP request, WebSocket upgrade, and frame the Relay handles:

```sh
ICDP_DEBUG=1 node server.js
```

## Next steps

- [Connect a CDP Client](/guides/connect-a-cdp-client) — discover, attach, and run commands against a Target.
- [Embed a Relay in another runtime](/guides/embed-a-relay-in-another-runtime) — use the runtime-agnostic `RelayCore` outside Node.
- [Relay reference](/reference/relay) — the transport and discovery surface.
