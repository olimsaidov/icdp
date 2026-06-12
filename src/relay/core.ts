import {
  CDP_METHOD_NOT_FOUND,
  CDP_SERVER_ERROR,
  type CdpId,
  type CdpMessage,
  type HostToRelayMessage,
  PROTOCOL_VERSION,
  parseJson,
  type RelayToHostMessage,
  type TargetSummary,
} from "../protocol.ts";

/** Minimal socket surface the adapter must provide for each connection. */
export type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type RelayCoreOptions = {
  /** Reported by Browser.getVersion and /json/version. */
  product?: string;
  /** Absolute WebSocket URL of the browser endpoint, for /json payloads. */
  browserWsUrl?: string;
};

type ClientState = {
  socket: SocketLike;
  autoAttach: boolean;
  discoverTargets: boolean;
  sessions: Set<string>;
};

type SessionState = {
  sessionId: string;
  targetId: string;
  client: ClientState;
};

type PendingCommand = {
  client: ClientState;
  clientId: CdpId | undefined;
  sessionId: string;
};

/** Sentinel: the method was handled and a response was already sent. */
const RESPONDED = Symbol("responded");

export class RelayCore {
  private readonly product: string;
  private readonly browserWsUrl: string;
  private hostSocket: SocketLike | null = null;
  private readonly clients = new Map<SocketLike, ClientState>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly targets = new Map<string, TargetSummary>();
  private readonly pending = new Map<number, PendingCommand>();
  private nextBridgeId = 1;
  private nextSessionId = 1;

  constructor(options: RelayCoreOptions = {}) {
    this.product = options.product ?? "icdp/0.1";
    this.browserWsUrl = options.browserWsUrl ?? "";
  }

  // -- adapter wiring ---------------------------------------------------------

  /** A Host bridge connected. New-wins: any previous Host is dropped. */
  hostConnected(socket: SocketLike): void {
    if (this.hostSocket && this.hostSocket !== socket) {
      const previous = this.hostSocket;
      this.hostSocket = null;
      this.dropAllTargets("Host replaced by a newer connection");
      try {
        previous.close(1008, "replaced by a newer host");
      } catch {}
    }
    this.hostSocket = socket;
  }

  hostDisconnected(socket: SocketLike): void {
    if (this.hostSocket !== socket) return;
    this.hostSocket = null;
    this.dropAllTargets("Host disconnected");
  }

