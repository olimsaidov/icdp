// @vitest-environment jsdom
import { expect, test, vi } from "vitest";

import { NetworkObserver } from "../src/frame/cdp/network-observer.ts";

type EmittedEvent = {
  method: string;
  params: Record<string, any>;
};

function headers(values: Record<string, string>) {
  return {
    forEach(callback: (value: string, name: string) => void) {
      for (const [name, value] of Object.entries(values)) callback(value, name);
    },
    get(name: string) {
      const entry = Object.entries(values).find(
        ([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
      );
      return entry?.[1] ?? null;
    },
  };
}

async function fetchAndRequestId(events: EmittedEvent[], path: string): Promise<string> {
  const finishedBefore = events.filter(
    (event) => event.method === "Network.loadingFinished",
  ).length;
  await window.fetch(`https://example.test/${path}`);
  await vi.waitFor(() => {
    expect(events.filter((event) => event.method === "Network.loadingFinished")).toHaveLength(
      finishedBefore + 1,
    );
  });
  return events.findLast(
    (event) =>
      event.method === "Network.requestWillBeSent" &&
      decodeURIComponent(new URL(event.params.request.url).pathname).slice(1) === path,
  )!.params.requestId;
}

// Ported from Chromium:
// third_party/blink/web_tests/http/tests/inspector-protocol/
// network-data-length.js and network/get-response-body.js
test("reports a schema-complete fetch lifecycle with one stable request id and body", async () => {
  const response = {
    clone() {
      return this;
    },
    headers: headers({
      "content-length": "5",
      "content-type": "text/plain; charset=utf-8",
      "x-test": "yes",
    }),
    status: 201,
    statusText: "Created",
    text: () => Promise.resolve("hello"),
    url: "https://example.test/api",
  } as unknown as Response;
  const nativePromise = Promise.resolve(response);
  const nativeFetch = vi.fn(() => nativePromise) as unknown as typeof fetch;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: nativeFetch,
    writable: true,
  });
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(
    window,
    (method, params) => {
      events.push({ method, params });
    },
    { loaderId: () => "loader-1" },
  );
  observer.install();

  const input = "https://example.test/api";
  const returned = window.fetch(input);

  expect(returned).toBe(nativePromise);
  expect(nativeFetch).toHaveBeenCalledWith(input);
  await vi.waitFor(() => {
    expect(events.map((event) => event.method)).toEqual([
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Network.dataReceived",
      "Network.loadingFinished",
    ]);
  });

  const [request, responseEvent, data, finished] = events.map((event) => event.params);
  expect(request).toMatchObject({
    loaderId: "loader-1",
    documentURL: expect.any(String),
    request: {
      url: "https://example.test/api",
      method: "GET",
      headers: {},
      initialPriority: "High",
      referrerPolicy: "strict-origin-when-cross-origin",
    },
    timestamp: expect.any(Number),
    wallTime: expect.any(Number),
    initiator: { type: "script" },
    redirectHasExtraInfo: false,
    type: "Fetch",
  });
  expect(responseEvent).toMatchObject({
    requestId: request!.requestId,
    loaderId: request!.loaderId,
    timestamp: expect.any(Number),
    type: "Fetch",
    hasExtraInfo: false,
    response: {
      url: "https://example.test/api",
      status: 201,
      statusText: "Created",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-test": "yes",
      },
      mimeType: "text/plain",
      charset: "utf-8",
      connectionReused: false,
      connectionId: 0,
      encodedDataLength: 0,
      securityState: "unknown",
    },
  });
  expect(data).toEqual({
    requestId: request!.requestId,
    timestamp: expect.any(Number),
    dataLength: 5,
    encodedDataLength: 5,
  });
  expect(finished).toEqual({
    requestId: request!.requestId,
    timestamp: expect.any(Number),
    encodedDataLength: 5,
  });
  expect(request!.timestamp).toBeGreaterThanOrEqual(window.performance.timeOrigin / 1000);
  expect(observer.getResponseBody(request!.requestId)).toEqual({
    body: "hello",
    base64Encoded: false,
  });
});

