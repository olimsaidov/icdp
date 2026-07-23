# icdp

A library that provides a cooperative Chrome DevTools Protocol subset over an
iframe boundary, so any compatible CDP Client can drive and inspect an embedded
app — including a cross-origin iframe — without a browser debugging session.

## Language

**Frame Agent**:
The script running inside the iframe'd app that emulates CDP domains against the real DOM. The party that ultimately executes commands. Always included cooperatively by the embedded app (never injected by the Host); it announces itself to the parent on boot and stays dormant unless the parent's origin is on its allowlist.
_Avoid_: driver, bridge (the prior art's names for it)

**Host**:
The hub of the system: code in the parent window that pairs with Frame Agents
and owns Targets, Clients, and Sessions. The Relay uplink carries remote Client
traffic; parent-window code (for example, a console panel) can attach locally
without a server. Domain state, frontend node ids, Runtime handles, and events
belong to one Session.
_Avoid_: shell, parent connector

**Relay**:
The server component exposing HTTP discovery, one browser-level CDP WebSocket,
and direct per-Target CDP WebSockets. It carries raw messages and Target
snapshots but does not own protocol state. It serves exactly one validated
Host at a time.
_Avoid_: server, facade, proxy

**Client**:
Any CDP-speaking implementation that connects to the Relay's browser endpoint
with flat Target Sessions or to a direct Target endpoint.

**Target**:
One iframe pairing as seen by Clients. Addressed either through the browser
endpoint's flat-session protocol (`Target.attachToTarget` + `sessionId`) or
through its Chromium-style direct `/devtools/page/<targetId>` endpoint.

**Pairing**:
The Host-side slot an iframe occupies. Target identity belongs to the Pairing, not the iframe element or its document: reloads, remounts, and cross-app navigations keep the same targetId (surfaced as `Page.frameNavigated`); only the Host destroying the Pairing destroys the Target. Commands in flight when a document dies fail fast with a CDP error — they are never replayed.

**Session**:
A Client's attachment to one Target, identified by `sessionId`. One Client may hold sessions to many Targets over one connection.
