---
description: "Delegate Target.createTarget and Target.closeTarget to the Host so a Client can open and close Targets itself."
---

# Let Clients open and close Targets

You have a [Host](/explanation/concepts) that pairs iframes as [Targets](/explanation/concepts), and an external [Client](/explanation/concepts) — agent-browser, `chrome-remote-interface` — driving them through a [Relay](/explanation/concepts). You want the Client to open and close Targets on its own, not just consume the ones the Host paired at boot via `pair()`.

This guide assumes you already have a Host wired to a Relay. If you do not, set those up first with [Pair an iframe](/guides/pair-an-iframe) and [Run a Relay](/guides/run-a-relay).

## The default: no Client-driven lifecycle

Out of the box the Relay owns the `Target` registry. A Client's `Target.createTarget` is rejected:

```text
Target.createTarget is not supported: icdp targets are iframes paired by the Host.
```

and `Target.closeTarget` is answered locally as a no-op returning `{ success: true }`. The Relay does this because `Target` identity belongs to the [Pairing](/explanation/concepts) — only the Host can mint or destroy a Pairing, so only the Host can honour these two methods.

## Pass the two hooks to the Host

Hand `onCreateTarget` and `onCloseTarget` to the `IcdpHost` constructor. `onCreateTarget` receives the [`CreateTargetParams`](/reference/host) the Client sent (including `url`), creates an iframe, `pair()`s it, and returns the new `targetId` (a `string` or a `Promise<string>`). `onCloseTarget` receives the `targetId` and tears the Target down — `unpair()` plus removing the iframe element you made.

```ts
import { IcdpHost } from "@olimsaidov/icdp/host";

const host = new IcdpHost({
  onCreateTarget: ({ url }) => {
    const iframe = document.createElement("iframe");
    iframe.src = url ?? "about:blank";
    document.body.append(iframe);
    const targetId = crypto.randomUUID();
    host.pair(iframe, { targetId, origins: ["https://app.example.com"] });
    return targetId; // string | Promise<string>
  },
  onCloseTarget: (targetId) => {
    host.unpair(targetId);
    // also remove the iframe element you appended above
  },
});

host.connectRelay({ url: "ws://127.0.0.1:3000/icdp/host" });
```

The `url` you pair into must carry the [Frame Agent](/explanation/concepts), and the origin you pass to `pair()` must be on the agent's `allowedParents`; otherwise the handshake never completes and the create rolls back (see below). The Host never injects the agent — the embedded app includes it. See [Embed the Frame Agent](/guides/embed-the-frame-agent).

## How the Relay routes only what you handle

The Host advertises which browser-level methods it handles in its `ready` message to the Relay; `handledMethods()` returns `Target.createTarget` and/or `Target.closeTarget` for exactly the hooks you set. The Relay forwards those to the Host as a `browserRequest` and keeps its built-in default for any method you leave unhandled. Set only `onCreateTarget`, and `Target.closeTarget` stays the Relay's no-op.

Only `Target.createTarget` and `Target.closeTarget` are forwardable. The registry methods — `Target.getTargets`, `Target.attachToTarget`, `Target.setAutoAttach`, `Target.setDiscoverTargets` — stay Relay-owned, because they read the Relay's own session and target state, which the Host cannot answer. See the [Relay reference](/reference/relay).

## The await-connect contract

`Target.createTarget` does not resolve when your `onCreateTarget` returns. The Host awaits the new Target's handshake first, so the Client's response carries a `targetId` for a Target that is already connected. The Client's first command — typically an attach, then `Runtime.enable` — cannot race the not-connected gate.

If the Target never connects — the handshake does not complete within 10 s, or the Pairing is destroyed mid-handshake — the Host unpairs the half-made Pairing and the request fails. The Target is rolled back automatically; it never lingers as a zombie in the Host, the Relay, or `Target.getTargets`. The unpair is idempotent, so your `onCreateTarget` does not need its own cleanup for this case.

::: info
The Relay also bounds the forwarded request with `browserRequestTimeoutMs` (default 30000 ms), a separate backstop against a silent or hung Host. The 10 s handshake timeout inside the Host fires first under normal conditions.
:::

For the full picture of identity, reloads, and teardown, see [Target lifecycle](/explanation/target-lifecycle).

## Drive it with agent-browser

With both hooks wired, agent-browser's `tab` commands map straight onto the lifecycle methods:

```sh
agent-browser --cdp 9222 tab list                                # Target.getTargets
agent-browser --cdp 9222 tab new http://127.0.0.1:3001/page-two  # Target.createTarget -> new iframe
agent-browser --cdp 9222 tab close t3                            # Target.closeTarget -> iframe removed
```

`tab new` returns once the new Target has connected, so a follow-up command on it lands. Pointing `tab new` at a non-app origin — `https://example.com`, which carries no Frame Agent — makes the create time out and roll the half-made Target back instead of leaving a zombie.

::: warning
`onCreateTarget` lets a connected Client spawn iframes pointing at any `url` it asks for. Validate or constrain the `url` if the Relay is reachable by anything you do not trust, and keep `pair()`'s `origins` to a real allowlist rather than `"*"`.
:::

## See also

- [Host reference](/reference/host) — `IcdpHostOptions`, `handledMethods`, `handleBrowserRequest`.
- [Relay reference](/reference/relay) — which methods the Relay answers itself versus forwards.
- [Target lifecycle](/explanation/target-lifecycle) — why identity belongs to the Pairing.