test("preserves fetch promise rejection for an invalid URL", async () => {
  const nativeFetch = vi.fn(() =>
    Promise.reject(new TypeError("Failed to parse URL")),
  ) as unknown as typeof fetch;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: nativeFetch,
    writable: true,
  });
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(window, (method, params) => events.push({ method, params }));
  observer.install();

  const request = window.fetch("http://[");

  await expect(request).rejects.toThrow("Failed to parse URL");
  expect(events).toEqual([]);
  observer.uninstall();
});

test("preserves an exotic fetch input without re-coercing it", async () => {
  const previousRequest = (window as unknown as { Request?: typeof Request }).Request;
  Object.defineProperty(window, "Request", {
    configurable: true,
    value: Request,
    writable: true,
  });
  try {
    let coercions = 0;
    const nativeFetch = vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      return Promise.resolve({
        clone() {
          return this;
        },
        headers: headers({ "content-length": "2", "content-type": "text/plain" }),
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve("ok"),
        url,
      } as unknown as Response);
    }) as unknown as typeof fetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: nativeFetch,
      writable: true,
    });
    const events: EmittedEvent[] = [];
    const observer = new NetworkObserver(window, (method, params) =>
      events.push({ method, params }),
    );
    observer.install();
    const input = {
      toString() {
        coercions += 1;
        return `https://example.test/coercion-${coercions}`;
      },
    };

    await window.fetch(input as RequestInfo);

    expect(coercions).toBe(1);
    expect(nativeFetch).toHaveBeenCalledWith(input);
    expect(events).toEqual([]);
    observer.uninstall();
  } finally {
    if (previousRequest) {
      Object.defineProperty(window, "Request", {
        configurable: true,
        value: previousRequest,
        writable: true,
      });
    } else {
      delete (window as unknown as { Request?: typeof Request }).Request;
    }
  }
});

test("preserves fetch init accessors and skips observation rather than rereading them", async () => {
  const previousRequest = (window as unknown as { Request?: typeof Request }).Request;
  Object.defineProperty(window, "Request", {
    configurable: true,
    value: Request,
    writable: true,
  });
  try {
    const nativeFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return Promise.resolve({
        clone() {
          return this;
        },
        headers: headers({ "content-length": "2", "content-type": "text/plain" }),
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve("ok"),
        url: request.url,
      } as unknown as Response);
    }) as unknown as typeof fetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: nativeFetch,
      writable: true,
    });
    const reads = { headers: 0, method: 0, referrerPolicy: 0, signal: 0 };
    const controller = new AbortController();
    const init = {
      get headers() {
        reads.headers += 1;
        return { "x-read": String(reads.headers) };
      },
      get method() {
        reads.method += 1;
        return reads.method === 1 ? "GET" : "POST";
      },
      get referrerPolicy() {
        reads.referrerPolicy += 1;
        return reads.referrerPolicy === 1 ? "no-referrer" : "unsafe-url";
      },
      get signal() {
        reads.signal += 1;
        return controller.signal;
      },
    } satisfies RequestInit;
    const events: EmittedEvent[] = [];
    const observer = new NetworkObserver(window, (method, params) =>
      events.push({ method, params }),
    );
    observer.install();

    const input = "https://example.test/init";
    await window.fetch(input, init);

    expect(reads).toEqual({ headers: 1, method: 1, referrerPolicy: 1, signal: 1 });
    expect(nativeFetch).toHaveBeenCalledWith(input, init);
    expect(events).toEqual([]);
    observer.uninstall();
  } finally {
    if (previousRequest) {
      Object.defineProperty(window, "Request", {
        configurable: true,
        value: previousRequest,
        writable: true,
      });
    } else {
      delete (window as unknown as { Request?: typeof Request }).Request;
    }
  }
});

