---
description: "API reference for IcdpHost — the parent-window hub: constructor, options, methods, and the types it uses."
---

# @olimsaidov/icdp/host

The `host` entry point exports [`IcdpHost`](/explanation/concepts), the parent-window hub. An `IcdpHost` pairs with [Frame Agents](/explanation/concepts), holds [Target](/explanation/concepts) identity in [Pairings](/explanation/concepts), fans CDP [Sessions](/explanation/concepts) out to consumers, and optionally opens an uplink to a [Relay](/explanation/concepts). Local consumers (e.g. a console panel) and the Relay uplink are both consumers of the same hub; the Relay uplink carries no special privilege.

```ts
import { IcdpHost } from "@olimsaidov/icdp/host";
```

For the recipes that use this surface, see [Pair an iframe](/guides/pair-an-iframe), [Local console panel](/guides/local-console-panel), and [Client-driven targets](/guides/client-driven-targets). The shared message and type definitions live in [@olimsaidov/icdp/protocol](/reference/protocol).

## Constructor

```ts
new IcdpHost(optionsOrWindow?: IcdpHostOptions | WindowLike)
```

The argument is either an [`IcdpHostOptions`](#icdphostoptions) object or a bare [`WindowLike`](#structural-shapes). A bare window is accepted for back-compat: if the argument has an `addEventListener` member it is treated as the window and wrapped as `{ window }`. When no argument is given, the options default to `{}` and the window defaults to the global `window`.

The constructor installs a single `message` listener on the window for the handshake; [`destroy()`](#destroy) removes it.

| Argument | Type | Default | Effect |
| --- | --- | --- | --- |
| `optionsOrWindow` | `IcdpHostOptions \| WindowLike` | `{}` | Options object, or a bare window (back-compat). |

### IcdpHostOptions

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `window` | `WindowLike` | global `window` | The window to listen on for handshake messages. |
| `onCreateTarget` | `(params: CreateTargetParams) => string \| Promise<string>` | — | Handle a Client's `Target.createTarget`: create and `pair()` an iframe, then return its `targetId`. Throw to reject the request. |
| `onCloseTarget` | `(targetId: string) => void \| Promise<void>` | — | Handle a Client's `Target.closeTarget`: tear the Target down (e.g. `unpair()` plus removing the iframe). Throw to reject. |

Setting `onCreateTarget` and/or `onCloseTarget` causes the matching method to be advertised by [`handledMethods()`](#handledmethods), which the uplink sends to the Relay so it forwards those requests to this Host. See [Client-driven targets](/guides/client-driven-targets).

## Methods

### pair

```ts
pair(iframe: FrameElementLike, options: PairOptions): void
```

Registers an iframe slot as a Target. The Pairing owns the Target identity. Adds a `load` listener to the iframe, probes the iframe immediately, and emits a `targetCreated` event.

- **Throws** if `options.targetId` is already paired (`Target "<id>" is already paired`).
- The `load` listener re-probes only when the Pairing has no channel yet; a connected Pairing is not re-probed. See [Target lifecycle](/explanation/target-lifecycle).

### unpair

```ts
unpair(targetId: string): void
```

Destroys a Pairing. This is the only way a Target dies. Removes the iframe `load` listener, fails all in-flight commands with reason `Target destroyed`, closes the [MessagePort](/explanation/concepts), and emits a `targetDestroyed` event. Idempotent: a no-op for an unknown `targetId`.

### targets

```ts
targets(): TargetSummary[]
```

Returns a [`TargetSummary`](/reference/protocol) for every current Pairing.

### onTargets

```ts
onTargets(listener: (event: TargetEvent) => void): () => void
```

Subscribes to Target lifecycle events. Returns an unsubscribe function. See [`TargetEvent`](#targetevent).

### attach

```ts
attach(targetId: string): LocalSession
```

Attaches a local consumer to a Target with no server in the path. Returns a [`LocalSession`](#localsession).

- **Throws** for an unknown `targetId` (`Unknown target "<id>"`).
- `LocalSession.send()` rejects with an `Error` carrying a numeric `.code` when the frame returns a CDP error.

See [Local console panel](/guides/local-console-panel).

### connectRelay

```ts
connectRelay(options: RelayUplinkOptions): () => void
```

Opens the Relay uplink, structurally just another consumer of this hub. Returns a disconnect function. Replaces any existing uplink (the previous one is closed first). The uplink auto-reconnects on close, with a default delay of 500 ms (see [`RelayUplinkOptions`](#relayuplinkoptions)). On connect it announces a `ready` message carrying the current targets and the advertised handled methods.

### handledMethods

```ts
handledMethods(): string[]
```

Returns the browser-level methods this Host handles, derived from the options: `"Target.createTarget"` when `onCreateTarget` is set, `"Target.closeTarget"` when `onCloseTarget` is set. The uplink sends this list to the Relay so it forwards those methods instead of using its built-in default.

### handleBrowserRequest

```ts
handleBrowserRequest(method: string, params: Record<string, unknown>): Promise<unknown>
```

Runs a browser-level method this Host advertised. Invoked by the Relay uplink in response to a `browserRequest`; the resolved value, or a thrown error, becomes the Client's response.

- For `Target.createTarget`: calls `onCreateTarget(params)`, then awaits the new Target's handshake (default timeout 10 000 ms). On success it returns `{ targetId }`. If the Target does not connect — timeout, or destroyed mid-handshake — it `unpair()`s the half-made Pairing and rethrows.
- For `Target.closeTarget`: calls `onCloseTarget(String(params.targetId ?? ""))` and returns `{ success: true }`.
- **Throws** if the corresponding hook is unset (`<method> is not handled by this Host`), or for any other method (`Unhandled browser method: <method>`).

### destroy

```ts
destroy(): void
```

Closes the uplink, `unpair()`s every Target, and removes the window `message` listener.

## Types

### PairOptions

```ts
type PairOptions = {
  targetId: string;
  origins: string[] | "*";
};
```

| Field | Type | Description |
| --- | --- | --- |
| `targetId` | `string` | Stable Target id for this Pairing. Survives reloads and navigations. |
| `origins` | `string[] \| "*"` | Frame origins allowed to pair into this slot, or `"*"` to accept whatever the iframe element currently hosts. The Host checks the `hello` event origin against this allowlist before sending `welcome`. |

### LocalSession

```ts
type LocalSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  detach(): void;
};
```

| Member | Signature | Description |
| --- | --- | --- |
| `send` | `(method, params?) => Promise<unknown>` | Sends a CDP command to the Target. Resolves with the result, or rejects with an `Error` whose `.code` carries the CDP error code. `params` defaults to `{}`. |
| `onEvent` | `(listener) => () => void` | Subscribes to CDP events from the Target. Returns an unsubscribe function. |
| `detach` | `() => void` | Removes this Session and releases its ref-counted domain enables. |

### TargetEvent

```ts
type TargetEvent =
  | { kind: "targetCreated"; target: TargetSummary }
  | { kind: "targetDestroyed"; targetId: string }
  | { kind: "targetInfoChanged"; target: TargetSummary };
```

| `kind` | Payload | Emitted when |
| --- | --- | --- |
| `targetCreated` | `target: TargetSummary` | `pair()` registers a new Pairing. |
| `targetDestroyed` | `targetId: string` | `unpair()` destroys a Pairing. |
| `targetInfoChanged` | `target: TargetSummary` | A Target completes a handshake (initial connect, reload, or navigation under the same `targetId`). |

[`TargetSummary`](/reference/protocol) is `{ targetId: string; title: string; url: string }`.

### RelayUplinkOptions

```ts
type RelayUplinkOptions = {
  url: string;
  reconnectDelayMs?: number;
  webSocketFactory?: (url: string) => WebSocket;
};
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | — | Bridge WebSocket URL on the Relay, e.g. `ws://host/icdp/host`. |
| `reconnectDelayMs` | `number` | `500` | Delay before re-connecting after the socket closes. |
| `webSocketFactory` | `(url: string) => WebSocket` | `new WebSocket(url)` | Custom WebSocket constructor, for non-browser runtimes and tests. |

### CreateTargetParams

```ts
type CreateTargetParams = { url?: string } & Record<string, unknown>;
```

The params of a Client's `Target.createTarget` request, passed to `onCreateTarget`. `url` is the requested target URL; any other CDP fields pass through.

### Structural shapes

`FrameElementLike` and `WindowLike` are minimal structural views of an iframe element and the parent window, declared so callers can supply fakes in tests. A real `HTMLIFrameElement` satisfies `FrameElementLike` and a real `Window` satisfies `WindowLike`.

```ts
type FrameElementLike = {
  contentWindow: {
    postMessage: (message: unknown, targetOrigin: string, transfer?: Transferable[]) => void;
  } | null;
  addEventListener: (type: "load", listener: () => void) => void;
  removeEventListener: (type: "load", listener: () => void) => void;
};

type WindowLike = {
  addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
};
```

## Semantics

- **Pairing-owned identity.** The `targetId` belongs to the Pairing, not the iframe element or its document. Reloads, remounts, and cross-app navigations keep the same `targetId`, surfaced as a `targetInfoChanged` event (and as `Page.frameNavigated` to Clients). Only `unpair()` destroys the Target. See [Target lifecycle](/explanation/target-lifecycle).
- **Document death fails commands.** Commands in flight when a document dies fail fast with CDP error code `-32000` and are never replayed. A second `hello` (a reload) fails pending commands with reason `Target reloaded` and re-opens the channel; `unpair()` fails them with reason `Target destroyed`.
- **Ref-counted enables.** Domain enables are ref-counted per Target across consumers, so the Relay's `enable` and a local panel's `enable` coexist. A `.disable` is only forwarded to the frame when the last holder releases the domain; detaching a Session releases its holds.
- **New-wins uplink.** `connectRelay()` replaces any existing uplink. On the Relay side, a newly connecting Host takes over from a stale one.

::: info Uplink internals
`dispatch`, `dispatchTo`, `releaseEnables`, and `releaseEnablesFor` are present on the class as Relay-uplink internals. They are called by the uplink to route commands and release enable refs and are not part of the everyday surface; use `attach()` and `connectRelay()` instead.
:::
