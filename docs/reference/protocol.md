---
description: "API reference for the shared constants, CDP types, handshake messages, and Host-Relay bridge messages."
---

# @olimsaidov/icdp/protocol

The `/protocol` entry point exports the wire types shared across the system: the constants and CDP shapes every layer agrees on, the handshake messages the [Frame Agent](/explanation/concepts) and [Host](/explanation/concepts) exchange over `window.postMessage`, and the bridge messages the [Host](/reference/host) and [Relay](/reference/relay) exchange over WebSocket. It carries no runtime behavior beyond two small helpers; it is the type contract that lets the four layers interoperate.

```ts
import {
  PROTOCOL_VERSION,
  CDP_SERVER_ERROR,
  CDP_METHOD_NOT_FOUND,
  isHandshakeMessage,
  parseJson,
} from "@olimsaidov/icdp/protocol";
import type {
  CdpId,
  CdpMessage,
  CdpError,
  FrameInfo,
  TargetSummary,
  HandshakeMessage,
  HostToRelayMessage,
  RelayToHostMessage,
} from "@olimsaidov/icdp/protocol";
```

## Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `PROTOCOL_VERSION` | `1` | The bridge and handshake protocol version. Carried as the `v` field of every handshake and bridge `ready` message. |
| `CDP_SERVER_ERROR` | `-32000` | The CDP error `code` for a server-side failure: an unknown method, an in-flight command failing because its document died, or any handler error. |
| `CDP_METHOD_NOT_FOUND` | `-32601` | The CDP error `code` for an unrecognized method at the dispatch layer. |

## Core CDP types

### `CdpId`

```ts
type CdpId = Protocol.integer | string;
```

A CDP message id. Numeric in practice; widened to accept a string for compatibility with the upstream `devtools-protocol` types.

### `CdpMessage`

A raw CDP frame — a command, a response, or an event. Every field is optional; the populated set distinguishes the three.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `CdpId` | Present on commands and their responses; absent on events. |
| `method` | `string` | Present on commands and events. |
| `params` | `Record<string, unknown>` | Command or event parameters. |
| `sessionId` | `string` | The flat-session routing key. See [the flat-session protocol](/explanation/flat-session-protocol). |
| `result` | `unknown` | Present on a successful response. |
| `error` | `CdpError` | Present on a failed response. |

### `CdpError`

```ts
type CdpError = { code: number; message: string };
```

A CDP error payload. `code` is a numeric code such as `CDP_SERVER_ERROR` or `CDP_METHOD_NOT_FOUND`.

### `FrameInfo`

```ts
type FrameInfo = { title: string; url: string };
```

The metadata a Frame Agent reports about its document.

### `TargetSummary`

```ts
type TargetSummary = FrameInfo & { targetId: string };
```

Target metadata as the Host reports it to the Relay: a `FrameInfo` extended with the stable `targetId`. The `targetId` belongs to the [Pairing](/explanation/concepts), not the document, so it survives reloads and navigations.

## Handshake messages

The Frame Agent and Host pair over `window.postMessage`, then over a transferred `MessagePort`. These three message types model that exchange; `HandshakeMessage` is their union and `isHandshakeMessage` is the runtime guard. Each carries `v` set to `PROTOCOL_VERSION`.

### `HelloMessage`

```ts
type HelloMessage = { icdp: "hello"; v: number } & FrameInfo;
```

Sent by the **Frame Agent** to `window.parent` when it boots, and again in reply to a probe. Carries the document's `title` and `url`.

### `ProbeMessage`

```ts
type ProbeMessage = { icdp: "probe"; v: number };
```

Sent by the **Host** to an iframe it does not yet have a channel for.

### `WelcomeMessage`

```ts
type WelcomeMessage = { icdp: "welcome"; v: number };
```

Sent by the **Host** in reply to a hello, transferring one end of a `MessageChannel` as the command channel. The port travels in the `postMessage` transfer list, not in the message body.

### `HandshakeMessage` union

```ts
type HandshakeMessage = HelloMessage | ProbeMessage | WelcomeMessage;
```