test("omits dataReceived for empty 204 and Content-Length zero fetch responses", async () => {
  const nativeFetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const noContent = url.endsWith("/empty-204");
    return Promise.resolve({
      clone: () =>
        noContent
          ? { body: null }
          : {
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.close();
                },
              }),
            },
      headers: headers(noContent ? {} : { "content-length": "0" }),
      status: noContent ? 204 : 200,
      statusText: noContent ? "No Content" : "OK",
      url,
    } as unknown as Response);
  }) as unknown as typeof fetch;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: nativeFetch,
    writable: true,
  });
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(window, (method, params) => {
    events.push({ method, params });
  });
  observer.install();

  const noContentRequestId = await fetchAndRequestId(events, "empty-204");
  const zeroLengthRequestId = await fetchAndRequestId(events, "empty-content-length");

  for (const requestId of [noContentRequestId, zeroLengthRequestId]) {
    expect(
      events.filter((event) => event.params.requestId === requestId).map((event) => event.method),
    ).toEqual(["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished"]);
    expect(observer.getResponseBody(requestId).body).toBe("");
  }
  observer.uninstall();
});

// Ported from Chromium:
// content/browser/devtools/protocol/network_handler.cc
// NetworkHandler::ProcessDurableMessageOrGetLocalData
test("returns non-UTF-8 fetch bodies as base64", async () => {
  const bytes = new Uint8Array([0xff, 0x00, 0x01]);
  const response = {
    clone: () => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    }),
    headers: headers({
      "content-length": String(bytes.byteLength),
      "content-type": "application/octet-stream",
    }),
    status: 200,
    statusText: "OK",
    url: "https://example.test/binary",
  } as unknown as Response;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: vi.fn(() => Promise.resolve(response)),
    writable: true,
  });
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(window, (method, params) => {
    events.push({ method, params });
  });
  observer.install();

  const requestId = await fetchAndRequestId(events, "binary");

  expect(observer.getResponseBody(requestId)).toEqual({
    body: "/wAB",
    base64Encoded: true,
  });
  observer.uninstall();
});

// Ported from Chromium:
// third_party/blink/renderer/core/inspector/inspector_page_agent.cc
// InspectorPageAgent::SegmentedBufferContent
test("uses the response MIME type to base64-encode valid UTF-8 binary fetch bodies", async () => {
  const bytes = new TextEncoder().encode("valid UTF-8, binary resource");
  const response = {
    clone: () => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    }),
    headers: headers({
      "content-length": String(bytes.byteLength),
      "content-type": "application/octet-stream",
    }),
    status: 200,
    statusText: "OK",
    url: "https://example.test/valid-binary",
  } as unknown as Response;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: vi.fn(() => Promise.resolve(response)),
    writable: true,
  });
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(window, (method, params) => {
    events.push({ method, params });
  });
  observer.install();

  const requestId = await fetchAndRequestId(events, "valid-binary");

  expect(observer.getResponseBody(requestId)).toEqual({
    body: "dmFsaWQgVVRGLTgsIGJpbmFyeSByZXNvdXJjZQ==",
    base64Encoded: true,
  });
  observer.uninstall();
});

test("installs and restores fetch once while suppressing ICDP-internal requests", async () => {
  const response = {
    clone() {
      return this;
    },
    headers: headers({}),
    status: 204,
    statusText: "No Content",
    text: () => Promise.resolve(""),
    url: "https://example.test/internal",
  } as unknown as Response;
  const nativePromise = Promise.resolve(response);
  const nativeFetch = vi.fn(() => nativePromise) as unknown as typeof fetch;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: nativeFetch,
    writable: true,
  });
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(window, (method, params) => {
    events.push({ method, params });
  });

  observer.install();
  const installedFetch = window.fetch;
  observer.install();
  expect(window.fetch).toBe(installedFetch);

  const returned = window.fetch("https://example.test/internal?__icdp_internal__=true");
  expect(returned).toBe(nativePromise);
  await returned;
  expect(nativeFetch).toHaveBeenCalledOnce();
  expect(events).toEqual([]);

  observer.uninstall();
  observer.uninstall();
  expect(window.fetch).toBe(nativeFetch);

  await window.fetch("https://example.test/after-uninstall");
  expect(events).toEqual([]);
});

