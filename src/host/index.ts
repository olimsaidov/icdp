import {
  CDP_SERVER_ERROR,
  type CdpError,
  type CdpMessage,
  type FrameInfo,
  type HostToRelayMessage,
  isHandshakeMessage,
  PROTOCOL_VERSION,
  parseJson,
  type RelayToHostMessage,
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
  consumerKey: string;
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
  /** domain -> consumer keys that currently have it enabled */
  enables: Map<string, Set<string>>;
  localSessions: Map<string, LocalSessionState>;
  onLoad: () => void;
};

type LocalSessionState = {
  key: string;
  listeners: Set<(method: string, params: Record<string, unknown>) => void>;
};

export type RelayUplinkOptions = {
  /** Bridge WebSocket URL on the Relay, e.g. ws://host/icdp/host */
  url: string;
  reconnectDelayMs?: number;
  webSocketFactory?: (url: string) => WebSocket;
};

const TARGET_NOT_CONNECTED = "Target is not connected: the Frame Agent has not paired yet.";

function methodDomain(method: string): string {
  return method.split(".")[0] ?? method;
}

/** Params of a CDP Target.createTarget request handed to onCreateTarget. */
export type CreateTargetParams = { url?: string } & Record<string, unknown>;

export type IcdpHostOptions = {
  /** The window to listen on (defaults to the global `window`). */
  window?: WindowLike;
  /**
   * Handle a Client's `Target.createTarget`: create + `pair()` an iframe and
   * return its `targetId`. The Relay's response resolves only after the new
   * Target connects, so the Client's first commands land. Throw to reject.
   */
  onCreateTarget?: (params: CreateTargetParams) => string | Promise<string>;
  /**
   * Handle a Client's `Target.closeTarget`: tear the Target down (e.g.
   * `unpair()` + remove the iframe). Throw to reject.
   */
  onCloseTarget?: (targetId: string) => void | Promise<void>;
};

