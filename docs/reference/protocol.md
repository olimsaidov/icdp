---
description: "The CDP errors and wire types shared by the Frame Agent, Host, and Relay."
---

# `@olimsaidov/icdp/protocol`

The protocol entry point exports the small contracts used at each boundary.

## Constants

| Constant | Value | Meaning |
| --- | ---: | --- |
| `PROTOCOL_VERSION` | `5` | ICDP handshake and bridge version. |
| `CDP_SERVER_ERROR` | `-32000` | Runtime/server failure. |
| `CDP_SESSION_NOT_FOUND` | `-32001` | Unknown flattened `sessionId`. |
| `CDP_PARSE_ERROR` | `-32700` | Malformed JSON. |
| `CDP_INVALID_REQUEST` | `-32600` | Invalid CDP command envelope. |
| `CDP_METHOD_NOT_FOUND` | `-32601` | Unknown or unavailable method. |
| `CDP_INVALID_PARAMS` | `-32602` | Invalid method parameters. |

`CdpId` is a `number`. A raw `CdpMessage` may contain `id`, `method`,
`params`, `sessionId`, `result`, or `error` according to whether it is a
command, response, or event.

```ts
type CdpError = { code: number; message: string; data?: unknown };
type FrameInfo = { title: string; url: string };
type TargetSummary = FrameInfo & { targetId: string };
```

Client commands follow Chromium's CRDTP JSON envelope rules: ids are signed
32-bit integers, duplicate top-level properties are rejected in wire order,
vertical-tab and form-feed count as whitespace, and line or block comments
are accepted outside strings.

## Frame Agent handshake

The initial handshake uses `window.postMessage`:

```ts
type HelloMessage = {
  icdp: "hello";
  v: number;
  title: string;
  url: string;
};

type ProbeMessage = { icdp: "probe"; v: number };
type WelcomeMessage = { icdp: "welcome"; v: number };
```

The Host transfers a `MessagePort` with `WelcomeMessage`.
`isHandshakeMessage(value)` recognizes these three message discriminants.

## Host–Frame messages

All messages on the transferred port are JSON-encoded and Session-addressed.

```ts
type FrameSessionState = {
  enabledDomains: string[];
  domainParams?: Record<string, Record<string, unknown>>;
};

type HostToFrameMessage =
  | { kind: "attach"; sessionId: string; state: FrameSessionState }
  | { kind: "detach"; sessionId: string }
  | {
      kind: "command";
      sessionId: string;
      id: number;
      method: string;
      params: Record<string, unknown>;
    };

type FrameToHostMessage =
  | {
      kind: "response";
      sessionId: string;
      id: number;
      result?: unknown;
      error?: CdpError;
    }
  | {
      kind: "event";
      sessionId: string;
      method: string;
      params: Record<string, unknown>;
    }
  | {
      kind: "metadata";
      info: FrameInfo;
    };
```

The `attach` state lets a replacement document restore only the domains that
the same Session had successfully enabled, together with accepted enable-time
parameters such as `DOM.includeWhitespace`.
The Frame sends `metadata` whenever its title or URL changes so Target
discovery, `Target.getTargetInfo`, and `/json/list` stay synchronized with the
live document.

## Host–Relay messages

The Relay transports raw Client CDP. It does not receive parsed commands,
responses, or Session events.

```ts
type BridgeReady = {
  kind: "ready";
  v: number;
  instanceId: string;
  targets: TargetSummary[];
};

type BridgeReadyComplete = {
  kind: "readyComplete";
};

type BridgeClients = {
  kind: "clients";
  clientIds: string[];
  targetIds?: Record<string, string>;
};

type BridgeClientMessage = {
  kind: "clientMessage";
  clientId: string;
  message: string;
};

type HostToRelayMessage =
  | BridgeReady
  | BridgeReadyComplete
  | { kind: "targetCreated"; target: TargetSummary }
  | { kind: "targetDestroyed"; targetId: string }
  | { kind: "targetInfoChanged"; target: TargetSummary }
  | BridgeClientMessage;

type RelayToHostMessage = BridgeClients | BridgeClientMessage;
```

`BridgeClients` is a complete snapshot, not a delta. `targetIds` identifies
direct page-socket Clients so the Host can create their unannounced implicit
Sessions. Removing a Client id causes the Host to detach every Session owned by
that Client.
`BridgeReady.instanceId` is stable across uplink reconnects by one Host
instance and changes when a different Host replaces it.
After `BridgeReady`, the Host replays queued `clientMessage` frames and then
sends `BridgeReadyComplete`. The Relay waits for that marker before closing
direct Clients whose Target is absent from the new snapshot. This preserves
Chromium's response-before-close ordering when a Target was destroyed during
an uplink outage.

## `parseJson`

```ts
function parseJson<T>(raw: string | ArrayBuffer | Uint8Array): T | null;
```

The helper decodes binary input with `TextDecoder`, parses JSON, and returns
`null` on failure. The generic type is a TypeScript assertion; it does not
perform schema validation.