test("reports XHR with stable lifecycle fields while preserving native method calls", async () => {
  class FakeXMLHttpRequest extends EventTarget {
    readonly nativeHeaders: Array<[string, string]> = [];
    openArguments: unknown[] = [];
    responseText = "xhr body";
    responseType: XMLHttpRequestResponseType = "";
    responseURL = "https://example.test/xhr";
    sendBody: Document | XMLHttpRequestBodyInit | null | undefined;
    status = 202;
    statusText = "Accepted";

    open(...args: unknown[]): void {
      this.openArguments = args;
    }

    setRequestHeader(name: string, value: string): void {
      this.nativeHeaders.push([name, value]);
    }

    send(body?: Document | XMLHttpRequestBodyInit | null): void {
      this.sendBody = body;
      queueMicrotask(() => this.dispatchEvent(new Event("load")));
    }

    getAllResponseHeaders(): string {
      return "Content-Type: application/json; charset=utf-8\r\nX-Reply: yes\r\n";
    }
  }

  Object.defineProperty(window, "XMLHttpRequest", {
    configurable: true,
    value: FakeXMLHttpRequest,
    writable: true,
  });
  const nativeOpen = FakeXMLHttpRequest.prototype.open;
  const nativeSend = FakeXMLHttpRequest.prototype.send;
  const nativeSetRequestHeader = FakeXMLHttpRequest.prototype.setRequestHeader;
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(window, (method, params) => {
    events.push({ method, params });
  });
  observer.install();

  const xhr = new window.XMLHttpRequest() as unknown as FakeXMLHttpRequest;
  const url = "https://example.test/xhr";
  const open = xhr.open as unknown as (
    method: string,
    url: string,
    async: boolean,
    username: string,
    password: string,
  ) => void;
  open.call(xhr, "POST", url, false, "user", "password");
  xhr.setRequestHeader("X-Request", "yes");
  xhr.send("request body");

  await vi.waitFor(() => {
    expect(events.map((event) => event.method)).toEqual([
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Network.dataReceived",
      "Network.loadingFinished",
    ]);
  });
  expect(xhr.openArguments).toEqual(["POST", url, false, "user", "password"]);
  expect(xhr.nativeHeaders).toEqual([["X-Request", "yes"]]);
  expect(xhr.sendBody).toBe("request body");

  const [request, responseEvent, data, finished] = events.map((event) => event.params);
  expect(request).toMatchObject({
    request: {
      url: "https://example.test/xhr",
      method: "POST",
      headers: { "x-request": "yes" },
      postData: "request body",
      hasPostData: true,
      initialPriority: "High",
      referrerPolicy: "strict-origin-when-cross-origin",
    },
    type: "XHR",
  });
  expect(responseEvent).toMatchObject({
    requestId: request!.requestId,
    type: "XHR",
    response: {
      url: "https://example.test/xhr",
      status: 202,
      statusText: "Accepted",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-reply": "yes",
      },
      mimeType: "application/json",
      charset: "utf-8",
    },
  });
  expect(data!.requestId).toBe(request!.requestId);
  expect(finished!.requestId).toBe(request!.requestId);
  expect(observer.getResponseBody(request!.requestId)).toEqual({
    body: "xhr body",
    base64Encoded: false,
  });

  observer.uninstall();
  expect(FakeXMLHttpRequest.prototype.open).toBe(nativeOpen);
  expect(FakeXMLHttpRequest.prototype.send).toBe(nativeSend);
  expect(FakeXMLHttpRequest.prototype.setRequestHeader).toBe(nativeSetRequestHeader);
});

