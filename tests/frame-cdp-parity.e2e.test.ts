/* oxlint-disable unicorn/consistent-function-scoping -- keep one-off parity helpers beside their tests */
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rolldown } from "rolldown";
import { expect, test } from "vitest";
import { WebSocketServer } from "ws";

import { serveRelay } from "../src/relay/node.ts";

type CdpError = { code: number; message: string };
type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: CdpError;
  sessionId?: string;
};
type EventWaiter = {
  method: string;
  predicate: (params: Record<string, any>) => boolean;
  reject: (error: Error) => void;
  resolve: (params: Record<string, any>) => void;
  sessionId?: string;
  timer: ReturnType<typeof setTimeout>;
};
type CdpEndpoint = {
  readonly events: CdpMessage[];
  request(method: string, params?: Record<string, unknown>): Promise<CdpMessage>;
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  waitForEvent(
    method: string,
    predicate?: (params: Record<string, any>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, any>>;
};
type RawCdpConnection = {
  close(): Promise<void>;
  endpoint(sessionId?: string): CdpEndpoint;
};
type ParityHarness = {
  appOrigin: string;
  attachAdditionalSessions(): Promise<{ icdp: CdpEndpoint; native: CdpEndpoint }>;
  close(): Promise<void>;
  icdp: CdpEndpoint;
  native: CdpEndpoint;
};

const XHR_JSON_BODY = '{\n  "value" : 1,\n  "nested": [ true, null ]\n}\n';

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
].filter((path): path is string => Boolean(path));

async function chromePath(): Promise<string> {
  for (const path of CHROME_PATHS) {
    try {
      await access(path, fsConstants.X_OK);
      return path;
    } catch {}
  }
  throw new Error(`Chromium executable not found; checked ${CHROME_PATHS.join(", ")}`);
}

async function bundleFixture(): Promise<string> {
  const build = await rolldown({
    input: "tests/fixtures/frame-cdp-parity-entry.ts",
    platform: "browser",
    logLevel: "silent",
  });
  try {
    const { output } = await build.generate({ format: "esm" });
    const entry = output.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
    if (!entry || entry.type !== "chunk") throw new Error("fixture bundle has no entry");
    return entry.code;
  } finally {
    await build.close();
  }
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendJs(response: ServerResponse, source: string): void {
  response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
  response.end(source);
}

function shellHtml(appOrigin: string, parentOrigin: string, relayWsUrl: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>icdp parity shell</title>
    <style>html, body, #preview { width: 100%; height: 100%; margin: 0; border: 0; }</style>
  </head>
  <body>
    <iframe id="preview" src="${appOrigin}/"></iframe>
    <script>
      window.__ICDP_APP_ORIGIN = ${JSON.stringify(appOrigin)};
      window.__ICDP_PARENT_ORIGIN = ${JSON.stringify(parentOrigin)};
      window.__ICDP_RELAY_WS = ${JSON.stringify(relayWsUrl)};
    </script>
    <script type="module" src="/frame-cdp-parity.js"></script>
  </body>
</html>`;
}

function appHtml(parentOrigin: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Frame CDP parity fixture</title>
    <style>
      body { margin: 0; font: 16px system-ui; }
      #box { box-sizing: content-box; width: 120px; height: 40px; margin: 7px; border: 3px solid; padding: 5px; }
      #scroller { width: 180px; height: 60px; overflow: auto; }
      #spacer { height: 400px; padding-top: 320px; }
    </style>
    <script>
      window.__ICDP_PARENT_ORIGIN = ${JSON.stringify(parentOrigin)};
      window.__ICDP_APP_ORIGIN = location.origin;
      window.__ICDP_RELAY_WS = "";
    </script>
    <script type="module" src="/frame-cdp-parity.js"></script>
  </head>
  <body>
    <main id="main">
      <h1>Frame CDP parity fixture</h1>
      <button id="action" aria-label="Parity action">Run</button>
      <label for="editor">Editor</label><input id="editor" value="">
      <div id="box">Box</div>
      <div id="mutation-root"><span id="mutable">before</span></div>
      <div id="scroller"><div id="spacer"><button id="far">Far button</button></div></div>
    </main>
    <script>
      window.__parity = { clicks: 0, input: [], keys: [], mouse: [] };
      const action = document.getElementById("action");
      action.addEventListener("click", event => {
        window.__parity.clicks++;
        window.__parity.mouse.push({ type: event.type, trusted: event.isTrusted });
      });
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        action.addEventListener(type, event => {
          window.__parity.mouse.push({
            type: event.type,
            button: event.button,
            buttons: event.buttons,
            trusted: event.isTrusted
          });
        });
      }
      const editor = document.getElementById("editor");
      for (const type of ["keydown", "keypress", "keyup"]) {
        editor.addEventListener(type, event => {
          window.__parity.keys.push({
            type: event.type,
            key: event.key,
            code: event.code,
            trusted: event.isTrusted
          });
        });
      }
      editor.addEventListener("input", event => {
        window.__parity.input.push({
          data: event.data,
          inputType: event.inputType,
          trusted: event.isTrusted
        });
      });
    </script>
  </body>
</html>`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitUntil<T>(
  probe: () => Promise<T | undefined>,
  description: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function openRawCdp(url: string): Promise<RawCdpConnection> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`failed to open ${url}`)), {
      once: true,
    });
  });

  let nextId = 1;
  const pending = new Map<number, (message: CdpMessage) => void>();
  const waiters = new Set<EventWaiter>();
  const events: CdpMessage[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    if (!message.method) return;
    events.push(message);
    for (const waiter of waiters) {
      if (
        waiter.method !== message.method ||
        waiter.sessionId !== message.sessionId ||
        !waiter.predicate(message.params ?? {})
      ) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message.params ?? {});
    }
  });

  const endpoint = (sessionId?: string): CdpEndpoint => ({
    get events() {
      return events.filter((message) => message.sessionId === sessionId);
    },
    request: (method, params = {}) =>
      new Promise<CdpMessage>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for ${method} ${JSON.stringify(params)}`));
        }, 15_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    async send(method, params = {}) {
      const response = await this.request(method, params);
      if (response.error) {
        throw Object.assign(new Error(response.error.message), { code: response.error.code });
      }
      return response.result ?? {};
    },
    waitForEvent(method, predicate = () => true, timeoutMs = 15_000) {
      return new Promise<Record<string, any>>((resolve, reject) => {
        const waiter: EventWaiter = {
          method,
          predicate,
          reject,
          resolve,
          sessionId,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`timed out waiting for ${method}`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  });

  return {
    endpoint,
    close: () =>
      new Promise<void>((resolve) => {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("CDP connection closed"));
        }
        waiters.clear();
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
      }),
  };
}

async function launchChrome(executable: string): Promise<{
  browserWsUrl: string;
  close(): Promise<void>;
}> {
  const profile = await mkdtemp(join(tmpdir(), "icdp-frame-cdp-parity-"));
  const process = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--site-per-process",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--hide-scrollbars",
      "--mute-audio",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  process.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const activePortFile = join(profile, "DevToolsActivePort");
  const [port, browserPath] = await waitUntil(async () => {
    if (process.exitCode !== null) {
      throw new Error(`Chromium exited with ${process.exitCode}\n${stderr}`);
    }
    try {
      const lines = (await readFile(activePortFile, "utf8")).trim().split(/\r?\n/);
      return lines.length >= 2 ? [lines[0]!, lines[1]!] : undefined;
    } catch {
      return undefined;
    }
  }, "Chromium DevToolsActivePort");

  return {
    browserWsUrl: `ws://127.0.0.1:${port}${browserPath}`,
    close: async () => {
      if (process.exitCode === null) {
        process.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            process.kill("SIGKILL");
            resolve();
          }, 5_000);
          process.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      await rm(profile, { recursive: true, force: true });
    },
  };
}

async function createParityHarness(): Promise<ParityHarness> {
  const fixtureScript = await bundleFixture();
  let appOrigin = "";
  let parentOrigin = "";
  const relay = await serveRelay({
    product: "icdp-frame-cdp-parity",
    fallback: (request, response) => {
      const path = new URL(request.url ?? "/", "http://shell").pathname;
      if (path === "/frame-cdp-parity.js") return sendJs(response, fixtureScript);
      sendHtml(response, shellHtml(appOrigin, parentOrigin, relay.hostWsUrl));
    },
  });
  parentOrigin = `http://127.0.0.1:${relay.hostPort}`;

  const appServer = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://app").pathname;
    if (path === "/frame-cdp-parity.js") return sendJs(response, fixtureScript);
    if (path === "/data") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return response.end("parity-response");
    }
    if (path === "/xhr-binary") {
      response.writeHead(200, {
        "Content-Length": "3",
        "Content-Type": "application/octet-stream",
      });
      return response.end(Buffer.from([0, 255, 1]));
    }
    if (path === "/xhr-json") {
      response.writeHead(200, {
        "Content-Length": String(Buffer.byteLength(XHR_JSON_BODY)),
        "Content-Type": "application/json",
      });
      return response.end(XHR_JSON_BODY);
    }
    if (path === "/xhr-quoted") {
      response.writeHead(200, { "Content-Type": 'text/plain; charset="utf-8"' });
      return response.end("quoted-charset");
    }
    sendHtml(response, appHtml(parentOrigin));
  });
  const appWebSockets = new WebSocketServer({ noServer: true });
  appServer.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://app").pathname !== "/echo") {
      socket.destroy();
      return;
    }
    appWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
      appWebSockets.emit("connection", webSocket, request);
    });
  });
  appWebSockets.on("connection", (webSocket) => {
    webSocket.on("message", (data) => webSocket.send(data.toString()));
  });
  await new Promise<void>((resolve) => appServer.listen(0, resolve));
  appOrigin = `http://localhost:${(appServer.address() as AddressInfo).port}`;

  const chrome = await launchChrome(await chromePath());
  const nativeConnection = await openRawCdp(chrome.browserWsUrl);
  const nativeRoot = nativeConnection.endpoint();
  const nativeTargetId = (await nativeRoot.send("Target.createTarget", { url: appOrigin }))
    .targetId as string;
  await nativeRoot.send("Target.createTarget", { url: parentOrigin });

  const icdpTargetId = await waitUntil(async () => {
    const status = (await (
      await fetch(`http://127.0.0.1:${relay.browserPort}/icdp/status`)
    ).json()) as {
      hostConnected: boolean;
      targets: Array<{ targetId: string; url: string }>;
    };
    return status.hostConnected && status.targets[0]?.url.startsWith(appOrigin)
      ? status.targets[0].targetId
      : undefined;
  }, "icdp frame pairing");

  const nativeSessionId = (
    await nativeRoot.send("Target.attachToTarget", {
      targetId: nativeTargetId,
      flatten: true,
    })
  ).sessionId as string;
  const icdpConnection = await openRawCdp(relay.browserWsUrl);
  const icdpRoot = icdpConnection.endpoint();
  const icdpSessionId = (
    await icdpRoot.send("Target.attachToTarget", {
      targetId: icdpTargetId,
      flatten: true,
    })
  ).sessionId as string;
  const native = nativeConnection.endpoint(nativeSessionId);
  const icdp = icdpConnection.endpoint(icdpSessionId);
  await Promise.all(
    [native, icdp].map((endpoint) =>
      waitUntil(async () => {
        const result = await endpoint.send("Runtime.evaluate", {
          expression: "document.readyState === 'complete' && Boolean(window.__parity)",
          returnByValue: true,
        });
        return result.result?.value === true ? true : undefined;
      }, "fixture readiness"),
    ),
  );

  return {
    appOrigin,
    native,
    icdp,
    attachAdditionalSessions: async () => {
      const [nextNative, nextIcdp] = await Promise.all([
        nativeRoot.send("Target.attachToTarget", {
          targetId: nativeTargetId,
          flatten: true,
        }),
        icdpRoot.send("Target.attachToTarget", {
          targetId: icdpTargetId,
          flatten: true,
        }),
      ]);
      return {
        native: nativeConnection.endpoint(nextNative.sessionId as string),
        icdp: icdpConnection.endpoint(nextIcdp.sessionId as string),
      };
    },
    close: async () => {
      await Promise.allSettled([nativeConnection.close(), icdpConnection.close()]);
      await chrome.close();
      for (const webSocket of appWebSockets.clients) webSocket.terminate();
      await new Promise<void>((resolve) => appWebSockets.close(() => resolve()));
      await closeServer(appServer);
      await relay.stop();
    },
  };
}

