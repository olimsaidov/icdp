---
description: "Reference for starting the cooperative in-page Frame Agent."
---

# `@olimsaidov/icdp/frame`

```ts
import { startFrameAgent } from "@olimsaidov/icdp/frame";

startFrameAgent({
  allowedParents: ["https://shell.example.com"],
});
```

## `startFrameAgent(options): void`

`FrameAgentOptions` contains one required field:

```ts
type FrameAgentOptions = {
  allowedParents: string[] | "*";
};
```

The module is inert on import. Calling `startFrameAgent` in a top-level window
does nothing, and repeated calls in the same document do nothing.

In an iframe, the agent:

1. announces `{ icdp: "hello", v, title, url }` to the allowed parent origins;
2. retries up to ten times at 300 ms intervals and answers later probes;
3. accepts `welcome` only from `window.parent` at an allowed origin;
4. adopts the transferred `MessagePort`;
5. installs console observation and starts serving explicit Session messages.

A bfcache `pageshow` announcement lets the Host reconnect a restored document.
Adopting a replacement port clears Frame Sessions; the Host recreates them
with their enabled-domain state.

## Security

The agent can expose DOM content, synthesize page events, navigate within its
origin, and evaluate JavaScript in the framed origin. Use exact
`allowedParents` values.

`allowedParents: "*"` grants those capabilities to any embedder. It is
appropriate only for disposable pages or where another sandbox is the actual
security boundary.

The Host independently checks the origin configured in `pair()`. Both checks
must pass before it transfers a port.

## Protocol behavior

The Frame Agent keeps one document backend and creates an independent
`FrameSession` for each `attach` message. Commands with an unknown Session are
rejected. Unknown methods return `-32601`; missing required parameters return
`-32602`; implementation failures return `-32000`.

The exact command surface is listed in [CDP support](/reference/cdp-support).
