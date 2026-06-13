---
description: "Why icdp is shaped the way it is — architecture, vocabulary, the flat-session protocol, lifecycle, and the accessibility tree."
---

# Explanation

These pages discuss the *why* behind icdp: the reasoning, the trade-offs, and the consequences that shaped each piece. For concrete tasks, see the [how-to guides](/guides/); for exact signatures, see the [reference](/reference/).

## Reading order

Start at the top and follow the chain. The first two pages are worth reading together; the rest build on the vocabulary they establish.

- **[Architecture](/explanation/architecture)** — the four pieces (Frame Agent, Host, Relay, Client), the MessagePort and WebSocket boundaries between them, and why the Host, not the Relay, is the hub.
- **[Concepts](/explanation/concepts)** — the canonical vocabulary: Frame Agent, Host, Relay, Client, Target, Pairing, Session. Keep this open while you read the others; every page uses these terms exactly.
- **[The flat-session protocol](/explanation/flat-session-protocol)** — why Clients address Targets through `Target.attachToTarget` and `sessionId` routing on one browser-level endpoint, with no per-target WebSocket URLs.
- **[Target lifecycle](/explanation/target-lifecycle)** — why Target identity belongs to the Pairing rather than the iframe element or its document, so reloads and cross-app navigations keep the same `targetId`, and how in-flight commands fail when a document dies.
- **[The accessibility tree](/explanation/accessibility-tree)** — how the Frame Agent produces AX-tree snapshots from the real DOM, and where that diverges from Chromium.