export class IcdpHost {
  private readonly pairings = new Map<string, Pairing>();
  private readonly targetListeners = new Set<(event: TargetEvent) => void>();
  private nextLocalSession = 1;
  private uplink: RelayUplink | null = null;
  private readonly win: WindowLike;
  private readonly options: IcdpHostOptions;
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
      enables: new Map(),
      localSessions: new Map(),
      onLoad: () => this.probe(pairing),
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
      key: `local-${this.nextLocalSession++}`,
      listeners: new Set(),
    };
    pairing.localSessions.set(state.key, state);

    return {
      send: (method, params = {}) =>
        new Promise((resolve, reject) => {
          this.dispatch(pairing, state.key, method, params, (result, error) => {
            if (error) reject(Object.assign(new Error(error.message), { code: error.code }));
            else resolve(result);
          });
        }),
      onEvent: (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      detach: () => {
        pairing.localSessions.delete(state.key);
        this.releaseEnables(pairing, state.key);
      },
    };
  }

  /** Connect the Relay uplink. Structurally just another consumer of this hub. */
  connectRelay(options: RelayUplinkOptions): () => void {
    this.uplink?.close();
    this.uplink = new RelayUplink(this, options);
    return () => {
      this.uplink?.close();
      this.uplink = null;
    };
  }

  /** Browser-level methods this Host handles, advertised to the Relay so it
   *  forwards them instead of using its built-in default. */
  handledMethods(): string[] {
    const methods: string[] = [];
    if (this.options.onCreateTarget) methods.push("Target.createTarget");
    if (this.options.onCloseTarget) methods.push("Target.closeTarget");
    return methods;
  }

  /** Run a browser-level method the Host advertised (invoked by the Relay
   *  uplink). The resolved value, or a thrown error, becomes the Client's
   *  response. createTarget resolves only once the new Target connects. */
  async handleBrowserRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "Target.createTarget") {
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
      if (!this.options.onCloseTarget) throw new Error(`${method} is not handled by this Host`);
      await this.options.onCloseTarget(String(params.targetId ?? ""));
      return { success: true };
    }
    throw new Error(`Unhandled browser method: ${method}`);
  }

  /** Resolve once a paired Target completes its handshake (targetInfoChanged);
   *  reject if it is destroyed first or does not connect within the timeout. */
  private whenConnected(targetId: string, timeoutMs = 10_000): Promise<void> {
    const pairing = this.pairings.get(targetId);
    if (!pairing) return Promise.reject(new Error(`Unknown target "${targetId}"`));
    if (pairing.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.onTargets((event) => {
        if (event.kind === "targetInfoChanged" && event.target.targetId === targetId) {
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

  private emitTargetEvent(event: TargetEvent): void {
    for (const listener of this.targetListeners) listener(event);
    this.uplink?.handleTargetEvent(event);
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

    if (pairing.port) {
      this.failPending(pairing, "Target reloaded");
      pairing.port.close();
    }

    const channel = new MessageChannel();
    pairing.port = channel.port1;
    pairing.connected = true;
    pairing.info = { title: event.data.title, url: event.data.url };
    pairing.enables.clear();
    channel.port1.onmessage = (portEvent) =>
      this.handleFrameMessage(pairing, String(portEvent.data));
    pairing.iframe.contentWindow?.postMessage(
      { icdp: "welcome", v: PROTOCOL_VERSION } satisfies WelcomeMessage,
      event.origin === "null" ? "*" : event.origin,
      [channel.port2],
    );

    this.emitTargetEvent({ kind: "targetInfoChanged", target: this.summary(pairing) });
  }

  private handleFrameMessage(pairing: Pairing, raw: string): void {
    const message = parseJson<CdpMessage>(raw);
    if (!message) return;

    if (message.id != null) {
      const call = pairing.pending.get(Number(message.id));
      if (!call) return;
      pairing.pending.delete(Number(message.id));
      call.settle(message.result ?? {}, message.error);
      return;
    }

    if (!message.method) return;
    const params = message.params ?? {};
    for (const session of pairing.localSessions.values()) {
      for (const listener of session.listeners) listener(message.method, params);
    }
    this.uplink?.handleFrameEvent(pairing.targetId, message.method, params);
  }

  private failPending(pairing: Pairing, reason: string): void {
    for (const [id, call] of pairing.pending) {
      pairing.pending.delete(id);
      call.settle(undefined, { code: CDP_SERVER_ERROR, message: reason });
    }
  }

  /** Route one command from a consumer to the Frame Agent, with enable ref-counting. */
  dispatch(
    pairing: Pairing,
    consumerKey: string,
    method: string,
    params: Record<string, unknown>,
    settle: (result: unknown, error?: CdpError) => void,
  ): void {
    const domain = methodDomain(method);

    if (method.endsWith(".disable")) {
      const holders = pairing.enables.get(domain);
      holders?.delete(consumerKey);
      if (holders && holders.size > 0) {
        // Another consumer still has this domain enabled — swallow the disable.
        settle({});
        return;
      }
    }

    if (!pairing.port) {
      settle(undefined, { code: CDP_SERVER_ERROR, message: TARGET_NOT_CONNECTED });
      return;
    }

    if (method.endsWith(".enable")) {
      let holders = pairing.enables.get(domain);
      if (!holders) {
        holders = new Set();
        pairing.enables.set(domain, holders);
      }
      holders.add(consumerKey);
    }

    const commandId = pairing.nextCommandId++;
    pairing.pending.set(commandId, { consumerKey, settle });
    pairing.port.postMessage(JSON.stringify({ id: commandId, method, params }));
  }

  dispatchTo(
    targetId: string,
    consumerKey: string,
    method: string,
    params: Record<string, unknown>,
    settle: (result: unknown, error?: CdpError) => void,
  ): void {
    const pairing = this.pairings.get(targetId);
    if (!pairing) {
      settle(undefined, { code: CDP_SERVER_ERROR, message: `Unknown target "${targetId}"` });
      return;
    }
    this.dispatch(pairing, consumerKey, method, params, settle);
  }

  /** Drop a consumer's enable refs; send disables to the frame for domains it held last. */
  releaseEnables(pairing: Pairing, consumerKey: string): void {
    for (const [domain, holders] of pairing.enables) {
      if (!holders.delete(consumerKey)) continue;
      if (holders.size === 0 && pairing.port) {
        const commandId = pairing.nextCommandId++;
        pairing.pending.set(commandId, { consumerKey, settle: () => {} });
        pairing.port.postMessage(
          JSON.stringify({ id: commandId, method: `${domain}.disable`, params: {} }),
        );
      }
    }
  }

  releaseEnablesFor(targetId: string, consumerKey: string): void {
    const pairing = this.pairings.get(targetId);
    if (pairing) this.releaseEnables(pairing, consumerKey);
  }
}

class RelayUplink {
  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: IcdpHost,
    private readonly options: RelayUplinkOptions,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(this.options.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.send({
        kind: "ready",
        v: PROTOCOL_VERSION,
        targets: this.host.targets(),
        handles: this.host.handledMethods(),
      });
    });
    socket.addEventListener("message", (event) => {
      const message = parseJson<RelayToHostMessage>(String(event.data));
      if (message) this.handleRelayMessage(message);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
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

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  private send(message: HostToRelayMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private handleRelayMessage(message: RelayToHostMessage): void {
    if (message.kind === "command") {
      this.host.dispatchTo(
        message.targetId,
        `relay-${message.sessionId}`,
        message.method,
        message.params,
        (result, error) => {
          this.send({
            kind: "response",
            sessionId: message.sessionId,
            id: message.id,
            ...(error ? { error } : { result }),
          });
        },
      );
    } else if (message.kind === "detached") {
      this.host.releaseEnablesFor(message.targetId, `relay-${message.sessionId}`);
    } else if (message.kind === "browserRequest") {
      this.host.handleBrowserRequest(message.method, message.params).then(
        (result) => this.send({ kind: "browserResult", id: message.id, result }),
        (error: unknown) =>
          this.send({
            kind: "browserResult",
            id: message.id,
            error: {
              code: CDP_SERVER_ERROR,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
    }
  }

  handleFrameEvent(targetId: string, method: string, params: Record<string, unknown>): void {
    this.send({ kind: "event", targetId, method, params });
  }

  handleTargetEvent(event: TargetEvent): void {
    if (event.kind === "targetCreated") this.send({ kind: "targetCreated", target: event.target });
    else if (event.kind === "targetDestroyed")
      this.send({ kind: "targetDestroyed", targetId: event.targetId });
    else this.send({ kind: "targetInfoChanged", target: event.target });
  }
}
