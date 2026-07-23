---
description: "The canonical icdp vocabulary: Frame Agent, Host, Relay, Client, Target, Pairing, and Session."
---

# Concepts

## Frame Agent

The script cooperatively loaded by the embedded app. It implements the
document-facing CDP subset with normal page APIs. One backend represents the
document; every attached Session gets independent frontend DOM ids, Runtime
handles, enabled domains, input state, responses, and events.

## Host

Parent-window code and the protocol authority. The Host pairs iframe slots,
owns Target identity, parses Client CDP messages, implements browser and
Target commands, creates Sessions, routes commands and events, and restores
Session enable state after a document reload.

Use `host.attach(targetId)` for a local Session or `host.connectRelay(...)` to
serve remote CDP Clients.

## Relay

A small WebSocket transport and HTTP discovery cache. It assigns each Client
connection an opaque id and forwards raw CDP JSON between that Client and the
Host. It caches Target summaries for `/json`, `/json/list`, and status
responses. It does not interpret CDP, own Sessions, or choose event
recipients.

The Relay accepts one validated Host. A new socket remains an inert contender
until a valid `ready` frame promotes it and replaces the old connection.

## Client

An external CDP-speaking tool connected to the Relay's browser endpoint. A
Client uses `Target.attachToTarget` with `flatten: true`, then places the
returned `sessionId` on per-Target commands.

## Pairing

The Host-side association created by:

```ts
host.pair(iframe, { targetId, origins });
```

It binds a stable Target id and origin policy to an iframe slot. A new
document may replace the Frame Agent channel without replacing the Pairing.
Only `unpair(targetId)` ends it.

## Target

The CDP view of a Pairing. It has type `page`, a stable `targetId`, and the
latest title and URL announced by the Frame Agent. It is not a Chromium
process or renderer target.

## Session

One attachment from one consumer to one Target. It has an opaque `sessionId`
and isolated domain state. A remote Session belongs to exactly one Client
connection; a local Session belongs to the `LocalSession` returned by
`host.attach`.

Frame events are already Session-addressed. Enabling a domain in one Session
does not enable it or expose its events in another.
