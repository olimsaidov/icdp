---
description: "Register an iframe with the Host so CDP Clients and local sessions can address it as a Target."
---

# Pair an iframe as a Target

You have an iframe whose app ships the [Frame Agent](/explanation/concepts), and you want the [Host](/explanation/concepts) to treat that iframe as a CDP [Target](/explanation/concepts) — addressable by a local console panel or by external [Clients](/explanation/concepts) through a [Relay](/explanation/concepts). Pairing is the Host-side registration that makes this happen.

This guide assumes the embedded app already calls `startFrameAgent` with your parent origin allowlisted. If it does not, do that first: see [Embed the Frame Agent](/guides/embed-the-frame-agent).

## Pair the iframe

Construct a Host and pair the iframe element:

```ts
import { IcdpHost } from "@olimsaidov/icdp/host";

const host = new IcdpHost();
const iframe = document.querySelector("iframe#preview");

host.pair(iframe, {
  targetId: "preview",
  origins: ["https://app.example.com"],
});
```

`pair(iframe, options)` registers the iframe as a slot — a [Pairing](/explanation/concepts) — and immediately probes the iframe to start the handshake. It emits a `targetCreated` event synchronously, before the iframe answers, so the Target appears in `host.targets()` right away even while it is still connecting.

## What `targetId` is

`targetId` is the stable identity of the Target. It belongs to the Pairing, not to the iframe element or its current document. Reloads, remounts, and cross-app navigations inside the iframe keep the same `targetId` — Clients see a `Page.frameNavigated` event rather than the Target disappearing and a new one taking its place. The only thing that destroys a Target is `host.unpair(targetId)`.

Pick a `targetId` that is stable and meaningful to your application (`"preview"`, a record id, a `crypto.randomUUID()` you store). See [Target lifecycle](/explanation/target-lifecycle) for the full identity model.

`pair` throws if the `targetId` is already in use:

```ts
host.pair(iframeA, { targetId: "preview", origins: ["https://app.example.com"] });
host.pair(iframeB, { targetId: "preview", origins: ["https://app.example.com"] });
// Error: Target "preview" is already paired
```

## The `origins` allowlist

`origins` is the list of frame origins allowed to pair into this slot. When the Frame Agent answers the probe, the Host checks the message's `event.origin` against this list; a hello from any other origin is ignored, and the Pairing stays unconnected. List the exact origin(s) the embedded app serves from:

```ts
host.pair(iframe, {
  targetId: "preview",
  origins: ["https://app.example.com"],
});
```

`origins: "*"` accepts whatever origin the iframe currently hosts. This is a second, independent gate from the agent's own `allowedParents`; the agent still refuses to adopt a channel unless your parent origin is on _its_ allowlist.

::: warning
`origins: "*"` removes the Host-side origin check entirely, so any document the iframe ends up hosting can adopt the command channel and expose its DOM through this Target. Use a concrete origin list unless the iframe content is fully under your control.
:::

## What the handshake does

The handshake runs over `window.postMessage` and a transferred `MessagePort`:

1. The Host posts `{ icdp: "probe", v }` to the iframe.
2. The Frame Agent replies `{ icdp: "hello", v, title, url }` to the parent.
3. The Host checks `event.origin` against the Pairing's `origins`, creates a `MessageChannel`, and posts `{ icdp: "welcome", v }` to the iframe, transferring one port. That port becomes the command channel; the Pairing is now connected, and the Host emits `targetInfoChanged` carrying the real `title` and `url`.

The iframe's `load` event re-probes the Pairing only when it has no channel yet. A genuine reload of an already-connected document re-announces on its own with a fresh hello; the Host treats that second hello as a reload, fails any in-flight commands with `Target reloaded`, and re-opens the channel — the `targetId` is unchanged throughout. (See [The handshake](/reference/host) in the reference for the exact message shapes.)

## Observe Targets

Read the current set:

```ts
host.targets();
// [{ targetId: "preview", title: "My App", url: "https://app.example.com/" }]
```

Subscribe to changes. `onTargets` returns an unsubscribe function:

```ts
const off = host.onTargets((event) => {
  switch (event.kind) {
    case "targetCreated":
      console.log("new target", event.target.targetId);
      break;
    case "targetInfoChanged":
      console.log("connected / navigated", event.target.url);
      break;
    case "targetDestroyed":
      console.log("gone", event.targetId);
      break;
  }
});

// later
off();
```

A freshly paired Target produces `targetCreated` at `pair()` time and a `targetInfoChanged` once the handshake completes. A reload or in-iframe navigation produces another `targetInfoChanged` with the new `title`/`url`.

## Destroy a Target

`unpair(targetId)` is the only way a Target dies. It fails any in-flight commands (CDP error code `-32000`), closes the command port, removes the iframe `load` listener, and emits `targetDestroyed`. It is idempotent — calling it for an unknown or already-removed `targetId` is a no-op:

```ts
host.unpair("preview");
```

`host.destroy()` unpairs every Target, closes the Relay uplink, and removes the Host's window message listener.

## Consume the Target

A registered, connected Target can be driven two ways:

- **Locally, with no server in the path.** `host.attach(targetId)` returns a session you send CDP commands on and subscribe to events from directly in the parent window — useful for a console panel or an inline inspector. See [Build a local console panel](/guides/local-console-panel).
- **Over a Relay, for external Clients.** `host.connectRelay({ url })` opens an uplink to a Relay that exposes a Chrome-compatible CDP endpoint, so tools like agent-browser can attach. See [Run a Relay](/guides/run-a-relay).

Both consume the same hub at once: events broadcast to every attached session, and domain enables are ref-counted per Target, so a local panel's `Runtime.enable` and a Client's coexist.

## Related

- [Host reference](/reference/host) — full method signatures, options, and handshake details.
- [Target lifecycle](/explanation/target-lifecycle) — why identity belongs to the Pairing and survives reloads.