test("raw CDP evaluates the frame in native Chromium and icdp", async () => {
  const harness = await createParityHarness();
  try {
    const params = { expression: "6 * 7", returnByValue: true };
    const [nativeResult, icdpResult] = await Promise.all([
      harness.native.send("Runtime.evaluate", params),
      harness.icdp.send("Runtime.evaluate", params),
    ]);

    expect(nativeResult.result).toMatchObject({ type: "number", value: 42 });
    expect(icdpResult.result).toMatchObject({ type: "number", value: 42 });
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime enable and disable gate execution-context and console events", async () => {
  const harness = await createParityHarness();
  try {
    const enable = async (endpoint: CdpEndpoint) => {
      const contextEvent = endpoint.waitForEvent("Runtime.executionContextCreated");
      const [, event] = await Promise.all([endpoint.send("Runtime.enable"), contextEvent]);
      return event.context;
    };
    const [nativeContext, icdpContext] = await Promise.all([
      enable(harness.native),
      enable(harness.icdp),
    ]);

    for (const context of [nativeContext, icdpContext]) {
      expect(context).toMatchObject({
        origin: harness.appOrigin,
        auxData: { isDefault: true, type: "default" },
      });
      expect(context.id).toEqual(expect.any(Number));
      expect(context.uniqueId).toEqual(expect.any(String));
    }

    const emitConsole = async (endpoint: CdpEndpoint) => {
      const event = endpoint.waitForEvent(
        "Runtime.consoleAPICalled",
        (params) => params.args?.[0]?.value === "runtime-parity",
      );
      await endpoint.send("Runtime.evaluate", {
        expression: 'console.warn("runtime-parity", 17)',
      });
      return await event;
    };
    const [nativeConsole, icdpConsole] = await Promise.all([
      emitConsole(harness.native),
      emitConsole(harness.icdp),
    ]);
    for (const event of [nativeConsole, icdpConsole]) {
      expect(event).toMatchObject({
        type: "warning",
        args: [
          { type: "string", value: "runtime-parity" },
          { type: "number", value: 17 },
        ],
      });
      expect(event.executionContextId).toEqual(expect.any(Number));
      expect(event.timestamp).toEqual(expect.any(Number));
    }

    await Promise.all([
      harness.native.send("Runtime.disable"),
      harness.icdp.send("Runtime.disable"),
    ]);
    const nativeConsoleAfterDisable = harness.native.waitForEvent(
      "Runtime.consoleAPICalled",
      (params) => params.args?.[0]?.value === "after-disable",
      300,
    );
    const icdpConsoleAfterDisable = harness.icdp.waitForEvent(
      "Runtime.consoleAPICalled",
      (params) => params.args?.[0]?.value === "after-disable",
      300,
    );
    const [nativeAfterDisable, icdpAfterDisable] = await Promise.all([
      harness.native.send("Runtime.evaluate", {
        expression: 'console.warn("after-disable")',
        returnByValue: true,
      }),
      harness.icdp.send("Runtime.evaluate", {
        expression: 'console.warn("after-disable")',
        returnByValue: true,
      }),
    ]);
    expect(nativeAfterDisable.result.type).toBe("undefined");
    expect(icdpAfterDisable.result.type).toBe("undefined");
    await expect(nativeConsoleAfterDisable).rejects.toThrow(
      "timed out waiting for Runtime.consoleAPICalled",
    );
    await expect(icdpConsoleAfterDisable).rejects.toThrow(
      "timed out waiting for Runtime.consoleAPICalled",
    );
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime remote objects, calls, and releases follow Chromium handles", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      const evaluated = await endpoint.send("Runtime.evaluate", {
        expression: "({ answer: 40, label: 'parity' })",
        objectGroup: "single-object",
      });
      expect(evaluated.result).toMatchObject({
        type: "object",
        className: "Object",
        objectId: expect.any(String),
      });
      const objectId = evaluated.result.objectId as string;

      const properties = await endpoint.send("Runtime.getProperties", {
        objectId,
        ownProperties: true,
      });
      expect(properties.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "answer",
            value: expect.objectContaining({ type: "number", value: 40 }),
          }),
          expect.objectContaining({
            name: "label",
            value: expect.objectContaining({ type: "string", value: "parity" }),
          }),
        ]),
      );

      const called = await endpoint.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function (increment) { return this.answer + increment; }",
        arguments: [{ value: 2 }],
        returnByValue: true,
      });
      expect(called.result).toMatchObject({ type: "number", value: 42 });

      await endpoint.send("Runtime.releaseObject", { objectId });
      expect((await endpoint.request("Runtime.getProperties", { objectId })).error).toMatchObject({
        code: -32000,
      });

      const grouped = await endpoint.send("Runtime.evaluate", {
        expression: "({ grouped: true })",
        objectGroup: "parity-group",
      });
      await endpoint.send("Runtime.releaseObjectGroup", { objectGroup: "parity-group" });
      expect(
        (
          await endpoint.request("Runtime.getProperties", {
            objectId: grouped.result.objectId,
          })
        ).error,
      ).toMatchObject({ code: -32000 });

      expect(await endpoint.send("Runtime.runIfWaitingForDebugger")).toEqual({});
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime object handles survive disabling the domain", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      const evaluated = await endpoint.send("Runtime.evaluate", {
        expression: "({ survivesDisable: true })",
      });
      await endpoint.send("Runtime.disable");
      const properties = await endpoint.send("Runtime.getProperties", {
        objectId: evaluated.result.objectId,
        ownProperties: true,
      });
      expect(properties.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "survivesDisable",
            value: expect.objectContaining({ type: "boolean", value: true }),
          }),
        ]),
      );
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime object ids share a context prefix while values remain Session-local", async () => {
  const harness = await createParityHarness();
  try {
    const additional = await harness.attachAdditionalSessions();
    for (const [primary, secondary] of [
      [harness.native, additional.native],
      [harness.icdp, additional.icdp],
    ] as const) {
      const contextCreated = primary.waitForEvent("Runtime.executionContextCreated");
      await Promise.all([primary.send("Runtime.enable"), contextCreated]);
      const first = await primary.send("Runtime.evaluate", {
        expression: "({ owner: 'primary' })",
      });
      const objectId = first.result.objectId as string;
      expect(objectId).toMatch(/^-?\d+\.-?\d+\.\d+$/);

      expect(
        (
          await secondary.request("Runtime.getProperties", {
            objectId,
            ownProperties: true,
          })
        ).error,
      ).toEqual({
        code: -32000,
        message: "Could not find object with given id",
      });

      const second = await secondary.send("Runtime.evaluate", {
        expression: "({ owner: 'secondary' })",
      });
      expect(second.result.objectId).toBe(objectId);
      const properties = await secondary.send("Runtime.getProperties", {
        objectId,
        ownProperties: true,
      });
      expect(properties.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "owner",
            value: expect.objectContaining({ value: "secondary" }),
          }),
        ]),
      );
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime rejects malformed remote ids and non-function declarations like V8", async () => {
  const harness = await createParityHarness();
  try {
    for (const endpoint of [harness.native, harness.icdp]) {
      for (const [method, params] of [
        ["Runtime.getProperties", { objectId: "bad" }],
        ["Runtime.getProperties", { objectId: "bad:1" }],
        ["Runtime.callFunctionOn", { objectId: "bad", functionDeclaration: "function () {}" }],
        [
          "Runtime.callFunctionOn",
          {
            objectId: "bad",
            functionDeclaration: "function () {}",
            serializationOptions: { serialization: "json" },
          },
        ],
        ["Runtime.releaseObject", { objectId: "bad" }],
        ["DOM.requestNode", { objectId: "bad" }],
      ] as const) {
        expect((await endpoint.request(method, params)).error).toEqual({
          code: -32000,
          message: "Invalid remote object id",
        });
      }

      const target = await endpoint.send("Runtime.evaluate", {
        expression: "({ target: true })",
      });
      const [isolateId, contextId, objectId] = String(target.result.objectId).split(".");
      const signedAlias = [
        isolateId!.startsWith("-") ? isolateId : `+${isolateId}`,
        contextId!.startsWith("-") ? contextId : `+${contextId}`,
        objectId!.startsWith("-") ? objectId : `+${objectId}`,
      ].join(".");
      const aliasedProperties = await endpoint.send("Runtime.getProperties", {
        objectId: signedAlias,
        ownProperties: true,
      });
      expect(aliasedProperties.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "target",
            value: expect.objectContaining({ value: true }),
          }),
        ]),
      );
      expect(
        (
          await endpoint.request("Runtime.getProperties", {
            objectId: String(target.result.objectId).replace(/\d+$/, "0"),
          })
        ).error,
      ).toEqual({
        code: -32000,
        message: "Could not find object with given id",
      });
      const negativeId = String(target.result.objectId).replace(/\d+$/, "-1");
      const negativeError = (
        await endpoint.request("Runtime.getProperties", {
          objectId: negativeId,
        })
      ).error;
      expect(
        negativeError,
        `${endpoint === harness.native ? "native" : "icdp"} ${negativeId}`,
      ).toEqual({
        code: -32000,
        message: "Could not find object with given id",
      });
      expect(
        (
          await endpoint.request("Runtime.getProperties", {
            objectId: String(target.result.objectId).replace(/\d+$/, "9223372036854775808"),
          })
        ).error,
      ).toEqual({
        code: -32000,
        message: "Invalid remote object id",
      });
      expect(
        (
          await endpoint.request("Runtime.getProperties", {
            objectId: `${isolateId}.2147483648.${objectId}`,
          })
        ).error,
      ).toEqual({
        code: -32000,
        message: "Invalid remote object id",
      });
      expect(
        (
          await endpoint.request("Runtime.callFunctionOn", {
            objectId: target.result.objectId,
            functionDeclaration: "42",
          })
        ).error,
      ).toEqual({
        code: -32000,
        message: "Given expression does not evaluate to a function",
      });
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime returnByValue does not invoke toJSON", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("Runtime.evaluate", {
        expression: "window.__toJSONHits = 0",
      });
      const evaluated = await endpoint.send("Runtime.evaluate", {
        expression: `({
          answer: 42,
          toJSON() {
            window.__toJSONHits++;
            return { wrong: true };
          }
        })`,
        returnByValue: true,
      });
      const hits = await endpoint.send("Runtime.evaluate", {
        expression: "window.__toJSONHits",
        returnByValue: true,
      });
      expect(evaluated.result).toMatchObject({
        type: "object",
        value: { answer: 42, toJSON: {} },
      });
      expect(hits.result.value).toBe(0);

      const enumerable = await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          function callable() {}
          callable.answer = 42;
          const object = { visible: true };
          Object.defineProperty(object, "hidden", {
            enumerable: false,
            value: "private"
          });
          return { callable, object };
        })()`,
        returnByValue: true,
      });
      expect(enumerable.result.value).toEqual({
        callable: { answer: 42 },
        object: { visible: true },
      });

      expect(
        (
          await endpoint.request("Runtime.evaluate", {
            expression: `({
              get broken() {
                throw new Error("getter boom");
              }
            })`,
            returnByValue: true,
          })
        ).error,
      ).toEqual({
        code: -32603,
        message: "Internal error",
      });
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime describes DOM wrappers with Blink-compatible subtypes", async () => {
  const harness = await createParityHarness();
  try {
    for (const endpoint of [harness.native, harness.icdp]) {
      const element = await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#box')",
      });
      expect(element.result).toMatchObject({
        type: "object",
        subtype: "node",
        className: "HTMLDivElement",
        description: "div#box",
      });

      for (const [expression, className] of [
        ["document.querySelectorAll('div')", "NodeList"],
        ["document.body.children", "HTMLCollection"],
        ["document.body.classList", "DOMTokenList"],
      ]) {
        const collection = await endpoint.send("Runtime.evaluate", { expression });
        expect(collection.result).toMatchObject({
          type: "object",
          subtype: "array",
          className,
          description: expect.stringMatching(new RegExp(`^${className}\\(\\d+\\)$`)),
        });
      }

      const exception = await endpoint.send("Runtime.evaluate", {
        expression: "new DOMException('stopped', 'AbortError')",
      });
      expect(exception.result).toMatchObject({
        type: "object",
        subtype: "error",
        className: "DOMException",
        description: expect.stringContaining("AbortError: stopped"),
      });

      const all = await endpoint.send("Runtime.evaluate", {
        expression: "document.all",
      });
      expect(all.result).toMatchObject({
        type: "object",
        subtype: "array",
        className: "HTMLAllCollection",
        description: expect.stringMatching(/^HTMLAllCollection\(\d+\)$/),
      });
      const allByValue = await endpoint.send("Runtime.evaluate", {
        expression: "document.all",
        returnByValue: true,
      });
      expect(allByValue.result).toMatchObject({
        type: "object",
        value: expect.any(Object),
      });
      expect(Object.keys(allByValue.result.value)).not.toHaveLength(0);
      expect(Object.values(allByValue.result.value)).toEqual(
        expect.arrayContaining([expect.any(Object)]),
      );

      const documentType = await endpoint.send("Runtime.evaluate", {
        expression: "document.doctype",
      });
      expect(documentType.result).toMatchObject({
        type: "object",
        subtype: "node",
        className: "DocumentType",
        description: "<!DOCTYPE html>",
      });

      const trusted = await endpoint.send("Runtime.evaluate", {
        expression:
          "trustedTypes.createPolicy('runtime-parity', { createHTML: value => value }).createHTML('<b>safe</b>')",
      });
      expect(trusted.result).toMatchObject({
        type: "object",
        subtype: "trustedtype",
        className: "TrustedHTML",
        description: "<b>safe</b>",
      });

      for (const [expression, expected] of [
        [
          "new Map([[1, 2]]).entries()",
          {
            type: "object",
            subtype: "iterator",
            className: "MapIterator",
            description: "MapIterator",
          },
        ],
        [
          "new Set([1]).values()",
          {
            type: "object",
            subtype: "iterator",
            className: "SetIterator",
            description: "SetIterator",
          },
        ],
        [
          "(function* () {})()",
          {
            type: "object",
            subtype: "generator",
            className: "Generator",
            description: "Generator",
          },
        ],
        [
          "(async function* () {})()",
          {
            type: "object",
            subtype: "generator",
            className: "AsyncGenerator",
            description: "AsyncGenerator",
          },
        ],
        [
          "new WebAssembly.Memory({ initial: 1 })",
          {
            type: "object",
            subtype: "webassemblymemory",
            className: "Memory",
            description: "Memory(1)",
          },
        ],
      ] as const) {
        expect((await endpoint.send("Runtime.evaluate", { expression })).result).toMatchObject(
          expected,
        );
      }
      const stringIterator = await endpoint.send("Runtime.evaluate", {
        expression: "'x'[Symbol.iterator]()",
      });
      expect(stringIterator.result).toMatchObject({
        type: "object",
        className: "StringIterator",
        description: "StringIterator",
      });
      expect(stringIterator.result).not.toHaveProperty("subtype");

      const map = await endpoint.send("Runtime.evaluate", {
        expression: "new Map([['a', 1]])",
        objectGroup: "entries-parity",
      });
      const mapProperties = await endpoint.send("Runtime.getProperties", {
        objectId: map.result.objectId,
        ownProperties: true,
      });
      const entries = mapProperties.internalProperties.find(
        (property: Record<string, any>) => property.name === "[[Entries]]",
      ).value;
      expect(entries).toMatchObject({
        type: "object",
        subtype: "array",
        className: "Array",
        description: "Array(1)",
        objectId: expect.any(String),
      });
      const directEntry = await endpoint.send("Runtime.callFunctionOn", {
        objectId: entries.objectId,
        functionDeclaration: "function () { return this[0]; }",
      });
      expect(directEntry.result).toMatchObject({
        subtype: "internal#entry",
        className: "Object",
        description: '{"a" => 1}',
      });
      const entriesProperties = await endpoint.send("Runtime.getProperties", {
        objectId: entries.objectId,
        ownProperties: true,
      });
      expect(entriesProperties).not.toHaveProperty("internalProperties");
      expect(entriesProperties.result[0].value).toMatchObject({
        subtype: "internal#entry",
        description: '{"a" => 1}',
        objectId: expect.any(String),
      });
      const entryObjectId = entriesProperties.result[0].value.objectId;
      const entryProperties = await endpoint.send("Runtime.getProperties", {
        objectId: entryObjectId,
        ownProperties: true,
      });
      expect(entryProperties).not.toHaveProperty("internalProperties");
      expect(
        Object.fromEntries(
          entryProperties.result.map((property: Record<string, any>) => [
            property.name,
            property.value.value,
          ]),
        ),
      ).toEqual({ key: "a", value: 1 });

      const sameEntries = await endpoint.send("Runtime.callFunctionOn", {
        objectId: entries.objectId,
        functionDeclaration: "function () { return this; }",
      });
      expect(sameEntries.result).toMatchObject({
        subtype: "array",
        className: "Array",
        description: "Array(1)",
      });
      expect(
        await endpoint.send("Runtime.getProperties", {
          objectId: sameEntries.result.objectId,
          ownProperties: true,
        }),
      ).not.toHaveProperty("internalProperties");

      expect(
        await endpoint.send("Runtime.getProperties", {
          objectId: directEntry.result.objectId,
          ownProperties: true,
        }),
      ).not.toHaveProperty("internalProperties");

      const entryPrototypes = await endpoint.send("Runtime.callFunctionOn", {
        objectId: entries.objectId,
        functionDeclaration: `function () {
          return {
            array: Array.isArray(this),
            entries: Object.getPrototypeOf(this),
            entry: Object.getPrototypeOf(this[0])
          };
        }`,
        returnByValue: true,
      });
      expect(entryPrototypes.result.value).toEqual({
        array: true,
        entries: null,
        entry: null,
      });

      const mutableMap = await endpoint.send("Runtime.evaluate", {
        expression: "new Map([['mutable', 1]])",
        objectGroup: "entries-parity",
      });
      const mutableMapProperties = await endpoint.send("Runtime.getProperties", {
        objectId: mutableMap.result.objectId,
        ownProperties: true,
      });
      const mutableEntries = mutableMapProperties.internalProperties.find(
        (property: Record<string, any>) => property.name === "[[Entries]]",
      ).value;
      await endpoint.send("Runtime.callFunctionOn", {
        objectId: mutableEntries.objectId,
        functionDeclaration: `function () {
          this[0] = { replacement: true };
          this.extra = 7;
        }`,
      });
      const replacedEntries = await endpoint.send("Runtime.getProperties", {
        objectId: mutableEntries.objectId,
        ownProperties: true,
      });
      expect(replacedEntries).not.toHaveProperty("internalProperties");
      expect(
        replacedEntries.result.find((property: Record<string, any>) => property.name === "0").value,
      ).not.toHaveProperty("subtype", "internal#entry");
      expect(
        replacedEntries.result.find((property: Record<string, any>) => property.name === "extra")
          .value.value,
      ).toBe(7);

      await endpoint.send("Runtime.callFunctionOn", {
        objectId: mutableEntries.objectId,
        functionDeclaration: `function () {
          delete this[0];
          delete this.extra;
          this.length = 2;
        }`,
      });
      const sparseEntries = await endpoint.send("Runtime.getProperties", {
        objectId: mutableEntries.objectId,
        ownProperties: true,
      });
      expect(sparseEntries.result.map((property: Record<string, any>) => property.name)).toEqual([
        "length",
      ]);
      expect(sparseEntries.result[0].value.value).toBe(2);

      const accessorMap = await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          window.__entryNameGetterCalls = 0;
          const constructor = function EntryKey() {};
          Object.defineProperty(constructor, "name", {
            get() {
              window.__entryNameGetterCalls++;
              return "Observed";
            }
          });
          return new Map([[Object.create({ constructor }), 1]]);
        })()`,
        objectGroup: "entries-parity",
      });
      const accessorMapProperties = await endpoint.send("Runtime.getProperties", {
        objectId: accessorMap.result.objectId,
        ownProperties: true,
      });
      const accessorEntries = accessorMapProperties.internalProperties.find(
        (property: Record<string, any>) => property.name === "[[Entries]]",
      ).value;
      await endpoint.send("Runtime.getProperties", {
        objectId: accessorEntries.objectId,
        ownProperties: true,
      });
      expect(
        (
          await endpoint.send("Runtime.evaluate", {
            expression: "window.__entryNameGetterCalls",
            returnByValue: true,
          })
        ).result.value,
      ).toBe(0);

      await endpoint.send("Runtime.releaseObjectGroup", { objectGroup: "entries-parity" });
      expect(
        (
          await endpoint.request("Runtime.getProperties", {
            objectId: entries.objectId,
          })
        ).error,
      ).toMatchObject({ code: -32000 });

      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#runtime-cross-realm")?.remove();
          const frame = document.createElement("iframe");
          frame.id = "runtime-cross-realm";
          document.body.append(frame);
          const child = frame.contentWindow;
          const policy = child.trustedTypes.createPolicy(
            "runtime-cross-realm",
            { createHTML: value => value }
          );
          window.__runtimeCrossRealm = {
            node: frame.contentDocument.body,
            exception: new child.DOMException("cross-realm", "AbortError"),
            error: new child.TypeError("cross-realm"),
            promise: child.Promise.resolve(42),
            trusted: policy.createHTML("<i>cross-realm</i>")
          };
        })()`,
      });
      for (const [name, expected] of [
        [
          "node",
          {
            type: "object",
            subtype: "node",
            className: "HTMLBodyElement",
            description: "body",
          },
        ],
        [
          "exception",
          {
            type: "object",
            subtype: "error",
            className: "DOMException",
            description: expect.stringContaining("AbortError: cross-realm"),
          },
        ],
        [
          "error",
          {
            type: "object",
            subtype: "error",
            className: "TypeError",
            description: expect.stringContaining("TypeError: cross-realm"),
          },
        ],
        [
          "promise",
          {
            type: "object",
            subtype: "promise",
            className: "Promise",
            description: "Promise",
          },
        ],
        [
          "trusted",
          {
            type: "object",
            subtype: "trustedtype",
            className: "TrustedHTML",
            description: "<i>cross-realm</i>",
          },
        ],
      ] as const) {
        const remote = await endpoint.send("Runtime.evaluate", {
          expression: `window.__runtimeCrossRealm[${JSON.stringify(name)}]`,
        });
        expect(remote.result).toMatchObject(expected);
      }

      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          window.__runtimeTagGetterCalls = 0;
          window.__runtimeThrowingTag = {};
          Object.defineProperty(window.__runtimeThrowingTag, Symbol.toStringTag, {
            get() {
              window.__runtimeTagGetterCalls++;
              throw new Error("tag getter must not run");
            }
          });
        })()`,
      });
      const throwingTag = await endpoint.send("Runtime.evaluate", {
        expression: "window.__runtimeThrowingTag",
      });
      expect(throwingTag.result).toMatchObject({
        type: "object",
        className: "Object",
        description: "Object",
      });
      const tagGetterCalls = await endpoint.send("Runtime.evaluate", {
        expression: "window.__runtimeTagGetterCalls",
        returnByValue: true,
      });
      expect(tagGetterCalls.result.value).toBe(0);

      const spoofedMap = await endpoint.send("Runtime.evaluate", {
        expression: "({ [Symbol.toStringTag]: 'Map' })",
      });
      expect(spoofedMap.result).toMatchObject({
        type: "object",
        className: "Map",
        description: "Map",
      });
      expect(spoofedMap.result).not.toHaveProperty("subtype");

      const spoofedError = await endpoint.send("Runtime.evaluate", {
        expression:
          "Object.defineProperty(new TypeError('bad input'), Symbol.toStringTag, { value: 'Map' })",
      });
      expect(spoofedError.result).toMatchObject({
        type: "object",
        subtype: "error",
        className: "TypeError",
        description: expect.stringContaining("TypeError: bad input"),
      });
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime context validation precedes unsupported options", async () => {
  const harness = await createParityHarness();
  try {
    for (const endpoint of [harness.native, harness.icdp]) {
      expect(
        (
          await endpoint.request("Runtime.evaluate", {
            expression: "1",
            contextId: 1,
            uniqueContextId: "bad",
            timeout: 1,
          })
        ).error,
      ).toMatchObject({
        code: -32602,
        message: "contextId and uniqueContextId are mutually exclusive",
      });
      expect(
        (
          await endpoint.request("Runtime.evaluate", {
            expression: "1",
            uniqueContextId: "bad",
          })
        ).error,
      ).toMatchObject({
        code: -32602,
        message: "invalid uniqueContextId",
      });
      expect(
        (
          await endpoint.request("Runtime.evaluate", {
            expression: "1",
            uniqueContextId: "1.0",
          })
        ).error,
      ).toMatchObject({
        code: -32602,
        message: "uniqueContextId not found",
      });
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime awaited rejections preserve promise and returnByValue semantics", async () => {
  const harness = await createParityHarness();
  try {
    for (const endpoint of [harness.native, harness.icdp]) {
      const rejected = await endpoint.send("Runtime.evaluate", {
        expression: "Promise.reject({ reason: 'parity' })",
        awaitPromise: true,
        returnByValue: true,
      });
      expect(rejected.result).toEqual({
        type: "object",
        value: { reason: "parity" },
      });
      expect(rejected.exceptionDetails).toMatchObject({
        text: "Uncaught (in promise)",
        exception: {
          type: "object",
          className: "Object",
          objectId: expect.any(String),
        },
      });

      const cyclic = await endpoint.request("Runtime.evaluate", {
        expression:
          "Promise.reject((value => { value.self = value; return value; })({ reason: 'cyclic' }))",
        awaitPromise: true,
        returnByValue: true,
      });
      expect(cyclic.error).toMatchObject({
        code: -32000,
        message: "Object reference chain is too long",
      });

      const synchronous = await endpoint.send("Runtime.evaluate", {
        expression: "throw { reason: 'synchronous' }",
        returnByValue: true,
      });
      expect(synchronous.result).toMatchObject({
        type: "object",
        objectId: expect.any(String),
      });
      expect(synchronous.result).not.toHaveProperty("value");
      expect(synchronous.exceptionDetails.exception).toMatchObject({
        type: "object",
        objectId: expect.any(String),
      });
      expect(synchronous.exceptionDetails.exception.objectId).not.toBe(synchronous.result.objectId);

      const cyclicSynchronous = await endpoint.send("Runtime.evaluate", {
        expression:
          "throw (value => { value.self = value; return value; })({ reason: 'cyclic-sync' })",
        returnByValue: true,
      });
      expect(cyclicSynchronous.result).toMatchObject({
        type: "object",
        objectId: expect.any(String),
      });

      for (const expression of [
        "Promise.reject(new Error('direct rejection'))",
        "Promise.resolve().then(() => { throw new Error('then rejection'); })",
      ]) {
        const error = await endpoint.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
        });
        expect(error.exceptionDetails).toMatchObject({
          text: expect.stringMatching(/^Uncaught \(in promise\) Error: (direct|then) rejection$/),
        });
      }
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime.callFunctionOn failures inherit the receiver object group", async () => {
  const harness = await createParityHarness();
  try {
    for (const endpoint of [harness.native, harness.icdp]) {
      const receiver = await endpoint.send("Runtime.evaluate", {
        expression: "({ grouped: true })",
        objectGroup: "receiver-group",
      });
      const rejected = await endpoint.send("Runtime.callFunctionOn", {
        objectId: receiver.result.objectId,
        functionDeclaration: "function () { return Promise.reject({ reason: 'grouped' }); }",
        awaitPromise: true,
      });
      const handles = [
        rejected.result.objectId,
        rejected.exceptionDetails.exception.objectId,
      ] as string[];
      expect(handles).toEqual([expect.any(String), expect.any(String)]);

      await endpoint.send("Runtime.releaseObjectGroup", {
        objectGroup: "receiver-group",
      });
      for (const objectId of handles) {
        expect(
          (
            await endpoint.request("Runtime.getProperties", {
              objectId,
              ownProperties: true,
            })
          ).error,
        ).toEqual({
          code: -32000,
          message: "Could not find object with given id",
        });
      }
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime preserves awaited, unserializable, exception, and side-effect results", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      const awaited = await endpoint.send("Runtime.evaluate", {
        expression: 'Promise.resolve("settled")',
        awaitPromise: true,
        returnByValue: true,
      });
      expect(awaited.result).toMatchObject({ type: "string", value: "settled" });

      const negativeZero = await endpoint.send("Runtime.evaluate", { expression: "-0" });
      expect(negativeZero.result).toMatchObject({
        type: "number",
        description: "-0",
        unserializableValue: "-0",
      });

      const thrown = await endpoint.send("Runtime.evaluate", {
        expression: 'throw new Error("parity-boom")',
      });
      expect(thrown.result).toMatchObject({ type: "object", subtype: "error" });
      expect(thrown.exceptionDetails).toMatchObject({
        text: "Uncaught",
        exception: { type: "object", subtype: "error" },
      });
      expect(thrown.exceptionDetails.exception.description).toContain("parity-boom");

      const guarded = await endpoint.send("Runtime.evaluate", {
        expression: "window.__sideEffect = 1",
        throwOnSideEffect: true,
      });
      expect(guarded.exceptionDetails).toMatchObject({
        text: "Uncaught",
        exception: { type: "object", subtype: "error" },
      });
      const sideEffect = await endpoint.send("Runtime.evaluate", {
        expression: "window.__sideEffect",
        returnByValue: true,
      });
      expect(sideEffect.result.type).toBe("undefined");
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM tree ids bridge selectors, layout, Runtime objects, and scrolling", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      expect(await endpoint.send("DOM.enable", { includeWhitespace: "none" })).toEqual({});
      const documentResult = await endpoint.send("DOM.getDocument", { depth: 2 });
      expect(documentResult.root).toMatchObject({
        nodeId: expect.any(Number),
        backendNodeId: expect.any(Number),
        nodeType: 9,
        nodeName: "#document",
        documentURL: expect.stringContaining(harness.appOrigin),
      });

      const boxQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: documentResult.root.nodeId,
        selector: "#box",
      });
      expect(boxQuery.nodeIds).toHaveLength(1);
      const boxNodeId = boxQuery.nodeIds[0] as number;
      const described = await endpoint.send("DOM.describeNode", {
        nodeId: boxNodeId,
      });
      expect(described.node).toMatchObject({
        nodeId: boxNodeId,
        nodeName: "DIV",
        localName: "div",
        attributes: expect.arrayContaining(["id", "box"]),
      });

      const box = await endpoint.send("DOM.getBoxModel", { nodeId: boxNodeId });
      expect(box.model).toMatchObject({
        content: expect.any(Array),
        padding: expect.any(Array),
        border: expect.any(Array),
        margin: expect.any(Array),
        width: expect.any(Number),
        height: expect.any(Number),
      });
      expect(box.model.content).toHaveLength(8);
      expect(box.model.padding).toHaveLength(8);
      expect(box.model.border).toHaveLength(8);
      expect(box.model.margin).toHaveLength(8);
      expect(box.model.width).toBeGreaterThan(120);
      expect(box.model.height).toBeGreaterThan(40);

      const resolved = await endpoint.send("DOM.resolveNode", {
        nodeId: boxNodeId,
        objectGroup: "dom-bridge",
      });
      expect(resolved.object).toMatchObject({
        type: "object",
        subtype: "node",
        objectId: expect.any(String),
      });
      const requested = await endpoint.send("DOM.requestNode", {
        objectId: resolved.object.objectId,
      });
      expect(requested.nodeId).toBe(boxNodeId);

      const farQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: documentResult.root.nodeId,
        selector: "#far",
      });
      expect(farQuery.nodeIds).toHaveLength(1);
      const beforeScroll = await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#scroller').scrollTop",
        returnByValue: true,
      });
      expect(beforeScroll.result.value).toBe(0);
      expect(
        await endpoint.send("DOM.scrollIntoViewIfNeeded", {
          nodeId: farQuery.nodeIds[0],
        }),
      ).toEqual({});
      const afterScroll = await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#scroller').scrollTop",
        returnByValue: true,
      });
      expect(afterScroll.result.value).toBeGreaterThan(0);

      expect(await endpoint.send("DOM.disable")).toEqual({});
      expect(
        (await endpoint.request("DOM.getBoxModel", { nodeId: boxNodeId })).error,
      ).toMatchObject({ code: -32000 });
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM.getBoxModel distinguishes text from non-layout nodes", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#box-model-fixture")?.remove();
          const fixture = document.createElement("div");
          fixture.id = "box-model-fixture";
          fixture.append(document.createComment("no layout"));
          const hidden = document.createElement("span");
          hidden.id = "hidden-box";
          hidden.style.display = "none";
          fixture.append(hidden);
          document.body.append(fixture);
        })()`,
      });
      const { root } = await endpoint.send("DOM.getDocument", { depth: -1 });
      const boxQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#box",
      });
      const box = await endpoint.send("DOM.describeNode", {
        nodeId: boxQuery.nodeIds[0],
        depth: 1,
      });
      const textNodeId = box.node.children[0].nodeId as number;
      const elementModel = await endpoint.send("DOM.getBoxModel", {
        nodeId: boxQuery.nodeIds[0],
      });
      const textModel = await endpoint.send("DOM.getBoxModel", { nodeId: textNodeId });
      expect(textModel.model).toMatchObject({
        content: expect.any(Array),
        padding: expect.any(Array),
        border: expect.any(Array),
        margin: expect.any(Array),
        width: expect.any(Number),
        height: expect.any(Number),
      });
      expect(textModel.model.width).toBeGreaterThan(0);
      expect(textModel.model.height).toBeGreaterThan(0);
      expect(textModel.model.width).toBeLessThan(elementModel.model.width);

      const fixtureQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#box-model-fixture",
      });
      const fixture = await endpoint.send("DOM.describeNode", {
        nodeId: fixtureQuery.nodeIds[0],
        depth: 1,
      });
      const commentNodeId = fixture.node.children.find(
        (node: { nodeType: number }) => node.nodeType === 8,
      ).nodeId as number;
      const hiddenQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#hidden-box",
      });
      const detached = await endpoint.send("Runtime.evaluate", {
        expression: "document.createElement('div')",
      });

      for (const params of [
        { nodeId: commentNodeId },
        { nodeId: hiddenQuery.nodeIds[0] },
        { objectId: detached.result.objectId },
      ]) {
        expect((await endpoint.request("DOM.getBoxModel", params)).error).toEqual({
          code: -32000,
          message: "Could not compute box model.",
        });
      }
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM.getBoxModel exposes native rotated quads and rejects inaccessible transformed quads", async () => {
  const harness = await createParityHarness();
  try {
    const prepare = async (endpoint: CdpEndpoint) => {
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#individual-transform")?.remove();
          const element = document.createElement("div");
          element.id = "individual-transform";
          element.style.rotate = "30deg";
          element.textContent = "Rotated text";
          const motion = document.createElement("div");
          motion.id = "motion-transform";
          motion.style.offsetPath = 'path("M 0 0 L 100 100")';
          motion.style.offsetDistance = "50%";
          motion.style.offsetRotate = "45deg";
          motion.textContent = "Motion path";
          document.body.append(element, motion);
        })()`,
      });
      const { root } = await endpoint.send("DOM.getDocument", { depth: -1 });
      const query = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#individual-transform",
      });
      const described = await endpoint.send("DOM.describeNode", {
        nodeId: query.nodeIds[0],
        depth: 1,
      });
      const motionQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#motion-transform",
      });
      return {
        element: query.nodeIds[0] as number,
        motion: motionQuery.nodeIds[0] as number,
        text: described.node.children[0].nodeId as number,
      };
    };

    const nativeIds = await prepare(harness.native);
    for (const nodeId of [nativeIds.element, nativeIds.text, nativeIds.motion]) {
      const { model } = await harness.native.send("DOM.getBoxModel", { nodeId });
      expect(model.border[1]).not.toBeCloseTo(model.border[3]);
    }

    const icdpIds = await prepare(harness.icdp);
    for (const nodeId of [icdpIds.element, icdpIds.text, icdpIds.motion]) {
      expect((await harness.icdp.request("DOM.getBoxModel", { nodeId })).error).toEqual({
        code: -32000,
        message: "Could not compute box model.",
      });
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM.requestNode exposes detached and template-content Runtime nodes", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      const { root } = await endpoint.send("DOM.getDocument", { depth: 0 });
      await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#main",
      });
      const detached = await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const root = document.createElement("section");
          root.innerHTML = '<span id="detached-child">detached</span>';
          return root.firstChild;
        })()`,
      });
      const detachedPush = endpoint.waitForEvent(
        "DOM.setChildNodes",
        (params) => params.parentId === 0,
        5_000,
      );
      const detachedNode = await endpoint.send("DOM.requestNode", {
        objectId: detached.result.objectId,
      });
      const detachedPushEvent = await detachedPush;
      expect(detachedNode.nodeId).toEqual(expect.any(Number));
      expect(detachedNode.nodeId).toBeGreaterThan(0);
      expect(detachedPushEvent.nodes).toEqual([
        expect.objectContaining({
          nodeId: expect.any(Number),
          nodeName: "SECTION",
          childNodeCount: 1,
        }),
      ]);
      expect(
        await endpoint.send("DOM.describeNode", {
          nodeId: detachedNode.nodeId,
        }),
      ).toMatchObject({
        node: {
          nodeName: "SPAN",
        },
      });

      const secondDetachedPush = endpoint.waitForEvent(
        "DOM.setChildNodes",
        (params) => params.parentId === 0,
        5_000,
      );
      const secondDetachedNode = await endpoint.send("DOM.requestNode", {
        objectId: detached.result.objectId,
      });
      const secondDetachedPushEvent = await secondDetachedPush;
      expect(secondDetachedNode.nodeId).not.toBe(detachedNode.nodeId);
      expect(secondDetachedPushEvent.nodes[0].nodeId).not.toBe(detachedPushEvent.nodes[0].nodeId);

      const attached = endpoint.waitForEvent(
        "DOM.childNodeInserted",
        (params) => params.node?.nodeName === "SECTION",
        5_000,
      );
      await endpoint.send("Runtime.callFunctionOn", {
        objectId: detached.result.objectId,
        functionDeclaration: "function () { document.body.append(this.parentNode); }",
      });
      expect((await attached).node.nodeId).not.toBe(secondDetachedPushEvent.nodes[0].nodeId);

      const templateChild = await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const template = document.createElement("template");
          template.id = "runtime-template";
          template.innerHTML = '<button id="template-child">template</button>';
          document.body.append(template);
          return template.content.firstChild;
        })()`,
      });
      const templateNode = await endpoint.send("DOM.requestNode", {
        objectId: templateChild.result.objectId,
      });
      expect(templateNode.nodeId).toEqual(expect.any(Number));
      expect(templateNode.nodeId).toBeGreaterThan(0);
      expect(
        await endpoint.send("DOM.describeNode", {
          nodeId: templateNode.nodeId,
        }),
      ).toMatchObject({
        node: {
          nodeName: "BUTTON",
          attributes: expect.arrayContaining(["id", "template-child"]),
        },
      });
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM emits Chromium mutation events only for the session frontend tree", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#count-replace")?.remove();
          const parent = document.createElement("div");
          parent.id = "count-replace";
          parent.append(document.createElement("span"));
          document.body.append(parent);
        })()`,
      });
      await endpoint.send("DOM.enable");
      const { root } = await endpoint.send("DOM.getDocument", { depth: 0 });

      const childPush = endpoint.waitForEvent("DOM.setChildNodes");
      const rootQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#mutation-root",
      });
      expect((await childPush).nodes).toEqual(expect.any(Array));
      const mutationRootId = rootQuery.nodeIds[0] as number;
      const replaceQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#count-replace",
      });
      const replaceRootId = replaceQuery.nodeIds[0] as number;
      expect(replaceRootId).toBeGreaterThan(0);

      const countUpdated = endpoint.waitForEvent(
        "DOM.childNodeCountUpdated",
        (params) => params.nodeId === mutationRootId,
      );
      await endpoint.send("Runtime.evaluate", {
        expression:
          "document.querySelector('#mutation-root').append(Object.assign(document.createElement('i'), { id: 'count-only' }))",
      });
      expect(await countUpdated).toMatchObject({
        nodeId: mutationRootId,
        childNodeCount: 2,
      });

      const replaceStart = endpoint.events.length;
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const parent = document.querySelector("#count-replace");
          parent.replaceChild(document.createElement("b"), parent.firstChild);
        })()`,
      });
      const replaceCounts = await waitUntil(
        async () => {
          const counts = endpoint.events
            .slice(replaceStart)
            .filter(
              (event) =>
                event.method === "DOM.childNodeCountUpdated" &&
                event.params?.nodeId === replaceRootId,
            )
            .map((event) => event.params!.childNodeCount);
          return counts.length >= 2 ? counts : undefined;
        },
        `${endpoint === harness.native ? "native" : "icdp"} replaceChild count transitions`,
      );
      expect(replaceCounts).toEqual([0, 1]);

      const mutableQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#mutable",
      });
      const mutableNodeId = mutableQuery.nodeIds[0] as number;
      const mutable = await endpoint.send("DOM.describeNode", {
        nodeId: mutableNodeId,
        depth: 1,
      });
      const textNodeId = mutable.node.children[0].nodeId as number;

      const attributeModified = endpoint.waitForEvent(
        "DOM.attributeModified",
        (params) => params.nodeId === mutableNodeId && params.name === "data-parity",
      );
      await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#mutable').setAttribute('data-parity', 'yes')",
      });
      expect(await attributeModified).toMatchObject({
        nodeId: mutableNodeId,
        name: "data-parity",
        value: "yes",
      });

      const attributeRemoved = endpoint.waitForEvent(
        "DOM.attributeRemoved",
        (params) => params.nodeId === mutableNodeId && params.name === "data-parity",
      );
      await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#mutable').removeAttribute('data-parity')",
      });
      expect(await attributeRemoved).toEqual({
        nodeId: mutableNodeId,
        name: "data-parity",
      });

      const characterData = endpoint.waitForEvent(
        "DOM.characterDataModified",
        (params) => params.nodeId === textNodeId,
      );
      await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#mutable').firstChild.data = 'after'",
      });
      expect(await characterData).toEqual({
        nodeId: textNodeId,
        characterData: "after",
      });

      const inserted = endpoint.waitForEvent(
        "DOM.childNodeInserted",
        (params) =>
          params.parentNodeId === mutationRootId && params.node?.attributes?.includes("new"),
      );
      await endpoint.send("Runtime.evaluate", {
        expression:
          "document.querySelector('#mutation-root').append(Object.assign(document.createElement('b'), { id: 'new', textContent: 'new' }))",
      });
      const insertedEvent = await inserted;
      expect(insertedEvent).toMatchObject({
        parentNodeId: mutationRootId,
        node: {
          nodeId: expect.any(Number),
          nodeName: "B",
          attributes: expect.arrayContaining(["id", "new"]),
        },
      });

      const removed = endpoint.waitForEvent(
        "DOM.childNodeRemoved",
        (params) => params.nodeId === insertedEvent.node.nodeId,
      );
      await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#new').remove()",
      });
      expect(await removed).toEqual({
        parentNodeId: mutationRootId,
        nodeId: insertedEvent.node.nodeId,
      });
      await endpoint.send("DOM.disable");
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM.requestChildNodes materializes each frontend subtree only once", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("DOM.enable");
      const { root } = await endpoint.send("DOM.getDocument", { depth: 0 });

      for (const depth of [0, -2]) {
        expect(
          (
            await endpoint.request("DOM.requestChildNodes", {
              nodeId: root.nodeId,
              depth,
            })
          ).error,
        ).toEqual({
          code: -32000,
          message: "Please provide a positive integer as a depth or -1 for entire subtree",
        });
      }

      const unknownEvent = endpoint.waitForEvent("DOM.setChildNodes", undefined, 250);
      expect(
        await endpoint.send("DOM.requestChildNodes", {
          nodeId: 2_147_483_647,
          depth: 1,
        }),
      ).toEqual({});
      await expect(unknownEvent).rejects.toThrow("timed out waiting for DOM.setChildNodes");

      const firstPush = endpoint.waitForEvent(
        "DOM.setChildNodes",
        (params) => params.parentId === root.nodeId,
      );
      expect(
        await endpoint.send("DOM.requestChildNodes", {
          nodeId: root.nodeId,
          depth: 1,
        }),
      ).toEqual({});
      const first = await firstPush;
      const documentType = first.nodes.find((node: { nodeType: number }) => node.nodeType === 10);
      const documentElement = first.nodes.find((node: { nodeType: number }) => node.nodeType === 1);
      expect(documentType).toEqual(expect.objectContaining({ nodeId: expect.any(Number) }));
      expect(documentElement).toEqual(expect.objectContaining({ nodeId: expect.any(Number) }));

      const repeatedPush = endpoint.waitForEvent(
        "DOM.setChildNodes",
        (params) => params.parentId === root.nodeId,
        250,
      );
      expect(
        await endpoint.send("DOM.requestChildNodes", {
          nodeId: root.nodeId,
          depth: 1,
        }),
      ).toEqual({});
      await expect(repeatedPush).rejects.toThrow("timed out waiting for DOM.setChildNodes");

      const descendantPush = endpoint.waitForEvent(
        "DOM.setChildNodes",
        (params) => params.parentId === documentElement.nodeId,
      );
      const repeatedRoot = endpoint.waitForEvent(
        "DOM.setChildNodes",
        (params) => params.parentId === root.nodeId,
        250,
      );
      expect(
        await endpoint.send("DOM.requestChildNodes", {
          nodeId: root.nodeId,
          depth: 2,
        }),
      ).toEqual({});
      expect(await descendantPush).toMatchObject({
        parentId: documentElement.nodeId,
        nodes: expect.any(Array),
      });
      await expect(repeatedRoot).rejects.toThrow("timed out waiting for DOM.setChildNodes");

      const leafPush = endpoint.waitForEvent("DOM.setChildNodes", undefined, 250);
      expect(
        await endpoint.send("DOM.requestChildNodes", {
          nodeId: documentType.nodeId,
          depth: 1,
        }),
      ).toEqual({});
      await expect(leafPush).rejects.toThrow("timed out waiting for DOM.setChildNodes");
      await endpoint.send("DOM.disable");
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM announces dynamic open shadow roots and continues their mutation stream", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#dynamic-shadow-host")?.remove();
          const host = document.createElement("div");
          host.id = "dynamic-shadow-host";
          host.innerHTML = "<span>light one</span><span>light two</span>";
          document.body.append(host);
        })()`,
      });
      await endpoint.send("DOM.enable");
      const { root } = await endpoint.send("DOM.getDocument", { depth: 0, pierce: true });
      const { nodeIds } = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#dynamic-shadow-host",
      });
      const hostId = nodeIds[0] as number;

      const order: string[] = [];
      const materialized = endpoint
        .waitForEvent("DOM.setChildNodes", (params) => params.parentId === hostId, 5_000)
        .then((event) => {
          order.push("DOM.setChildNodes");
          return event;
        });
      const pushed = endpoint
        .waitForEvent("DOM.shadowRootPushed", (params) => params.hostId === hostId, 5_000)
        .then((event) => {
          order.push("DOM.shadowRootPushed");
          return event;
        });
      await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#dynamic-shadow-host').attachShadow({ mode: 'open' })",
      });
      expect(await materialized).toMatchObject({
        parentId: hostId,
        nodes: [
          expect.objectContaining({ nodeName: "SPAN" }),
          expect.objectContaining({ nodeName: "SPAN" }),
        ],
      });
      const pushedEvent = await pushed;
      expect(order).toEqual(["DOM.setChildNodes", "DOM.shadowRootPushed"]);
      expect(pushedEvent).toMatchObject({
        hostId,
        root: {
          nodeId: expect.any(Number),
          backendNodeId: expect.any(Number),
          nodeType: 11,
          nodeName: "#document-fragment",
          shadowRootType: "open",
        },
      });

      await endpoint.send("DOM.requestChildNodes", {
        nodeId: pushedEvent.root.nodeId,
        depth: 1,
      });
      const inserted = endpoint.waitForEvent(
        "DOM.childNodeInserted",
        (params) =>
          params.parentNodeId === pushedEvent.root.nodeId &&
          params.node?.attributes?.includes("shadow-child"),
        5_000,
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const button = document.createElement("button");
          button.id = "shadow-child";
          document.querySelector("#dynamic-shadow-host").shadowRoot.append(button);
        })()`,
      });
      expect(await inserted).toMatchObject({
        parentNodeId: pushedEvent.root.nodeId,
        node: {
          nodeId: expect.any(Number),
          nodeName: "BUTTON",
          attributes: expect.arrayContaining(["id", "shadow-child"]),
        },
      });
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM preserves Chromium whitespace visibility and batched attribute events", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      const strippedWhitespace = [
        0x0b, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
        0x2009, 0x200a, 0x2028, 0x205f, 0x3000,
      ];
      const retainedWhitespace = [0x00a0, 0x2029, 0x202f, 0xfeff];
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#whitespace-fixture")?.remove();
          const fixture = document.createElement("div");
          fixture.id = "whitespace-fixture";
          fixture.innerHTML = '<span id="changing-text">visible</span>';
          for (const codePoint of ${JSON.stringify([
            ...strippedWhitespace,
            ...retainedWhitespace,
          ])}) {
            const span = document.createElement("span");
            span.id = "whitespace-" + codePoint.toString(16);
            span.textContent = String.fromCodePoint(codePoint);
            fixture.append(span);
          }
          document.body.append(fixture);
        })()`,
      });
      const { root } = await endpoint.send("DOM.getDocument", { depth: -1 });
      const changingQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#changing-text",
      });
      const changingId = changingQuery.nodeIds[0] as number;
      const changing = await endpoint.send("DOM.describeNode", {
        nodeId: changingId,
        depth: 1,
      });
      const originalTextId = changing.node.children[0].nodeId as number;
      for (const codePoint of strippedWhitespace) {
        const { nodeIds } = await endpoint.send("DOM.querySelectorAll", {
          nodeId: root.nodeId,
          selector: `#whitespace-${codePoint.toString(16)}`,
        });
        const whitespace = await endpoint.send("DOM.describeNode", {
          nodeId: nodeIds[0],
          depth: 1,
        });
        expect(whitespace.node).toMatchObject({
          childNodeCount: 0,
          children: [],
        });
      }
      for (const codePoint of retainedWhitespace) {
        const { nodeIds } = await endpoint.send("DOM.querySelectorAll", {
          nodeId: root.nodeId,
          selector: `#whitespace-${codePoint.toString(16)}`,
        });
        const whitespace = await endpoint.send("DOM.describeNode", {
          nodeId: nodeIds[0],
          depth: 1,
        });
        expect(whitespace.node.children).toEqual([
          expect.objectContaining({
            nodeType: 3,
            nodeValue: String.fromCodePoint(codePoint),
          }),
        ]);
      }

      const removed = endpoint.waitForEvent(
        "DOM.childNodeRemoved",
        (params) => params.parentNodeId === changingId && params.nodeId === originalTextId,
      );
      await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#changing-text').firstChild.data = '   '",
      });
      expect(await removed).toEqual({
        parentNodeId: changingId,
        nodeId: originalTextId,
      });

      const inserted = endpoint.waitForEvent(
        "DOM.childNodeInserted",
        (params) => params.parentNodeId === changingId,
      );
      await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#changing-text').firstChild.data = 'visible again'",
      });
      const insertedEvent = await inserted;
      expect(insertedEvent).toMatchObject({
        parentNodeId: changingId,
        previousNodeId: 0,
        node: {
          nodeId: expect.any(Number),
          nodeType: 3,
          nodeValue: "visible again",
        },
      });
      expect(insertedEvent.node.nodeId).not.toBe(originalTextId);

      const modified = endpoint.waitForEvent(
        "DOM.attributeModified",
        (params) => params.nodeId === changingId && params.name === "data-batched",
      );
      const attributeRemoved = endpoint.waitForEvent(
        "DOM.attributeRemoved",
        (params) => params.nodeId === changingId && params.name === "data-batched",
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const node = document.querySelector("#changing-text");
          node.setAttribute("data-batched", "one");
          node.removeAttribute("data-batched");
        })()`,
      });
      expect(await modified).toEqual({
        nodeId: changingId,
        name: "data-batched",
        value: "one",
      });
      expect(await attributeRemoved).toEqual({
        nodeId: changingId,
        name: "data-batched",
      });

      const batchedRemoved = endpoint.waitForEvent(
        "DOM.childNodeRemoved",
        (params) => params.parentNodeId === changingId,
        5_000,
      );
      const batchedInserted = endpoint.waitForEvent(
        "DOM.childNodeInserted",
        (params) =>
          params.parentNodeId === changingId && params.node?.nodeValue === "batched visible",
        5_000,
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const text = document.querySelector("#changing-text").firstChild;
          text.data = "   ";
          text.data = "batched visible";
        })()`,
      });
      const [batchedRemovedEvent, batchedInsertedEvent] = await Promise.all([
        batchedRemoved,
        batchedInserted,
      ]);
      expect(batchedRemovedEvent).toMatchObject({
        parentNodeId: changingId,
        nodeId: expect.any(Number),
      });
      expect(batchedInsertedEvent).toMatchObject({
        parentNodeId: changingId,
        node: {
          nodeId: expect.any(Number),
          nodeValue: "batched visible",
        },
      });
      expect(batchedInsertedEvent.node.nodeId).not.toBe(batchedRemovedEvent.nodeId);

      const firstModified = endpoint.waitForEvent(
        "DOM.characterDataModified",
        (params) =>
          params.nodeId === batchedInsertedEvent.node.nodeId && params.characterData === "one",
      );
      const secondModified = endpoint.waitForEvent(
        "DOM.characterDataModified",
        (params) =>
          params.nodeId === batchedInsertedEvent.node.nodeId && params.characterData === "two",
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const text = document.querySelector("#changing-text").firstChild;
          text.data = "one";
          text.data = "two";
        })()`,
      });
      expect(await firstModified).toEqual({
        nodeId: batchedInsertedEvent.node.nodeId,
        characterData: "one",
      });
      expect(await secondModified).toEqual({
        nodeId: batchedInsertedEvent.node.nodeId,
        characterData: "two",
      });
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM mutation batches retain record-time sibling, text, and namespace state", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#mutation-batch-fixture")?.remove();
          const fixture = document.createElement("div");
          fixture.id = "mutation-batch-fixture";
          fixture.innerHTML = [
            '<div id="batch-parent"><span id="batch-a">A</span> </div>',
            '<div id="batch-text-parent"></div>',
            '<div id="batch-extract"><div id="batch-container"><span id="batch-kid">kid</span></div><div id="batch-dest"></div></div>',
            '<svg><use id="batch-svg-use"></use></svg>'
          ].join("");
          document.body.append(fixture);
        })()`,
      });
      await endpoint.send("DOM.enable");
      const { root } = await endpoint.send("DOM.getDocument", { depth: 0 });
      const { nodeIds } = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#batch-parent, #batch-text-parent, #batch-svg-use",
      });
      const [parentId, textParentId, useId] = nodeIds as number[];
      let aId = 0;
      for (const nodeId of [parentId, textParentId]) {
        const materialized = endpoint.waitForEvent(
          "DOM.setChildNodes",
          (params) => params.parentId === nodeId,
        );
        await endpoint.send("DOM.requestChildNodes", { nodeId, depth: 1 });
        const event = await materialized;
        if (nodeId === parentId) {
          aId = event.nodes[0]?.nodeId as number;
        }
      }
      expect(aId).toBeGreaterThan(0);

      const batchStart = endpoint.events.length;
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const parent = document.querySelector("#batch-parent");
          const moved = document.createElement("b");
          moved.id = "batch-b";
          parent.append(moved);
          moved.previousSibling.remove();
          parent.prepend(moved);
        })()`,
      });
      const mutationEvents = await waitUntil(async () => {
        const events = endpoint.events
          .slice(batchStart)
          .filter(
            (event) =>
              event.params?.parentNodeId === parentId &&
              ["DOM.childNodeInserted", "DOM.childNodeRemoved"].includes(event.method ?? ""),
          );
        return events.length >= 3 ? events : undefined;
      }, "batched child movement events");
      const [afterAEvent, removedEvent, atStartEvent] = mutationEvents.map(
        (event) => event.params!,
      );
      expect(afterAEvent).toMatchObject({
        parentNodeId: parentId,
        previousNodeId: aId,
        node: { attributes: expect.arrayContaining(["batch-b"]) },
      });
      expect(atStartEvent).toMatchObject({
        parentNodeId: parentId,
        previousNodeId: 0,
        node: { attributes: expect.arrayContaining(["batch-b"]) },
      });
      expect(removedEvent!.nodeId).toBe(afterAEvent!.node.nodeId);
      expect(atStartEvent!.node.nodeId).not.toBe(afterAEvent!.node.nodeId);
      expect(mutationEvents.map((event) => event.method)).toEqual([
        "DOM.childNodeInserted",
        "DOM.childNodeRemoved",
        "DOM.childNodeInserted",
      ]);

      const textStart = endpoint.events.length;
      const insertedText = endpoint.waitForEvent(
        "DOM.childNodeInserted",
        (params) =>
          params.parentNodeId === textParentId &&
          params.node?.nodeType === 3 &&
          params.node?.nodeValue === "shown",
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const text = document.createTextNode(" ");
          document.querySelector("#batch-text-parent").append(text);
          text.data = "shown";
        })()`,
      });
      await insertedText;
      expect(
        endpoint.events
          .slice(textStart)
          .filter(
            (event) =>
              event.method === "DOM.childNodeInserted" &&
              event.params?.parentNodeId === textParentId,
          ),
      ).toHaveLength(1);

      const attribute = endpoint.waitForEvent(
        "DOM.attributeModified",
        (params) => params.nodeId === useId,
        5_000,
      );
      await endpoint.send("Runtime.evaluate", {
        expression:
          "document.querySelector('#batch-svg-use').setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#target')",
      });
      expect(await attribute).toEqual({
        nodeId: useId,
        name: "xlink:href",
        value: "#target",
      });

      const extraction = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#batch-extract, #batch-container, #batch-kid, #batch-dest",
      });
      const [extractId, containerId, oldKidId, destinationId] = extraction.nodeIds as number[];
      await endpoint.send("DOM.requestChildNodes", { nodeId: extractId, depth: -1 });

      const extracted = endpoint.waitForEvent(
        "DOM.childNodeInserted",
        (params) => params.parentNodeId === destinationId,
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const container = document.querySelector("#batch-container");
          const kid = document.querySelector("#batch-kid");
          const destination = document.querySelector("#batch-dest");
          container.remove();
          destination.append(kid);
        })()`,
      });
      const extractedEvent = await extracted;
      expect(extractedEvent.node).toMatchObject({
        nodeName: "SPAN",
        attributes: expect.arrayContaining(["id", "batch-kid"]),
      });
      expect(extractedEvent.node.nodeId).not.toBe(oldKidId);
      expect((await endpoint.request("DOM.describeNode", { nodeId: oldKidId })).error).toEqual({
        code: -32000,
        message: "Could not find node with given id",
      });
      expect(containerId).toBeGreaterThan(0);
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM insertion events serialize element and text state at insertion time", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#insertion-snapshot")?.remove();
          const fixture = document.createElement("div");
          fixture.id = "insertion-snapshot";
          document.body.append(fixture);
        })()`,
      });
      const { root } = await endpoint.send("DOM.getDocument", { depth: 0 });
      const { nodeIds } = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#insertion-snapshot",
      });
      const parentId = nodeIds[0] as number;
      const materialized = endpoint.waitForEvent(
        "DOM.setChildNodes",
        (params) => params.parentId === parentId,
      );
      await endpoint.send("DOM.requestChildNodes", { nodeId: parentId, depth: 1 });
      await materialized;

      const insertedElement = endpoint.waitForEvent(
        "DOM.childNodeInserted",
        (params) => params.parentNodeId === parentId && params.node?.nodeName === "B",
      );
      const modifiedAttribute = endpoint.waitForEvent(
        "DOM.attributeModified",
        (params) => params.name === "id" && params.value === "after-insertion",
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const child = document.createElement("b");
          document.querySelector("#insertion-snapshot").append(child);
          child.id = "after-insertion";
        })()`,
      });
      const insertedElementEvent = await insertedElement;
      expect(insertedElementEvent.node.attributes).toEqual([]);
      expect(await modifiedAttribute).toEqual({
        nodeId: insertedElementEvent.node.nodeId,
        name: "id",
        value: "after-insertion",
      });

      const insertedText = endpoint.waitForEvent(
        "DOM.childNodeInserted",
        (params) =>
          params.parentNodeId === parentId &&
          params.node?.nodeType === 3 &&
          params.node?.nodeValue === "before",
      );
      const modifiedText = endpoint.waitForEvent(
        "DOM.characterDataModified",
        (params) => params.characterData === "after",
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const text = document.createTextNode("before");
          document.querySelector("#insertion-snapshot").append(text);
          text.data = "after";
        })()`,
      });
      const insertedTextEvent = await insertedText;
      expect(await modifiedText).toEqual({
        nodeId: insertedTextEvent.node.nodeId,
        characterData: "after",
      });

      const descendantStart = endpoint.events.length;
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const child = document.createElement("strong");
          document.querySelector("#insertion-snapshot").append(child);
          child.textContent = "later";
        })()`,
      });
      const descendantEvents = await waitUntil(async () => {
        const events = endpoint.events
          .slice(descendantStart)
          .filter((event) =>
            ["DOM.childNodeInserted", "DOM.childNodeCountUpdated"].includes(event.method ?? ""),
          );
        return events.length >= 2 ? events : undefined;
      }, "record-time descendant insertion events");
      const insertedContainer = descendantEvents.find(
        (event) =>
          event.method === "DOM.childNodeInserted" &&
          event.params?.parentNodeId === parentId &&
          event.params.node?.nodeName === "STRONG",
      );
      expect(insertedContainer?.params?.node).toMatchObject({
        childNodeCount: 0,
      });
      expect(insertedContainer?.params?.node).not.toHaveProperty("children");
      expect(descendantEvents).toEqual([
        expect.objectContaining({
          method: "DOM.childNodeInserted",
          params: expect.objectContaining({
            parentNodeId: parentId,
            node: expect.objectContaining({ nodeName: "STRONG", childNodeCount: 0 }),
          }),
        }),
        {
          method: "DOM.childNodeCountUpdated",
          params: {
            nodeId: insertedContainer?.params?.node.nodeId,
            childNodeCount: 1,
          },
          sessionId: expect.any(String),
        },
      ]);

      const orderedAttributes = endpoint.waitForEvent(
        "DOM.childNodeInserted",
        (params) =>
          params.parentNodeId === parentId &&
          params.node?.nodeName === "I" &&
          params.node?.attributes?.includes("ordered-attributes"),
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const child = document.createElement("i");
          child.setAttribute("id", "ordered-attributes");
          child.setAttribute("a", "1");
          child.setAttribute("b", "2");
          document.querySelector("#insertion-snapshot").append(child);
          child.removeAttribute("a");
          child.setAttribute("a", "3");
        })()`,
      });
      expect((await orderedAttributes).node.attributes).toEqual([
        "id",
        "ordered-attributes",
        "a",
        "1",
        "b",
        "2",
      ]);

      const shadowStart = endpoint.events.length;
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const host = document.createElement("section");
          host.id = "snapshot-shadow-host";
          document.querySelector("#insertion-snapshot").append(host);
          host.attachShadow({ mode: "open" });
        })()`,
      });
      const shadowEvents = await waitUntil(async () => {
        const events = endpoint.events
          .slice(shadowStart)
          .filter(
            (event) =>
              (event.method === "DOM.childNodeInserted" &&
                event.params?.parentNodeId === parentId &&
                event.params?.node?.attributes?.includes("snapshot-shadow-host")) ||
              (event.method === "DOM.setChildNodes" &&
                event.params?.parentId &&
                event.params.parentId !== parentId) ||
              event.method === "DOM.shadowRootPushed",
          );
        return events.some((event) => event.method === "DOM.shadowRootPushed") ? events : undefined;
      }, "shadow-root insertion chronology");
      const shadowInsertion = shadowEvents.find(
        (event) => event.method === "DOM.childNodeInserted",
      )!;
      expect(shadowInsertion.params!.node).not.toHaveProperty("shadowRoots");
      expect(shadowEvents.map((event) => event.method)).toEqual([
        "DOM.childNodeInserted",
        "DOM.setChildNodes",
        "DOM.shadowRootPushed",
      ]);

      const templateStart = endpoint.events.length;
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const template = document.createElement("template");
          template.id = "snapshot-template";
          document.querySelector("#insertion-snapshot").append(template);
          template.innerHTML = "<b>later</b>";
        })()`,
      });
      const templateEvents = await waitUntil(async () => {
        const events = endpoint.events
          .slice(templateStart)
          .filter(
            (event) =>
              (event.method === "DOM.childNodeInserted" &&
                event.params?.parentNodeId === parentId &&
                event.params?.node?.attributes?.includes("snapshot-template")) ||
              event.method === "DOM.childNodeCountUpdated",
          );
        return events.length >= 2 ? events : undefined;
      }, "template insertion chronology");
      const templateInsertion = templateEvents[0]!;
      expect(templateInsertion.params!.node.templateContent).toMatchObject({
        childNodeCount: 0,
      });
      expect(templateEvents).toEqual([
        expect.objectContaining({ method: "DOM.childNodeInserted" }),
        {
          method: "DOM.childNodeCountUpdated",
          params: {
            nodeId: templateInsertion.params!.node.templateContent.nodeId,
            childNodeCount: 1,
          },
          sessionId: expect.any(String),
        },
      ]);
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM serializes frame ownership and caps long node values like Blink", async () => {
  const harness = await createParityHarness();
  try {
    for (const endpoint of [harness.native, harness.icdp]) {
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#long-text")?.remove();
          const span = document.createElement("span");
          span.id = "long-text";
          span.textContent = "x".repeat(10001);
          document.body.append(span);
        })()`,
      });
      const frame = (await endpoint.send("Page.getFrameTree")).frameTree.frame;
      const { root } = await endpoint.send("DOM.getDocument", { depth: 1 });
      const documentElement = root.children.find(
        (node: { nodeName: string }) => node.nodeName === "HTML",
      );
      expect(documentElement).toMatchObject({
        nodeType: 1,
        nodeName: "HTML",
        frameId: frame.id,
      });

      const { nodeIds } = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#long-text",
      });
      const described = await endpoint.send("DOM.describeNode", {
        nodeId: nodeIds[0],
        depth: 1,
      });
      expect(described.node.children[0]).toMatchObject({
        nodeType: 3,
        nodeValue: `${"x".repeat(10_000)}…`,
      });
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Input commands match Chromium effects and attainable trust semantics", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("Runtime.evaluate", {
        expression:
          "window.__parity.input = []; document.querySelector('#editor').value = ''; document.querySelector('#editor').focus()",
      });
      expect(await endpoint.send("Input.insertText", { text: "alpha" })).toEqual({});
      const inserted = await endpoint.send("Runtime.evaluate", {
        expression:
          "({ value: document.querySelector('#editor').value, events: window.__parity.input, active: document.activeElement?.id, focused: document.hasFocus() })",
        returnByValue: true,
      });

      await endpoint.send("Runtime.evaluate", {
        expression:
          "window.__parity.input = []; window.__parity.keys = []; document.querySelector('#editor').value = ''; document.querySelector('#editor').focus()",
      });
      await endpoint.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Z",
        code: "KeyZ",
        text: "Z",
        windowsVirtualKeyCode: 90,
        nativeVirtualKeyCode: 90,
      });
      await endpoint.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Z",
        code: "KeyZ",
        windowsVirtualKeyCode: 90,
        nativeVirtualKeyCode: 90,
      });
      const keyed = await endpoint.send("Runtime.evaluate", {
        expression:
          "({ value: document.querySelector('#editor').value, inputs: window.__parity.input, keys: window.__parity.keys })",
        returnByValue: true,
      });

      await endpoint.send("DOM.enable");
      const { root } = await endpoint.send("DOM.getDocument", { depth: 0 });
      const { nodeIds } = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#action",
      });
      const { model } = await endpoint.send("DOM.getBoxModel", { nodeId: nodeIds[0] });
      const x = (model.border[0] + model.border[2]) / 2;
      const y = (model.border[1] + model.border[5]) / 2;
      await endpoint.send("Runtime.evaluate", {
        expression: "window.__parity.clicks = 0; window.__parity.mouse = []",
      });
      await endpoint.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await endpoint.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await endpoint.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      const clicked = await endpoint.send("Runtime.evaluate", {
        expression: "({ clicks: window.__parity.clicks, events: window.__parity.mouse })",
        returnByValue: true,
      });
      return {
        inserted: inserted.result.value,
        keyed: keyed.result.value,
        clicked: clicked.result.value,
      };
    };

    await harness.native.send("Page.bringToFront");
    const native = await exercise(harness.native);
    const icdp = await exercise(harness.icdp);
    for (const [name, result] of [
      ["native", native],
      ["icdp", icdp],
    ] as const) {
      expect(result.inserted.value, `${name}: ${JSON.stringify(result.inserted)}`).toBe("alpha");
      expect(result.inserted.events).toEqual([
        expect.objectContaining({ data: "alpha", inputType: "insertText" }),
      ]);
      expect(result.keyed.value).toBe("Z");
      expect(result.keyed.keys.map((event: { type: string }) => event.type)).toEqual(
        expect.arrayContaining(["keydown", "keyup"]),
      );
      expect(result.clicked.clicks).toBe(1);
      expect(result.clicked.events.map((event: { type: string }) => event.type)).toEqual(
        expect.arrayContaining(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]),
      );
    }
    expect(native.inserted.events[0].trusted).toBe(true);
    expect(native.keyed.keys.every((event: { trusted: boolean }) => event.trusted)).toBe(true);
    expect(native.clicked.events.every((event: { trusted: boolean }) => event.trusted)).toBe(true);
    expect(icdp.inserted.events[0].trusted).toBe(true);
    expect(icdp.keyed.keys.every((event: { trusted: boolean }) => !event.trusted)).toBe(true);
    expect(icdp.clicked.events.every((event: { trusted: boolean }) => !event.trusted)).toBe(true);
  } finally {
    await harness.close();
  }
}, 120_000);

test("Input editing honors cancellation, beforeinput ordering, and grapheme deletion", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const editor = document.querySelector("#editor");
          window.__editEvents = [];
          window.__blockBeforeInput = false;
          window.__blockKeydown = false;
          editor.onbeforeinput = event => {
            window.__editEvents.push({
              type: event.type,
              data: event.data,
              inputType: event.inputType
            });
            if (window.__blockBeforeInput) event.preventDefault();
          };
          editor.oninput = event => window.__editEvents.push({
            type: event.type,
            data: event.data,
            inputType: event.inputType
          });
          editor.onkeydown = event => {
            if (window.__blockKeydown) event.preventDefault();
          };
        })()`,
      });

      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const editor = document.querySelector("#editor");
          editor.value = "";
          editor.focus();
          editor.setSelectionRange(0, 0);
          window.__editEvents = [];
          window.__blockBeforeInput = true;
        })()`,
      });
      await endpoint.send("Input.insertText", { text: "blocked" });
      const beforeInputCancelled = await endpoint.send("Runtime.evaluate", {
        expression:
          "({ value: document.querySelector('#editor').value, events: window.__editEvents })",
        returnByValue: true,
      });

      await endpoint.send("Runtime.evaluate", {
        expression: "window.__editEvents = []; window.__blockBeforeInput = false",
      });
      await endpoint.send("Input.insertText", { text: "ok" });
      const inserted = await endpoint.send("Runtime.evaluate", {
        expression:
          "({ value: document.querySelector('#editor').value, events: window.__editEvents })",
        returnByValue: true,
      });

      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const editor = document.querySelector("#editor");
          editor.value = "";
          editor.setSelectionRange(0, 0);
          window.__blockKeydown = true;
        })()`,
      });
      await endpoint.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "X",
        code: "KeyX",
        text: "X",
        windowsVirtualKeyCode: 88,
      });
      const keydownCancelled = await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#editor').value",
        returnByValue: true,
      });

      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const editor = document.querySelector("#editor");
          editor.value = "A😀";
          editor.setSelectionRange(editor.value.length, editor.value.length);
          window.__blockKeydown = false;
        })()`,
      });
      await endpoint.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });
      const deleted = await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#editor').value",
        returnByValue: true,
      });

      return {
        beforeInputCancelled: beforeInputCancelled.result.value,
        inserted: inserted.result.value,
        keydownCancelled: keydownCancelled.result.value,
        deleted: deleted.result.value,
      };
    };

    for (const endpoint of [harness.native, harness.icdp]) {
      const result = await exercise(endpoint);
      expect(result.beforeInputCancelled).toEqual({
        value: "",
        events: [{ type: "beforeinput", data: "blocked", inputType: "insertText" }],
      });
      expect(result.inserted).toEqual({
        value: "ok",
        events: [
          { type: "beforeinput", data: "ok", inputType: "insertText" },
          { type: "input", data: "ok", inputType: "insertText" },
        ],
      });
      expect(result.keydownCancelled).toBe("");
      expect(result.deleted).toBe("A");
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Input.insertText respects native control constraints and internal carets", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#input-constraints")?.remove();
          const fixture = document.createElement("div");
          fixture.id = "input-constraints";
          fixture.innerHTML = [
            '<input id="readonly-editor" value="fixed" readonly>',
            '<input id="full-editor" value="full" maxlength="4">',
            '<input id="number-editor" type="number">',
            '<input id="email-editor" type="email" value="before@example.test">'
          ].join("");
          document.body.append(fixture);
          window.__constraintEvents = {};
          for (const input of fixture.querySelectorAll("input")) {
            window.__constraintEvents[input.id] = [];
            for (const type of ["beforeinput", "input"]) {
              input.addEventListener(type, event => {
                window.__constraintEvents[input.id].push({
                  type: event.type,
                  data: event.data,
                  inputType: event.inputType
                });
              });
            }
          }
        })()`,
      });

      for (const [id, text] of [
        ["readonly-editor", "x"],
        ["full-editor", "x"],
        ["number-editor", "42"],
        ["email-editor", ".new"],
      ]) {
        await endpoint.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(`#${id}`)}).focus()`,
        });
        await endpoint.send("Input.insertText", { text });
      }

      const state = await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const values = {};
          for (const input of document.querySelectorAll("#input-constraints input")) {
            values[input.id] = input.value;
          }
          return { values, events: window.__constraintEvents };
        })()`,
        returnByValue: true,
      });
      return state.result.value;
    };

    const native = await exercise(harness.native);
    const icdp = await exercise(harness.icdp);
    for (const result of [native, icdp]) {
      expect(result.values["readonly-editor"]).toBe("fixed");
      expect(result.values["full-editor"]).toBe("full");
      expect(result.values["number-editor"]).toBe("42");
      expect(result.events["readonly-editor"].map((event: { type: string }) => event.type)).toEqual(
        ["beforeinput"],
      );
      expect(result.events["full-editor"].map((event: { type: string }) => event.type)).toEqual([
        "beforeinput",
      ]);
      expect(result.events["number-editor"].map((event: { type: string }) => event.type)).toEqual([
        "beforeinput",
        "input",
      ]);
      expect(result.events["email-editor"].map((event: { type: string }) => event.type)).toEqual([
        "beforeinput",
        "input",
      ]);
    }
    expect(icdp.values["email-editor"]).toBe(native.values["email-editor"]);
  } finally {
    await harness.close();
  }
}, 120_000);

