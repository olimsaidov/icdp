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
  close(): Promise<void>;
  icdp: CdpEndpoint;
  native: CdpEndpoint;
};

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
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    if (!message.method) return;
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
    request: (method, params = {}) =>
      new Promise<CdpMessage>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for ${method}`));
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

test("DOM emits Chromium mutation events only for the session frontend tree", async () => {
  const harness = await createParityHarness();
  try {
    const exercise = async (endpoint: CdpEndpoint) => {
      await endpoint.send("DOM.enable");
      const { root } = await endpoint.send("DOM.getDocument", { depth: 0 });

      const childPush = endpoint.waitForEvent("DOM.setChildNodes");
      const rootQuery = await endpoint.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "#mutation-root",
      });
      expect((await childPush).nodes).toEqual(expect.any(Array));
      const mutationRootId = rootQuery.nodeIds[0] as number;

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

test("Input commands match Chromium effects while retaining synthetic trust semantics", async () => {
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
    expect(icdp.inserted.events[0].trusted).toBe(false);
    expect(icdp.keyed.keys.every((event: { trusted: boolean }) => !event.trusted)).toBe(true);
    expect(icdp.clicked.events.every((event: { trusted: boolean }) => !event.trusted)).toBe(true);
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
        mimeType: "text/html",
      });
      expect(await endpoint.send("Page.disable")).toEqual({});
    };

    await exercise(harness.native);
    await exercise(harness.icdp);
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
      return navigation;
    };

    const native = await exercise(harness.native, "/native-navigation?parity=1");
    const icdp = await exercise(harness.icdp, "/icdp-navigation?parity=1");
    expect(native).toMatchObject({
      frameId: expect.any(String),
      loaderId: expect.any(String),
    });
    expect(icdp).toEqual({ frameId: "icdp-frame" });
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
      ).toMatchObject({
        code: -32602,
        message: "Invalid parameters",
      });
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
