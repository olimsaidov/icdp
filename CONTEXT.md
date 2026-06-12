# icdp

A library that provides the Chrome DevTools Protocol over an iframe boundary, so external CDP tools (agent-browser, Playwright, chrome-remote-interface) can drive and inspect an app embedded in an iframe — including cross-origin iframes — without a real browser debugging session.

## Language

**Frame Agent**:
The script running inside the iframe'd app that emulates CDP domains against the real DOM. The party that ultimately executes commands. Always included cooperatively by the embedded app (never injected by the Host); it announces itself to the parent on boot and stays dormant unless the parent's origin is on its allowlist.
_Avoid_: driver, bridge (the prior art's names for it)

**Host**:
The hub of the system: code in the parent window that pairs with Frame Agents and fans CDP sessions out to consumers. The Relay uplink is structurally just another consumer; parent-window code (e.g. a console panel) can attach to Targets locally without any server. Events broadcast to all attached sessions; domain enables are ref-counted per Target.
_Avoid_: shell, parent connector

**Relay**:
The server component exposing a Chrome-compatible CDP endpoint (`/json/version`, `/devtools/page/...`) that external clients attach to. Serves exactly one Host at a time; a newly connecting Host takes over from a stale one (new-wins), with target destroy/create events emitted to attached Clients.
_Avoid_: server, facade, proxy

**Client**:
An external CDP-speaking tool (agent-browser, Playwright, chrome-remote-interface) that connects to the Relay over WebSocket.

**Target**:
One iframe pairing as seen by Clients. Addressed exclusively via the flat-session protocol (`Target.attachToTarget` + `sessionId` routing on the single browser-level endpoint); there are no per-target WebSocket URLs.

**Pairing**:
The Host-side slot an iframe occupies. Target identity belongs to the Pairing, not the iframe element or its document: reloads, remounts, and cross-app navigations keep the same targetId (surfaced as `Page.frameNavigated`); only the Host destroying the Pairing destroys the Target. Commands in flight when a document dies fail fast with a CDP error — they are never replayed.

**Session**:
A Client's attachment to one Target, identified by `sessionId`. One Client may hold sessions to many Targets over one connection.