test("Input preserves Chromium key phases and pointer compatibility suppression", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      const geometry = await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#input-sequence-fixture")?.remove();
          const fixture = document.createElement("div");
          fixture.id = "input-sequence-fixture";
          fixture.innerHTML = [
            '<input id="sequence-editor">',
            '<input id="readonly-sequence" value="fixed" readonly>',
            '<button id="cancel-pointer"><span>cancel</span></button>',
            '<button id="disabled-pointer" disabled><span>disabled</span></button>',
            '<button id="cancel-right-pointer"><span>right</span></button>'
          ].join("");
          document.body.append(fixture);
          window.__inputSequence = {
            key: [],
            readonly: [],
            cancel: [],
            disabled: [],
            right: []
          };
          const record = (target, bucket, types) => {
            for (const type of types) {
              target.addEventListener(type, event => {
                window.__inputSequence[bucket].push(type);
                if (bucket === "cancel" && type === "pointerdown") event.preventDefault();
              });
            }
          };
          record(
            fixture.querySelector("#sequence-editor"),
            "key",
            ["keydown", "keypress", "beforeinput", "input"]
          );
          record(
            fixture.querySelector("#readonly-sequence"),
            "readonly",
            ["keydown", "keypress", "beforeinput", "input"]
          );
          record(
            fixture.querySelector("#cancel-pointer"),
            "cancel",
            ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]
          );
          record(
            fixture.querySelector("#disabled-pointer"),
            "disabled",
            ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]
          );
          record(
            fixture.querySelector("#cancel-right-pointer"),
            "right",
            ["pointerdown", "mousedown", "contextmenu", "pointerup", "mouseup", "auxclick"]
          );
          fixture.querySelector("#cancel-right-pointer").addEventListener(
            "pointerdown",
            event => event.preventDefault()
          );
          const center = selector => {
            const rect = fixture.querySelector(selector).getBoundingClientRect();
            return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
          };
          return {
            cancel: center("#cancel-pointer span"),
            disabled: center("#disabled-pointer span"),
            right: center("#cancel-right-pointer span")
          };
        })()`,
        returnByValue: true,
      });

      await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#sequence-editor').focus()",
      });
      await endpoint.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Z",
        code: "KeyZ",
        text: "Z",
        windowsVirtualKeyCode: 90,
      });

      await endpoint.send("Runtime.evaluate", {
        expression: "document.querySelector('#readonly-sequence').focus()",
      });
      await endpoint.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });

      const points = geometry.result.value;
      const click = async (point: { x: number; y: number }) => {
        await endpoint.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...point,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        await endpoint.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...point,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
      };
      await click(points.cancel);
      await click(points.disabled);
      await endpoint.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...points.right,
        button: "right",
        buttons: 2,
        clickCount: 1,
      });
      await endpoint.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...points.right,
        button: "right",
        buttons: 0,
        clickCount: 1,
      });
      const state = await endpoint.send("Runtime.evaluate", {
        expression: `({
          events: window.__inputSequence,
          keyValue: document.querySelector("#sequence-editor").value,
          readonlyValue: document.querySelector("#readonly-sequence").value
        })`,
        returnByValue: true,
      });
      return state.result.value;
    };

    for (const endpoint of [harness.native, harness.icdp]) {
      expect(await exercise(endpoint)).toEqual({
        events: {
          key: ["keydown", "keypress", "beforeinput", "input"],
          readonly: ["keydown"],
          cancel: ["pointerdown", "pointerup", "click"],
          disabled: ["pointerdown", "pointerup"],
          right: ["pointerdown", "contextmenu", "pointerup", "auxclick"],
        },
        keyValue: "Z",
        readonlyValue: "fixed",
      });
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Input mouse clicks preserve coordinates, modifiers, focus, and clickCount", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("DOM.enable");
      const { root } = await endpoint.send("DOM.getDocument", { depth: 0 });
      const { nodeIds } = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#editor",
      });
      const { model } = await endpoint.send("DOM.getBoxModel", { nodeId: nodeIds[0] });
      const x = (model.border[0] + model.border[2]) / 2;
      const y = (model.border[1] + model.border[5]) / 2;
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const editor = document.querySelector("#editor");
          window.__mouseClicks = [];
          window.__doubleClicks = 0;
          editor.onclick = event => window.__mouseClicks.push({
            clientX: event.clientX,
            clientY: event.clientY,
            detail: event.detail,
            altKey: event.altKey,
            shiftKey: event.shiftKey
          });
          editor.ondblclick = () => window.__doubleClicks++;
          document.body.tabIndex = -1;
          document.body.focus();
        })()`,
      });

      for (let count = 0; count < 2; count++) {
        await endpoint.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          buttons: 1,
          clickCount: 1,
          modifiers: 9,
        });
        await endpoint.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          buttons: 0,
          clickCount: 1,
          modifiers: 9,
        });
      }

      const state = await endpoint.send("Runtime.evaluate", {
        expression: `({
          active: document.activeElement?.id,
          clicks: window.__mouseClicks,
          doubleClicks: window.__doubleClicks
        })`,
        returnByValue: true,
      });
      return { ...state.result.value, x, y };
    };

    for (const endpoint of [harness.native, harness.icdp]) {
      const result = await exercise(endpoint);
      expect(result.active).toBe("editor");
      expect(result.doubleClicks).toBe(0);
      expect(result.clicks).toHaveLength(2);
      for (const click of result.clicks) {
        expect(click).toMatchObject({
          detail: 1,
          altKey: true,
          shiftKey: true,
        });
        expect(click.clientX).toBe(Math.floor(result.x));
        expect(click.clientY).toBe(Math.floor(result.y));
      }
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Input mouse state survives a flattened Session handoff", async () => {
  const harness = await createParityHarness();
  try {
    const additional = await harness.attachAdditionalSessions();
    for (const [primary, secondary] of [
      [harness.native, additional.native],
      [harness.icdp, additional.icdp],
    ] as const) {
      const geometry = await primary.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#session-handoff")?.remove();
          const button = document.createElement("button");
          button.id = "session-handoff";
          button.style.cssText =
            "position:fixed;left:320px;top:20px;width:120px;height:50px";
          button.textContent = "Session handoff";
          window.__sessionHandoffClicks = 0;
          button.addEventListener("click", () => window.__sessionHandoffClicks++);
          document.body.append(button);
          const rect = button.getBoundingClientRect();
          return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
        })()`,
        returnByValue: true,
      });
      const { x, y } = geometry.result.value;
      await primary.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await primary.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await secondary.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      const clicks = await primary.send("Runtime.evaluate", {
        expression: "window.__sessionHandoffClicks",
        returnByValue: true,
      });
      expect(clicks.result.value).toBe(1);
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Input pointer fields and cross-target hover transitions match Chromium", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      const geometry = await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#pointer-parity-fixture")?.remove();
          const fixture = document.createElement("div");
          fixture.id = "pointer-parity-fixture";
          fixture.innerHTML =
            '<button id="pointer-a" style="position:fixed;left:20px;top:20px;width:100px;height:50px">A</button>' +
            '<button id="pointer-b" style="position:fixed;left:180px;top:20px;width:100px;height:50px">B</button>';
          document.body.append(fixture);
          window.__pointerParity = [];
          const record = event => window.__pointerParity.push({
            type: event.type,
            target: event.currentTarget.id,
            relatedTarget: event.relatedTarget?.id ?? null,
            constructor: event.constructor.name,
            button: event.button,
            detail: event.detail,
            pointerType: event.pointerType ?? null
          });
          const types = [
            "pointerout", "pointerleave", "pointerover", "pointerenter",
            "mouseout", "mouseleave", "mouseover", "mouseenter",
            "pointermove", "pointerdown", "pointerup", "click", "contextmenu", "auxclick"
          ];
          for (const selector of ["#pointer-a", "#pointer-b"]) {
            const target = fixture.querySelector(selector);
            for (const type of types) target.addEventListener(type, record);
          }
          const center = selector => {
            const rect = fixture.querySelector(selector).getBoundingClientRect();
            return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
          };
          return { a: center("#pointer-a"), b: center("#pointer-b") };
        })()`,
        returnByValue: true,
      });
      const { a, b } = geometry.result.value;
      const readAndClear = async () => {
        const result = await endpoint.send("Runtime.evaluate", {
          expression: "window.__pointerParity.splice(0)",
          returnByValue: true,
        });
        return result.result.value;
      };

      await endpoint.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...a });
      await readAndClear();
      await endpoint.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...b });
      const transition = (await readAndClear()).filter(
        (event: { type: string }) => !event.type.endsWith("move"),
      );

      await endpoint.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...b });
      const move = (await readAndClear()).find(
        (event: { type: string }) => event.type === "pointermove",
      );

      await endpoint.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...b,
        button: "left",
        buttons: 1,
        clickCount: 2,
      });
      await endpoint.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...b,
        button: "left",
        buttons: 0,
        clickCount: 2,
      });
      const left = await readAndClear();

      await endpoint.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...b,
        button: "right",
        buttons: 2,
        clickCount: 1,
      });
      await endpoint.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...b,
        button: "right",
        buttons: 0,
        clickCount: 1,
      });
      const right = await readAndClear();
      return { transition, move, left, right };
    };

    for (const endpoint of [harness.native, harness.icdp]) {
      const result = await exercise(endpoint);
      expect(
        result.transition.map(
          (event: { type: string; target: string; relatedTarget: string | null }) => [
            event.type,
            event.target,
            event.relatedTarget,
          ],
        ),
      ).toEqual([
        ["pointerout", "pointer-a", "pointer-b"],
        ["pointerleave", "pointer-a", "pointer-b"],
        ["pointerover", "pointer-b", "pointer-a"],
        ["pointerenter", "pointer-b", "pointer-a"],
        ["mouseout", "pointer-a", "pointer-b"],
        ["mouseleave", "pointer-a", "pointer-b"],
        ["mouseover", "pointer-b", "pointer-a"],
        ["mouseenter", "pointer-b", "pointer-a"],
      ]);
      expect(result.move).toMatchObject({
        constructor: "PointerEvent",
        button: -1,
        detail: 0,
        pointerType: "mouse",
      });
      expect(
        result.left
          .filter((event: { type: string }) =>
            ["pointerdown", "pointerup", "click"].includes(event.type),
          )
          .map(
            (event: {
              type: string;
              constructor: string;
              button: number;
              detail: number;
              pointerType: string | null;
            }) => [event.type, event.constructor, event.button, event.detail, event.pointerType],
          ),
      ).toEqual([
        ["pointerdown", "PointerEvent", 0, 0, "mouse"],
        ["pointerup", "PointerEvent", 0, 0, "mouse"],
        ["click", "PointerEvent", 0, 2, "mouse"],
      ]);
      expect(
        result.right.find((event: { type: string }) => event.type === "auxclick"),
      ).toMatchObject({
        constructor: "PointerEvent",
        button: 2,
        detail: 1,
        pointerType: "mouse",
      });
      expect(
        result.right.find((event: { type: string }) => event.type === "contextmenu"),
      ).toMatchObject({
        constructor: "PointerEvent",
        button: 2,
        detail: 0,
        pointerType: "mouse",
      });
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Input mouse synthesis follows disabled, ancestor, and exact double-click rules", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      const geometry = await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#mouse-edge-fixture")?.remove();
          const fixture = document.createElement("div");
          fixture.id = "mouse-edge-fixture";
          fixture.innerHTML =
            '<button id="common-button"><span id="press-child">left</span>' +
            '<span id="release-child">right</span></button>' +
            '<button id="disabled-button" disabled>disabled</button>';
          document.body.append(fixture);
          window.__mouseEdge = { common: 0, disabled: 0, double: 0 };
          document.querySelector("#common-button").onclick = () => window.__mouseEdge.common++;
          document.querySelector("#common-button").ondblclick = () => window.__mouseEdge.double++;
          document.querySelector("#disabled-button").onclick = () => window.__mouseEdge.disabled++;
          const center = selector => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
          };
          return {
            press: center("#press-child"),
            release: center("#release-child"),
            disabled: center("#disabled-button")
          };
        })()`,
        returnByValue: true,
      });
      const { press, release, disabled } = geometry.result.value;
      const dispatch = (type: string, point: { x: number; y: number }, clickCount: number) =>
        endpoint.send("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount,
        });

      await dispatch("mousePressed", press, 1);
      await dispatch("mouseReleased", release, 1);
      await dispatch("mousePressed", press, 3);
      await dispatch("mouseReleased", press, 3);
      await endpoint.send("Runtime.evaluate", {
        expression: "window.__mouseEdge.activeBeforeDisabled = document.activeElement?.id",
      });
      await dispatch("mousePressed", disabled, 1);
      await dispatch("mouseReleased", disabled, 1);

      const state = await endpoint.send("Runtime.evaluate", {
        expression: "({ ...window.__mouseEdge })",
        returnByValue: true,
      });
      return state.result.value;
    };

    for (const endpoint of [harness.native, harness.icdp]) {
      expect(await exercise(endpoint)).toEqual({
        common: 2,
        disabled: 0,
        double: 0,
        activeBeforeDisabled: "common-button",
      });
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Accessibility tree queries and enable-gated methods follow Chromium", async () => {
  const harness = await createParityHarness();
  try {
    const isParityButton = (node: any) =>
      node.role?.value === "button" && node.name?.value === "Parity action";
    const exercise = async (endpoint: CdpEndpoint) => {
      const full = await endpoint.send("Accessibility.getFullAXTree");
      expect(full.nodes.some(isParityButton)).toBe(true);

      const { root } = await endpoint.send("DOM.getDocument", { depth: 0 });
      const { nodeIds } = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#action",
      });
      const described = await endpoint.send("DOM.describeNode", { nodeId: nodeIds[0] });
      const backendNodeId = described.node.backendNodeId as number;

      const partial = await endpoint.send("Accessibility.getPartialAXTree", {
        backendNodeId,
        fetchRelatives: false,
      });
      expect(partial.nodes.some(isParityButton)).toBe(true);

      const queried = await endpoint.send("Accessibility.queryAXTree", {
        backendNodeId,
        accessibleName: "Parity action",
        role: "button",
      });
      expect(queried.nodes.some(isParityButton)).toBe(true);

      expect((await endpoint.request("Accessibility.getRootAXNode")).error).toMatchObject({
        code: -32000,
      });
      expect(await endpoint.send("Accessibility.enable")).toEqual({});

      const rootNode = await endpoint.send("Accessibility.getRootAXNode");
      expect(rootNode.node).toMatchObject({
        nodeId: expect.any(String),
        role: { type: expect.any(String), value: expect.any(String) },
      });
      const children = await endpoint.send("Accessibility.getChildAXNodes", {
        id: rootNode.node.nodeId,
      });
      expect(children.nodes).toEqual(expect.any(Array));

      const ancestors = await endpoint.send("Accessibility.getAXNodeAndAncestors", {
        backendNodeId,
      });
      expect(ancestors.nodes.some(isParityButton)).toBe(true);
      expect(ancestors.nodes.length).toBeGreaterThan(1);

      expect(
        (
          await endpoint.request("Accessibility.getChildAXNodes", {
            id: "not-an-ax-node",
          })
        ).error,
      ).toMatchObject({ code: -32602, message: "Invalid ID" });

      expect(await endpoint.send("Accessibility.disable")).toEqual({});
      expect(await endpoint.send("Accessibility.disable")).toEqual({});
      expect((await endpoint.request("Accessibility.getRootAXNode")).error).toMatchObject({
        code: -32000,
      });
    };

    await harness.native.send("Page.bringToFront");
    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("Network observes page fetches, returns bodies, and stops after disable", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint, source: string) => {
      expect(await endpoint.send("Network.enable")).toEqual({});
      const urlPart = `/data?source=${source}`;
      const requestEvent = endpoint.waitForEvent("Network.requestWillBeSent", (params) =>
        params.request?.url?.includes(urlPart),
      );
      const responseEvent = endpoint.waitForEvent("Network.responseReceived", (params) =>
        params.response?.url?.includes(urlPart),
      );
      const dataEvent = endpoint.waitForEvent("Network.dataReceived");
      const loadingEvent = endpoint.waitForEvent("Network.loadingFinished");
      const fetched = await endpoint.send("Runtime.evaluate", {
        expression: `fetch(${JSON.stringify(urlPart)}).then(response => response.text())`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(fetched.result).toMatchObject({ type: "string", value: "parity-response" });

      const [request, response, data, loading] = await Promise.all([
        requestEvent,
        responseEvent,
        dataEvent,
        loadingEvent,
      ]);
      expect(request).toMatchObject({
        requestId: expect.any(String),
        type: "Fetch",
        request: {
          method: "GET",
          url: expect.stringContaining(urlPart),
        },
      });
      expect(response).toMatchObject({
        requestId: request.requestId,
        type: "Fetch",
        response: {
          status: 200,
          url: expect.stringContaining(urlPart),
        },
      });
      expect(data).toMatchObject({
        requestId: request.requestId,
        dataLength: expect.any(Number),
        encodedDataLength: expect.any(Number),
      });
      expect(loading.requestId).toBe(request.requestId);

      const body = await endpoint.send("Network.getResponseBody", {
        requestId: request.requestId,
      });
      expect(body).toEqual({ body: "parity-response", base64Encoded: false });

      const loadingFailed = endpoint.waitForEvent("Network.loadingFailed");
      const failedFetch = await endpoint.send("Runtime.evaluate", {
        expression: `fetch(${JSON.stringify(`http://127.0.0.1:1/fail?source=${source}`)}).then(() => "unexpected").catch(() => "failed")`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(failedFetch.result.value).toBe("failed");
      expect(await loadingFailed).toMatchObject({
        requestId: expect.any(String),
        type: "Fetch",
        errorText: expect.any(String),
      });

      const webSocketUrl = `${harness.appOrigin.replace("http:", "ws:")}/echo?source=${source}`;
      const webSocketCreated = endpoint.waitForEvent(
        "Network.webSocketCreated",
        (params) => params.url === webSocketUrl,
      );
      const webSocketRequest = endpoint.waitForEvent("Network.webSocketWillSendHandshakeRequest");
      const webSocketResponse = endpoint.waitForEvent("Network.webSocketHandshakeResponseReceived");
      const webSocketSent = endpoint.waitForEvent(
        "Network.webSocketFrameSent",
        (params) => params.response?.payloadData === "ping",
      );
      const webSocketReceived = endpoint.waitForEvent(
        "Network.webSocketFrameReceived",
        (params) => params.response?.payloadData === "ping",
      );
      const webSocketClosed = endpoint.waitForEvent("Network.webSocketClosed");
      const echoed = await endpoint.send("Runtime.evaluate", {
        expression: `new Promise((resolve, reject) => {
          const socket = new WebSocket(${JSON.stringify(webSocketUrl)});
          socket.onerror = () => reject(new Error("WebSocket failed"));
          socket.onopen = () => socket.send("ping");
          socket.onmessage = event => {
            socket.close();
            resolve(event.data);
          };
        })`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(echoed.result.value).toBe("ping");
      const [created, handshakeRequest, handshakeResponse, sent, received, closed] =
        await Promise.all([
          webSocketCreated,
          webSocketRequest,
          webSocketResponse,
          webSocketSent,
          webSocketReceived,
          webSocketClosed,
        ]);
      for (const event of [handshakeRequest, handshakeResponse, sent, received, closed]) {
        expect(event.requestId).toBe(created.requestId);
      }
      expect(handshakeResponse.response.status).toBe(101);
      expect(sent.response).toMatchObject({ opcode: 1, payloadData: "ping" });
      expect(received.response).toMatchObject({ opcode: 1, payloadData: "ping" });

      expect(await endpoint.send("Network.disable")).toEqual({});
      const afterDisable = endpoint.waitForEvent(
        "Network.requestWillBeSent",
        (params) => params.request?.url?.includes(`/data?disabled=${source}`),
        300,
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `fetch(${JSON.stringify(`/data?disabled=${source}`)}).then(response => response.text())`,
        awaitPromise: true,
        returnByValue: true,
      });
      await expect(afterDisable).rejects.toThrow("timed out waiting for Network.requestWillBeSent");
    };

    await exercise(harness.native, "native");
    await exercise(harness.icdp, "icdp");
  } finally {
    await harness.close();
  }
}, 120_000);

test("Network instrumentation preserves fetch coercion and rejection semantics", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint, source: string) => {
      await endpoint.send("Network.enable");
      const marker = `coercion=1&source=${source}`;
      const requestEvent = endpoint.waitForEvent("Network.requestWillBeSent", (params) =>
        params.request?.url?.includes(marker),
      );
      const responseEvent = endpoint.waitForEvent("Network.responseReceived", (params) =>
        params.response?.url?.includes(marker),
      );
      const result = await endpoint.send("Runtime.evaluate", {
        expression: `(async () => {
          let coercions = 0;
          const input = {
            toString() {
              coercions++;
              return location.origin + "/data?coercion=" + coercions + "&source=${source}";
            }
          };
          const text = await fetch(input).then(response => response.text());
          let invalidSync = false;
          let invalidPromise = false;
          let invalidName = "";
          try {
            const request = fetch("http://[");
            invalidPromise = request instanceof Promise;
            try {
              await request;
            } catch (error) {
              invalidName = error.name;
            }
          } catch (error) {
            invalidSync = true;
            invalidName = error.name;
          }
          return { coercions, text, invalidName, invalidPromise, invalidSync };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(result.result.value).toEqual({
        coercions: 1,
        text: "parity-response",
        invalidName: "TypeError",
        invalidPromise: true,
        invalidSync: false,
      });
      const [request, response] = await Promise.all([requestEvent, responseEvent]);
      expect(request.request.url).toBe(response.response.url);
      expect(request.request.url).toContain(marker);

      const proxyMarker = `proxy-init=1&source=${source}`;
      const proxyRequest = endpoint.waitForEvent("Network.requestWillBeSent", (params) =>
        params.request?.url?.includes(proxyMarker),
      );
      const proxyResult = await endpoint.send("Runtime.evaluate", {
        expression: `(async () => {
          const counts = { getPrototypeOf: 0, ownKeys: 0 };
          const target = { method: "GET" };
          const init = new Proxy(target, {
            getPrototypeOf() {
              counts.getPrototypeOf++;
              target.method = "POST";
              return Object.prototype;
            },
            ownKeys() {
              counts.ownKeys++;
              return Reflect.ownKeys(target);
            }
          });
          await fetch(location.origin + "/data?${proxyMarker}", init);
          return counts;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(proxyResult.result.value).toEqual({ getPrototypeOf: 0, ownKeys: 0 });
      expect((await proxyRequest).request.method).toBe("GET");

      const metadataMarker = `metadata=1&source=${source}`;
      const metadataRequest = endpoint.waitForEvent("Network.requestWillBeSent", (params) =>
        params.request?.url?.includes(metadataMarker),
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `fetch(location.origin + "/data?${metadataMarker}", {
          method: "mIxEd-CaSe",
          body: "hello",
          headers: [
            ["X-Probe", "  yes \\t"],
            ["X-Duplicate", "a"],
            ["x-duplicate", "b"]
          ]
        }).then(response => response.text())`,
        awaitPromise: true,
      });
      const metadata = (await metadataRequest).request;
      const metadataHeaders = Object.fromEntries(
        Object.entries(metadata.headers).map(([name, value]) => [name.toLowerCase(), value]),
      );
      expect({ ...metadata, headers: metadataHeaders }).toMatchObject({
        method: "mIxEd-CaSe",
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          "x-duplicate": "a, b",
          "x-probe": "yes",
        },
        hasPostData: true,
        postData: "hello",
      });

      await endpoint.send("Network.disable");
      await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          const pageFetch = window.fetch;
          window.__fetchArgumentProbe = undefined;
          window.fetch = function (...args) {
            window.__fetchArgumentProbe = {
              argCount: args.length,
              inputClass: args[0]?.constructor?.name,
              sameInit: args[1] === window.__fetchExpected.init,
              sameInput: args[0] === window.__fetchExpected.input
            };
            return Reflect.apply(pageFetch, this, args);
          };
        })()`,
      });
      await endpoint.send("Network.enable");
      const wrapperResult = await endpoint.send("Runtime.evaluate", {
        expression: `(async () => {
          const input = location.origin + "/data?wrapper=1&source=${source}";
          const init = { headers: { "x-wrapper": "yes" } };
          window.__fetchExpected = { input, init };
          const text = await fetch(input, init).then(response => response.text());
          return { ...window.__fetchArgumentProbe, text };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(wrapperResult.result.value).toEqual({
        argCount: 2,
        inputClass: "String",
        sameInit: true,
        sameInput: true,
        text: "parity-response",
      });
    };

    await exercise(harness.native, "native");
    await exercise(harness.icdp, "icdp");
  } finally {
    await harness.close();
  }
}, 120_000);

test("Network returns byte-exact XHR bodies or an explicit unavailable-body error", async () => {
  const harness = await createParityHarness();
  try {
    const runXhr = async (
      endpoint: CdpEndpoint,
      path: "/data" | "/xhr-binary" | "/xhr-json" | "/xhr-quoted",
      responseType: "" | "arraybuffer" | "json",
    ): Promise<string> => {
      await endpoint.send("Network.enable");
      const url = `${harness.appOrigin}${path}`;
      const requestEvent = endpoint.waitForEvent(
        "Network.requestWillBeSent",
        (params) => params.request?.url === url,
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", ${JSON.stringify(url)});
          xhr.responseType = ${JSON.stringify(responseType)};
          xhr.onload = () => resolve(true);
          xhr.onerror = () => reject(new Error("XHR failed"));
          xhr.send();
        })`,
        awaitPromise: true,
      });
      const requestId = String((await requestEvent).requestId);
      await waitUntil(
        async () =>
          endpoint.events.some(
            (event) =>
              event.method === "Network.loadingFinished" && event.params?.requestId === requestId,
          )
            ? true
            : undefined,
        `XHR completion for ${path}`,
      );
      return requestId;
    };

    const nativeBinary = await runXhr(harness.native, "/xhr-binary", "");
    expect(
      await harness.native.send("Network.getResponseBody", { requestId: nativeBinary }),
    ).toEqual({
      body: "AP8B",
      base64Encoded: true,
    });
    const icdpBinary = await runXhr(harness.icdp, "/xhr-binary", "");
    expect(
      (await harness.icdp.request("Network.getResponseBody", { requestId: icdpBinary })).error,
    ).toEqual({
      code: -32000,
      message: "No resource with given identifier found",
    });

    const nativeJson = await runXhr(harness.native, "/xhr-json", "json");
    expect(await harness.native.send("Network.getResponseBody", { requestId: nativeJson })).toEqual(
      {
        body: XHR_JSON_BODY,
        base64Encoded: false,
      },
    );
    const icdpJson = await runXhr(harness.icdp, "/xhr-json", "json");
    expect(
      (await harness.icdp.request("Network.getResponseBody", { requestId: icdpJson })).error,
    ).toEqual({
      code: -32000,
      message: "No resource with given identifier found",
    });

    for (const endpoint of [harness.native, harness.icdp]) {
      const textRequestId = await runXhr(endpoint, "/data", "arraybuffer");
      expect(await endpoint.send("Network.getResponseBody", { requestId: textRequestId })).toEqual({
        body: "parity-response",
        base64Encoded: false,
      });

      const requestId = await runXhr(endpoint, "/xhr-binary", "arraybuffer");
      expect(await endpoint.send("Network.getResponseBody", { requestId })).toEqual({
        body: "AP8B",
        base64Encoded: true,
      });

      const quotedRequestId = await runXhr(endpoint, "/xhr-quoted", "arraybuffer");
      expect(
        await endpoint.send("Network.getResponseBody", { requestId: quotedRequestId }),
      ).toEqual({
        body: "quoted-charset",
        base64Encoded: false,
      });

      const postUrl = `${harness.appOrigin}/data?xhr-post=${endpoint === harness.native ? "native" : "icdp"}`;
      const postRequest = endpoint.waitForEvent(
        "Network.requestWillBeSent",
        (params) => params.request?.url === postUrl,
      );
      await endpoint.send("Runtime.evaluate", {
        expression: `new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", ${JSON.stringify(postUrl)});
          xhr.onload = () => resolve(true);
          xhr.onerror = () => reject(new Error("XHR failed"));
          xhr.send(new URLSearchParams({ a: "1" }));
        })`,
        awaitPromise: true,
      });
      const post = (await postRequest).request;
      const postHeaders = Object.fromEntries(
        Object.entries(post.headers).map(([name, value]) => [name.toLowerCase(), value]),
      );
      expect({ ...post, headers: postHeaders }).toMatchObject({
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        hasPostData: true,
        postData: "a=1",
      });
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Storage reports real usage and quota for the current frame origin", async () => {
  const harness = await createParityHarness();
  try {
    const [native, icdp] = await Promise.all([
      harness.native.send("Storage.getUsageAndQuota", { origin: harness.appOrigin }),
      harness.icdp.send("Storage.getUsageAndQuota", { origin: harness.appOrigin }),
    ]);
    for (const result of [native, icdp]) {
      expect(result).toMatchObject({
        usage: expect.any(Number),
        quota: expect.any(Number),
        overrideActive: expect.any(Boolean),
        usageBreakdown: expect.any(Array),
      });
      expect(result.usage).toBeGreaterThanOrEqual(0);
      expect(result.quota).toBeGreaterThan(0);
    }
  } finally {
    await harness.close();
  }
}, 120_000);

