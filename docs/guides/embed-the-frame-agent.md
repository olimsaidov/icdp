---
description: "Make your app drivable when embedded in an iframe by shipping the Frame Agent and allowlisting its parents."
---

# Embed the Frame Agent in your app

You want your app to be drivable over CDP while it runs inside an iframe — including a cross-origin iframe — so an external [Client](/explanation/concepts) can snapshot, click, type, and eval against it. icdp does this with [cooperative embedding](/explanation/architecture): your app ships the [Frame Agent](/explanation/concepts) itself, and the [Host](/explanation/concepts) in the parent window never injects code across the boundary.

This guide covers the embedded-app side only. Pairing the iframe from the parent is a separate step — see [Pair an iframe](/guides/pair-an-iframe).

## Install

```sh
npm install @olimsaidov/icdp
```

The package is ESM only.

## Boot the agent

Import `startFrameAgent` from the `frame` subpath and call it once at startup. List the parent origins that are allowed to drive your app in `allowedParents`:

```ts
import { startFrameAgent } from "@olimsaidov/icdp/frame";

startFrameAgent({ allowedParents: ["https://shell.example.com"] });
```

That is the whole integration. On boot the agent installs a console bridge and posts a `hello` announcement to `window.parent` (to each allowed origin). It retries the announcement up to 10 times at 300 ms intervals until a parent adopts the channel. When an allowlisted parent answers with a `welcome` carrying a transferred `MessagePort`, the agent adopts that port as its command channel and begins serving CDP requests against the real DOM.

## Why the call is unconditional

`startFrameAgent` is safe to call from your normal startup path with no environment check:

- It is a no-op if it has already been started.
- It is a no-op when `window.parent === window`, i.e. when the page is not embedded.

So a top-level visit to your app does nothing; only an embedded load announces.

## Dormant until welcomed

The agent announces on boot, but it does not act on that announcement by itself. It adopts a command channel — and exposes the DOM — **only** when a parent whose origin is in `allowedParents` replies with a `welcome`. Until then it stays dormant: it answers a `probe` with a fresh announcement, but it ignores any handshake message from an origin that is not on the allowlist.

A wildcard skips the origin check entirely:

```ts
startFrameAgent({ allowedParents: "*" });
```

::: danger allowedParents: "\*" trusts any embedder
`"*"` hands DOM read, write, and `eval` to **any** page that frames yours. Any embedder can drive the app, read its DOM, and run arbitrary code in its origin. Use it only for pages that are themselves sandboxed or throwaway. For anything real, list exact parent origins.
:::

## What the agent exposes

Once a channel is adopted, the agent dispatches incoming CDP requests against the live DOM. The registered domain surface (Accessibility, DOM, CSS, Input, Page, Runtime, and more) is enumerated in [CDP support](/reference/cdp-support). A few behaviors worth knowing while you integrate:

- **Same-origin navigation only.** `Page.navigate` is restricted to your app's own origin; a cross-origin URL throws. (Cross-app navigation that keeps the Target alive is the parent's concern — see [Target lifecycle](/explanation/target-lifecycle).)
- **Runtime events queue before `Runtime.enable`.** `Runtime.consoleAPICalled` and other Runtime events are buffered (cap ~200) until the Client calls `Runtime.enable`, then flushed. The single execution context has id `1` and name `top`.
- **Unknown methods fail cleanly.** A method the agent does not register returns a CDP error with code `-32000`.

Screenshots, PDF, file uploads, drag-and-drop, dialogs, and real network interception are intentionally unsupported, because page JavaScript cannot provide them.

## Next steps

- Register the iframe as a Target from the parent: [Pair an iframe](/guides/pair-an-iframe).
- The exact `startFrameAgent` signature, options, and handshake messages: [Frame reference](/reference/frame).
- The full registered command surface: [CDP support](/reference/cdp-support).