test("XHR instrumentation does not recoerce open or header arguments", async () => {
  class FakeXMLHttpRequest extends EventTarget {
    responseText = "ok";
    responseType: XMLHttpRequestResponseType = "";
    responseURL = "https://example.test/xhr";
    status = 200;
    statusText = "OK";

    open(method: unknown, url: unknown): void {
      String(method);
      String(url);
    }

    setRequestHeader(name: unknown, value: unknown): void {
      String(name);
      String(value);
    }

    send(): void {
      queueMicrotask(() => this.dispatchEvent(new Event("load")));
    }

    getAllResponseHeaders(): string {
      return "Content-Type: text/plain\r\n";
    }
  }

  Object.defineProperty(window, "XMLHttpRequest", {
    configurable: true,
    value: FakeXMLHttpRequest,
    writable: true,
  });
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(window, (method, params) => events.push({ method, params }));
  observer.install();
  const counts = { headerName: 0, headerValue: 0, method: 0, url: 0 };
  const convertible = (name: keyof typeof counts, value: string) => ({
    toString() {
      counts[name] += 1;
      return value;
    },
  });

  const exoticOpen = new window.XMLHttpRequest();
  (exoticOpen.open as unknown as (method: unknown, url: unknown) => void)(
    convertible("method", "GET"),
    convertible("url", "https://example.test/exotic-open"),
  );
  exoticOpen.send();

  const exoticHeader = new window.XMLHttpRequest();
  exoticHeader.open("GET", "https://example.test/exotic-header");
  expect(() =>
    (exoticHeader.setRequestHeader as unknown as (name: unknown, value: unknown) => void)(
      convertible("headerName", "X-Probe"),
      convertible("headerValue", "yes"),
    ),
  ).not.toThrow();
  exoticHeader.send();
  await Promise.resolve();

  expect(counts).toEqual({ headerName: 1, headerValue: 1, method: 1, url: 1 });
  expect(events).toEqual([]);
  observer.uninstall();
});

// Ported from Chromium's response-body preservation behavior:
// third_party/blink/renderer/core/inspector/inspector_page_agent.cc
test("encodes XHR ArrayBuffer and Blob response bodies according to response MIME", async () => {
  class FakeXMLHttpRequest extends EventTarget {
    contentType = "application/octet-stream";
    response: unknown;
    responseText = "";
    responseType: XMLHttpRequestResponseType = "";
    responseURL = "https://example.test/xhr-binary";
    status = 200;
    statusText = "OK";

    open(..._args: unknown[]): void {}
    setRequestHeader(): void {}

    send(_body?: unknown): void {
      queueMicrotask(() => this.dispatchEvent(new Event("load")));
    }

    getAllResponseHeaders(): string {
      return `Content-Type: ${this.contentType}\r\n`;
    }
  }

  Object.defineProperty(window, "XMLHttpRequest", {
    configurable: true,
    value: FakeXMLHttpRequest,
    writable: true,
  });
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(window, (method, params) => {
    events.push({ method, params });
  });
  observer.install();

  const arrayBufferXhr = new window.XMLHttpRequest() as unknown as FakeXMLHttpRequest;
  arrayBufferXhr.open("GET", "https://example.test/xhr-arraybuffer");
  arrayBufferXhr.responseType = "arraybuffer";
  arrayBufferXhr.response = new TextEncoder().encode("array").buffer;
  arrayBufferXhr.send();

  await vi.waitFor(() => {
    expect(events.filter((event) => event.method === "Network.loadingFinished")).toHaveLength(1);
  });
  const arrayBufferRequestId = events.find(
    (event) =>
      event.method === "Network.requestWillBeSent" &&
      event.params.request.url.endsWith("/xhr-arraybuffer"),
  )!.params.requestId;
  expect(observer.getResponseBody(arrayBufferRequestId)).toEqual({
    body: "YXJyYXk=",
    base64Encoded: true,
  });

  const blobXhr = new window.XMLHttpRequest() as unknown as FakeXMLHttpRequest;
  blobXhr.open("GET", "https://example.test/xhr-blob");
  blobXhr.responseType = "blob";
  blobXhr.response = {
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode("blob").buffer),
    size: 4,
  } as Blob;
  blobXhr.send();

  await vi.waitFor(() => {
    expect(events.filter((event) => event.method === "Network.loadingFinished")).toHaveLength(2);
  });
  const blobRequestId = events.find(
    (event) =>
      event.method === "Network.requestWillBeSent" &&
      event.params.request.url.endsWith("/xhr-blob"),
  )!.params.requestId;
  expect(observer.getResponseBody(blobRequestId)).toEqual({
    body: "YmxvYg==",
    base64Encoded: true,
  });

  const textXhr = new window.XMLHttpRequest() as unknown as FakeXMLHttpRequest;
  textXhr.open("GET", "https://example.test/xhr-text-arraybuffer");
  textXhr.contentType = 'text/plain; charset="utf-8"';
  textXhr.responseType = "arraybuffer";
  textXhr.response = new TextEncoder().encode("text array").buffer;
  textXhr.send();

  await vi.waitFor(() => {
    expect(events.filter((event) => event.method === "Network.loadingFinished")).toHaveLength(3);
  });
  const textRequestId = events.find(
    (event) =>
      event.method === "Network.requestWillBeSent" &&
      event.params.request.url.endsWith("/xhr-text-arraybuffer"),
  )!.params.requestId;
  expect(observer.getResponseBody(textRequestId)).toEqual({
    body: "text array",
    base64Encoded: false,
  });

  const mimeXhr = new window.XMLHttpRequest() as unknown as FakeXMLHttpRequest;
  mimeXhr.open("GET", "https://example.test/xhr-mime");
  mimeXhr.responseText = "mime";
  mimeXhr.send();

  await vi.waitFor(() => {
    expect(events.filter((event) => event.method === "Network.loadingFinished")).toHaveLength(4);
  });
  const mimeRequestId = events.find(
    (event) =>
      event.method === "Network.requestWillBeSent" &&
      event.params.request.url.endsWith("/xhr-mime"),
  )!.params.requestId;
  expect(() => observer.getResponseBody(mimeRequestId)).toThrow(
    "No resource with given identifier found",
  );
  observer.uninstall();
});

