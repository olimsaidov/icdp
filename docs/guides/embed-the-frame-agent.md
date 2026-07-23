---
description: "Ship the cooperative Frame Agent in an iframe app and allowlist its parent."
---

# Embed the Frame Agent

Install the ESM package:

```sh
npm install @olimsaidov/icdp
```

Start the agent from the embedded application's normal startup path:

```ts
import { startFrameAgent } from "@olimsaidov/icdp/frame";

startFrameAgent({
  allowedParents: ["https://shell.example.com"],
});
```

Importing the module has no side effects. The call is idempotent and does
nothing when the page is not framed.

The iframe announces itself to the allowed parent, accepts a transferred
`MessagePort` only from that parent, and then serves Session-scoped CDP
against its own document. The parent separately registers the iframe with
[`host.pair()`](/guides/pair-an-iframe).

## Origin policy

The Frame Agent can read and modify the DOM and evaluate code in the app's
origin. Keep the allowlist exact.

```ts
// Only for disposable or separately sandboxed pages:
startFrameAgent({ allowedParents: "*" });
```

`"*"` trusts any embedder. The Host's Pairing also has an `origins` allowlist;
both ends must accept the handshake.

## Integration behavior

- `Page.navigate` is restricted to the current origin.
- Runtime console calls are retained in a bounded backlog and delivered to
  each Session when it enables Runtime.
- Network observation begins when at least one Session enables Network and
  covers page-created fetch, XHR, and WebSocket activity.
- A new document handshake keeps Host Target/Session identity but recreates
  document-scoped DOM ids and Runtime handles.
- Unsupported methods return `-32601`.

The Frame Agent cannot provide screenshots/PDF, trusted native input, the
browser network stack, V8 debugging, workers, or cross-origin child-frame
DOM. See [CDP support](/reference/cdp-support) for the exact 38 commands and
hard limits.
