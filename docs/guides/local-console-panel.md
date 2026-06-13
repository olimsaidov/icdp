---
description: "Read CDP from a Target directly in the parent window — e.g. a console panel — with no Relay in the path."
---

# Tap a Target with no server

You have parent-window code — a console panel, a debug overlay, an inspector — that wants to consume CDP from a [Target](/explanation/concepts): receive `Runtime.consoleAPICalled`, send `DOM.getDocument`, read live events. You do not want to stand up a [Relay](/explanation/concepts), and you do not want a WebSocket round-trip just to read events from a frame that lives in the same window.

You don't need one. The [Host](/explanation/concepts) is the hub. The Relay uplink is structurally just one consumer among others, so local parent-window code attaches to a Target through the same fan-out — and a local session works whether the Relay is connected, disconnected, or never configured at all. See the [architecture overview](/explanation/architecture) for why the Host fans sessions out instead of looping through a server.

This guide assumes you already have an `IcdpHost` with at least one paired Target. If you don't, start with [Pair an iframe](/guides/pair-an-iframe).

## Attach a local session

`host.attach(targetId)` returns a `LocalSession` with no server in the path. It throws if `targetId` is not paired.

```ts
import { IcdpHost } from "@olimsaidov/icdp/host";

const host = new IcdpHost();
// ...pair an iframe as "app-1" first (see "Pair an iframe").

const session = host.attach("app-1");
```

A `LocalSession` has three members:

```ts
type LocalSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  detach(): void;
};
```

## Subscribe before you enable

Register your event listener first, then enable the domain. `onEvent` returns an unsubscribe function; events fired by the Frame Agent are broadcast to every attached session.

```ts
const off = session.onEvent((method, params) => {
  if (method === "Runtime.consoleAPICalled") {
    console.log("frame console:", params);
  }
});

await session.send("Runtime.enable");
```

`send` resolves with the command's CDP result. On a CDP error it rejects with an `Error` whose `message` is the CDP message and whose numeric `.code` carries the CDP error code (for example `-32000`, exported as `CDP_SERVER_ERROR` from [`@olimsaidov/icdp/protocol`](/reference/protocol)):

```ts
try {
  await session.send("DOM.getDocument");
} catch (error) {
  // error.code is the CDP error code; error.message is the CDP message.
}
```

## Detach when done

`detach()` removes the session. Call it when your panel closes.

```ts
off();            // stop receiving events
session.detach(); // drop the session and release its enable refs
```

::: info Enables are ref-counted per Target
Domain `.enable` calls are reference-counted per Target by consumer. Your local `Runtime.enable` and the Relay's `Runtime.enable` coexist: the underlying `.enable` reaches the Frame Agent once, and a `.disable` is only forwarded to the frame when the *last* holder releases. `detach()` releases this session's refs for you, so a `Runtime.disable` is sent to the frame only if no other consumer still holds it. This is why a local panel cannot turn a domain off underneath the Relay, and vice versa.
:::

## A console-panel example

A self-contained panel: subscribe to console output, enable `Runtime`, surface each call, and clean up on close.

```ts
import { IcdpHost } from "@olimsaidov/icdp/host";

export function openConsolePanel(host: IcdpHost, targetId: string, render: (line: string) => void) {
  const session = host.attach(targetId);

  const off = session.onEvent((method, params) => {
    if (method !== "Runtime.consoleAPICalled") return;
    const args = (params.args as Array<{ value?: unknown }> | undefined) ?? [];
    render(args.map((arg) => String(arg.value ?? "")).join(" "));
  });

  // No await needed at call sites that don't read a result; enable streams events.
  session.send("Runtime.enable").catch((error) => render(`error: ${error.message}`));

  return function close() {
    off();
    session.detach();
  };
}
```

The panel reads from the live frame with no Relay, no WebSocket, and no Client. If you later run a Relay and a Client attaches the same Target, both consume the same broadcast — the local panel keeps working unchanged.

::: tip Same window, real DOM
Events you receive here come straight from the [Frame Agent](/explanation/concepts) running inside the embedded app, against the real DOM. There is no polling and no server hop. The `attach`/`detach` lifecycle is independent of `connectRelay`: tearing the uplink down does not disturb local sessions, and vice versa.
:::

## See also

- [Host reference](/reference/host) — `attach`, `LocalSession`, `connectRelay`, and the full method surface.
- [Architecture](/explanation/architecture) — why the Host fans sessions out instead of piping to a server.
- [Run a Relay](/guides/run-a-relay) — when you do want external Clients in the path.
