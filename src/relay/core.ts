import { parseCdpCommand } from "../cdp-dispatch.ts";
import {
  CDP_SERVER_ERROR,
  type CdpMessage,
  type HostToRelayMessage,
  parseJson,
  PROTOCOL_VERSION,
  type RelayToHostMessage,
  type TargetSummary,
} from "../protocol.ts";
import { isUsableTargetId } from "../target-id.ts";

/** Minimal socket surface the adapter must provide for each connection. */
export type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type RelayCoreOptions = {
  /** Reported by /json/version. */
  product?: string;
  /** Absolute WebSocket URL of the browser endpoint, for /json/version. */
  browserWsUrl?: string;
  /** Absolute direct WebSocket URL advertised for one Target in /json/list. */
  targetWsUrl?: (targetId: string) => string;
};

type ClientState = {
  id: string;
  socket: SocketLike;
  targetId?: string;
};

/**
 * Runtime-agnostic Relay transport.
 *
 * CDP targets and sessions belong to the Host. The Relay only multiplexes raw
 * Client messages by connection id and caches Host target summaries for HTTP
 * discovery.
 */
export class RelayCore {
  private readonly product: string;
  private readonly browserWsUrl: string;
  private readonly targetWsUrl?: (targetId: string) => string;
  private hostSocket: SocketLike | null = null;
  private hostReady = false;
  private hostReadyComplete = false;
  private hostInstanceId: string | null = null;
  private contenderSocket: SocketLike | null = null;
  private readonly clients = new Map<SocketLike, ClientState>();
  private readonly clientsById = new Map<string, ClientState>();
  private readonly targets = new Map<string, TargetSummary>();

  constructor(options: RelayCoreOptions = {}) {
    this.product = options.product ?? "icdp/0.5.1";
    this.browserWsUrl = options.browserWsUrl ?? "";
    this.targetWsUrl = options.targetWsUrl;
  }

  hostConnected(socket: SocketLike): void {
    if (this.hostSocket && this.hostReady && this.hostSocket !== socket) {
      if (this.contenderSocket && this.contenderSocket !== socket) {
        try {
          this.contenderSocket.close(1008, "replaced by a newer host contender");
        } catch {}
      }
      this.contenderSocket = socket;
      return;
    }
    if (this.hostSocket && this.hostSocket !== socket) {
      const previous = this.hostSocket;
      this.hostSocket = null;
      this.targets.clear();
      try {
        previous.close(1008, "replaced by a newer host");
      } catch {}
    }
    this.hostSocket = socket;
    this.hostReady = false;
    this.hostReadyComplete = false;
  }

  hostDisconnected(socket: SocketLike): void {
    if (this.contenderSocket === socket) {
      this.contenderSocket = null;
      return;
    }
    if (this.hostSocket !== socket) return;
    this.hostSocket = null;
    this.hostReady = false;
    this.hostReadyComplete = false;
    this.targets.clear();
    if (this.contenderSocket) {
      this.hostSocket = this.contenderSocket;
      this.contenderSocket = null;
    }
  }

  hostMessage(socket: SocketLike, raw: string): void {
    const isContender = this.contenderSocket === socket;
    if (this.hostSocket !== socket && !isContender) return;
    const message = parseJson<HostToRelayMessage>(raw);
    if (!message) return;

    if (message.kind === "ready") {
      if (
        message.v !== PROTOCOL_VERSION ||
        typeof message.instanceId !== "string" ||
        !Array.isArray(message.targets) ||
        !message.targets.every(
          (target) =>
            typeof target === "object" &&
            target !== null &&
            isUsableTargetId(target.targetId) &&
            typeof target.title === "string" &&
            typeof target.url === "string",
        )
      ) {
        if (isContender) {
          this.contenderSocket = null;
        } else {
          this.hostSocket = null;
          this.hostReady = false;
          this.hostReadyComplete = false;
          this.targets.clear();
        }
        socket.close(1002, "Incompatible host protocol");
        return;
      }
      if (isContender) {
        const previous = this.hostSocket;
        this.hostSocket = socket;
        this.contenderSocket = null;
        try {
          previous?.close(1008, "replaced by a newer host");
        } catch {}
      }
      if (this.hostInstanceId !== null && this.hostInstanceId !== message.instanceId) {
        this.closeClientsForHostReplacement();
      }
      this.hostInstanceId = message.instanceId;
      this.hostReady = true;
      this.hostReadyComplete = false;
      this.targets.clear();
      for (const target of message.targets) this.targets.set(target.targetId, target);
      this.syncClients();
      return;
    }
    if (!this.hostReady || this.hostSocket !== socket) return;

    switch (message.kind) {
      case "readyComplete":
        if (this.hostReadyComplete) return;
        this.hostReadyComplete = true;
        this.closeClientsForMissingTargets();
        this.syncClients();
        return;
      case "targetCreated":
      case "targetInfoChanged":
        if (
          !isUsableTargetId(message.target?.targetId) ||
          typeof message.target.title !== "string" ||
          typeof message.target.url !== "string"
        ) {
          return;
        }
        this.targets.set(message.target.targetId, message.target);
        return;
      case "targetDestroyed":
        if (typeof message.targetId !== "string") return;
        this.targets.delete(message.targetId);
        this.closeTargetClients(message.targetId);
        return;
      case "clientMessage":
        if (typeof message.clientId !== "string" || typeof message.message !== "string") return;
        {
          const client = this.clientsById.get(message.clientId);
          if (client) this.sendRawToClient(client, message.message);
        }
        return;
      default:
        return;
    }
  }