test("Page enable does not replay completed lifecycle events and reports its frame", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      const domContent = endpoint.waitForEvent("Page.domContentEventFired", undefined, 300);
      const load = endpoint.waitForEvent("Page.loadEventFired", undefined, 300);
      expect(await endpoint.send("Page.enable")).toEqual({});
      await expect(domContent).rejects.toThrow("timed out waiting for Page.domContentEventFired");
      await expect(load).rejects.toThrow("timed out waiting for Page.loadEventFired");

      const tree = await endpoint.send("Page.getFrameTree");
      expect(tree.frameTree.frame).toMatchObject({
        id: expect.any(String),
        loaderId: expect.any(String),
        url: expect.stringContaining(harness.appOrigin),
        securityOrigin: harness.appOrigin,
        securityOriginDetails: { isLocalhost: true },
        mimeType: "text/html",
        secureContextType: "SecureLocalhost",
        crossOriginIsolatedContextType: "NotIsolated",
      });

      const initialUrl = new URL(tree.frameTree.frame.url);
      initialUrl.hash = "";
      await endpoint.send("Runtime.evaluate", {
        expression: "history.pushState(null, '', '#page-frame-fragment')",
      });
      const fragmentTree = await endpoint.send("Page.getFrameTree");
      expect(fragmentTree.frameTree.frame).toMatchObject({
        url: initialUrl.href,
        urlFragment: "#page-frame-fragment",
      });
      await endpoint.send("Runtime.evaluate", {
        expression: "history.pushState(null, '', '#')",
      });
      const emptyFragmentTree = await endpoint.send("Page.getFrameTree");
      expect(emptyFragmentTree.frameTree.frame).toMatchObject({
        url: initialUrl.href,
        urlFragment: "#",
      });
      expect(await endpoint.send("Page.disable")).toEqual({});
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("Page instrumentation preserves History URL coercion and native errors", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint, source: string) => {
      await endpoint.send("Page.enable");
      const marker = `history-coercion-1?source=${source}`;
      const navigation = endpoint.waitForEvent("Page.navigatedWithinDocument", (params) =>
        params.url?.includes(marker),
      );
      const result = await endpoint.send("Runtime.evaluate", {
        expression: `(() => {
          let coercions = 0;
          const url = {
            toString() {
              coercions++;
              return "/history-coercion-" + coercions + "?source=${source}";
            }
          };
          history.pushState({}, "", url);
          let invalidName = "";
          try {
            history.pushState({}, "", "http://[");
          } catch (error) {
            invalidName = error.name;
          }
          return { coercions, href: location.href, invalidName };
        })()`,
        returnByValue: true,
      });
      expect(result.result.value).toEqual({
        coercions: 1,
        href: `${harness.appOrigin}/${marker}`,
        invalidName: "SecurityError",
      });
      expect(await navigation).toMatchObject({
        navigationType: "historyApi",
        url: `${harness.appOrigin}/${marker}`,
      });
      expect(
        endpoint.events.filter(
          (event) =>
            event.method === "Page.navigatedWithinDocument" && event.params?.url?.includes(marker),
        ),
      ).toHaveLength(1);
    };

    await exercise(harness.native, "native");
    await exercise(harness.icdp, "icdp");
  } finally {
    await harness.close();
  }
}, 120_000);