### `isHandshakeMessage`

```ts
function isHandshakeMessage(data: unknown): data is HandshakeMessage;
```

A type guard. Returns `true` when `data` is a non-null object with an `icdp` field equal to `"hello"`, `"probe"`, or `"welcome"`. Used to filter handshake traffic from unrelated `message` events on the window.

## Bridge messages

The Host and Relay exchange JSON frames over a single WebSocket. Every frame has a `kind` discriminant. `HostToRelayMessage` and `RelayToHostMessage` are the per-direction unions; `parseJson` decodes raw frames into them. The producers and consumers are documented under [`/reference/host`](/reference/host) and [`/reference/relay`](/reference/relay); the design is discussed in [the flat-session protocol](/explanation/flat-session-protocol).

### Host → Relay

| Type | `kind` | Fields | Meaning |
| --- | --- | --- | --- |
| `BridgeReady` | `"ready"` | `v: number`, `targets: TargetSummary[]`, `handles?: string[]` | The Host announces itself and its current Targets. New-wins: the Relay drops any previous Host. `handles` lists browser-level methods (e.g. `"Target.createTarget"`) the Host handles itself; the Relay forwards those as a `BridgeBrowserRequest` instead of applying its default. Omitted or empty leaves the Relay's defaults in place. |
| `BridgeTargetCreated` | `"targetCreated"` | `target: TargetSummary` | A Pairing appeared. |
| `BridgeTargetDestroyed` | `"targetDestroyed"` | `targetId: string` | A Pairing was destroyed by the Host. |
| `BridgeTargetInfoChanged` | `"targetInfoChanged"` | `target: TargetSummary` | A Target's document changed (reload or navigation) under a stable `targetId`. |
| `BridgeResponse` | `"response"` | `sessionId: string`, `id: number`, `result?: unknown`, `error?: CdpError` | The response to a `BridgeCommand`. Exactly one of `result` or `error` is set. |
| `BridgeEvent` | `"event"` | `targetId: string`, `method: string`, `params: Record<string, unknown>` | A CDP event from a Target. The Relay fans it out to every [Session](/explanation/concepts) attached to that Target. |
| `BridgeBrowserResult` | `"browserResult"` | `id: number`, `result?: unknown`, `error?: CdpError` | The response to a `BridgeBrowserRequest`. Not session-scoped. Exactly one of `result` or `error` is set. |

```ts
type HostToRelayMessage =
  | BridgeReady
  | BridgeTargetCreated
  | BridgeTargetDestroyed
  | BridgeTargetInfoChanged
  | BridgeResponse
  | BridgeEvent
  | BridgeBrowserResult;
```

### Relay → Host

| Type | `kind` | Fields | Meaning |
| --- | --- | --- | --- |
| `BridgeCommand` | `"command"` | `sessionId: string`, `targetId: string`, `id: number`, `method: string`, `params: Record<string, unknown>` | A Client command routed to one session on one Target. |
| `BridgeDetached` | `"detached"` | `sessionId: string`, `targetId: string` | A session detached, because the Client disconnected or detached explicitly. |
| `BridgeBrowserRequest` | `"browserRequest"` | `id: number`, `method: string`, `params: Record<string, unknown>` | A browser-level method the Host advertised it handles (e.g. `Target.createTarget` / `Target.closeTarget`). Not session-scoped; answered with a `BridgeBrowserResult`. |

```ts
type RelayToHostMessage = BridgeCommand | BridgeDetached | BridgeBrowserRequest;
```

## `parseJson`

```ts
function parseJson<T>(raw: string | Buffer | ArrayBuffer | Uint8Array): T | null;
```

Parses a raw WebSocket frame into `T`. Decodes binary frames (`Buffer`, `ArrayBuffer`, `Uint8Array`) as UTF-8 via `TextDecoder` before parsing. Returns `null` on any parse failure instead of throwing, so callers branch on the result rather than wrap it in a `try`. The type parameter is unchecked: it asserts the parsed shape, it does not validate it.
