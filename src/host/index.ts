import { parseCdpCommand, validateCdpParams, type CdpParamSchema } from "../cdp-dispatch.ts";
import {
  CDP_INVALID_PARAMS,
  CDP_METHOD_NOT_FOUND,
  CDP_SERVER_ERROR,
  CDP_SESSION_NOT_FOUND,
  type CdpError,
  type CdpMessage,
  type FrameToHostMessage,
  type FrameInfo,
  type FrameSessionState,
  type HostToRelayMessage,
  type HostToFrameMessage,
  isHandshakeMessage,
  PROTOCOL_VERSION,
  parseJson,
  type TargetSummary,
  type WelcomeMessage,
} from "../protocol.ts";

/** Minimal structural view of an iframe, so tests can fake it. */
export type FrameElementLike = {
  contentWindow: {
    postMessage: (message: unknown, targetOrigin: string, transfer?: Transferable[]) => void;
  } | null;
  addEventListener: (type: "load", listener: () => void) => void;
  removeEventListener: (type: "load", listener: () => void) => void;
};

/** Minimal structural view of the parent window, so tests can fake it. */
export type WindowLike = {
  addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
};

export type PairOptions = {
  /** Stable Target id for this Pairing. Survives reloads and navigations. */
  targetId: string;
  /**
   * Frame origins allowed to pair into this slot, or "*" to accept whatever
   * the iframe element currently hosts.
   */
  origins: string[] | "*";
};

export type LocalSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  detach(): void;
};

export type TargetEvent =
  | { kind: "targetCreated"; target: TargetSummary }
  | { kind: "targetDestroyed"; targetId: string }
  | { kind: "targetInfoChanged"; target: TargetSummary };

type PendingCall = {
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
  settle: (result: unknown, error?: CdpError) => void;
};

type Pairing = {
  targetId: string;
  iframe: FrameElementLike;
  origins: string[] | "*";
  port: MessagePort | null;
  connected: boolean;
  info: FrameInfo;
  nextCommandId: number;
  pending: Map<number, PendingCall>;
  sessions: Set<string>;
  helloAwaitingLoad: boolean;
  loadAwaitingHello: boolean;
  onLoad: () => void;
};

type LocalSessionState = {
  listeners: Set<(method: string, params: Record<string, unknown>) => void>;
};

type TargetAgentState = {
  /** Internal Session that owns this Target agent; absent for the browser root. */
  ownerSessionId?: string;
  /** Outer flat-Session id for events; absent for browser and direct page sockets. */
  envelopeSessionId?: string;
  /** Current page Target; absent for the browser Target agent. */
  targetId?: string;
  autoAttach: boolean;
  autoAttachFilter?: TargetFilter;
  discoverTargets: boolean;
  discoverFilter?: TargetFilter;
  reportedTargets: Set<string>;
};

type RelayClientState = {
  id: string;
  directTargetId?: string;
  directSessionId?: string;
  rootTargetAgent: TargetAgentState;
  sessions: Set<string>;
};

type SessionState = {
  sessionId: string;
  targetId: string;
  owner: { kind: "relay"; clientId: string } | { kind: "local"; local: LocalSessionState };
  /** The Target agent that attached this Session; absent means browser root. */
  parentAgentSessionId?: string;
  targetAgent: TargetAgentState;
  autoAttached: boolean;
  enabledDomains: Set<string>;
  domainParams: Map<string, Record<string, unknown>>;
};

export type RelayUplinkOptions = {
  /** Bridge WebSocket URL on the Relay, e.g. ws://host/icdp/host */
  url: string;
  reconnectDelayMs?: number;
  webSocketFactory?: (url: string) => WebSocket;
};

const TARGET_NOT_CONNECTED = "Target is not connected: the Frame Agent has not paired yet.";
const CONSUMER_DETACHED = "Consumer detached";
let fallbackInstanceSequence = 0;

function uniqueInstanceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  fallbackInstanceSequence++;
  return `${Date.now().toString(36)}-${fallbackInstanceSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function methodDomain(method: string): string {
  return method.split(".")[0] ?? method;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFrameToHostMessage(value: unknown): value is FrameToHostMessage {
  if (!isRecord(value) || typeof value.sessionId !== "string") return false;
  if (value.kind === "event") {
    return typeof value.method === "string" && isRecord(value.params);
  }
  if (value.kind !== "response" || !Number.isInteger(value.id)) return false;
  return (
    value.error === undefined ||
    (isRecord(value.error) &&
      typeof value.error.code === "number" &&
      typeof value.error.message === "string")
  );
}

type TargetFilter = Array<{ exclude?: boolean; type?: string }>;

const BROWSER_PARAM_SCHEMAS: Record<string, CdpParamSchema> = {
  "Browser.getVersion": {},
  "Target.setRemoteLocations": { required: { locations: "array" } },
  "Target.getTargets": { optional: { filter: "array" } },
  "Target.getTargetInfo": { optional: { targetId: "string" } },
  "Target.setDiscoverTargets": {
    required: { discover: "boolean" },
    optional: { filter: "array" },
  },
  "Target.setAutoAttach": {
    required: { autoAttach: "boolean", waitForDebuggerOnStart: "boolean" },
    optional: { filter: "array", flatten: "boolean" },
  },
  "Target.attachToTarget": {
    required: { targetId: "string" },
    optional: { flatten: "boolean" },
  },
  "Target.detachFromTarget": {
    optional: { sessionId: "string", targetId: "string" },
  },
  "Target.createTarget": {
    required: { url: "string" },
    optional: {
      left: "integer",
      top: "integer",
      width: "integer",
      height: "integer",
      windowState: "string",
      browserContextId: "string",
      enableBeginFrameControl: "boolean",
      newWindow: "boolean",
      background: "boolean",
      forTab: "boolean",
      hidden: "boolean",
      focus: "boolean",
    },
  },
  "Target.closeTarget": { required: { targetId: "string" } },
};

function targetFilter(value: unknown): TargetFilter | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return;
  const entries: TargetFilter = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
    const { exclude, type } = entry as Record<string, unknown>;
    if (exclude !== undefined && typeof exclude !== "boolean") return;
    if (type !== undefined && typeof type !== "string") return;
    entries.push({
      ...(exclude !== undefined ? { exclude } : {}),
      ...(type !== undefined ? { type } : {}),
    });
  }
  return entries;
}

function matchesTargetFilter(filter: TargetFilter | undefined, type = "page"): boolean {
  if (filter === undefined) return type !== "browser" && type !== "tab";
  for (const entry of filter) {
    if (entry.type === undefined || entry.type === type) return !entry.exclude;
  }
  return false;
}

function createTargetAgent(
  targetId?: string,
  ownerSessionId?: string,
  envelopeSessionId?: string,
): TargetAgentState {
  return {
    ...(targetId === undefined ? {} : { targetId }),
    ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
    ...(envelopeSessionId === undefined ? {} : { envelopeSessionId }),
    autoAttach: false,
    discoverTargets: false,
    reportedTargets: new Set(),
  };
}

function isRemoteLocation(value: unknown): boolean {
  if (!isRecord(value) || typeof value.host !== "string") return false;
  return (
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port >= -2_147_483_648 &&
    value.port <= 2_147_483_647
  );
}

/** Params of a CDP Target.createTarget request handed to onCreateTarget. */
export type CreateTargetParams = {
  url: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  windowState?: string;
  browserContextId?: string;
  enableBeginFrameControl?: boolean;
  newWindow?: boolean;
  background?: boolean;
  forTab?: boolean;
  hidden?: boolean;
  focus?: boolean;
} & Record<string, unknown>;

export type IcdpHostOptions = {
  /** The window to listen on (defaults to the global `window`). */
  window?: WindowLike;
  /** Reported by Browser.getVersion. */
  product?: string;
  /**
   * Handle a Client's `Target.createTarget`: create + `pair()` an iframe and
   * return its `targetId`. The Relay's response resolves only after the new
   * Target connects, so the Client's first commands land. Throw to reject.
   */
  onCreateTarget?: (params: CreateTargetParams) => string | Promise<string>;
  /**
   * Handle a Client's `Target.closeTarget`: release the underlying Target
   * resource (for example, remove its iframe). The Host unpairs it after the
   * success response has been queued. Throw to reject.
   */
  onCloseTarget?: (targetId: string) => void | Promise<void>;
};

export class IcdpHost {
  private readonly pairings = new Map<string, Pairing>();
  private readonly relayClients = new Map<string, RelayClientState>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly targetListeners = new Set<(event: TargetEvent) => void>();
  private nextSession = 1;
  private uplink: RelayUplink | null = null;
  private readonly win: WindowLike;
  private readonly options: IcdpHostOptions;
  private readonly instanceId = `icdp-host-${uniqueInstanceId()}`;
  private readonly browserTargetId = `icdp-browser-${uniqueInstanceId()}`;
  private readonly onWindowMessage = (event: MessageEvent) => this.handleWindowMessage(event);

  constructor(optionsOrWindow: IcdpHostOptions | WindowLike = {}) {
    // Back-compat: a bare WindowLike (has addEventListener) is still accepted.
    this.options =
      "addEventListener" in optionsOrWindow ? { window: optionsOrWindow } : optionsOrWindow;
    this.win = this.options.window ?? window;
    this.win.addEventListener("message", this.onWindowMessage);
  }

  /** Register an iframe slot as a Target. The Pairing owns target identity. */
  pair(iframe: FrameElementLike, options: PairOptions): void {
    if (this.pairings.has(options.targetId)) {
      throw new Error(`Target "${options.targetId}" is already paired`);
    }
    const pairing: Pairing = {
      targetId: options.targetId,
      iframe,
      origins: options.origins,
      port: null,
      connected: false,
      info: { title: options.targetId, url: "" },
      nextCommandId: 1,
      pending: new Map(),
      sessions: new Set(),
      helloAwaitingLoad: false,
      loadAwaitingHello: false,
      onLoad: () => {
        if (pairing.helloAwaitingLoad) {
          pairing.helloAwaitingLoad = false;
          return;
        }
        if (pairing.port) {
          this.failPending(pairing, "Target reloaded");
          pairing.port.close();
          pairing.port = null;
          pairing.connected = false;
        }
        pairing.loadAwaitingHello = true;
        this.probe(pairing);
      },
    };
    this.pairings.set(options.targetId, pairing);
    iframe.addEventListener("load", pairing.onLoad);
    this.probe(pairing);
    this.emitTargetEvent({ kind: "targetCreated", target: this.summary(pairing) });
  }

  /** Destroy a Pairing. This is the only way a Target dies. */
  unpair(targetId: string): void {
    const pairing = this.pairings.get(targetId);
    if (!pairing) return;
    this.endSessionsForTargetDestruction(targetId);
    this.pairings.delete(targetId);
    pairing.iframe.removeEventListener("load", pairing.onLoad);
    this.failPending(pairing, "Target destroyed");
    pairing.port?.close();
    pairing.port = null;
    this.emitTargetEvent({ kind: "targetDestroyed", targetId });
  }

  targets(): TargetSummary[] {
    return Array.from(this.pairings.values(), (pairing) => this.summary(pairing));
  }

  onTargets(listener: (event: TargetEvent) => void): () => void {
    this.targetListeners.add(listener);
    return () => this.targetListeners.delete(listener);
  }

  /** Attach a local consumer (e.g. a console panel) to a Target — no server involved. */
  attach(targetId: string): LocalSession {
    const pairing = this.pairings.get(targetId);
    if (!pairing) throw new Error(`Unknown target "${targetId}"`);
    const state: LocalSessionState = {
      listeners: new Set(),
    };
    const session = this.startSession(targetId, { kind: "local", local: state });
    let detached = false;

    return {
      send: (method, params = {}) =>
        new Promise((resolve, reject) => {
          if (detached) {
            reject(Object.assign(new Error(CONSUMER_DETACHED), { code: CDP_SERVER_ERROR }));
            return;
          }
          this.dispatchSession(session, method, params, (result, error) => {
            if (error) {
              reject(
                Object.assign(new Error(error.message), {
                  code: error.code,
                  ...(error.data !== undefined ? { data: error.data } : {}),
                }),
              );
            } else resolve(result);
          });
        }),
      onEvent: (listener) => {
        if (detached) return () => {};
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      detach: () => {
        if (detached) return;
        detached = true;
        state.listeners.clear();
        this.endSession(session.sessionId);
      },
    };
  }

  /** Connect the Relay uplink. Structurally just another consumer of this hub. */
  connectRelay(options: RelayUplinkOptions): () => void {
    this.uplink?.close(true);
    const uplink = new RelayUplink(this, options, this.instanceId);
    this.uplink = uplink;
    return () => {
      uplink.close();
      if (this.uplink === uplink) this.uplink = null;
    };
  }

  syncRelayClients(clientIds: string[], targetIds: Record<string, string> = {}): void {
    const current = new Set(clientIds);
    for (const [clientId, client] of this.relayClients) {
      if (current.has(clientId)) continue;
      for (const sessionId of Array.from(client.sessions)) this.endSession(sessionId);
      this.relayClients.delete(clientId);
    }
    for (const clientId of current) {
      const directTargetId = targetIds[clientId];
      const existing = this.relayClients.get(clientId);
      if (existing && existing.directTargetId === directTargetId) continue;
      if (existing) {
        for (const sessionId of Array.from(existing.sessions)) this.endSession(sessionId);
        this.relayClients.delete(clientId);
      }
      const client: RelayClientState = {
        id: clientId,
        ...(directTargetId === undefined ? {} : { directTargetId }),
        rootTargetAgent: createTargetAgent(),
        sessions: new Set(),
      };
      this.relayClients.set(clientId, client);
      if (directTargetId !== undefined && this.pairings.has(directTargetId)) {
        const session = this.attachRelayClient(client, directTargetId, {
          notify: false,
          direct: true,
          parentAgent: client.rootTargetAgent,
        });
        client.directSessionId = session.sessionId;
      }
    }
  }

  handleRelayClientMessage(clientId: string, raw: string): void {
    void this.dispatchRelayClientMessage(clientId, raw);
  }

  private async dispatchRelayClientMessage(clientId: string, raw: string): Promise<void> {
    const client = this.relayClients.get(clientId);
    if (!client) return;

    const parsed = parseCdpCommand(raw);
    if (!parsed.ok) {
      this.sendRelayClient(clientId, parsed.response);
      return;
    }

    const message = parsed.command;
    const params = message.params;
    const session = message.sessionId
      ? this.sessions.get(message.sessionId)
      : client.directSessionId
        ? this.sessions.get(client.directSessionId)
        : undefined;
    if (
      message.sessionId &&
      (!session || session.owner.kind !== "relay" || session.owner.clientId !== clientId)
    ) {
      this.sendRelayClient(clientId, {
        id: message.id,
        error: {
          code: CDP_SESSION_NOT_FOUND,
          message: "Session with given id not found.",
        },
      });
      return;
    }
    const targetAgent = session?.targetAgent ?? client.rootTargetAgent;
    const requestIsLive = (): boolean =>
      this.relayClients.get(clientId) === client &&
      (session === undefined || this.sessions.get(session.sessionId) === session);

    const respond = (result: unknown): void => {
      if (!requestIsLive()) return;
      this.sendRelayClient(clientId, {
        id: message.id,
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        result: result ?? {},
      });
    };
    const reject = (code: number, error: string, data?: unknown): void => {
      if (!requestIsLive()) return;
      this.sendRelayClient(clientId, {
        id: message.id,
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        error: {
          code,
          message: error,
          ...(data !== undefined ? { data } : {}),
        },
      });
    };

    if (message.method === "Browser.getVersion") {
      respond({
        protocolVersion: "1.3",
        product: this.options.product ?? "icdp/0.5.0",
        revision: `icdp-v${PROTOCOL_VERSION}`,
        userAgent: this.options.product ?? "icdp/0.5.0",
        jsVersion: "synthetic",
      });
      return;
    }

    if (session && message.method === "Target.getTargetInfo") {
      const schemaError = validateCdpParams(params, BROWSER_PARAM_SCHEMAS[message.method]);
      if (schemaError) {
        reject(schemaError.code, schemaError.message);
        return;
      }
      const targetId = (params.targetId as string | undefined) ?? targetAgent.targetId;
      if (targetId === undefined) {
        respond({ targetInfo: this.browserTargetInfo() });
        return;
      }
      const targetInfo = this.targetInfoForId(targetId);
      if (!targetInfo) {
        reject(CDP_INVALID_PARAMS, "No target with given id found");
        return;
      }
      respond({ targetInfo });
      return;
    }

    if (
      session &&
      !message.method.startsWith("Browser.") &&
      !message.method.startsWith("Target.")
    ) {
      this.dispatchSession(session, message.method, message.params, (result, error) => {
        if (error) reject(error.code, error.message, error.data);
        else respond(result);
      });
      return;
    }

    const schemaError = validateCdpParams(params, BROWSER_PARAM_SCHEMAS[message.method]);
    if (schemaError) {
      reject(schemaError.code, schemaError.message);
      return;
    }
    if (
      message.method === "Target.setRemoteLocations" &&
      !(params.locations as unknown[]).every(isRemoteLocation)
    ) {
      reject(CDP_INVALID_PARAMS, "Invalid parameters");
      return;
    }
    const acceptsFilter =
      message.method === "Target.getTargets" ||
      message.method === "Target.setDiscoverTargets" ||
      message.method === "Target.setAutoAttach";
    const hasFilter = acceptsFilter && Object.prototype.hasOwnProperty.call(params, "filter");
    const filter = targetFilter(params.filter);
    if (hasFilter && filter === undefined) {
      reject(CDP_INVALID_PARAMS, "Invalid parameters");
      return;
    }

    if (message.method === "Target.setRemoteLocations") {
      reject(CDP_SERVER_ERROR, "Not supported");
      return;
    }
    if (message.method === "Target.getTargets") {
      const activeFilter = hasFilter ? filter : targetAgent.discoverFilter;
      const targetInfos = this.targets()
        .filter(() => matchesTargetFilter(activeFilter))
        .map((target) => this.targetInfo(target));
      if (matchesTargetFilter(activeFilter, "browser")) {
        targetInfos.unshift(this.browserTargetInfo());
      }
      respond({
        targetInfos,
      });
      return;
    }
    if (message.method === "Target.getTargetInfo") {
      const targetId = (params.targetId as string | undefined) ?? targetAgent.targetId;
      const targetInfo =
        targetId === undefined ? this.browserTargetInfo() : this.targetInfoForId(targetId);
      if (!targetInfo) {
        reject(CDP_INVALID_PARAMS, "No target with given id found");
        return;
      }
      respond({ targetInfo });
      return;
    }
    if (message.method === "Target.setDiscoverTargets") {
      if (!params.discover && filter && filter.length > 0) {
        reject(CDP_INVALID_PARAMS, "Filter should not be present with `discover` is off");
        return;
      }
      targetAgent.discoverTargets = params.discover as boolean;
      targetAgent.discoverFilter = targetAgent.discoverTargets ? filter : undefined;
      if (targetAgent.discoverTargets) {
        if (matchesTargetFilter(targetAgent.discoverFilter, "browser")) {
          this.reportTargetInfoCreated(client, targetAgent, this.browserTargetInfo());
        }
        for (const target of this.targets()) {
          this.reportTargetCreated(client, targetAgent, target);
        }
      } else {
        targetAgent.reportedTargets.clear();
      }
      respond({});
      return;
    }
    if (message.method === "Target.setAutoAttach") {
      if (params.flatten !== true) {
        reject(
          CDP_INVALID_PARAMS,
          "Only flatten protocol is supported with browser level auto-attach",
        );
        return;
      }
      if (params.waitForDebuggerOnStart) {
        reject(CDP_SERVER_ERROR, "waitForDebuggerOnStart is not supported");
        return;
      }
      if (!params.autoAttach && filter && filter.length > 0) {
        reject(CDP_INVALID_PARAMS, "Target filter should be empty when disabling auto-attach");
        return;
      }
      if (filter && matchesTargetFilter(filter, "tab") && matchesTargetFilter(filter, "page")) {
        reject(
          CDP_INVALID_PARAMS,
          'Filter should not simultaneously allow "tab" and "page", page targets are attached via tab targets',
        );
        return;
      }
      targetAgent.autoAttach = params.autoAttach as boolean;
      targetAgent.autoAttachFilter = targetAgent.autoAttach ? filter : undefined;
      if (targetAgent.autoAttach) {
        // Pairings are top-level page Targets. Chromium page Target agents do
        // not auto-attach unrelated top-level pages; only the browser agent
        // receives this Host's Pairings as auto-attach candidates.
        if (targetAgent.ownerSessionId === undefined) {
          for (const target of this.targets()) {
            if (!matchesTargetFilter(targetAgent.autoAttachFilter)) continue;
            if (
              Array.from(client.sessions).some((sessionId) => {
                const attached = this.sessions.get(sessionId);
                return (
                  attached?.targetId === target.targetId &&
                  attached.autoAttached &&
                  attached.parentAgentSessionId === targetAgent.ownerSessionId
                );
              })
            ) {
              continue;
            }
            this.attachRelayClient(client, target.targetId, {
              autoAttached: true,
              parentAgent: targetAgent,
            });
          }
        }
      } else {
        for (const sessionId of Array.from(client.sessions)) {
          const attached = this.sessions.get(sessionId);
          if (
            attached?.autoAttached &&
            attached.parentAgentSessionId === targetAgent.ownerSessionId
          ) {
            this.endRelaySessionTree(sessionId);
          }
        }
      }
      respond({});
      return;
    }
    if (message.method === "Target.attachToTarget") {
      if (params.flatten !== true) {
        reject(CDP_INVALID_PARAMS, "Only flatten protocol is supported");
        return;
      }
      const targetId = params.targetId as string;
      if (!this.pairings.has(targetId)) {
        reject(CDP_INVALID_PARAMS, "No target with given id found");
        return;
      }
      const attached = this.attachRelayClient(client, targetId, {
        parentAgent: targetAgent,
      });
      respond({ sessionId: attached.sessionId });
      return;
    }
    if (message.method === "Target.detachFromTarget") {
      let sessionId = params.sessionId as string | undefined;
      if (sessionId === undefined && typeof params.targetId === "string") {
        const matches = Array.from(client.sessions).filter(
          (candidate) =>
            candidate !== client.directSessionId &&
            this.sessions.get(candidate)?.targetId === params.targetId &&
            this.sessions.get(candidate)?.parentAgentSessionId === targetAgent.ownerSessionId,
        );
        if (matches.length > 1) {
          reject(CDP_SERVER_ERROR, "Multiple sessions attached, specify id.");
          return;
        }
        sessionId = matches[0];
        if (!sessionId) {
          reject(CDP_INVALID_PARAMS, "No session for given target id");
          return;
        }
      }
      const detached = sessionId !== undefined ? this.sessions.get(sessionId) : undefined;
      if (
        sessionId === undefined ||
        sessionId === client.directSessionId ||
        !detached ||
        detached.owner.kind !== "relay" ||
        detached.owner.clientId !== clientId ||
        detached.parentAgentSessionId !== targetAgent.ownerSessionId
      ) {
        reject(
          CDP_INVALID_PARAMS,
          sessionId !== undefined ? "No session with given id" : "Session id must be specified",
        );
        return;
      }
      this.endRelaySessionTree(sessionId);
      respond({});
      return;
    }
    if (message.method === "Target.createTarget" || message.method === "Target.closeTarget") {
      if (
        message.method === "Target.closeTarget" &&
        !this.pairings.has(params.targetId as string)
      ) {
        reject(CDP_INVALID_PARAMS, "No target with given id found");
        return;
      }
      try {
        if (message.method === "Target.closeTarget") {
          const targetId = params.targetId as string;
          await this.prepareTargetClose(targetId);
          // Chromium sends the command response before targetDestroyed and
          // before a direct /devtools/page socket closes.
          respond({ success: true });
          this.unpair(targetId);
        } else {
          respond(await this.handleBrowserRequest(message.method, params));
        }
      } catch (error) {
        reject(CDP_SERVER_ERROR, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    reject(CDP_METHOD_NOT_FOUND, `'${message.method}' wasn't found`);
  }

  /** Run a browser-level method the Host advertised (invoked by the Relay
   *  uplink). The resolved value, or a thrown error, becomes the Client's
   *  response. createTarget resolves only once the new Target connects. */
  async handleBrowserRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "Target.createTarget") {
      if (typeof params.url !== "string") throw new Error("Invalid parameters");
      if (!this.options.onCreateTarget) throw new Error(`${method} is not handled by this Host`);
      const targetId = await this.options.onCreateTarget(params as CreateTargetParams);
      try {
        await this.whenConnected(targetId);
      } catch (error) {
        // The Target never materialised (timed out, or destroyed mid-handshake).
        // Tear down the half-created Pairing so it doesn't linger as a zombie in
        // the Host, the Relay, and Target.getTargets. unpair() is idempotent.
        this.unpair(targetId);
        throw error;
      }
      return { targetId };
    }
    if (method === "Target.closeTarget") {
      if (typeof params.targetId !== "string") throw new Error("Invalid parameters");
      await this.prepareTargetClose(params.targetId);
      this.unpair(params.targetId);
      return { success: true };
    }
    throw new Error(`Unhandled browser method: ${method}`);
  }

  private async prepareTargetClose(targetId: string): Promise<void> {
    if (!this.pairings.has(targetId)) {
      throw new Error("No target with given id found");
    }
    if (!this.options.onCloseTarget) {
      throw new Error("Target.closeTarget is not handled by this Host");
    }
    await this.options.onCloseTarget(targetId);
  }

  /** Resolve once a paired Target completes its handshake; reject if it is
   *  destroyed first or does not connect within the timeout. */
  private whenConnected(targetId: string, timeoutMs = 10_000): Promise<void> {
    const pairing = this.pairings.get(targetId);
    if (!pairing) return Promise.reject(new Error(`Unknown target "${targetId}"`));
    if (pairing.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.onTargets((event) => {
        if (
          event.kind === "targetInfoChanged" &&
          event.target.targetId === targetId &&
          pairing.connected
        ) {
          clearTimeout(timer);
          off();
          resolve();
        } else if (event.kind === "targetDestroyed" && event.targetId === targetId) {
          clearTimeout(timer);
          off();
          reject(new Error(`Target "${targetId}" was destroyed before connecting`));
        }
      });
      timer = setTimeout(() => {
        off();
        reject(new Error(`Target "${targetId}" did not connect within ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  destroy(): void {
    this.uplink?.close();
    this.uplink = null;
    for (const targetId of Array.from(this.pairings.keys())) this.unpair(targetId);
    this.win.removeEventListener("message", this.onWindowMessage);
  }

  // -- internals ------------------------------------------------------------

  private summary(pairing: Pairing): TargetSummary {
    return { targetId: pairing.targetId, ...pairing.info };
  }

  private frameSessionState(session: SessionState): FrameSessionState {
    const enabledDomains = Array.from(session.enabledDomains).toSorted();
    return {
      enabledDomains,
      domainParams: Object.fromEntries(
        enabledDomains.map((domain) => [domain, session.domainParams.get(domain) ?? {}]),
      ),
    };
  }

  private targetInfo(target: TargetSummary): Record<string, unknown> {
    return {
      ...target,
      type: "page",
      attached: Array.from(this.sessions.values()).some(
        (session) => session.targetId === target.targetId,
      ),
      canAccessOpener: false,
    };
  }

  private browserTargetInfo(): Record<string, unknown> {
    return {
      targetId: this.browserTargetId,
      type: "browser",
      title: "",
      url: "",
      attached: true,
      canAccessOpener: false,
    };
  }

  private targetInfoForId(targetId: string): Record<string, unknown> | undefined {
    if (targetId === this.browserTargetId) return this.browserTargetInfo();
    const pairing = this.pairings.get(targetId);
    return pairing ? this.targetInfo(this.summary(pairing)) : undefined;
  }

  private sendRelayClient(clientId: string, message: CdpMessage): void {
    this.uplink?.sendClientMessage(clientId, message);
  }

  private emitAttachedChanged(targetId: string): void {
    const pairing = this.pairings.get(targetId);
    if (pairing) {
      this.emitTargetEvent({ kind: "targetInfoChanged", target: this.summary(pairing) });
    }
  }

  private targetAgents(client: RelayClientState): TargetAgentState[] {
    const agents = [client.rootTargetAgent];
    for (const sessionId of client.sessions) {
      const session = this.sessions.get(sessionId);
      if (session) agents.push(session.targetAgent);
    }
    return agents;
  }

  private targetAgentForParent(
    client: RelayClientState,
    parentAgentSessionId: string | undefined,
  ): TargetAgentState {
    if (parentAgentSessionId === undefined) return client.rootTargetAgent;
    return this.sessions.get(parentAgentSessionId)?.targetAgent ?? client.rootTargetAgent;
  }

  private sendTargetAgentEvent(
    client: RelayClientState,
    agent: TargetAgentState,
    message: CdpMessage,
  ): void {
    this.sendRelayClient(client.id, {
      ...message,
      ...(agent.envelopeSessionId === undefined ? {} : { sessionId: agent.envelopeSessionId }),
    });
  }

  private reportTargetCreated(
    client: RelayClientState,
    agent: TargetAgentState,
    target: TargetSummary,
  ): void {
    if (!matchesTargetFilter(agent.discoverFilter)) return;
    this.reportTargetInfoCreated(client, agent, this.targetInfo(target));
  }

  private reportTargetInfoCreated(
    client: RelayClientState,
    agent: TargetAgentState,
    targetInfo: Record<string, unknown>,
  ): void {
    const targetId = targetInfo.targetId as string;
    if (agent.reportedTargets.has(targetId)) return;
    agent.reportedTargets.add(targetId);
    this.sendTargetAgentEvent(client, agent, {
      method: "Target.targetCreated",
      params: { targetInfo },
    });
  }

  private attachRelayClient(
    client: RelayClientState,
    targetId: string,
    options: {
      autoAttached?: boolean;
      direct?: boolean;
      notify?: boolean;
      parentAgent?: TargetAgentState;
    } = {},
  ): SessionState {
    const parentAgent = options.parentAgent ?? client.rootTargetAgent;
    const session = this.startSession(
      targetId,
      { kind: "relay", clientId: client.id },
      options.autoAttached,
      parentAgent.ownerSessionId,
      options.direct,
    );
    client.sessions.add(session.sessionId);
    const pairing = this.pairings.get(targetId)!;
    if (options.notify !== false) {
      this.sendTargetAgentEvent(client, parentAgent, {
        method: "Target.attachedToTarget",
        params: {
          sessionId: session.sessionId,
          targetInfo: this.targetInfo(this.summary(pairing)),
          waitingForDebugger: false,
        },
      });
    }
    return session;
  }

  private startSession(
    targetId: string,
    owner: SessionState["owner"],
    autoAttached = false,
    parentAgentSessionId?: string,
    direct = false,
  ): SessionState {
    const pairing = this.pairings.get(targetId);
    if (!pairing) throw new Error(`Unknown target "${targetId}"`);
    const sessionId = `icdp-session-${this.nextSession++}`;
    const session: SessionState = {
      sessionId,
      targetId,
      owner,
      ...(parentAgentSessionId === undefined ? {} : { parentAgentSessionId }),
      targetAgent: createTargetAgent(targetId, sessionId, direct ? undefined : sessionId),
      autoAttached,
      enabledDomains: new Set(),
      domainParams: new Map(),
    };
    this.sessions.set(session.sessionId, session);
    const becameAttached = pairing.sessions.size === 0;
    pairing.sessions.add(session.sessionId);
    this.postToFrame(pairing, {
      kind: "attach",
      sessionId: session.sessionId,
      state: this.frameSessionState(session),
    });
    if (becameAttached) this.emitAttachedChanged(targetId);
    return session;
  }

  private endRelaySessionTree(sessionId: string): void {
    const root = this.sessions.get(sessionId);
    if (!root || root.owner.kind !== "relay") return;
    const client = this.relayClients.get(root.owner.clientId);
    if (!client) return;

    const doomedIds = new Set([sessionId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const candidateId of client.sessions) {
        const candidate = this.sessions.get(candidateId);
        if (
          candidate &&
          !doomedIds.has(candidateId) &&
          candidate.parentAgentSessionId !== undefined &&
          doomedIds.has(candidate.parentAgentSessionId)
        ) {
          doomedIds.add(candidateId);
          expanded = true;
        }
      }
    }

    const depth = (session: SessionState): number => {
      let value = 0;
      let parentId = session.parentAgentSessionId;
      while (parentId !== undefined && doomedIds.has(parentId)) {
        value++;
        parentId = this.sessions.get(parentId)?.parentAgentSessionId;
      }
      return value;
    };
    const doomed = Array.from(doomedIds, (id) => this.sessions.get(id))
      .filter((session): session is SessionState => session !== undefined)
      .toSorted((left, right) => depth(right) - depth(left));
    const attachedChangedTargetIds = new Set<string>();
    for (const session of doomed) {
      if (attachedChangedTargetIds.has(session.targetId)) continue;
      const pairing = this.pairings.get(session.targetId);
      if (
        pairing &&
        pairing.sessions.size > 0 &&
        Array.from(pairing.sessions).every((candidateId) => doomedIds.has(candidateId))
      ) {
        attachedChangedTargetIds.add(session.targetId);
      }
    }

    const parentAgent = this.targetAgentForParent(client, root.parentAgentSessionId);
    for (const session of doomed) {
      this.endSession(session.sessionId, {
        discardPending: true,
        recursive: false,
        suppressAttachedChanged: true,
      });
    }
    this.sendTargetAgentEvent(client, parentAgent, {
      method: "Target.detachedFromTarget",
      params: { sessionId: root.sessionId, targetId: root.targetId },
    });
    for (const changedTargetId of attachedChangedTargetIds) {
      this.emitAttachedChanged(changedTargetId);
    }
  }

  private endSessionsForTargetDestruction(targetId: string): void {
    const doomedIds = new Set(
      Array.from(this.sessions.values())
        .filter((session) => session.targetId === targetId)
        .map((session) => session.sessionId),
    );
    if (doomedIds.size === 0) return;

    // A child Session cannot outlive the Target agent that owns it, even when
    // that child happens to inspect another still-live Pairing.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const session of this.sessions.values()) {
        if (
          !doomedIds.has(session.sessionId) &&
          session.parentAgentSessionId !== undefined &&
          doomedIds.has(session.parentAgentSessionId)
        ) {
          doomedIds.add(session.sessionId);
          expanded = true;
        }
      }
    }

    const doomed = Array.from(this.sessions.values()).filter((session) =>
      doomedIds.has(session.sessionId),
    );
    const attachedChangedTargetIds = new Set<string>();
    for (const session of doomed) {
      if (session.targetId === targetId || attachedChangedTargetIds.has(session.targetId)) continue;
      const pairing = this.pairings.get(session.targetId);
      if (
        pairing &&
        pairing.sessions.size > 0 &&
        Array.from(pairing.sessions).every((sessionId) => doomedIds.has(sessionId))
      ) {
        attachedChangedTargetIds.add(session.targetId);
      }
    }
    const destroyedPairing = this.pairings.get(targetId);
    if (
      destroyedPairing &&
      destroyedPairing.sessions.size > 0 &&
      Array.from(destroyedPairing.sessions).every((sessionId) => doomedIds.has(sessionId))
    ) {
      // Chromium publishes attached:false for the closing Target after any
      // descendant-owned live Targets, but before parent detach/destruction.
      attachedChangedTargetIds.add(targetId);
    }
    const notifications: Array<{
      agent: TargetAgentState;
      client: RelayClientState;
      sessionId: string;
      targetId: string;
    }> = [];

    // Chromium reports every destroyed renderer Session before emitting any
    // parent Target.detachedFromTarget notification. A direct socket brackets
    // its explicit child Sessions with its two unscoped Inspector reasons.
    for (const client of this.relayClients.values()) {
      const clientSessions = doomed.filter(
        (session) => session.owner.kind === "relay" && session.owner.clientId === client.id,
      );
      const direct = clientSessions.find(
        (session) => session.sessionId === client.directSessionId && session.targetId === targetId,
      );
      if (direct) {
        this.sendRelayClient(client.id, {
          method: "Inspector.detached",
          params: { reason: "Render process gone." },
        });
      }
      for (const session of clientSessions) {
        if (session.targetId !== targetId || session === direct) continue;
        this.sendRelayClient(client.id, {
          method: "Inspector.detached",
          params: { reason: "Render process gone." },
          sessionId: session.sessionId,
        });
      }
      if (direct) {
        this.sendRelayClient(client.id, {
          method: "Inspector.detached",
          params: { reason: "target_closed" },
        });
      }

      for (const session of clientSessions) {
        if (session === direct) continue;
        const parentIsDoomed =
          session.parentAgentSessionId !== undefined && doomedIds.has(session.parentAgentSessionId);
        if (parentIsDoomed) continue;
        notifications.push({
          agent: this.targetAgentForParent(client, session.parentAgentSessionId),
          client,
          sessionId: session.sessionId,
          targetId: session.targetId,
        });
      }
    }
    for (const session of doomed) {
      if (session.targetId !== targetId || session.owner.kind !== "local") continue;
      for (const listener of session.owner.local.listeners) {
        listener("Inspector.detached", { reason: "Render process gone." });
      }
    }

    const depth = (session: SessionState): number => {
      let value = 0;
      let parentId = session.parentAgentSessionId;
      const seen = new Set<string>();
      while (parentId !== undefined && doomedIds.has(parentId) && !seen.has(parentId)) {
        seen.add(parentId);
        value++;
        parentId = this.sessions.get(parentId)?.parentAgentSessionId;
      }
      return value;
    };
    for (const session of doomed.toSorted((left, right) => depth(right) - depth(left))) {
      this.endSession(session.sessionId, {
        discardPending: session.owner.kind === "relay",
        reason: session.targetId === targetId ? "Target destroyed" : CONSUMER_DETACHED,
        recursive: false,
        suppressAttachedChanged: true,
      });
    }
    for (const changedTargetId of attachedChangedTargetIds) {
      this.emitAttachedChanged(changedTargetId);
    }
    for (const notification of notifications) {
      this.sendTargetAgentEvent(notification.client, notification.agent, {
        method: "Target.detachedFromTarget",
        params: {
          sessionId: notification.sessionId,
          targetId: notification.targetId,
        },
      });
    }
  }

  private endSession(
    sessionId: string,
    options: {
      discardPending?: boolean;
      reason?: string;
      recursive?: boolean;
      suppressAttachedChanged?: boolean;
    } = {},
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (options.recursive !== false && session.owner.kind === "relay") {
      const client = this.relayClients.get(session.owner.clientId);
      if (client) {
        for (const childId of Array.from(client.sessions)) {
          if (this.sessions.get(childId)?.parentAgentSessionId === sessionId) {
            this.endSession(childId, options);
          }
        }
      }
    }
    this.sessions.delete(sessionId);
    const pairing = this.pairings.get(session.targetId);
    pairing?.sessions.delete(sessionId);
    const becameDetached = pairing !== undefined && pairing.sessions.size === 0;
    if (session.owner.kind === "relay") {
      const client = this.relayClients.get(session.owner.clientId);
      const direct = client?.directSessionId === sessionId;
      if (direct) client.directSessionId = undefined;
      client?.sessions.delete(sessionId);
    } else {
      session.owner.local.listeners.clear();
    }
    if (pairing) {
      for (const [commandId, call] of pairing.pending) {
        if (call.sessionId !== sessionId) continue;
        pairing.pending.delete(commandId);
        if (!options.discardPending) {
          call.settle(undefined, {
            code: CDP_SERVER_ERROR,
            message: options.reason ?? CONSUMER_DETACHED,
          });
        }
      }
      this.postToFrame(pairing, { kind: "detach", sessionId });
    }
    if (becameDetached && !options.suppressAttachedChanged) {
      this.emitAttachedChanged(session.targetId);
    }
  }

  private dispatchSession(
    session: SessionState,
    method: string,
    params: Record<string, unknown>,
    settle: (result: unknown, error?: CdpError) => void,
  ): void {
    const pairing = this.pairings.get(session.targetId);
    if (!pairing?.port) {
      settle(undefined, { code: CDP_SERVER_ERROR, message: TARGET_NOT_CONNECTED });
      return;
    }
    const commandId = pairing.nextCommandId++;
    pairing.pending.set(commandId, {
      sessionId: session.sessionId,
      method,
      params,
      settle,
    });
    this.postToFrame(pairing, {
      kind: "command",
      sessionId: session.sessionId,
      id: commandId,
      method,
      params,
    });
  }

  private postToFrame(pairing: Pairing, message: HostToFrameMessage): void {
    pairing.port?.postMessage(JSON.stringify(message));
  }

  private emitTargetEvent(event: TargetEvent): void {
    for (const listener of this.targetListeners) listener(event);
    for (const client of this.relayClients.values()) {
      for (const agent of this.targetAgents(client)) {
        if (agent.discoverTargets) {
          if (event.kind === "targetCreated") {
            this.reportTargetCreated(client, agent, event.target);
          } else if (event.kind === "targetDestroyed") {
            if (agent.reportedTargets.delete(event.targetId)) {
              this.sendTargetAgentEvent(client, agent, {
                method: "Target.targetDestroyed",
                params: { targetId: event.targetId },
              });
            }
          } else if (agent.reportedTargets.has(event.target.targetId)) {
            this.sendTargetAgentEvent(client, agent, {
              method: "Target.targetInfoChanged",
              params: { targetInfo: this.targetInfo(event.target) },
            });
          }
        }
      }
    }
    this.uplink?.handleTargetEvent(event);
    if (event.kind === "targetCreated") {
      for (const client of this.relayClients.values()) {
        const agent = client.rootTargetAgent;
        if (agent.autoAttach && matchesTargetFilter(agent.autoAttachFilter)) {
          this.attachRelayClient(client, event.target.targetId, {
            autoAttached: true,
            parentAgent: agent,
          });
        }
      }
    }
  }

  private probe(pairing: Pairing): void {
    // The probe carries nothing sensitive, so "*" is safe here; the security
    // gate is the welcome (origin-checked) and the agent's own allowlist.
    pairing.iframe.contentWindow?.postMessage({ icdp: "probe", v: PROTOCOL_VERSION }, "*");
  }

  private handleWindowMessage(event: MessageEvent): void {
    if (!isHandshakeMessage(event.data) || event.data.icdp !== "hello") return;
    const pairing = Array.from(this.pairings.values()).find(
      (candidate) =>
        candidate.iframe.contentWindow !== null && candidate.iframe.contentWindow === event.source,
    );
    if (!pairing) return;
    if (pairing.origins !== "*" && !pairing.origins.includes(event.origin)) return;

    if (pairing.loadAwaitingHello) pairing.loadAwaitingHello = false;
    else pairing.helloAwaitingLoad = true;

    if (pairing.port) {
      this.failPending(pairing, "Target reloaded");
      pairing.port.close();
    }

    const channel = new MessageChannel();
    pairing.port = channel.port1;
    pairing.connected = true;
    pairing.info = { title: event.data.title, url: event.data.url };
    channel.port1.onmessage = (portEvent) => {
      if (pairing.port === channel.port1) {
        this.handleFrameMessage(pairing, String(portEvent.data));
      }
    };
    pairing.iframe.contentWindow?.postMessage(
      { icdp: "welcome", v: PROTOCOL_VERSION } satisfies WelcomeMessage,
      event.origin === "null" ? "*" : event.origin,
      [channel.port2],
    );
    for (const sessionId of pairing.sessions) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      this.postToFrame(pairing, {
        kind: "attach",
        sessionId,
        state: this.frameSessionState(session),
      });
    }

    this.emitTargetEvent({ kind: "targetInfoChanged", target: this.summary(pairing) });
  }

  private handleFrameMessage(pairing: Pairing, raw: string): void {
    const message = parseJson<unknown>(raw);
    if (!isFrameToHostMessage(message)) return;

    if (message.kind === "response") {
      const call = pairing.pending.get(message.id);
      if (!call || call.sessionId !== message.sessionId) return;
      pairing.pending.delete(message.id);
      if (!message.error) {
        const session = this.sessions.get(call.sessionId);
        const domain = methodDomain(call.method);
        if (call.method.endsWith(".enable")) {
          if (session && !session.enabledDomains.has(domain)) {
            session.enabledDomains.add(domain);
            session.domainParams.set(domain, { ...call.params });
          }
        } else if (call.method === "DOM.getDocument") {
          session?.enabledDomains.add(domain);
          if (!session?.domainParams.has(domain)) session?.domainParams.set(domain, {});
        } else if (call.method.endsWith(".disable")) {
          session?.enabledDomains.delete(domain);
          session?.domainParams.delete(domain);
        }
      }
      call.settle(message.result ?? {}, message.error);
      return;
    }

    const session = this.sessions.get(message.sessionId);
    if (!session || session.targetId !== pairing.targetId) return;
    if (session.owner.kind === "relay") {
      const client = this.relayClients.get(session.owner.clientId);
      this.sendRelayClient(session.owner.clientId, {
        method: message.method,
        params: message.params,
        ...(client?.directSessionId === session.sessionId ? {} : { sessionId: session.sessionId }),
      });
    } else {
      for (const listener of session.owner.local.listeners) {
        listener(message.method, message.params);
      }
    }
  }

  private failPending(pairing: Pairing, reason: string): void {
    for (const [id, call] of pairing.pending) {
      pairing.pending.delete(id);
      call.settle(undefined, { code: CDP_SERVER_ERROR, message: reason });
    }
  }
}

class RelayUplink {
  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private outbox: HostToRelayMessage[] = [];

  constructor(
    private readonly host: IcdpHost,
    private readonly options: RelayUplinkOptions,
    private readonly instanceId: string,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(this.options.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (
        !this.sendOn(socket, {
          kind: "ready",
          v: PROTOCOL_VERSION,
          instanceId: this.instanceId,
          targets: this.host.targets(),
        })
      ) {
        return;
      }
      const pending = this.outbox;
      this.outbox = [];
      let replayed = true;
      for (let index = 0; index < pending.length; index++) {
        if (this.sendOn(socket, pending[index]!)) continue;
        this.outbox.unshift(...pending.slice(index));
        replayed = false;
        break;
      }
      if (replayed) this.sendOn(socket, { kind: "readyComplete" });
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.closed) return;
      const message = parseJson<unknown>(String(event.data));
      if (message) this.handleRelayMessage(message);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (event.code === 1002 || event.code === 1008) {
        this.closed = true;
        this.outbox = [];
        this.host.syncRelayClients([]);
        return;
      }
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.options.reconnectDelayMs ?? 500);
  }

  close(preserveClients = false): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.outbox = [];
    if (!preserveClients) this.host.syncRelayClients([]);
    this.socket?.close();
    this.socket = null;
  }

  private send(message: HostToRelayMessage): void {
    if (this.socket && this.sendOn(this.socket, message)) return;
    if (message.kind === "clientMessage") this.outbox.push(message);
  }

  private sendOn(socket: WebSocket, message: HostToRelayMessage): boolean {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      socket.close();
      return false;
    }
  }

  private handleRelayMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const envelope = message as Record<string, unknown>;
    const clientIds = envelope.clientIds;
    if (
      envelope.kind === "clients" &&
      Array.isArray(clientIds) &&
      clientIds.every((clientId) => typeof clientId === "string") &&
      (envelope.targetIds === undefined ||
        (isRecord(envelope.targetIds) &&
          Object.entries(envelope.targetIds).every(
            ([clientId, targetId]) => clientIds.includes(clientId) && typeof targetId === "string",
          )))
    ) {
      this.host.syncRelayClients(
        clientIds,
        (envelope.targetIds as Record<string, string> | undefined) ?? {},
      );
    } else if (
      envelope.kind === "clientMessage" &&
      typeof envelope.clientId === "string" &&
      typeof envelope.message === "string"
    ) {
      this.host.handleRelayClientMessage(envelope.clientId, envelope.message);
    }
  }

  sendClientMessage(clientId: string, message: CdpMessage): void {
    this.send({ kind: "clientMessage", clientId, message: JSON.stringify(message) });
  }

  handleTargetEvent(event: TargetEvent): void {
    if (event.kind === "targetCreated") this.send({ kind: "targetCreated", target: event.target });
    else if (event.kind === "targetDestroyed")
      this.send({ kind: "targetDestroyed", targetId: event.targetId });
    else this.send({ kind: "targetInfoChanged", target: event.target });
  }
}