  hostMessage(socket: SocketLike, raw: string): void {
    if (this.hostSocket !== socket) return;
    const message = parseJson<HostToRelayMessage>(raw);
    if (!message) return;
    switch (message.kind) {
      case "ready":
        this.dropAllTargets("Host re-announced");
        for (const target of message.targets) this.addTarget(target);
        return;
      case "targetCreated":
        this.addTarget(message.target);
        return;
      case "targetDestroyed":
        this.removeTarget(message.targetId, "Target destroyed");
        return;
      case "targetInfoChanged": {
        this.targets.set(message.target.targetId, message.target);
        this.broadcastTargetEvent("Target.targetInfoChanged", {
          targetInfo: this.targetInfo(message.target),
        });
        return;
      }
      case "response": {
        const id = Number(message.id);
        const call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id);
        this.sendToClient(call.client, {
          id: call.clientId,
          sessionId: call.sessionId,
          ...(message.error ? { error: message.error } : { result: message.result ?? {} }),
        });
        return;
      }
      case "event": {
        for (const session of this.sessions.values()) {
          if (session.targetId !== message.targetId) continue;
          this.sendToClient(session.client, {
            method: message.method,
            params: message.params,
            sessionId: session.sessionId,
          });
        }
        return;
      }
    }
  }

  clientConnected(socket: SocketLike): void {
    this.clients.set(socket, {
      socket,
      autoAttach: false,
      discoverTargets: false,
      sessions: new Set(),
    });
  }

  clientDisconnected(socket: SocketLike): void {
    const client = this.clients.get(socket);
    if (!client) return;
    this.clients.delete(socket);
    for (const sessionId of client.sessions) this.endSession(sessionId, { notifyClient: false });
  }

  clientMessage(socket: SocketLike, raw: string): void {
    const client = this.clients.get(socket);
    if (!client) return;
    const message = parseJson<CdpMessage>(raw);
    if (!message) return;

    if (message.sessionId) {
      this.routeSessionCommand(client, message);
      return;
    }

    const local = this.browserLevelResult(client, message);
    if (local === RESPONDED) return;
    if (local !== undefined) {
      this.sendToClient(client, { id: message.id, result: local });
      return;
    }

    this.sendToClient(client, {
      id: message.id,
      error: {
        code: CDP_METHOD_NOT_FOUND,
        message: `Method not available on the browser target: ${message.method ?? "<missing>"}. Attach to a target and send it with a sessionId.`,
      },
    });
  }

  // -- HTTP discovery payloads --------------------------------------------------

  jsonVersion(): Record<string, unknown> {
    return {
      Browser: this.product,
      "Protocol-Version": "1.3",
      "User-Agent": this.product,
      "V8-Version": "synthetic",
      "WebKit-Version": "synthetic",
      webSocketDebuggerUrl: this.browserWsUrl,
    };
  }

  jsonList(): Array<Record<string, unknown>> {
    return Array.from(this.targets.values(), (target) => ({
      description: "icdp iframe target",
      devtoolsFrontendUrl: "",
      id: target.targetId,
      title: target.title,
      type: "page",
      url: target.url,
      // Flat-session protocol only: attach via Target.attachToTarget on the browser endpoint.
      webSocketDebuggerUrl: this.browserWsUrl,
    }));
  }

  status(): { hostConnected: boolean; targets: TargetSummary[]; clients: number } {
    return {
      hostConnected: this.hostSocket !== null,
      targets: Array.from(this.targets.values()),
      clients: this.clients.size,
    };
  }

  // -- internals ------------------------------------------------------------

  private targetInfo(target: TargetSummary) {
    return {
      targetId: target.targetId,
      type: "page",
      title: target.title,
      url: target.url,
      attached: Array.from(this.sessions.values()).some(
        (session) => session.targetId === target.targetId,
      ),
      canAccessOpener: false,
    };
  }

  private sendToClient(client: ClientState, message: CdpMessage): void {
    try {
      client.socket.send(JSON.stringify(message));
    } catch {}
  }

  private sendToHost(message: RelayToHostMessage): void {
    try {
      this.hostSocket?.send(JSON.stringify(message));
    } catch {}
  }

  private broadcastTargetEvent(method: string, params: Record<string, unknown>): void {
    for (const client of this.clients.values()) {
      if (!client.discoverTargets) continue;
      this.sendToClient(client, { method, params });
    }
  }

  private addTarget(target: TargetSummary): void {
    this.targets.set(target.targetId, target);
    this.broadcastTargetEvent("Target.targetCreated", { targetInfo: this.targetInfo(target) });
    for (const client of this.clients.values()) {
      if (client.autoAttach) this.startSession(client, target.targetId);
    }
  }

  private removeTarget(targetId: string, reason: string): void {
    if (!this.targets.delete(targetId)) return;
    for (const session of Array.from(this.sessions.values())) {
      if (session.targetId === targetId)
        this.endSession(session.sessionId, { notifyClient: true, failReason: reason });
    }
    this.broadcastTargetEvent("Target.targetDestroyed", { targetId });
  }

  private dropAllTargets(reason: string): void {
    for (const targetId of Array.from(this.targets.keys())) this.removeTarget(targetId, reason);
  }

  private startSession(client: ClientState, targetId: string): SessionState {
    const session: SessionState = {
      sessionId: `icdp-session-${this.nextSessionId++}`,
      targetId,
      client,
    };
    this.sessions.set(session.sessionId, session);
    client.sessions.add(session.sessionId);
    const target = this.targets.get(targetId);
    if (target) {
      this.sendToClient(client, {
        method: "Target.attachedToTarget",
        params: {
          sessionId: session.sessionId,
          targetInfo: this.targetInfo(target),
          waitingForDebugger: false,
        },
      });
    }
    return session;
  }

  private endSession(
    sessionId: string,
    options: { notifyClient: boolean; failReason?: string },
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.client.sessions.delete(sessionId);

    for (const [bridgeId, call] of this.pending) {
      if (call.sessionId !== sessionId) continue;
      this.pending.delete(bridgeId);
      if (options.notifyClient) {
        this.sendToClient(session.client, {
          id: call.clientId,
          sessionId,
          error: { code: CDP_SERVER_ERROR, message: options.failReason ?? "Session detached" },
        });
      }
    }

    if (options.notifyClient) {
      this.sendToClient(session.client, {
        method: "Target.detachedFromTarget",
        params: { sessionId, targetId: session.targetId },
      });
    }
    this.sendToHost({ kind: "detached", sessionId, targetId: session.targetId });
  }

  private routeSessionCommand(client: ClientState, message: CdpMessage): void {
    const sessionId = message.sessionId as string;
    const session = this.sessions.get(sessionId);
    if (!session || session.client !== client) {
      this.sendToClient(client, {
        id: message.id,
        sessionId,
        error: { code: CDP_SERVER_ERROR, message: `Session not found: ${sessionId}` },
      });
      return;
    }
    if (!message.method) {
      this.sendToClient(client, {
        id: message.id,
        sessionId,
        error: { code: CDP_METHOD_NOT_FOUND, message: "Method not found: <missing>" },
      });
      return;
    }

    // Target/Browser housekeeping arrives session-scoped from real clients
    // (e.g. agent-browser sends Target.setAutoAttach inside the session); the
    // Frame Agent knows nothing about targets, so answer here.
    const local = this.sessionLevelResult(session, message);
    if (local !== undefined) {
      this.sendToClient(client, { id: message.id, sessionId, result: local });
      return;
    }

    if (!this.hostSocket) {
      this.sendToClient(client, {
        id: message.id,
        sessionId,
        error: { code: CDP_SERVER_ERROR, message: "Host is not connected" },
      });
      return;
    }

    const bridgeId = this.nextBridgeId++;
    this.pending.set(bridgeId, { client, clientId: message.id, sessionId });
    this.sendToHost({
      kind: "command",
      sessionId,
      targetId: session.targetId,
      id: bridgeId,
      method: message.method,
      params: message.params ?? {},
    });
  }

  /** Session-scoped methods the Relay answers itself; undefined = forward to the frame. */
  private sessionLevelResult(session: SessionState, message: CdpMessage): unknown | undefined {
    switch (message.method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: this.product,
          revision: `icdp-v${PROTOCOL_VERSION}`,
          userAgent: this.product,
          jsVersion: "synthetic",
        };
      case "Schema.getDomains":
        return { domains: [] };
      case "Target.setAutoAttach":
      case "Target.setDiscoverTargets":
      case "Target.setRemoteLocations":
      case "Target.activateTarget":
        return {};
      case "Target.getTargetInfo": {
        const target = this.targets.get(session.targetId);
        if (!target)
          return {
            targetInfo: {
              targetId: session.targetId,
              type: "page",
              title: "",
              url: "",
              attached: true,
            },
          };
        return { targetInfo: this.targetInfo(target) };
      }
      default:
        return undefined;
    }
  }

  /** Browser-level methods the Relay answers itself; undefined = not local. */
  private browserLevelResult(
    client: ClientState,
    message: CdpMessage,
  ): unknown | typeof RESPONDED | undefined {
    switch (message.method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: this.product,
          revision: `icdp-v${PROTOCOL_VERSION}`,
          userAgent: this.product,
          jsVersion: "synthetic",
        };
      case "Browser.close":
      case "Browser.setDownloadBehavior":
      case "Browser.setWindowBounds":
      case "Security.setIgnoreCertificateErrors":
      case "Target.setRemoteLocations":
      case "Target.activateTarget":
      case "Target.closeTarget":
        return {};
      case "Schema.getDomains":
        return { domains: [] };
      case "Target.getTargets":
        return {
          targetInfos: Array.from(this.targets.values(), (target) => this.targetInfo(target)),
        };
      case "Target.getTargetInfo": {
        const targetId = String(message.params?.targetId ?? "");
        const target = this.targets.get(targetId);
        if (!target)
          return { targetInfo: { targetId, type: "page", title: "", url: "", attached: false } };
        return { targetInfo: this.targetInfo(target) };
      }
      case "Target.setDiscoverTargets": {
        const discover = Boolean(message.params?.discover);
        client.discoverTargets = discover;
        if (discover) {
          for (const target of this.targets.values()) {
            this.sendToClient(client, {
              method: "Target.targetCreated",
              params: { targetInfo: this.targetInfo(target) },
            });
          }
        }
        return {};
      }
      case "Target.setAutoAttach": {
        const autoAttach = Boolean(message.params?.autoAttach);
        client.autoAttach = autoAttach;
        if (autoAttach) {
          for (const target of this.targets.values()) {
            const attachedHere = Array.from(client.sessions).some(
              (sessionId) => this.sessions.get(sessionId)?.targetId === target.targetId,
            );
            if (!attachedHere) this.startSession(client, target.targetId);
          }
        }
        return {};
      }
      case "Target.attachToTarget": {
        const targetId = String(message.params?.targetId ?? "");
        if (!this.targets.has(targetId)) {
          this.sendToClient(client, {
            id: message.id,
            error: {
              code: CDP_SERVER_ERROR,
              message: `No target with given id found: ${targetId}`,
            },
          });
          return RESPONDED;
        }
        const session = this.startSession(client, targetId);
        return { sessionId: session.sessionId };
      }
      case "Target.detachFromTarget": {
        const sessionId = String(message.params?.sessionId ?? "");
        this.endSession(sessionId, { notifyClient: false });
        return {};
      }
      case "Target.createTarget":
        this.sendToClient(client, {
          id: message.id,
          error: {
            code: CDP_SERVER_ERROR,
            message:
              "Target.createTarget is not supported: icdp targets are iframes paired by the Host.",
          },
        });
        return RESPONDED;
      default:
        return undefined;
    }
  }
}