// Ported from Chromium:
// third_party/blink/web_tests/http/tests/inspector-protocol/network/
// websocket/events.js
test("reports schema-complete WebSocket handshakes and masked frame directions", async () => {
  class FakeWebSocket extends EventTarget {
    static readonly CLOSED = 3;
    static readonly CLOSING = 2;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readonly sent: unknown[] = [];
    readonly url: string;
    readonly protocolsArgument: string | string[] | undefined;
    protocol = "";

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = String(url);
      this.protocolsArgument = protocols;
    }

    send(data: unknown): void {
      this.sent.push(data);
    }

    open(protocol = "chat"): void {
      this.protocol = protocol;
      this.dispatchEvent(new Event("open"));
    }

    receive(data: unknown): void {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }

    closeFromServer(): void {
      this.dispatchEvent(new Event("close"));
    }
  }

  Object.defineProperty(window, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
    writable: true,
  });
  const nativeConstructor = window.WebSocket;
  const nativeSend = FakeWebSocket.prototype.send;
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(window, (method, params) => {
    events.push({ method, params });
  });
  observer.install();

  const socket = new window.WebSocket("wss://example.test/socket", [
    "chat",
    "superchat",
  ]) as unknown as FakeWebSocket;
  expect(socket).toBeInstanceOf(FakeWebSocket);
  expect(socket.url).toBe("wss://example.test/socket");
  expect(socket.protocolsArgument).toEqual(["chat", "superchat"]);
  expect(window.WebSocket.OPEN).toBe(1);

  socket.open();
  socket.send("hello");
  socket.receive("world");
  socket.closeFromServer();

  await vi.waitFor(() => {
    expect(events.map((event) => event.method)).toEqual([
      "Network.webSocketCreated",
      "Network.webSocketWillSendHandshakeRequest",
      "Network.webSocketHandshakeResponseReceived",
      "Network.webSocketFrameSent",
      "Network.webSocketFrameReceived",
      "Network.webSocketClosed",
    ]);
  });

  const [created, willSend, handshake, sent, received, closed] = events.map(
    (event) => event.params,
  );
  const requestId = created!.requestId;
  expect(created).toMatchObject({
    requestId: expect.any(String),
    url: "wss://example.test/socket",
    initiator: { type: "script" },
  });
  expect(willSend).toMatchObject({
    requestId,
    timestamp: expect.any(Number),
    wallTime: expect.any(Number),
    request: {
      headers: {
        connection: "Upgrade",
        origin: expect.any(String),
        "sec-websocket-protocol": "chat, superchat",
        "sec-websocket-version": "13",
        upgrade: "websocket",
      },
    },
  });
  expect(handshake).toMatchObject({
    requestId,
    timestamp: expect.any(Number),
    response: {
      status: 101,
      statusText: "Switching Protocols",
      headers: {
        connection: "Upgrade",
        "sec-websocket-protocol": "chat",
        upgrade: "websocket",
      },
    },
  });
  expect(sent).toEqual({
    requestId,
    timestamp: expect.any(Number),
    response: { opcode: 1, mask: true, payloadData: "hello" },
  });
  expect(received).toEqual({
    requestId,
    timestamp: expect.any(Number),
    response: { opcode: 1, mask: false, payloadData: "world" },
  });
  expect(closed).toEqual({
    requestId,
    timestamp: expect.any(Number),
  });
  expect(willSend!.wallTime).toBeGreaterThan(0);
  expect(closed!.timestamp).toBeGreaterThan(0);
  expect(socket.sent).toEqual(["hello"]);

  observer.uninstall();
  expect(window.WebSocket).toBe(nativeConstructor);
  expect(socket.send).toBe(nativeSend);
});

