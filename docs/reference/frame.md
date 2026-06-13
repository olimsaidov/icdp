---
description: "API reference for startFrameAgent and FrameAgentOptions — the Frame Agent that runs inside the embedded app."
---

# @olimsaidov/icdp/frame

The `/frame` entry point exports a single function. The [Frame Agent](/explanation/concepts) it boots runs inside the embedded app, emulates a fixed set of CDP domains against the real DOM, and executes commands the [Host](/explanation/concepts) routes to it over a [MessagePort](/reference/protocol).

For a walkthrough of including the agent in your app, see [Embed the Frame Agent](/guides/embed-the-frame-agent).

```ts
import { startFrameAgent } from "@olimsaidov/icdp/frame";
```

## `startFrameAgent(options)`

```ts
function startFrameAgent(options: FrameAgentOptions): void
```

Boots the Frame Agent in the current document. Returns nothing.

The call is idempotent and safe to make unconditionally: it is a no-op when the agent has already started in this document, or when the page is not embedded (`window.parent === window`).

## `FrameAgentOptions`

```ts
type FrameAgentOptions = {
  allowedParents: string[] | "*";
};
```

| Field | Type | Description |
| --- | --- | --- |
| `allowedParents` | `string[] \| "*"` | Origins permitted to act as Host. The agent announces itself to every listed origin but adopts a command channel only from a parent whose origin matches. `"*"` matches any parent origin. |

::: danger allowedParents "\*"
`"*"` hands DOM read, DOM write, and `Runtime.evaluate` to ANY embedder. Use it only for pages that are themselves sandboxed or throwaway. For production embeds, list the exact Host origins.
:::

## Behavior

The following hold for a call that is not a no-op (the page is embedded and the agent has not yet started).

### Boot

- Installs a console bridge. It wraps `console` methods (`clear`, `debug`, `dir`, `error`, `group`, `groupCollapsed`, `groupEnd`, `info`, `log`, `table`, `warn`) so each call still runs the original and also emits a `Runtime.consoleAPICalled` event.
- Posts a [`hello`](/reference/protocol) (`{ icdp: "hello", v, title, url }`) to `window.parent`. The message is posted to each origin in `allowedParents`, or to `"*"` when `allowedParents` is `"*"`.
- Retries the `hello` announcement up to 10 times at 300ms intervals. Retrying stops as soon as a command channel is adopted, or after the tenth attempt.

### Handshake

The agent listens for [handshake messages](/reference/protocol) from `window.parent`. It ignores any message whose source is not `window.parent`, and any whose origin is not allowed by `allowedParents`.

- On a [`probe`](/reference/protocol) (`{ icdp: "probe", v }`), it re-announces a `hello`.
- On a [`welcome`](/reference/protocol) (`{ icdp: "welcome", v }`) carrying a transferred `MessagePort`, it adopts that port as the command channel. Adopting a port closes any port held previously, then emits `Page.frameNavigated`, `Page.domContentEventFired`, and `Page.loadEventFired`.

The agent is dormant until it adopts a channel: it announces, but it never adopts a port from a parent whose origin is not in `allowedParents` (or unless `allowedParents` is `"*"`).

### Command dispatch

Commands arrive as JSON CDP requests over the adopted port. The agent dispatches them through [chobitsu](https://github.com/liriliri/chobitsu) and icdp's registered domain handlers, and posts each response (or event) back over the same port. An unknown method returns a CDP error with code `-32000` and message `Method not found: <method>`. For the full list of registered methods, see [CDP support](/reference/cdp-support).

Notable per-method behavior:

- `Page.navigate` is restricted to the embedded app's own origin. A cross-origin URL throws (`Navigation outside the embedded app's origin is not allowed`).
- `Runtime.evaluate` and `Runtime.callFunctionOn` run the supplied expression or function with indirect `eval`. Both honor `awaitPromise`: when set and the value is a `Promise`, the agent awaits it before returning the result.
- Runtime events (including `Runtime.consoleAPICalled`) are queued until `Runtime.enable`, then flushed in order. While disabled the queue is capped (oldest dropped past ~200 entries). `Runtime.enable` emits `Runtime.executionContextCreated` for the single execution context, whose `id` is `1` and `name` is `top`.
