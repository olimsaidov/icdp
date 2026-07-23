import type Protocol from "devtools-protocol";

import { cdpMonotonicTime } from "./time.ts";

const DEFAULT_MAX_BODY_COUNT = 100;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 5_000;
const INTERNAL_QUERY_PARAMETER = "__icdp_internal__";

type Emit = (method: string, params: Record<string, unknown>) => void;

type NetworkWindow = Window & {
  Blob: typeof Blob;
  WebSocket: typeof WebSocket;
  XMLHttpRequest: typeof XMLHttpRequest;
};

export interface NetworkObserverOptions {
  loaderId?: () => string;
  maxBodyBytes?: number;
  maxBodyCount?: number;
}

interface BodyEntry extends Protocol.Network.GetResponseBodyResponse {
  bytes: number;
}

interface BodyCapture {
  base64Encoded?: boolean;
  body?: string;
  bytes: number;
  complete: boolean;
}

interface RequestState {
  loaderId: string;
  requestId: Protocol.Network.RequestId;
  type: Protocol.Network.ResourceType;
  url: string;
}

interface XhrRequestState extends RequestState {
  headers: Protocol.Network.Headers;
  method: string;
  suppressed: boolean;
}

interface SocketObservation {
  active: boolean;
  closeQueued: boolean;
  cleanup: () => void;
  ownSendDescriptor?: PropertyDescriptor;
  socket: WebSocket;
  tail: Promise<void>;
}

type XhrOpenArguments = [
  method: string,
  url: string | URL,
  async?: boolean,
  username?: string | null,
  password?: string | null,
];

function headersToObject(headers: unknown): Protocol.Network.Headers {
  const result: Protocol.Network.Headers = {};
  if (!headers) return result;
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length >= 2) {
        result[String(entry[0]).toLowerCase()] = String(entry[1]);
      }
    }
    return result;
  }
  if (
    typeof headers === "object" &&
    headers !== null &&
    "forEach" in headers &&
    typeof headers.forEach === "function"
  ) {
    headers.forEach((value: unknown, name: unknown) => {
      result[String(name).toLowerCase()] = String(value);
    });
    return result;
  }
  if (typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) {
      result[name.toLowerCase()] = String(value);
    }
  }
  return result;
}

function rawHeadersToObject(rawHeaders: string): Protocol.Network.Headers {
  const result: Protocol.Network.Headers = {};
  for (const line of rawHeaders.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    result[name] = result[name] ? `${result[name]}, ${value}` : value;
  }
  return result;
}

function contentType(headers: Protocol.Network.Headers): {
  charset: string;
  mimeType: string;
} {
  const raw = String(
    Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "",
  );
  const [mimeType = "", ...parameters] = raw.split(";").map((part) => part.trim());
  const charset =
    parameters
      .find((parameter) => parameter.toLowerCase().startsWith("charset="))
      ?.slice("charset=".length)
      .trim() ?? "";
  return { charset, mimeType };
}

function bodyByteLength(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

function responseContentLength(headers: Protocol.Network.Headers): number | undefined {
  const value = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "content-length",
  )?.[1];
  if (value === undefined) return undefined;
  const length = Number(value);
  return Number.isFinite(length) && length >= 0 ? length : undefined;
}

export class NetworkObserver {
  private readonly bodies = new Map<Protocol.Network.RequestId, BodyEntry>();
  private readonly loaderId: () => string;
  private readonly maxBodyBytes: number;
  private readonly maxBodyCount: number;
  private readonly requestScope = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  private bodyBytes = 0;
  private readonly activeXhrCleanups = new Set<() => void>();
  private installed = false;
  private nextRequestId = 0;
  private fetchWrapper?: typeof fetch;
  private originalFetch?: typeof fetch;
  private originalWebSocket?: typeof WebSocket;
  private originalXhrOpen?: XMLHttpRequest["open"];
  private originalXhrSend?: XMLHttpRequest["send"];
  private originalXhrSetRequestHeader?: XMLHttpRequest["setRequestHeader"];
  private xhrOpenWrapper?: XMLHttpRequest["open"];
  private readonly xhrRequests = new WeakMap<XMLHttpRequest, XhrRequestState>();
  private xhrPrototype?: XMLHttpRequest;
  private xhrSendWrapper?: XMLHttpRequest["send"];
  private xhrSetRequestHeaderWrapper?: XMLHttpRequest["setRequestHeader"];
  private readonly sockets = new Set<SocketObservation>();
  private webSocketWrapper?: typeof WebSocket;