// Ported from Chromium:
// third_party/blink/web_tests/http/tests/inspector-protocol/network/
// websocket/events.js
test("serializes async WebSocket frames before close and releases the socket wrapper", async () => {
  class FakeWebSocket extends EventTarget {
    static readonly CLOSED = 3;
    static readonly CLOSING = 2;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    protocol = "";

    send(_data?: unknown): void {}
  }

  Object.defineProperty(window, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
    writable: true,
  });
  const nativeSend = FakeWebSocket.prototype.send;
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(window, (method, params) => {
    events.push({ method, params });
  });
  observer.install();
  const socket = new window.WebSocket("wss://example.test/ordered") as unknown as FakeWebSocket;
  let resolveBlobBytes!: (value: ArrayBuffer) => void;
  const blobBytes = new Promise<ArrayBuffer>((resolve) => {
    resolveBlobBytes = resolve;
  });
  const blob = new window.Blob([]);
  Object.defineProperty(blob, "arrayBuffer", {
    configurable: true,
    value: () => blobBytes,
  });

  socket.send(blob);
  socket.send("after blob");
  socket.dispatchEvent(new Event("close"));
  await Promise.resolve();

  expect(events.map((event) => event.method)).toEqual([
    "Network.webSocketCreated",
    "Network.webSocketWillSendHandshakeRequest",
  ]);

  resolveBlobBytes(new Uint8Array([1, 2, 3]).buffer);
  await vi.waitFor(() => {
    expect(events.map((event) => event.method)).toEqual([
      "Network.webSocketCreated",
      "Network.webSocketWillSendHandshakeRequest",
      "Network.webSocketFrameSent",
      "Network.webSocketFrameSent",
      "Network.webSocketClosed",
    ]);
  });

  expect(events.slice(2).map((event) => event.params.response?.payloadData)).toEqual([
    "AQID",
    "after blob",
    undefined,
  ]);
  expect(socket.send).toBe(nativeSend);
  observer.uninstall();
});

test("evicts retained bodies independently by oldest count and UTF-8 bytes", async () => {
  const nativeFetch = vi.fn((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = decodeURIComponent(new URL(url).pathname.slice(1));
    return Promise.resolve({
      clone() {
        return this;
      },
      headers: headers({
        "content-length": String(new TextEncoder().encode(body).byteLength),
        "content-type": "text/plain",
      }),
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(body),
      url,
    } as unknown as Response);
  }) as unknown as typeof fetch;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: nativeFetch,
    writable: true,
  });

  const countEvents: EmittedEvent[] = [];
  const countBounded = new NetworkObserver(
    window,
    (method, params) => countEvents.push({ method, params }),
    { maxBodyCount: 2, maxBodyBytes: 1_000 },
  );
  countBounded.install();
  const first = await fetchAndRequestId(countEvents, "one");
  const second = await fetchAndRequestId(countEvents, "two");
  const third = await fetchAndRequestId(countEvents, "three");

  expect(() => countBounded.getResponseBody(first)).toThrow(
    "No resource with given identifier found",
  );
  expect(countBounded.getResponseBody(second).body).toBe("two");
  expect(countBounded.getResponseBody(third).body).toBe("three");
  countBounded.uninstall();

  const byteEvents: EmittedEvent[] = [];
  const byteBounded = new NetworkObserver(
    window,
    (method, params) => byteEvents.push({ method, params }),
    { maxBodyCount: 10, maxBodyBytes: 5 },
  );
  byteBounded.install();
  const ascii = await fetchAndRequestId(byteEvents, "abc");
  const unicode = await fetchAndRequestId(byteEvents, "😀");

  expect(() => byteBounded.getResponseBody(ascii)).toThrow(
    "No resource with given identifier found",
  );
  expect(byteBounded.getResponseBody(unicode).body).toBe("😀");
  byteBounded.uninstall();
});

