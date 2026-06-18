---
description: "Boot the bundled playground and drive a real cross-origin iframe with agent-browser, from first snapshot to navigation and Client-created Targets."
---

# Tutorial: drive an embedded app end to end

This takes you through the whole icdp chain once, top to bottom. You boot the bundled playground — a shell page that is the [Host](/explanation/concepts), a [Relay](/explanation/concepts) with separate Host and CDP ports, and a cross-origin app served as two [Targets](/explanation/concepts) — then drive one of those Targets from outside with the `agent-browser` [Client](/explanation/concepts). By the end you will have snapshotted an accessibility tree, clicked a below-fold control, asserted page state, navigated across documents, opened and closed a Target from the Client, and watched an intentionally unsupported command fail cleanly.

Every command here is copy-pasteable and guaranteed to work against a fresh checkout. Follow the links when you want the why.

## Prerequisites

- A clone of the [repository](https://github.com/olimsaidov/icdp) with `npm install` already run.
- Node >= 22 (the Relay runs on Node).
- The `agent-browser` CLI and Chrome installed. `agent-browser` is external prior art — it is not bundled with icdp, and it is the Client you will drive the chain with.

## 1. Boot the playground

From the repository root:

```sh
npm run playground
```

This bundles the shell and the [Frame Agent](/explanation/concepts), then starts the [full icdp topology](/explanation/architecture) — Client → Relay → Host → Frame Agent — on fixed ports.

The shell page at `http://127.0.0.1:3000` is the Host. It embeds **two cross-origin Targets** served from `http://127.0.0.1:3001`. The private CDP endpoint listens on port `9222`:

- **`playground`** — a feature-dense app: forms, SPA tabs via `history.pushState`, async zones, console buttons, shadow DOM, a nested `srcdoc` iframe, hidden cases, mouse/scroll boxes, full navigation to `/page-two`, and `window.playgroundState()` for `eval` assertions.
- **`todo`** — a second Target, so multi-target discovery has something to find.

Leave this process running. The terminal prints the shell URL, the cross-origin app origin, and the CDP browser endpoint.

::: tip
`ICDP_DEBUG=1 npm run playground` logs all Relay traffic, which is the fastest way to see the flat-session protocol on the wire. Override ports with `ICDP_PLAYGROUND_HOST_PORT`, `ICDP_PLAYGROUND_CDP_PORT`, and `ICDP_PLAYGROUND_APP_PORT`.
:::

## 2. Open the shell in a browser

Open `http://127.0.0.1:3000` in any browser. You are now looking at the Host's own page. Three things to notice:

- The **targets grid** — one uniform panel per Target. Right now it holds the two boot Targets, `playground` and `todo`.
- The **live target table** — every Target's `targetId`, title, and URL, updated as Targets are created, reloaded, and destroyed.
- The **console panel** — fed by a **local [Session](/explanation/concepts)**. The shell calls `host.attach(targetId)` and renders the app's console output with no Relay in that path at all. Click one of the app's console buttons and watch a log line arrive; that round trip never leaves the parent window.

The status endpoint at `http://127.0.0.1:9222/icdp/status` reports whether a Host is connected to the Relay and what Targets it has.

## 3. Sync the Client with one `wait`

`agent-browser` keeps a page model that must be synced from the live Target before it can resolve locators. Issue one `wait` as the very first command — it both attaches and syncs:

```sh
agent-browser --cdp 9222 wait --text "icdp Playground"
```

The `--cdp 9222` flag points `agent-browser` at the Relay's browser endpoint on port 9222. Under the hood this is the flat-session protocol: the Client calls `Target.getTargets`, attaches to one Target, and routes by `sessionId` — there are no per-target WebSocket URLs.

::: warning
Do not use `agent-browser connect <ws-url>`. As of `agent-browser` 0.27.x the session-bound `connect` no longer routes follow-up commands (this reproduces against real Chrome too — it is not an icdp limitation). Always use the per-command `--cdp <port>` flag, as shown.
:::

## 4. Snapshot the accessibility tree

```sh
agent-browser --cdp 9222 snapshot -i
```

This prints the app's accessibility tree, computed by the Frame Agent against the real DOM and returned over CDP. The `-i` flag includes interactive-element indices you can act on. Note that the hidden cases in the app do **not** appear: the snapshot reflects what assistive technology would expose, not the raw markup. (For how the tree is built, see [The accessibility tree](/explanation/accessibility-tree).)

## 5. Interact with a below-fold control

The `playground` app has a button, `#load-data` ("Load lab results (1.5s)"), below the fold. Coordinate-based clicks resolve via `elementFromPoint` inside the frame, so scroll the element into view first or the click silently misses:

```sh
agent-browser --cdp 9222 scrollintoview "#load-data"
agent-browser --cdp 9222 click "#load-data"
agent-browser --cdp 9222 wait --text "Lab results loaded"
```

The button kicks off a delayed async zone; the final `wait --text` blocks until the results render. You drove a click and a wait through the entire chain — Client → Relay → Host → Frame Agent → DOM — across an origin boundary.

## 6. Assert page state with `eval`

The app exposes `window.playgroundState()` for assertions. `eval` runs in the Target's real execution context:

```sh
agent-browser --cdp 9222 eval "window.playgroundState()"
```

The returned object reflects the live page, including the lab results you just loaded. `Runtime.evaluate` uses indirect eval in the single execution context (id 1, name `top`).

## 7. Cross a navigation and keep the same Target

[Target identity belongs to the Pairing, not the document](/explanation/target-lifecycle): a full navigation to another page keeps the same `targetId`. Navigate the app to its second document and back:

```sh
agent-browser --cdp 9222 click "#link-page-two"
agent-browser --cdp 9222 wait --text "Page Two"
agent-browser --cdp 9222 click "#back-home"
agent-browser --cdp 9222 wait --text "icdp Playground"
```

The `#page-two` document loads, the page reads "Target identity survived the navigation," and `#back-home` returns you to the app — all on **one** Target. Watch the live target table in the shell: the row's URL changes, but the `targetId` does not. Clients see this as `Page.frameNavigated`, never a `targetDestroyed`/`targetCreated` pair.

## 8. Open and close a Target from the Client

The shell passes `onCreateTarget` / `onCloseTarget` to `IcdpHost`, so a Client can open Targets on demand. `agent-browser`'s `tab` commands map straight onto the lifecycle methods:

```sh
agent-browser --cdp 9222 tab list                                # Target.getTargets
agent-browser --cdp 9222 tab new http://127.0.0.1:3001/page-two  # Target.createTarget -> new iframe
agent-browser --cdp 9222 tab list
agent-browser --cdp 9222 tab close t3                            # Target.closeTarget -> iframe removed
```

The new Target appears as another panel in the **same targets grid**, indistinguishable from the boot two. `Target.createTarget` resolves only once the new Target finishes its handshake, so your first follow-up command cannot race the gate. `tab close` removes the panel; a boot Target closes the same way.

::: info
Point `tab new` at a non-app origin (for example `https://example.com`, which carries no Frame Agent) and the create **times out and rolls the half-made Target back** instead of leaving a zombie. The Host awaits the handshake and tears down a Pairing that never connects.
:::

## 9. Watch a graceful, intentional failure

Page JavaScript cannot produce a screenshot, so the Frame Agent does not register it. Run it and watch it fail cleanly rather than hang:

```sh
agent-browser --cdp 9222 screenshot out.png
```

The Client gets back a CDP error, not a crash. Screenshots, PDF, file uploads, drag-and-drop, dialogs, and real network interception are [intentionally unsupported](/reference/cdp-support) — the compatibility bar is `agent-browser`'s support matrix, and these fall outside what a DOM can emulate.

## Recap

You ran the full icdp chain end to end:

- Booted the playground: a Host, a Relay, and two cross-origin Frame-Agent Targets.
- Synced `agent-browser` with one `wait`, then snapshotted the accessibility tree.
- Scrolled, clicked, waited on an async result, and asserted state with `eval`.
- Crossed a navigation while the `targetId` stayed put.
- Opened and closed a Target from the Client, watching it join the grid like a boot Target.
- Saw an unsupported command fail by design.

## Where next

- [Drive with agent-browser](/guides/drive-with-agent-browser) — the full command recipe and pitfalls against your own app.
- [Pair an iframe](/guides/pair-an-iframe) and [Embed the Frame Agent](/guides/embed-the-frame-agent) — wire your own Host and app instead of the playground.
- [Client-driven targets](/guides/client-driven-targets) — implement `onCreateTarget` / `onCloseTarget` yourself.
- [CDP support matrix](/reference/cdp-support) — exactly which methods the Frame Agent registers, and what is intentionally out.
- [Architecture](/explanation/architecture) and [Target lifecycle](/explanation/target-lifecycle) — why the chain is shaped this way and why Target identity outlives the document.
