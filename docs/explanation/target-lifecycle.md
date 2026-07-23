---
description: "How Pairings anchor Target identity across document replacement and how Sessions are restored."
---

# Target lifecycle and identity

A CDP Target is the Client view of one Host
[Pairing](/explanation/concepts). Calling `pair()` creates it:

```ts
host.pair(iframe, {
  targetId: "preview",
  origins: ["https://app.example.com"],
});
```

The `targetId` belongs to this Pairing. It remains stable when the iframe
reloads or navigates to another allowed document. It does not outlive
`unpair()`, and replacing the iframe element requires a new Pairing.

## Document replacement

The Frame Agent in a new document sends `hello`. The Host identifies the
paired iframe by `event.source`, checks the new origin, and replaces the
`MessagePort`.

The Host also treats a later iframe `load` as a document-generation boundary.
It invalidates the old port and probes the new document even when that
document never starts a Frame Agent; the Target then remains discoverable but
disconnected until a valid `hello` arrives.

The Host keeps Target and Session ids, but:

- commands still pending against the old document fail with `-32000`,
  `Target reloaded`;
- the old port closes;
- each surviving Session is attached to the new Frame backend with its
  successfully enabled domains and accepted enable-time parameters;
- document-scoped DOM ids, Runtime handles, loader id, and numeric/unique
  execution-context ids are new.

Restoring `Page` reports the replacement frame navigation, then reports the
replacement document's real DOM-content and load stages. Stages that occur
during the handshake gap are journaled and delivered after restoration;
`Page.enable` never fabricates them. Restoring `Runtime` emits
`executionContextsCleared` before the replacement context; restoring `DOM`
emits `documentUpdated`. Commands are never silently replayed against a
replacement document.

A same-document channel replacement restores domain state without inventing a
navigation. Returning from the back-forward cache emits `Page.frameNavigated`
with type `BackForwardCacheRestore`. When Page and Runtime are both enabled,
ordinary replacement follows Chromium's clear → frame navigation → context
creation → DOM-content/load order. A BFCache restore re-announces the preserved
context before its frame-navigation event.

A Pairing with no live Frame channel remains discoverable, but Target commands
fail fast with `-32000` and
`Target is not connected: the Frame Agent has not paired yet.`

## Destruction

Only the Host destroys the Target:

```ts
host.unpair("preview");
```

`unpair()` ends its Sessions, closes the port, removes the load listener, and
publishes the Target removal. Pending local API calls reject with
`Target destroyed`; pending relay commands are removed without a late protocol
response, matching Chromium's terminal Session behavior. It is idempotent for
an unknown id. `host.destroy()` unpairs everything.

## Client-created Targets

With `onCreateTarget`, the Host waits up to ten seconds for the new Pairing's
Frame handshake before returning its `targetId` to the Client. If the hook
returns an unknown Pairing, the handshake times out, or the Target is
destroyed during the wait, the Host unpairs any partial Target and returns an
error.

This makes successful `Target.createTarget` a readiness boundary: the Client
can attach as soon as it receives the id.

## Relay reconnect and Host replacement

A Host instance keeps one stable bridge `instanceId`. If its Relay uplink drops
transiently, the Relay clears stale discovery data but keeps Client sockets.
The same Host reconnects with the same id, receives the complete Client-id
snapshot, preserves its Targets and Sessions, and flushes queued Client
responses. Clients do not need to reattach.

If a Target was destroyed while the uplink was down, the reconnecting Host's
complete Target snapshot no longer contains it. The Relay closes any direct
socket still bound to that missing Target with code `1001`, but only after the
Host replays queued Client responses and sends `readyComplete`. A successful
`Target.closeTarget` response and its `Inspector.detached` events therefore
arrive before the direct socket closes even across an uplink outage.

The Relay still accepts only one validated Host connection. A new socket stays
a contender and cannot publish Targets or Client messages until it sends a
valid `ready` frame. Only then does it replace the old Host socket, which
closes with code `1008`. If the contender announces a different `instanceId`,
the Relay closes existing Client sockets with code `1012`, clears the old
Target cache, and publishes the replacement Host's Targets. Clients then
reconnect and perform normal discovery, auto-attach, and Session setup against
the new Host. This explicit disconnect prevents old flattened Session ids from
being routed into an unrelated Host.
