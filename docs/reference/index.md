---
description: "The five package entry points of @olimsaidov/icdp and where to find each type."
---

# Reference

`@olimsaidov/icdp` is ESM-only and ships five subpath entry points. Each is imported by its exact specifier; there is no root export. The Node [Relay](/explanation/concepts) adapter (`@olimsaidov/icdp/relay/node`) requires Node >= 22; the other entry points run anywhere a DOM exists.

## Entry points

| Specifier | Exports | Reference |
| --- | --- | --- |
| `@olimsaidov/icdp/frame` | `startFrameAgent` — runs inside the embedded app | [Frame Agent](/reference/frame) |
| `@olimsaidov/icdp/host` | `IcdpHost` — the parent-window hub | [Host](/reference/host) |
| `@olimsaidov/icdp/relay` | `RelayCore` — runtime-agnostic Relay core | [Relay](/reference/relay) |
| `@olimsaidov/icdp/relay/node` | `serveRelay` — Node `http` + `ws` adapter | [Relay](/reference/relay) |
| `@olimsaidov/icdp/protocol` | shared types, constants, and message shapes | [Protocol](/reference/protocol) |

```ts
import { startFrameAgent } from "@olimsaidov/icdp/frame";
import { IcdpHost } from "@olimsaidov/icdp/host";
import { RelayCore } from "@olimsaidov/icdp/relay";
import { serveRelay } from "@olimsaidov/icdp/relay/node";
import { PROTOCOL_VERSION } from "@olimsaidov/icdp/protocol";
```

## Cross-cutting reference

Two pages describe behavior that spans the entry points:

- [CDP support matrix](/reference/cdp-support) — the CDP domains and methods the [Frame Agent](/explanation/concepts) registers, the methods the [Relay](/explanation/concepts) answers itself, and what is intentionally unsupported.
- [HTTP endpoints](/reference/http-endpoints) — the discovery and status routes the Node [Relay](/explanation/concepts) serves over HTTP, alongside its WebSocket upgrade paths.
