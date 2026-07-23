---
description: "Attach a Session directly from the parent window without a Relay."
---

# Tap a Target with no server

`host.attach(targetId)` creates a real isolated Session using the same
Host–Frame path as a remote Client, but without a WebSocket.

```ts
import { IcdpHost } from "@olimsaidov/icdp/host";

const host = new IcdpHost();
// host.pair(...) first

const session = host.attach("app-1");
const off = session.onEvent((method, params) => {
  if (method === "Runtime.consoleAPICalled") {
    console.log("frame console:", params);
  }
});

await session.send("Runtime.enable");
```

Subscribe before enabling the domain so the first state events are visible.
`send` resolves with the CDP result and rejects with an `Error` whose numeric
`.code` is the CDP error code.

## Isolation

Every attachment has its own Frame Session. Enabling Runtime locally does not
enable Runtime for a remote Client, and one Session's disable cannot turn off
another Session. DOM frontend ids, Runtime handles, enabled domains, and
events are also isolated.

## Cleanup

```ts
off();
session.detach();
```

Detach clears this Session, rejects its pending calls, and stops its events.
It does not affect other Sessions or the Relay uplink.

See the [Host reference](/reference/host) for the complete `LocalSession`
shape.