test("Page navigate restores Runtime and reports real lifecycle ordering", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint, path: string) => {
      const initialContext = endpoint.waitForEvent("Runtime.executionContextCreated");
      await Promise.all([endpoint.send("Runtime.enable"), initialContext]);
      await endpoint.send("DOM.enable");
      await endpoint.send("Page.enable");
      const staleObject = await endpoint.send("Runtime.evaluate", {
        expression: "({ fromPreviousDocument: true })",
      });

      const order: string[] = [];
      const frameNavigated = endpoint
        .waitForEvent("Page.frameNavigated", (params) => params.frame?.url?.includes(path), 30_000)
        .then((event) => {
          order.push("Page.frameNavigated");
          return event;
        });
      const contextsCleared = endpoint.waitForEvent(
        "Runtime.executionContextsCleared",
        undefined,
        30_000,
      );
      const documentUpdated = endpoint.waitForEvent("DOM.documentUpdated", undefined, 30_000);
      const contextCreated = endpoint
        .waitForEvent(
          "Runtime.executionContextCreated",
          (params) => params.context?.origin === harness.appOrigin,
          30_000,
        )
        .then((event) => {
          order.push("Runtime.executionContextCreated");
          return event;
        });
      const domContent = endpoint
        .waitForEvent("Page.domContentEventFired", undefined, 30_000)
        .then((event) => {
          order.push("Page.domContentEventFired");
          return event;
        });
      const load = endpoint.waitForEvent("Page.loadEventFired", undefined, 30_000).then((event) => {
        order.push("Page.loadEventFired");
        return event;
      });

      const navigation = await endpoint.send("Page.navigate", {
        url: `${harness.appOrigin}${path}`,
      });
      const [frameEvent] = await Promise.all([
        frameNavigated,
        contextsCleared,
        documentUpdated,
        contextCreated,
        domContent,
        load,
      ]);
      expect(frameEvent).toMatchObject({
        frame: {
          id: expect.any(String),
          url: expect.stringContaining(path),
          securityOrigin: harness.appOrigin,
        },
        type: "Navigation",
      });
      expect(order).toEqual([
        "Page.frameNavigated",
        "Runtime.executionContextCreated",
        "Page.domContentEventFired",
        "Page.loadEventFired",
      ]);
      const location = await endpoint.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      expect(location.result.value).toContain(path);
      expect(
        (
          await endpoint.request("Runtime.getProperties", {
            objectId: staleObject.result.objectId,
          })
        ).error,
      ).toEqual({
        code: -32000,
        message: "Cannot find context with specified id",
      });
      return navigation;
    };

    const native = await exercise(harness.native, "/native-navigation?parity=1");
    const icdp = await exercise(harness.icdp, "/icdp-navigation?parity=1");
    expect(native).toMatchObject({
      frameId: expect.any(String),
      loaderId: expect.any(String),
    });
    expect(icdp).toEqual({
      frameId: "icdp-frame",
      loaderId: expect.any(String),
    });
  } finally {
    await harness.close();
  }
}, 120_000);

