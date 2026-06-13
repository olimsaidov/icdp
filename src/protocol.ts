import type Protocol from "devtools-protocol";

export const PROTOCOL_VERSION = 1;

export type CdpId = Protocol.integer | string;

/** A raw CDP message: command, response, or event. */
export type CdpMessage = {
  id?: CdpId;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: CdpError;
};

export type CdpError = { code: number; message: string };

export const CDP_SERVER_ERROR = -32000;
export const CDP_METHOD_NOT_FOUND = -32601;

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
  return (
    typeof data === "object" &&
    data !== null &&
    "icdp" in data &&
    ((data as { icdp: unknown }).icdp === "hello" ||
      (data as { icdp: unknown }).icdp === "probe" ||
      (data as { icdp: unknown }).icdp === "welcome")
  );
}

// ---------------------------------------------------------------------------
// Host <-> Relay bridge protocol (WebSocket, JSON frames)
// ---------------------------------------------------------------------------

/** Host -> Relay: announces itself and its current targets. New-wins: the Relay drops any previous Host. */
export type BridgeReady = {
  kind: "ready";
  v: number;
  targets: TargetSummary[];
  /** Browser-level methods (e.g. "Target.createTarget") the Host handles itself.
   *  The Relay forwards these as a BridgeBrowserRequest instead of using its
   *  built-in default; omitted/empty means the Relay keeps its defaults. */
  handles?: string[];
};
/** Host -> Relay: a Pairing appeared. */
export type BridgeTargetCreated = { kind: "targetCreated"; target: TargetSummary };
/** Host -> Relay: a Pairing was destroyed by the Host. */
export type BridgeTargetDestroyed = { kind: "targetDestroyed"; targetId: string };
/** Host -> Relay: a Target's document changed (reload / navigation under a stable targetId). */
export type BridgeTargetInfoChanged = { kind: "targetInfoChanged"; target: TargetSummary };
/** Relay -> Host: a Client command routed to one session. */
export type BridgeCommand = {
  kind: "command";
  sessionId: string;
  targetId: string;
  id: number;
  method: string;
  params: Record<string, unknown>;
};
/** Host -> Relay: the response to a BridgeCommand. */
export type BridgeResponse = {
  kind: "response";
  sessionId: string;
  id: number;
  result?: unknown;
  error?: CdpError;
};
/** Host -> Relay: a CDP event from a Target; the Relay fans it out to every session attached to it. */
export type BridgeEvent = {
  kind: "event";
  targetId: string;
  method: string;
  params: Record<string, unknown>;
};
/** Relay -> Host: a session detached (Client disconnected or detached explicitly). */
export type BridgeDetached = { kind: "detached"; sessionId: string; targetId: string };
/** Relay -> Host: a browser-level method the Host advertised it handles
 *  (e.g. Target.createTarget / Target.closeTarget). Not session-scoped. */
export type BridgeBrowserRequest = {
  kind: "browserRequest";
  id: number;
  method: string;
  params: Record<string, unknown>;
};
/** Host -> Relay: the response to a BridgeBrowserRequest. */
export type BridgeBrowserResult = {
  kind: "browserResult";
  id: number;
  result?: unknown;
  error?: CdpError;
};

export type HostToRelayMessage =
  | BridgeReady
  | BridgeTargetCreated
  | BridgeTargetDestroyed
  | BridgeTargetInfoChanged
  | BridgeResponse
  | BridgeEvent
  | BridgeBrowserResult;

export type RelayToHostMessage = BridgeCommand | BridgeDetached | BridgeBrowserRequest;

export function parseJson<T>(raw: string | Buffer | ArrayBuffer | Uint8Array): T | null {
  try {
    return JSON.parse(
      typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array),
    ) as T;
  } catch {
    return null;
  }
}