  constructor(
    private readonly window: Window,
    private readonly emit: Emit,
    options: NetworkObserverOptions = {},
  ) {
    this.loaderId = options.loaderId ?? (() => "");
    this.maxBodyBytes = Math.max(0, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    this.maxBodyCount = Math.max(0, options.maxBodyCount ?? DEFAULT_MAX_BODY_COUNT);
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;
    this.installFetch();
    this.installXhr();
    this.installWebSocket();
  }

  private installFetch(): void {
    if (typeof this.window.fetch !== "function") return;
    const observeFetch = this.observeFetch.bind(this);
    const original = this.window.fetch;
    this.originalFetch = original;
    const wrapper = function (
      this: Window,
      ...args: Parameters<typeof fetch>
    ): ReturnType<typeof fetch> {
      return observeFetch(this, original, args);
    };
    this.fetchWrapper = wrapper;
    this.window.fetch = wrapper;
  }

  private installXhr(): void {
    const prototype = (this.window as NetworkWindow).XMLHttpRequest?.prototype;
    if (!prototype) return;
    const openXhr = this.openXhr.bind(this);
    const sendXhr = this.sendXhr.bind(this);
    const setXhrRequestHeader = this.setXhrRequestHeader.bind(this);
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const originalSetRequestHeader = prototype.setRequestHeader;
    const openWrapper = function (this: XMLHttpRequest, ...args: XhrOpenArguments): void {
      Reflect.apply(originalOpen, this, args);
      openXhr(this, args);
    } as XMLHttpRequest["open"];
    const sendWrapper = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest["send"]>
    ): void {
      sendXhr(this, originalSend, args);
    };
    const setRequestHeaderWrapper = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest["setRequestHeader"]>
    ): void {
      Reflect.apply(originalSetRequestHeader, this, args);
      setXhrRequestHeader(this, args[0], args[1]);
    };
    this.xhrPrototype = prototype;
    this.originalXhrOpen = originalOpen;
    this.originalXhrSend = originalSend;
    this.originalXhrSetRequestHeader = originalSetRequestHeader;
    this.xhrOpenWrapper = openWrapper;
    this.xhrSendWrapper = sendWrapper;
    this.xhrSetRequestHeaderWrapper = setRequestHeaderWrapper;
    prototype.open = openWrapper;
    prototype.send = sendWrapper;
    prototype.setRequestHeader = setRequestHeaderWrapper;
  }

  private installWebSocket(): void {
    const networkWindow = this.window as NetworkWindow;
    const OriginalWebSocket = networkWindow.WebSocket;
    if (typeof OriginalWebSocket !== "function") return;
    const observeWebSocket = this.observeWebSocket.bind(this);
    function InstrumentedWebSocket(
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ): WebSocket {
      if (!new.target) {
        return Reflect.apply(OriginalWebSocket, this, [url, protocols]);
      }
      const socket =
        protocols === undefined
          ? new OriginalWebSocket(url)
          : new OriginalWebSocket(url, protocols);
      observeWebSocket(socket, String(url), protocols);
      return socket;
    }
    InstrumentedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(InstrumentedWebSocket, OriginalWebSocket);
    const wrapper = InstrumentedWebSocket as unknown as typeof WebSocket;
    this.originalWebSocket = OriginalWebSocket;
    this.webSocketWrapper = wrapper;
    networkWindow.WebSocket = wrapper;
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    if (this.originalFetch && this.fetchWrapper && this.window.fetch === this.fetchWrapper) {
      this.window.fetch = this.originalFetch;
    }
    this.originalFetch = undefined;
    this.fetchWrapper = undefined;
    if (
      this.originalWebSocket &&
      this.webSocketWrapper &&
      (this.window as NetworkWindow).WebSocket === this.webSocketWrapper
    ) {
      (this.window as NetworkWindow).WebSocket = this.originalWebSocket;
    }
    for (const observation of this.sockets) observation.cleanup();
    this.sockets.clear();
    this.originalWebSocket = undefined;
    this.webSocketWrapper = undefined;
    if (this.xhrPrototype) {
      if (
        this.originalXhrOpen &&
        this.xhrOpenWrapper &&
        this.xhrPrototype.open === this.xhrOpenWrapper
      ) {
        this.xhrPrototype.open = this.originalXhrOpen;
      }
      if (
        this.originalXhrSend &&
        this.xhrSendWrapper &&
        this.xhrPrototype.send === this.xhrSendWrapper
      ) {
        this.xhrPrototype.send = this.originalXhrSend;
      }
      if (
        this.originalXhrSetRequestHeader &&
        this.xhrSetRequestHeaderWrapper &&
        this.xhrPrototype.setRequestHeader === this.xhrSetRequestHeaderWrapper
      ) {
        this.xhrPrototype.setRequestHeader = this.originalXhrSetRequestHeader;
      }
    }
    for (const cleanup of this.activeXhrCleanups) cleanup();
    this.activeXhrCleanups.clear();
    this.xhrPrototype = undefined;
    this.originalXhrOpen = undefined;
    this.originalXhrSend = undefined;
    this.originalXhrSetRequestHeader = undefined;
    this.xhrOpenWrapper = undefined;
    this.xhrSendWrapper = undefined;
    this.xhrSetRequestHeaderWrapper = undefined;
    this.bodies.clear();
    this.bodyBytes = 0;
  }

  getResponseBody(requestId: Protocol.Network.RequestId): Protocol.Network.GetResponseBodyResponse {
    const entry = this.bodies.get(requestId);
    if (!entry) throw new Error("No resource with given identifier found");
    return { body: entry.body, base64Encoded: entry.base64Encoded };
  }

  private openXhr(xhr: XMLHttpRequest, args: XhrOpenArguments): void {
    const url = new URL(String(args[1]), this.window.location.href);
    const suppressed = url.searchParams.get(INTERNAL_QUERY_PARAMETER) === "true";
    url.hash = "";
    this.xhrRequests.set(xhr, {
      requestId: this.createRequestId(),
      loaderId: this.loaderId(),
      type: "XHR",
      url: url.href,
      method: String(args[0]).toUpperCase(),
      headers: {},
      suppressed,
    });
  }

  private setXhrRequestHeader(xhr: XMLHttpRequest, name: string, value: string): void {
    const state = this.xhrRequests.get(xhr);
    if (!state) return;
    const normalizedName = name.toLowerCase();
    const previous = state.headers[normalizedName];
    state.headers[normalizedName] = previous === undefined ? value : `${previous}, ${value}`;
  }

  private sendXhr(
    xhr: XMLHttpRequest,
    originalSend: XMLHttpRequest["send"],
    args: Parameters<XMLHttpRequest["send"]>,
  ): void {
    const state = this.xhrRequests.get(xhr);
    if (!state || state.suppressed) {
      Reflect.apply(originalSend, xhr, args);
      return;
    }
    const body = typeof args[0] === "string" ? args[0] : undefined;
    const request: Protocol.Network.Request = {
      url: state.url,
      method: state.method,
      headers: state.headers,
      initialPriority: "High",
      referrerPolicy: "strict-origin-when-cross-origin",
    };
    if (body !== undefined) {
      request.postData = body;
      request.hasPostData = true;
    }
    this.publish("Network.requestWillBeSent", {
      requestId: state.requestId,
      loaderId: state.loaderId,
      documentURL: this.window.document.URL,
      request,
      timestamp: this.monotonicTime(),
      wallTime: Date.now() / 1000,
      initiator: { type: "script" },
      redirectHasExtraInfo: false,
      type: "XHR",
    } satisfies Protocol.Network.RequestWillBeSentEvent);

    const cleanup = this.listenForXhrCompletion(xhr, state);
    try {
      Reflect.apply(originalSend, xhr, args);
    } catch (error) {
      cleanup();
      this.loadingFailed(state, error);
      throw error;
    }
  }

  private listenForXhrCompletion(xhr: XMLHttpRequest, state: XhrRequestState): () => void {
    const onLoad = (): void => {
      cleanup();
      void this.observeXhrResponse(state, xhr);
    };
    const onFailure = (event: Event): void => {
      cleanup();
      this.loadingFailed(state, new Error(`XMLHttpRequest ${event.type}`));
    };
    const cleanup = (): void => {
      xhr.removeEventListener("load", onLoad);
      xhr.removeEventListener("error", onFailure);
      xhr.removeEventListener("abort", onFailure);
      xhr.removeEventListener("timeout", onFailure);
      this.activeXhrCleanups.delete(cleanup);
    };
    xhr.addEventListener("load", onLoad);
    xhr.addEventListener("error", onFailure);
    xhr.addEventListener("abort", onFailure);
    xhr.addEventListener("timeout", onFailure);
    this.activeXhrCleanups.add(cleanup);
    return cleanup;
  }

  private async observeXhrResponse(state: XhrRequestState, xhr: XMLHttpRequest): Promise<void> {
    if (!this.installed) return;
    const headers = rawHeadersToObject(xhr.getAllResponseHeaders());
    const { charset, mimeType } = contentType(headers);
    this.publish("Network.responseReceived", {
      requestId: state.requestId,
      loaderId: state.loaderId,
      timestamp: this.monotonicTime(),
      type: "XHR",
      response: {
        url: xhr.responseURL || state.url,
        status: xhr.status,
        statusText: xhr.statusText,
        headers,
        mimeType,
        charset,
        connectionReused: false,
        connectionId: 0,
        encodedDataLength: 0,
        securityState: "unknown",
      },
      hasExtraInfo: false,
    } satisfies Protocol.Network.ResponseReceivedEvent);

    const captured = await this.captureXhrBody(xhr, mimeType, charset);
    if (!this.installed) return;
    this.finishResponse(
      state.requestId,
      captured.bytes,
      captured.body,
      captured.base64Encoded ?? false,
    );
  }

  private async captureXhrBody(
    xhr: XMLHttpRequest,
    mimeType: string,
    charset: string,
  ): Promise<BodyCapture> {
    if (xhr.responseType === "arraybuffer") {
      const bytes = new Uint8Array((xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0));
      return this.captureKnownBinary(bytes);
    }
    if (xhr.responseType === "blob") {
      const blob = xhr.response as Blob | null;
      const bytes = blob?.size ?? 0;
      if (
        !blob ||
        this.maxBodyCount === 0 ||
        bytes > this.maxBodyBytes ||
        typeof blob.arrayBuffer !== "function"
      ) {
        return { bytes, complete: true };
      }
      try {
        return this.captureKnownBinary(new Uint8Array(await blob.arrayBuffer()));
      } catch {
        return { bytes, complete: true };
      }
    }

    const body =
      xhr.responseType === "json"
        ? (JSON.stringify(xhr.response) ?? "")
        : xhr.responseType === "document"
          ? this.serializeDocument(xhr.response)
          : xhr.responseText;
    const bytes = new TextEncoder().encode(body);
    if (bytes.byteLength > this.maxBodyBytes || this.maxBodyCount === 0) {
      return { bytes: bytes.byteLength, complete: true };
    }
    if (xhr.responseType === "" && !this.isTextualMimeType(mimeType, charset)) {
      return {
        body: this.base64Encode(bytes),
        bytes: bytes.byteLength,
        base64Encoded: true,
        complete: true,
      };
    }
    return {
      body,
      bytes: bytes.byteLength,
      base64Encoded: false,
      complete: true,
    };
  }

  private captureKnownBinary(bytes: Uint8Array): BodyCapture {
    if (bytes.byteLength > this.maxBodyBytes || this.maxBodyCount === 0) {
      return { bytes: bytes.byteLength, complete: true };
    }
    return {
      body: this.base64Encode(bytes),
      bytes: bytes.byteLength,
      base64Encoded: true,
      complete: true,
    };
  }

  private serializeDocument(value: unknown): string {
    if (!value || typeof XMLSerializer === "undefined") return "";
    try {
      return new XMLSerializer().serializeToString(value as Node);
    } catch {
      return "";
    }
  }

  private observeWebSocket(socket: WebSocket, rawUrl: string, protocols?: string | string[]): void {
    const url = new URL(rawUrl, this.window.location.href);
    if (url.searchParams.get(INTERNAL_QUERY_PARAMETER) === "true") return;
    const requestId = this.createRequestId();
    const protocolHeader = Array.isArray(protocols) ? protocols.join(", ") : protocols;
    const requestHeaders: Protocol.Network.Headers = {
      connection: "Upgrade",
      origin: this.window.location.origin,
      "sec-websocket-version": "13",
      upgrade: "websocket",
    };
    if (protocolHeader) {
      requestHeaders["sec-websocket-protocol"] = protocolHeader;
    }
    this.publish("Network.webSocketCreated", {
      requestId,
      url: url.href,
      initiator: { type: "script" },
    } satisfies Protocol.Network.WebSocketCreatedEvent);
    this.publish("Network.webSocketWillSendHandshakeRequest", {
      requestId,
      timestamp: this.monotonicTime(),
      wallTime: Date.now() / 1000,
      request: { headers: requestHeaders },
    } satisfies Protocol.Network.WebSocketWillSendHandshakeRequestEvent);

    const originalSend = socket.send;
    const ownSendDescriptor = Object.getOwnPropertyDescriptor(socket, "send");
    let observation: SocketObservation;
    const onOpen = (): void => {
      if (observation.closeQueued) return;
      const responseHeaders: Protocol.Network.Headers = {
        connection: "Upgrade",
        upgrade: "websocket",
      };
      if (socket.protocol) {
        responseHeaders["sec-websocket-protocol"] = socket.protocol;
      }
      this.publish("Network.webSocketHandshakeResponseReceived", {
        requestId,
        timestamp: this.monotonicTime(),
        response: {
          status: 101,
          statusText: "Switching Protocols",
          headers: responseHeaders,
        },
      } satisfies Protocol.Network.WebSocketHandshakeResponseReceivedEvent);
    };
    const onMessage = (event: MessageEvent): void => {
      if (observation.closeQueued) return;
      this.enqueueWebSocketFrame(
        observation,
        "Network.webSocketFrameReceived",
        requestId,
        event.data,
        false,
      );
    };
    const onClose = (): void => {
      if (observation.closeQueued) return;
      observation.closeQueued = true;
      const timestamp = this.monotonicTime();
      this.enqueueSocketTask(observation, () => {
        try {
          this.publish("Network.webSocketClosed", {
            requestId,
            timestamp,
          } satisfies Protocol.Network.WebSocketClosedEvent);
        } finally {
          observation.cleanup();
        }
      });
    };
    const onError = (event: Event): void => {
      if (observation.closeQueued) return;
      const message =
        "message" in event && typeof event.message === "string" ? event.message : "WebSocket error";
      const timestamp = this.monotonicTime();
      this.enqueueSocketTask(observation, () => {
        this.publish("Network.webSocketFrameError", {
          requestId,
          timestamp,
          errorMessage: message,
        } satisfies Protocol.Network.WebSocketFrameErrorEvent);
      });
    };

    observation = {
      active: true,
      closeQueued: false,
      socket,
      ownSendDescriptor,
      tail: Promise.resolve(),
      cleanup: () => {
        if (!observation.active) return;
        observation.active = false;
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
        if (ownSendDescriptor) {
          Object.defineProperty(socket, "send", ownSendDescriptor);
        } else {
          delete (socket as { send?: WebSocket["send"] }).send;
        }
        this.sockets.delete(observation);
      },
    };
    const enqueueWebSocketFrame = this.enqueueWebSocketFrame.bind(this);
    socket.send = function (
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ): void {
      Reflect.apply(originalSend, this, [data]);
      if (observation.closeQueued) return;
      enqueueWebSocketFrame(observation, "Network.webSocketFrameSent", requestId, data, true);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    this.sockets.add(observation);
  }

  private enqueueWebSocketFrame(
    observation: SocketObservation,
    method: "Network.webSocketFrameReceived" | "Network.webSocketFrameSent",
    requestId: Protocol.Network.RequestId,
    data: unknown,
    mask: boolean,
  ): void {
    const timestamp = this.monotonicTime();
    this.enqueueSocketTask(observation, async () => {
      try {
        const text = typeof data === "string";
        const payloadData = text ? data : await this.binaryPayload(data);
        this.publish(method, {
          requestId,
          timestamp,
          response: { opcode: text ? 1 : 2, mask, payloadData },
        });
      } catch (error) {
        this.publish("Network.webSocketFrameError", {
          requestId,
          timestamp,
          errorMessage: error instanceof Error ? error.message : String(error),
        } satisfies Protocol.Network.WebSocketFrameErrorEvent);
      }
    });
  }

  private enqueueSocketTask(
    observation: SocketObservation,
    task: () => Promise<void> | void,
  ): void {
    if (!observation.active) return;
    observation.tail = observation.tail
      .then(async () => {
        if (observation.active) await task();
      })
      .catch(() => {});
  }

  private async binaryPayload(data: unknown): Promise<string> {
    let bytes: Uint8Array;
    const BlobConstructor = (this.window as NetworkWindow).Blob;
    if (BlobConstructor && data instanceof BlobConstructor) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      bytes = new Uint8Array(data as ArrayBufferLike);
    }
    return this.base64Encode(bytes);
  }

  private observeFetch(
    receiver: Window,
    original: typeof fetch,
    args: Parameters<typeof fetch>,
  ): ReturnType<typeof fetch> {
    const [input, init] = args;
    const inputRecord =
      typeof input === "object" && input !== null
        ? (input as unknown as {
            headers?: HeadersInit;
            method?: string;
            referrerPolicy?: ReferrerPolicy;
            url?: string;
          })
        : undefined;
    const rawUrl = inputRecord?.url ?? String(input);
    const url = new URL(rawUrl, this.window.location.href);
    if (url.searchParams.get(INTERNAL_QUERY_PARAMETER) === "true") {
      return Reflect.apply(original, receiver, args);
    }
    const fragment = url.hash;
    url.hash = "";
    const requestHeaders = {
      ...headersToObject(inputRecord?.headers),
      ...headersToObject(init?.headers),
    };
    const body = typeof init?.body === "string" ? init.body : undefined;
    const loaderId = this.loaderId();
    const requestId = this.createRequestId();
    const state: RequestState = {
      loaderId,
      requestId,
      type: "Fetch",
      url: url.href,
    };
    const request: Protocol.Network.Request = {
      url: url.href,
      method: String(init?.method ?? inputRecord?.method ?? "GET").toUpperCase(),
      headers: requestHeaders,
      initialPriority: "High",
      referrerPolicy: (init?.referrerPolicy ||
        inputRecord?.referrerPolicy ||
        "strict-origin-when-cross-origin") as Protocol.Network.Request["referrerPolicy"],
    };
    if (fragment) request.urlFragment = fragment;
    if (body !== undefined) {
      request.postData = body;
      request.hasPostData = true;
    }
    this.publish("Network.requestWillBeSent", {
      requestId,
      loaderId,
      documentURL: this.window.document.URL,
      request,
      timestamp: this.monotonicTime(),
      wallTime: Date.now() / 1000,
      initiator: { type: "script" },
      redirectHasExtraInfo: false,
      type: "Fetch",
    } satisfies Protocol.Network.RequestWillBeSentEvent);

    const promise = Reflect.apply(original, receiver, args);
    void promise.then(
      (response) => this.observeFetchResponse(state, response),
      (error: unknown) => this.loadingFailed(state, error),
    );
    return promise;
  }

  private async observeFetchResponse(state: RequestState, response: Response): Promise<void> {
    if (!this.installed) return;
    const headers = headersToObject(response.headers);
    const { charset, mimeType } = contentType(headers);
    this.publish("Network.responseReceived", {
      requestId: state.requestId,
      loaderId: state.loaderId,
      timestamp: this.monotonicTime(),
      type: state.type,
      response: {
        url: response.url || state.url,
        status: response.status,
        statusText: response.statusText,
        headers,
        mimeType,
        charset,
        connectionReused: false,
        connectionId: 0,
        encodedDataLength: 0,
        securityState: "unknown",
      },
      hasExtraInfo: false,
    } satisfies Protocol.Network.ResponseReceivedEvent);

    const captured = await this.captureFetchBody(
      response,
      responseContentLength(headers),
      mimeType,
      charset,
    );
    if (!this.installed || !captured.complete) return;
    this.finishResponse(
      state.requestId,
      captured.bytes,
      captured.body,
      captured.base64Encoded ?? false,
    );
  }

  private async captureFetchBody(
    response: Response,
    declaredLength: number | undefined,
    mimeType: string,
    charset: string,
  ): Promise<BodyCapture> {
    let clone: Response;
    try {
      clone = response.clone();
    } catch {
      return { bytes: 0, complete: false };
    }
    if (clone.body) {
      return this.readBoundedBody(clone.body, mimeType, charset);
    }
    if ("body" in clone && clone.body === null) {
      return this.encodeCapturedBody(new Uint8Array(), mimeType, charset);
    }
    if (declaredLength === undefined || declaredLength > this.maxBodyBytes) {
      return { bytes: 0, complete: false };
    }
    try {
      if (typeof clone.arrayBuffer === "function") {
        const bytes = new Uint8Array(await clone.arrayBuffer());
        if (bytes.byteLength > this.maxBodyBytes) {
          return { bytes: bytes.byteLength, complete: true };
        }
        return this.encodeCapturedBody(bytes, mimeType, charset);
      }
      const body = await clone.text();
      const bytes = bodyByteLength(body);
      if (bytes > this.maxBodyBytes) return { bytes, complete: true };
      if (!this.isTextualMimeType(mimeType, charset)) {
        const encoded = new TextEncoder().encode(body);
        return {
          body: this.base64Encode(encoded),
          bytes,
          base64Encoded: true,
          complete: true,
        };
      }
      return { body, bytes, base64Encoded: false, complete: true };
    } catch {
      return { bytes: 0, complete: false };
    }
  }

  private async readBoundedBody(
    stream: ReadableStream<Uint8Array>,
    mimeType: string,
    charset: string,
  ): Promise<BodyCapture> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let cancellationStarted = false;
    let retaining = this.maxBodyCount > 0 && this.maxBodyBytes > 0;
    let bytes = 0;
    const cancel = (): void => {
      cancellationStarted = true;
      void reader
        .cancel()
        .catch(() => {})
        .finally(() => {
          try {
            reader.releaseLock();
          } catch {
            // A pending read can retain the lock until cancellation settles.
          }
        });
    };
    try {
      while (true) {
        let timer: number | undefined;
        let result: ReadableStreamReadResult<Uint8Array> | undefined;
        try {
          result = await Promise.race([
            reader.read(),
            new Promise<undefined>((resolve) => {
              timer = this.window.setTimeout(resolve, BODY_READ_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timer !== undefined) this.window.clearTimeout(timer);
        }
        if (result === undefined) {
          cancel();
          return { bytes, complete: false };
        }
        if (result.done) {
          if (!retaining) return { bytes, complete: true };
          const combined = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return this.encodeCapturedBody(combined, mimeType, charset);
        }
        const chunk = result.value;
        bytes += chunk.byteLength;
        if (retaining && bytes <= this.maxBodyBytes) {
          chunks.push(chunk.slice());
        } else if (retaining) {
          retaining = false;
          chunks.length = 0;
        }
      }
    } catch {
      cancel();
      return { bytes, complete: false };
    } finally {
      if (!cancellationStarted) reader.releaseLock();
    }
  }

  private encodeCapturedBody(bytes: Uint8Array, mimeType: string, charset: string): BodyCapture {
    if (!this.isTextualMimeType(mimeType, charset)) {
      return {
        body: this.base64Encode(bytes),
        bytes: bytes.byteLength,
        base64Encoded: true,
        complete: true,
      };
    }
    try {
      return {
        body: new TextDecoder(charset || "utf-8", { fatal: true }).decode(bytes),
        bytes: bytes.byteLength,
        base64Encoded: false,
        complete: true,
      };
    } catch {
      return {
        body: this.base64Encode(bytes),
        bytes: bytes.byteLength,
        base64Encoded: true,
        complete: true,
      };
    }
  }

  private isTextualMimeType(mimeType: string, charset: string): boolean {
    if (charset) return true;
    const normalized = mimeType.toLowerCase();
    return (
      normalized.startsWith("text/") ||
      normalized === "application/json" ||
      normalized.endsWith("+json") ||
      normalized === "application/xml" ||
      normalized.endsWith("+xml") ||
      normalized === "application/javascript" ||
      normalized === "application/ecmascript" ||
      normalized === "application/x-javascript"
    );
  }

  private finishResponse(
    requestId: Protocol.Network.RequestId,
    bytes: number,
    body?: string,
    base64Encoded = false,
  ): void {
    if (!this.installed) return;
    this.publish("Network.dataReceived", {
      requestId,
      timestamp: this.monotonicTime(),
      dataLength: bytes,
      encodedDataLength: bytes,
    } satisfies Protocol.Network.DataReceivedEvent);
    if (body !== undefined) this.rememberBody(requestId, body, bytes, base64Encoded);
    this.publish("Network.loadingFinished", {
      requestId,
      timestamp: this.monotonicTime(),
      encodedDataLength: bytes,
    } satisfies Protocol.Network.LoadingFinishedEvent);
  }

  private loadingFailed(state: RequestState, error: unknown): void {
    if (!this.installed) return;
    this.publish("Network.loadingFailed", {
      requestId: state.requestId,
      timestamp: this.monotonicTime(),
      type: state.type,
      errorText: error instanceof Error ? error.message : String(error),
    } satisfies Protocol.Network.LoadingFailedEvent);
  }

  private rememberBody(
    requestId: Protocol.Network.RequestId,
    body: string,
    bytes: number,
    base64Encoded = false,
  ): void {
    if (this.maxBodyCount === 0 || bytes > this.maxBodyBytes) return;
    this.bodies.set(requestId, { body, base64Encoded, bytes });
    this.bodyBytes += bytes;
    while (this.bodies.size > this.maxBodyCount || this.bodyBytes > this.maxBodyBytes) {
      const oldest = this.bodies.entries().next().value;
      if (!oldest) break;
      this.bodies.delete(oldest[0]);
      this.bodyBytes -= oldest[1].bytes;
    }
  }

  private createRequestId(): Protocol.Network.RequestId {
    this.nextRequestId += 1;
    return `${this.requestScope}.${this.nextRequestId}`;
  }

  private base64Encode(bytes: Uint8Array): string {
    const chunks: string[] = [];
    const chunkSize = 32_768;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }
    return this.window.btoa(chunks.join(""));
  }

  private monotonicTime(): Protocol.Network.MonotonicTime {
    return cdpMonotonicTime(this.window.performance);
  }

  private publish(method: string, params: object): void {
    if (this.installed) this.emit(method, params as Record<string, unknown>);
  }
}
