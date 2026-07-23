export const PROTOCOL_VERSION = 4;

export type CdpId = number;

/** A raw CDP message: command, response, or event. */
export type CdpMessage = {
  id?: CdpId;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: CdpError;
};

export type CdpError = { code: number; message: string; data?: unknown };

export const CDP_SERVER_ERROR = -32000;
export const CDP_SESSION_NOT_FOUND = -32001;
export const CDP_PARSE_ERROR = -32700;
export const CDP_INVALID_REQUEST = -32600;
export const CDP_METHOD_NOT_FOUND = -32601;
export const CDP_INVALID_PARAMS = -32602;

/** Metadata a Frame Agent reports about its document. */
export type FrameInfo = {
  title: string;
  url: string;
};

/** Target metadata as the Host reports it to the Relay. */
export type TargetSummary = FrameInfo & {
  targetId: string;
};

// ---------------------------------------------------------------------------
// Frame Agent <-> Host handshake (window.postMessage, then a MessagePort)
// ---------------------------------------------------------------------------

/** Sent by the Frame Agent to window.parent when it boots (and on probe). */
export type HelloMessage = {
  icdp: "hello";
  v: number;
} & FrameInfo;

/** Sent by the Host to an iframe it doesn't yet have a channel for. */
export type ProbeMessage = {
  icdp: "probe";
  v: number;
};

/** Sent by the Host in reply to hello, transferring a MessagePort. */
export type WelcomeMessage = {
  icdp: "welcome";
  v: number;
};

export type HandshakeMessage = HelloMessage | ProbeMessage | WelcomeMessage;

export function isHandshakeMessage(data: unknown): data is HandshakeMessage {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  if (message.v !== PROTOCOL_VERSION) return false;
  if (message.icdp === "probe" || message.icdp === "welcome") return true;
  return (
    message.icdp === "hello" && typeof message.title === "string" && typeof message.url === "string"
  );
}

// ---------------------------------------------------------------------------
// Host <-> Frame Agent session protocol (MessagePort, JSON frames)
// ---------------------------------------------------------------------------

export type FrameSessionState = {
  enabledDomains: string[];
  domainParams?: Record<string, Record<string, unknown>>;
};

export type FrameAttach = {
  kind: "attach";
  sessionId: string;
  state: FrameSessionState;
};

export type FrameDetach = {
  kind: "detach";
  sessionId: string;
};

export type FrameCommand = {
  kind: "command";
  sessionId: string;
  id: number;
  method: string;
  params: Record<string, unknown>;
};

export type FrameResponse = {
  kind: "response";
  sessionId: string;
  id: number;
  result?: unknown;
  error?: CdpError;
};

export type FrameEvent = {
  kind: "event";
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
};

export type HostToFrameMessage = FrameAttach | FrameDetach | FrameCommand;
export type FrameToHostMessage = FrameResponse | FrameEvent;

// ---------------------------------------------------------------------------
// Host <-> Relay bridge protocol (WebSocket, JSON frames)
// ---------------------------------------------------------------------------

/** Host -> Relay: validates a Host contender and announces its current targets. */
export type BridgeReady = {
  kind: "ready";
  v: number;
  instanceId: string;
  targets: TargetSummary[];
};
/** Host -> Relay: all messages queued before `ready` have now been replayed. */
export type BridgeReadyComplete = {
  kind: "readyComplete";
};
/** Relay -> Host: the complete current Client set. Replaces the previous snapshot. */
export type BridgeClients = {
  kind: "clients";
  clientIds: string[];
  /** Direct page WebSocket Clients and the Target each is implicitly attached to. */
  targetIds?: Record<string, string>;
};
/** Bidirectional raw CDP message for one Client connection. */
export type BridgeClientMessage = {
  kind: "clientMessage";
  clientId: string;
  message: string;
};
/** Host -> Relay: a Pairing appeared. */
export type BridgeTargetCreated = { kind: "targetCreated"; target: TargetSummary };
/** Host -> Relay: a Pairing was destroyed by the Host. */
export type BridgeTargetDestroyed = { kind: "targetDestroyed"; targetId: string };
/** Host -> Relay: a Target's document changed (reload / navigation under a stable targetId). */
export type BridgeTargetInfoChanged = { kind: "targetInfoChanged"; target: TargetSummary };
export type HostToRelayMessage =
  | BridgeReady
  | BridgeReadyComplete
  | BridgeTargetCreated
  | BridgeTargetDestroyed
  | BridgeTargetInfoChanged
  | BridgeClientMessage;

export type RelayToHostMessage = BridgeClients | BridgeClientMessage;

export function parseJson<T>(raw: string | ArrayBuffer | Uint8Array): T | null {
  try {
    return JSON.parse(
      typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array),
    ) as T;
  } catch {
    return null;
  }
}