test("Page reload validates the current loader and restores lifecycle events", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      const initialContext = endpoint.waitForEvent("Runtime.executionContextCreated");
      await Promise.all([endpoint.send("Runtime.enable"), initialContext]);
      await endpoint.send("Page.enable");
      const before = await endpoint.send("Page.getFrameTree");

      const frameNavigated = endpoint.waitForEvent(
        "Page.frameNavigated",
        (params) => params.frame?.url?.startsWith(harness.appOrigin),
        30_000,
      );
      const contextsCleared = endpoint.waitForEvent(
        "Runtime.executionContextsCleared",
        undefined,
        30_000,
      );
      const contextCreated = endpoint.waitForEvent(
        "Runtime.executionContextCreated",
        (params) => params.context?.origin === harness.appOrigin,
        30_000,
      );
      const domContent = endpoint.waitForEvent("Page.domContentEventFired", undefined, 30_000);
      const load = endpoint.waitForEvent("Page.loadEventFired", undefined, 30_000);

      expect(
        await endpoint.send("Page.reload", {
          loaderId: before.frameTree.frame.loaderId,
        }),
      ).toEqual({});
      const [frameEvent] = await Promise.all([
        frameNavigated,
        contextsCleared,
        contextCreated,
        domContent,
        load,
      ]);
      expect(frameEvent).toMatchObject({
        frame: {
          id: expect.any(String),
          loaderId: expect.any(String),
          url: expect.stringContaining(harness.appOrigin),
        },
        type: "Navigation",
      });
      const after = await endpoint.send("Page.getFrameTree");
      expect(after.frameTree.frame.loaderId).not.toBe(before.frameTree.frame.loaderId);
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
  } finally {
    await harness.close();
  }
}, 120_000);

