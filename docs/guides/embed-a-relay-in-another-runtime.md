---
description: "Adapt the protocol-blind RelayCore to another HTTP and WebSocket runtime."
---

# Embed a Relay in another runtime

Use `RelayCore` when `@olimsaidov/icdp/relay/node` does not match your server
runtime.

```ts
import { RelayCore } from "@olimsaidov/icdp/relay";

const core = new RelayCore({
  product: "my-shell/1.0",
  browserWsUrl: "wss://debug.example.com/devtools/browser",
  targetWsUrl: (targetId) =>
    `wss://debug.example.com/devtools/page/${encodeURIComponent(targetId)}`,
});
```

Wrap each WebSocket in one stable object:

```ts
type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
```

Do not create a new wrapper per event; RelayCore uses object identity to match
connections.

## Wire socket events

For the single Host-uplink route:

```ts
core.hostConnected(hostSocket);
core.hostMessage(hostSocket, rawText);
core.hostDisconnected(hostSocket);
```

For every Client CDP socket:

```ts
core.clientConnected(clientSocket); // browser endpoint
core.clientMessage(clientSocket, rawText);
core.clientDisconnected(clientSocket);
```

For `/devtools/page/<targetId>`, decode the path segment and pass the Target:

```ts
core.clientConnected(clientSocket, targetId);
```

RelayCore rejects an unknown Target, assigns Client ids, and transports raw CDP
to the Host. Do not parse or route CDP in the adapter.

## Serve discovery

Expose these JSON payload builders on the browser-side HTTP server:

| Path | Value |
| --- | --- |
| `/json/version` | `core.jsonVersion()` |
| `/json`, `/json/list` | `core.jsonList()` |
| `/icdp/status` | `core.status()` |

`jsonVersion()` advertises `browserWsUrl`. Each `jsonList()` entry uses
`targetWsUrl(targetId)` and is backed by an implicit Host Session.

A new Host socket remains a contender until RelayCore validates its `ready`
frame. It cannot alter Targets or reach Clients before promotion. Once valid,
it replaces the old Host socket, closes that socket with code `1008`, and
replaces the cached Target summaries.