  clientConnected(socket: SocketLike, targetId?: string): void {
    if (targetId !== undefined && !this.targets.has(targetId)) {
      socket.close(1008, "Target not found");
      return;
    }
    const client = {
      id: `icdp-client-${globalThis.crypto.randomUUID()}`,
      socket,
      ...(targetId === undefined ? {} : { targetId }),
    };
    this.clients.set(socket, client);
    this.clientsById.set(client.id, client);
    this.syncClients();
  }

  clientDisconnected(socket: SocketLike): void {
    const client = this.clients.get(socket);
    if (!client) return;
    this.clients.delete(socket);
    this.clientsById.delete(client.id);
    this.syncClients();
  }

  clientMessage(socket: SocketLike, raw: string): void {
    const client = this.clients.get(socket);
    if (!client) return;
    if (this.hostSocket && this.hostReady) {
      this.sendToHost({ kind: "clientMessage", clientId: client.id, message: raw });
      return;
    }

    const parsed = parseCdpCommand(raw);
    if (!parsed.ok) {
      this.sendToClient(client, parsed.response);
      return;
    }
    const request = parsed.command;
    this.sendToClient(client, {
      id: request.id,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      error: { code: CDP_SERVER_ERROR, message: "Host is not connected" },
    });
  }

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
      ...(this.targetWsUrl ? { webSocketDebuggerUrl: this.targetWsUrl(target.targetId) } : {}),
    }));
  }

  status(): { hostConnected: boolean; targets: TargetSummary[]; clients: number } {
    return {
      hostConnected: this.hostSocket !== null && this.hostReady,
      targets: Array.from(this.targets.values()),
      clients: this.clients.size,
    };
  }

  private syncClients(): void {
    if (!this.hostReady) return;
    const targetIds = Object.fromEntries(
      Array.from(this.clientsById.values())
        .filter(
          (client): client is ClientState & { targetId: string } => client.targetId !== undefined,
        )
        .map((client) => [client.id, client.targetId]),
    );
    this.sendToHost({
      kind: "clients",
      clientIds: Array.from(this.clientsById.keys()),
      ...(Object.keys(targetIds).length === 0 ? {} : { targetIds }),
    });
  }

  private closeTargetClients(targetId: string): void {
    const clients = Array.from(this.clients.values()).filter(
      (client) => client.targetId === targetId,
    );
    if (clients.length === 0) return;
    for (const client of clients) {
      this.clients.delete(client.socket);
      this.clientsById.delete(client.id);
      try {
        client.socket.close(1001, "Target closed");
      } catch {}
    }
    this.syncClients();
  }

  private closeClientsForMissingTargets(): void {
    for (const client of Array.from(this.clients.values())) {
      if (client.targetId === undefined || this.targets.has(client.targetId)) continue;
      this.clients.delete(client.socket);
      this.clientsById.delete(client.id);
      try {
        client.socket.close(1001, "Target closed");
      } catch {}
    }
  }

  private sendToHost(message: RelayToHostMessage): void {
    try {
      this.hostSocket?.send(JSON.stringify(message));
    } catch {}
  }

  private closeClientsForHostReplacement(): void {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    this.clientsById.clear();
    for (const client of clients) {
      try {
        client.socket.close(1012, "Host instance replaced");
      } catch {}
    }
  }

  private sendToClient(client: ClientState, message: CdpMessage): void {
    this.sendRawToClient(client, JSON.stringify(message));
  }

  private sendRawToClient(client: ClientState, message: string): void {
    try {
      client.socket.send(message);
    } catch {}
  }
}