test("raw protocol errors match Chromium and Emulation stays an explicit boundary", async () => {
  const harness = await createParityHarness();
  try {
    for (const endpoint of [harness.native, harness.icdp]) {
      expect((await endpoint.request("NotARealDomain.missing")).error).toEqual({
        code: -32601,
        message: "'NotARealDomain.missing' wasn't found",
      });
      expect(
        (
          await endpoint.request("Runtime.evaluate", {
            expression: 42,
          })
        ).error,
      ).toEqual({
        code: -32602,
        message: "Invalid parameters",
        data: "Failed to deserialize params.expression - BINDINGS: string value expected at position 19",
      });
      expect((await endpoint.request("Runtime.evaluate", {})).error).toEqual({
        code: -32602,
        message: "Invalid parameters",
        data: "Failed to deserialize params.expression - BINDINGS: mandatory field missing at position 8",
      });
    }

    for (const [method, params] of [
      ["Runtime.evaluate", { serializationOptions: {} }],
      ["Runtime.evaluate", { serializationOptions: { serialization: 42 } }],
      ["Runtime.evaluate", { serializationOptions: { serialization: "json" }, expression: 42 }],
      ["Runtime.evaluate", { expression: 42, serializationOptions: {} }],
      ["Runtime.evaluate", { x: 2_147_483_647, expression: 42 }],
      ["Runtime.evaluate", { x: 2_147_483_648, expression: 42 }],
      [
        "Runtime.callFunctionOn",
        { objectId: "bad", functionDeclaration: "() => 1", arguments: [42] },
      ],
      [
        "Runtime.callFunctionOn",
        { objectId: "bad", functionDeclaration: "() => 1", arguments: [{ objectId: 1 }] },
      ],
      [
        "Runtime.callFunctionOn",
        {
          objectId: "bad",
          functionDeclaration: "() => 1",
          arguments: [{ unserializableValue: 1 }],
        },
      ],
      ["Runtime.callFunctionOn", { arguments: [], functionDeclaration: 42, executionContextId: 1 }],
      [
        "Runtime.callFunctionOn",
        { functionDeclaration: 42, arguments: [42], executionContextId: 1 },
      ],
      ["Target.setRemoteLocations", { locations: [{ host: 1, port: "9222" }] }],
      ["Target.getTargets", { filter: [{ type: 1 }] }],
    ] as const) {
      expect((await harness.icdp.request(method, params)).error).toEqual(
        (await harness.native.request(method, params)).error,
      );
    }

    expect(
      await harness.native.send("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 600,
        deviceScaleFactor: 2,
        mobile: false,
      }),
    ).toEqual({});
    const viewport = await harness.native.send("Runtime.evaluate", {
      expression: "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })",
      returnByValue: true,
    });
    expect(viewport.result.value).toEqual({ width: 800, height: 600, dpr: 2 });
    expect(await harness.native.send("Emulation.clearDeviceMetricsOverride")).toEqual({});

    expect(
      (
        await harness.icdp.request("Emulation.setDeviceMetricsOverride", {
          width: 800,
          height: 600,
          deviceScaleFactor: 2,
          mobile: false,
        })
      ).error,
    ).toEqual({
      code: -32601,
      message: "'Emulation.setDeviceMetricsOverride' wasn't found",
    });
  } finally {
    await harness.close();
  }
}, 120_000);

