---
description: "Why target identity belongs to the Pairing, how reloads and navigations keep the targetId, and how in-flight commands fail."
---

# Target lifecycle and identity

A [Target](/explanation/concepts) is what a [Client](/explanation/concepts) sees: one entry in `Target.getTargets`, one `targetId` it can attach a [Session](/explanation/concepts) to. But a Target has no substance of its own. It is the Client-facing projection of a [Pairing](/explanation/concepts) — the [Host](/explanation/concepts)-side slot an iframe occupies — and the Pairing is where identity lives. This page explains why identity is anchored to the Pairing rather than to the iframe element or its document, what that buys you, and how the system fails when a document dies underneath a command.

## Identity belongs to the Pairing

When you call [`pair(iframe, { targetId, origins })`](/reference/host), the Host creates a Pairing keyed by `targetId` and emits a `targetCreated`. From that moment the `targetId` is fixed for the life of the Pairing. It does not track the iframe element, and it does not track the document currently loaded in it:

- **Reloads** keep the `targetId`. The [Frame Agent](/explanation/concepts) re-announces on boot with a fresh `hello`; the Host recognises the iframe by `event.source`, re-opens the command channel, and keeps the same Pairing.
- **Cross-app navigations** keep the `targetId`. The document can change origin, change application, navigate to `/page-two` — as long as the new document carries a Frame Agent whose `event.origin` is on the Pairing's `origins` allowlist, it adopts the same slot.
- **Remounts** keep the `targetId`. The DOM beneath the iframe can be torn down and rebuilt; identity is the Pairing, not the element.

To a Client, each of these surfaces as a `Page.frameNavigated` event on the same Target, exactly as a navigation inside a real browser tab would. The Session the Client holds stays valid across the transition. This is deliberate: a Client driving a single-page app through SPA history changes, full navigations, and reloads should not have to re-discover and re-attach to a "new" Target after every transition. The Target it attached to is the Target it keeps.

The Host enforces this anchoring carefully on the reload path. A freshly-paired iframe connects once via the Frame Agent's boot `hello`; the Host only re-probes on a later `load` event when the Pairing has **no channel yet** (`if (!pairing.port) this.probe(pairing)`). A connected Pairing is never re-probed, because a probe would draw a fresh `hello`, and a fresh `hello` is exactly how the Host detects a genuine reload.

## Only the Host destroys a Target

A new document does not destroy the Target. A closed document does not destroy the Target. The single event that ends a Target is the Host destroying its Pairing, through [`unpair(targetId)`](/reference/host):

```ts
host.unpair("preview"); // fails in-flight commands, closes the port, emits targetDestroyed
```

`unpair` is idempotent and is the only path to `targetDestroyed`. [`destroy()`](/reference/host) reaches the same outcome by unpairing every Pairing. Nothing the embedded document does — navigating away, throwing, unloading — removes the Target from the Client's view; the Pairing outlives the document. This is the inverse of a real browser, where the page owns the tab's lifetime; here the parent window owns it, which is the whole point of [the Host being the hub](/explanation/architecture).

## In-flight commands fail fast, never replay

A document can die while commands are outstanding: a reload lands, a navigation commits, or the Host unpairs. Each Pairing holds a `pending` map of commands it has posted to the Frame Agent and is still waiting on. When the document underneath dies, every pending command is settled immediately with a CDP error — code `-32000` (`CDP_SERVER_ERROR`) — and the slot is cleared. The Host does not hold the command, does not queue it, and does not re-send it to the next document. The error reason names the cause:

- a reload (`hello` arriving while a channel is already open) fails pending commands with `Target reloaded`;
- `unpair` fails them with `Target destroyed`.

After a `Target reloaded` failure the channel re-opens against the new document, so subsequent commands proceed normally — but the commands that were in flight at the instant of reload are already lost, by design.

Fail-fast is the deliberate choice over silent replay. A command is a statement about a specific document: `DOM.querySelector` resolves a node id in *that* DOM; `Runtime.evaluate` runs in *that* execution context; `Input.dispatchMouseEvent` targets *that* layout. Replaying it against a document that replaced the one it was written for would execute against stale assumptions and return plausible-but-wrong results — a node id from the old tree, a click on a moved element. A `-32000` the Client can see and react to is safer than a success the Client cannot trust. The Client decides whether to retry against the new document; the Host never decides for it.

::: info
A command that arrives while a Pairing exists but has no channel yet (the Frame Agent has not paired) fails with the same `-32000` and the message `Target is not connected: the Frame Agent has not paired yet.` rather than waiting. The not-connected gate is a fast rejection, not a buffer.
:::

## Client-created Targets: the await-connect contract

When the Host is constructed with [`onCreateTarget`](/reference/host), a Client can open Targets itself via `Target.createTarget`. This raises a race the not-connected gate would otherwise expose: a Client that creates a Target and immediately sends a command to it could hit the new Pairing before its Frame Agent has handshaked, and get the not-connected `-32000`.

The Host closes that race by resolving `createTarget` only after the new Target connects. In [`handleBrowserRequest`](/reference/host), the Host calls your `onCreateTarget` hook to mint and `pair()` the iframe, then awaits the Pairing's handshake (`whenConnected`, default 10s) before returning `{ targetId }` to the Relay — which is what the Client's `createTarget` resolves to. By the time the Client learns the `targetId`, the Target is connected, so its first command cannot lose the race.

The same await is the rollback boundary. If the new Target never completes its handshake — it times out, or it is destroyed mid-handshake — the await rejects, and the Host `unpair`s the half-made Pairing before re-throwing:

```ts
const targetId = await this.options.onCreateTarget(params);
try {
  await this.whenConnected(targetId);
} catch (error) {
  this.unpair(targetId); // no zombie in the Host, the Relay, or Target.getTargets
  throw error;
}
return { targetId };
```

A Target either connects and becomes real, or it is rolled back; it never lingers as a zombie that `Target.getTargets` would list but no Session could drive. (Pointing `createTarget` at an origin that carries no Frame Agent — say `https://example.com` — is the timeout case: the create rolls back.) For wiring this up, see [Driving the Target lifecycle from a Client](/guides/client-driven-targets).

## New-wins: a Host takeover churns Targets

The [Relay](/explanation/concepts) serves exactly one Host at a time. When a Host connects while another is already attached, the newcomer wins: the Relay drops every Target from the stale Host, closes the previous Host socket with CDP close code `1008`, and adopts the new Host's Targets from its `ready` message. (A Host re-announcing on the same socket triggers the same drop-and-readopt.)

To attached Clients this surfaces as ordinary lifecycle churn: `targetDestroyed` for the stale Host's Targets, then `targetCreated` for the new Host's. A Client's Sessions to the old Targets are gone — those Targets no longer exist — and the Client re-attaches to whatever the new Host advertises. Identity does not survive a Host swap, because identity belongs to a Pairing, and the Pairings belonged to the Host that was replaced. The mechanism is consistent with the within-Host rule: a Target lives precisely as long as the Pairing that defines it.

## See also

- [Host reference](/reference/host) — `pair`, `unpair`, `onCreateTarget`, `handleBrowserRequest`, and the handshake.
- [The flat-session protocol](/explanation/flat-session-protocol) — how Clients address Targets without per-target URLs.
- [Driving the Target lifecycle from a Client](/guides/client-driven-targets) — wiring up `onCreateTarget` / `onCloseTarget`.
