---
description: "Stand up the Node Relay so external CDP Clients can connect over WebSocket and uplink your Host to it."
---

# Run a Relay for external CDP tools

You have a [Host](/explanation/concepts) with paired [Targets](/explanation/concepts) and want external CDP tools — agent-browser, chrome-remote-interface, Playwright over `connectOverCDP` — to drive them over WebSocket. A [Client](/explanation/concepts) cannot talk to the Host directly: the Host speaks the bridge protocol over a `MessagePort`, not standard CDP over a socket. The [Relay](/explanation/concepts) closes that gap. It exposes a Chrome-compatible CDP endpoint for Clients and a separate bridge endpoint that your Host uplinks to.

This guide assumes you already have a running Host that has paired at least one Target. If you do not, see [Pair an iframe](/guides/pair-an-iframe).

## Start the Relay

The Node adapter, `@olimsaidov/icdp/relay/node`, runs on `node:http` + `ws` and needs Node >= 22.

```ts
import { serveRelay } from "@olimsaidov/icdp/relay/node";

const relay = await serveRelay({ hostPort: 3000, browserPort: 9229 });

console.log(relay.hostWsUrl); //    ws://127.0.0.1:3000/icdp/host          <- the Host uplinks here
console.log(relay.browserWsUrl); // ws://127.0.0.1:9229/devtools/browser  <- Clients connect here
```

`serveRelay` resolves to a `RelayServer` with two URLs that matter:

- `relay.hostWsUrl` — the bridge endpoint. Hand this to `host.connectRelay`.
- `relay.browserWsUrl` — the browser-level CDP endpoint. Hand this to your Client.

The default `hostHostname` and `browserHostname` are `127.0.0.1`, the default `hostPath` is `/icdp/host`, and the default `browserPath` is `/devtools/browser`.

::: tip
Pass `hostPort: 0` or `browserPort: 0` (the defaults) to let the OS assign free ports, then read the real values back from `relay.hostPort` and `relay.browserPort`.
:::

## Uplink the Host

The Relay serves exactly one Host. Point the Host at `relay.hostWsUrl`:

```ts
const disconnect = host.connectRelay({ url: relay.hostWsUrl });
```

The uplink is structurally just another consumer of the same hub — a local [console panel](/guides/local-console-panel) and the Relay can attach to the same Targets at once. `connectRelay` returns a disconnect function and replaces any existing uplink. On disconnect the uplink auto-reconnects (default 500ms; override with `reconnectDelayMs`).

::: warning One Host at a time, new-wins
A newly connecting Host takes over from a stale one: the Relay drops the previous Host (close code `1008`) and the new Host's Targets replace the old set. Attached Clients see the churn as `targetDestroyed` / `targetCreated`. Run a single Host per Relay.
:::

## Connect a Client

A Client connects to `relay.browserWsUrl` and addresses Targets through the [flat-session protocol](/explanation/flat-session-protocol): `Target.getTargets`, then `Target.attachToTarget` and `sessionId` routing on the one browser-level endpoint. There are no per-target WebSocket URLs. For the agent-browser recipe, see [Drive with agent-browser](/guides/drive-with-agent-browser).

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

- [Drive with agent-browser](/guides/drive-with-agent-browser) — connect a Client and run commands against a Target.
- [Embed a Relay in another runtime](/guides/embed-a-relay-in-another-runtime) — use the runtime-agnostic `RelayCore` outside Node.
- [Relay reference](/reference/relay) — the full method surface, defaults, and the registry methods the Relay owns.
