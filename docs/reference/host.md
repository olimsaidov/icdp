---
description: "Reference for IcdpHost, the Target and DevTools-session owner."
---

# `@olimsaidov/icdp/host`

```ts
import { IcdpHost } from "@olimsaidov/icdp/host";

const host = new IcdpHost();
```

The Host pairs iframe slots, owns Target and Session state, implements
browser/Target CDP methods, and routes Session commands to Frame Agents.

## Constructor

```ts
new IcdpHost(options?: IcdpHostOptions)
```

```ts
type IcdpHostOptions = {
  window?: WindowLike;
  product?: string;
  onCreateTarget?: (params: CreateTargetParams) => string | Promise<string>;
  onCloseTarget?: (targetId: string) => void | Promise<void>;
};

type CreateTargetParams = {
  url: string;
} & Record<string, unknown>;
```

`window` defaults to the global `window`. `product` defaults to `icdp/0.5.1`
for `Browser.getVersion`. A bare `WindowLike` is still accepted as the
constructor argument.

The lifecycle hooks are optional. Without the corresponding hook,
`Target.createTarget` or `Target.closeTarget` returns a CDP server error.
After `onCloseTarget` resolves, the Host queues the success response and then
unpairs the Target. The hook should release external resources such as the
iframe; it does not need to call `unpair`.

## Pairings

### `pair(iframe, options): void`

```ts
host.pair(iframe, {
  targetId: "app",
  origins: ["https://app.example.com"],
});
```

`targetId` must be unique. `origins` is a string array or `"*"`. The Host
probes the iframe, accepts `hello` only from that iframe window at an allowed
origin, and transfers a `MessagePort` with `welcome`.

The Pairing is visible as a Target before its Frame Agent connects. Commands
against a disconnected Pairing fail with `-32000`.

### `unpair(targetId): void`

Ends every Session for the Target, fails pending commands, closes the port,
removes the iframe load listener, and emits `targetDestroyed`. Unknown ids are
ignored.

### `targets(): TargetSummary[]`

Returns current Pairings as `{ targetId, title, url }`.

### `onTargets(listener): () => void`

Subscribes to `targetCreated`, `targetDestroyed`, and `targetInfoChanged`.
Returns an unsubscribe function.

## Local Sessions

### `attach(targetId): LocalSession`

Creates an isolated Session without a Relay:

```ts
const session = host.attach("app");
const off = session.onEvent((method, params) => {
  // ...
});

await session.send("Runtime.enable");
await session.send("Runtime.evaluate", { expression: "document.title" });

off();
session.detach();
```

```ts
type LocalSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  detach(): void;
};
```

`send` rejects with an `Error` carrying the numeric CDP `.code` on failure.
After `detach`, pending and future calls fail and no further events are
delivered.

Each Session has independent domain-enable state, DOM frontend ids, Runtime
handles, and events. There is no Target-wide enable reference count or event
broadcast.

## Relay uplink

### `connectRelay(options): () => void`

```ts
const disconnect = host.connectRelay({
  url: "ws://127.0.0.1:3000/icdp/host",
  reconnectDelayMs: 500,
  webSocketFactory: (url) => new WebSocket(url),
});
```

The Host announces current Targets, consumes complete Client-id snapshots,
parses raw Client CDP, and returns raw responses through the uplink.

`connectRelay` replaces an existing uplink and returns a disconnect function.
The default reconnect delay is 500 ms. An unexpected transport close
reconnects the same Host instance without discarding its Targets or Sessions;
responses produced while disconnected are queued and sent after the new
uplink handshake. An explicit disconnect tears down the Relay-owned Client
Sessions.

## Browser and Target commands

The Host implements:

- `Browser.getVersion`
- `Target.getTargets`
- `Target.getTargetInfo`
- `Target.setDiscoverTargets`
- `Target.setAutoAttach` with `flatten: true`
- `Target.attachToTarget` with `flatten: true`
- `Target.detachFromTarget`
- `Target.createTarget` through `onCreateTarget`
- `Target.closeTarget` through `onCloseTarget`

`Target.createTarget` waits up to ten seconds for the new Pairing to complete
its Frame handshake. A failed create unpairs the half-created Target.

`Target.closeTarget` awaits its hook, queues `{ success: true }`, then unpairs
the Target. The Host emits Chromium-shaped `Inspector.detached` lifecycle
events, removes every descendant Target agent, publishes `attached: false`
changes to surviving discovery agents, and only then emits the parent
`Target.detachedFromTarget` and `Target.targetDestroyed` events. Pending
commands owned by destroyed relay Sessions are discarded, as Chromium does,
rather than answered after the terminal lifecycle. Direct Target sockets
receive the success response and their two unscoped Inspector reasons before
closing. Async Target hooks also recheck the originating Client and Session
before sending a completion, so a detached Session cannot receive a stale
response.

Browser-root, direct-page, and explicit flat Sessions have independent Target
agent state. Target responses and lifecycle events produced for an explicit
Session carry its outer `sessionId`. A Session may detach only children it
attached. Explicitly detaching one child emits that child's
`Target.detachedFromTarget`, publishes any resulting attached-state change,
then returns the command response; its descendants and their pending commands
end silently. Page Target agents can enumerate and explicitly attach Pairings
but do not auto-attach unrelated top-level Pairings.

`Target.setRemoteLocations` is explicitly unsupported. Other unknown
browser-level methods return `-32601`.

## Reload semantics

A second `hello` from a paired iframe means the document changed. The Host
fails old in-flight commands with `Target reloaded`, replaces the port, and
re-attaches every surviving Session with its successfully enabled domains.
The Target and Session ids remain stable; document-scoped DOM and Runtime ids
do not.

## `destroy(): void`

Stops the uplink, unpairs every Target, and removes the parent-window message
listener.