test("DOM.resolveNode without a target returns Chromium's server error", async () => {
  const harness = await createParityHarness();
  try {
    const expected = {
      code: -32000,
      message: "Either nodeId or backendNodeId must be specified.",
    };
    expect((await harness.native.request("DOM.resolveNode")).error).toMatchObject(expected);
    expect((await harness.icdp.request("DOM.resolveNode")).error).toMatchObject(expected);
  } finally {
    await harness.close();
  }
}, 120_000);

test("Page.reload rejects a stale loader with Chromium's invalid-params error", async () => {
  const harness = await createParityHarness();
  try {
    const expected = {
      code: -32602,
      message: "Reload was discarded because the page already navigated",
    };
    expect(
      (
        await harness.native.request("Page.reload", {
          loaderId: "stale-loader",
        })
      ).error,
    ).toMatchObject(expected);
    expect(
      (
        await harness.icdp.request("Page.reload", {
          loaderId: "stale-loader",
        })
      ).error,
    ).toMatchObject(expected);
  } finally {
    await harness.close();
  }
}, 120_000);

test("Runtime.callFunctionOn without a target reports Chromium's specific parameter error", async () => {
  const harness = await createParityHarness();
  try {
    const params = { functionDeclaration: "function () { return 1; }" };
    const nativeError = (await harness.native.request("Runtime.callFunctionOn", params)).error;
    expect(nativeError).toMatchObject({
      code: -32602,
      message: "Either objectId or executionContextId or uniqueContextId must be specified",
    });
    expect((await harness.icdp.request("Runtime.callFunctionOn", params)).error).toMatchObject(
      nativeError!,
    );
  } finally {
    await harness.close();
  }
}, 120_000);