test("drains an oversized fetch body to EOF without retaining it or trusting Content-Length", async () => {
  const cancel = vi.fn();
  const clone = vi.fn(() => ({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.enqueue(new TextEncoder().encode("def"));
        controller.close();
      },
      cancel,
    }),
  }));
  const response = {
    clone,
    headers: headers({
      "content-length": "100",
      "content-type": "text/plain",
    }),
    status: 200,
    statusText: "OK",
    url: "https://example.test/oversized",
  } as unknown as Response;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: vi.fn(() => Promise.resolve(response)),
    writable: true,
  });
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(
    window,
    (method, params) => events.push({ method, params }),
    { maxBodyBytes: 5 },
  );
  observer.install();

  await window.fetch("https://example.test/oversized");
  await vi.waitFor(() => {
    expect(events.filter((event) => event.method === "Network.loadingFinished")).toHaveLength(1);
  });

  const requestId = events.find((event) => event.method === "Network.requestWillBeSent")!.params
    .requestId;
  expect(clone).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
  expect(() => observer.getResponseBody(requestId)).toThrow(
    "No resource with given identifier found",
  );
  expect(
    events.find((event) => event.method === "Network.loadingFinished")!.params.encodedDataLength,
  ).toBe(6);
  observer.uninstall();
});

test("drains an unknown-length response stream after crossing the retention byte cap", async () => {
  const cancel = vi.fn();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("abc"));
      controller.enqueue(encoder.encode("def"));
      controller.close();
    },
    cancel,
  });
  const text = vi.fn(() =>
    Promise.reject(new Error("unknown streams must use the bounded reader")),
  );
  const response = {
    clone: () => ({ body: stream, text }),
    headers: headers({ "content-type": "text/plain" }),
    status: 200,
    statusText: "OK",
    url: "https://example.test/stream",
  } as unknown as Response;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: vi.fn(() => Promise.resolve(response)),
    writable: true,
  });
  const events: EmittedEvent[] = [];
  const observer = new NetworkObserver(
    window,
    (method, params) => events.push({ method, params }),
    { maxBodyBytes: 5 },
  );
  observer.install();

  await window.fetch("https://example.test/stream");
  await vi.waitFor(() => {
    expect(events.filter((event) => event.method === "Network.loadingFinished")).toHaveLength(1);
  });

  const requestId = events.find((event) => event.method === "Network.requestWillBeSent")!.params
    .requestId;
  expect(text).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(() => observer.getResponseBody(requestId)).toThrow(
    "No resource with given identifier found",
  );
  expect(
    events.find((event) => event.method === "Network.loadingFinished")!.params.encodedDataLength,
  ).toBe(6);
  observer.uninstall();
});

test("omits completion when a cloned response stream never reaches EOF", async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      cancel,
    });
    const response = {
      clone: () => ({ body: stream }),
      headers: headers({ "content-type": "text/plain" }),
      status: 200,
      statusText: "OK",
      url: "https://example.test/never-finishes",
    } as unknown as Response;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: vi.fn(() => Promise.resolve(response)),
      writable: true,
    });
    const events: EmittedEvent[] = [];
    const observer = new NetworkObserver(window, (method, params) => {
      events.push({ method, params });
    });
    observer.install();

    await window.fetch("https://example.test/never-finishes");
    await vi.advanceTimersByTimeAsync(5_001);

    expect(events.some((event) => event.method === "Network.responseReceived")).toBe(true);
    expect(events.some((event) => event.method === "Network.dataReceived")).toBe(false);
    expect(events.some((event) => event.method === "Network.loadingFinished")).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    observer.uninstall();
  } finally {
    vi.useRealTimers();
  }
});
