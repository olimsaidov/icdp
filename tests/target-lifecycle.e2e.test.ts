import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rolldown } from "rolldown";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { CdpMessage } from "../src/protocol.ts";
import { serveRelay } from "../src/relay/node.ts";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((path): path is string => Boolean(path));

type Chrome = {
  client: CdpClient;
  close(): Promise<void>;
  open(url: string): Promise<string>;
};

type Harness = {
  browserOrigin: string;
  browserWsUrl: string;
  close(): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  hostOrigin: string;
  reload(): Promise<void>;
};

const activeClients = new Set<CdpClient>();
const activeHarnesses = new Set<Harness>();

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      reject(error: Error): void;
      resolve(message: CdpMessage): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly opened: Promise<void>;
  readonly closed: Promise<CloseEvent>;
  readonly messages: CdpMessage[] = [];

  private constructor(private readonly socket: WebSocket) {
    this.opened = new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open")), {
        once: true,
      });
    });
    this.closed = new Promise((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      this.messages.push(message);
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP WebSocket closed before the response"));
      }
      this.pending.clear();
    });
  }

  static async open(url: string, tracked = true): Promise<CdpClient> {
    const client = new CdpClient(new WebSocket(url));
    try {
      await bounded(client.opened, `opening ${url}`);
    } catch (error) {
      client.close();
      throw error;
    }
    if (tracked) {
      activeClients.add(client);
      void client.closed.then(() => activeClients.delete(client));
    }
    return client;
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<CdpMessage> {
    await this.opened;
    const id = this.nextId++;
    const response = new Promise<CdpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 10_000);
      this.pending.set(id, { reject, resolve, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return await response;
  }

  async post(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<number> {
    await this.opened;
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return id;
  }

  async event(
    method: string,
    predicate: (message: CdpMessage) => boolean = () => true,
    from = 0,
  ): Promise<CdpMessage> {
    await until(
      () =>
        this.messages
          .slice(from)
          .some((message) => message.method === method && predicate(message)),
      method,
    );
    return this.messages
      .slice(from)
      .find((message) => message.method === method && predicate(message))!;
  }

  async exchange(raw: string, predicate: (message: CdpMessage) => boolean): Promise<CdpMessage> {
    await this.opened;
    const from = this.messages.length;
    this.socket.send(raw);
    await until(() => this.messages.slice(from).some(predicate), "raw CDP response");
    return this.messages.slice(from).find(predicate)!;
  }

  close(): void {
    activeClients.delete(this);
    try {
      this.socket.close();
    } catch {}
  }

  waitClosed(): Promise<CloseEvent> {
    return bounded(this.closed, "CDP WebSocket close");
  }
}

let chrome: Chrome;
let frameScript = "";
let shellScript = "";

async function until(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function bounded<T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function bundleBrowser(input: string): Promise<string> {
  const build = await rolldown({ input, platform: "browser", logLevel: "silent" });
  try {
    const { output } = await build.generate({ format: "esm" });
    const entry = output.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
    if (!entry || entry.type !== "chunk") throw new Error(`no entry chunk for ${input}`);
    return entry.code;
  } finally {
    await build.close();
  }
}

async function chromeExecutable(): Promise<string> {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`Chrome not found; checked: ${CHROME_CANDIDATES.join(", ")}`);
}

async function startChrome(): Promise<Chrome> {
  const executable = await chromeExecutable();
  const profile = await mkdtemp(join(tmpdir(), "icdp-target-lifecycle-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const activePortPath = join(profile, "DevToolsActivePort");
  try {
    await until(async () => {
      try {
        await access(activePortPath);
        return true;
      } catch {
        if (child.exitCode !== null) {
          throw new Error(`Chrome exited with ${child.exitCode}\n${stderr}`);
        }
        return false;
      }
    }, "Chrome DevToolsActivePort");
    const [port, browserPath] = (await readFile(activePortPath, "utf8")).trim().split("\n");
    if (!port || !browserPath) throw new Error("invalid Chrome DevToolsActivePort");
    const client = await CdpClient.open(`ws://127.0.0.1:${port}${browserPath}`, false);
    return {
      client,
      async open(url) {
        const response = await client.send("Target.createTarget", { url });
        const targetId = (response.result as { targetId?: string } | undefined)?.targetId;
        if (!targetId) throw new Error(`Chrome failed to open ${url}: ${JSON.stringify(response)}`);
        return targetId;
      },
      async close() {
        await client.send("Browser.close").catch(() => undefined);
        await waitForExit(child);
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    killProcessGroup(child);
    await waitForExit(child);
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function killProcessGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (await waitForChildExit(child, 5_000)) return;
  killProcessGroup(child);
  await waitForChildExit(child, 2_000);
}

function send(response: ServerResponse, type: string, body: string): void {
  response.writeHead(200, { "Content-Type": type });
  response.end(body);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function shellHtml(appOrigin: string, relayWsUrl: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>icdp lifecycle host</title></head>
  <body>
    <script>
      window.__ICDP_APP_ORIGIN = ${JSON.stringify(appOrigin)};
      window.__ICDP_RELAY_WS = ${JSON.stringify(relayWsUrl)};
    </script>
    <script type="module" src="/shell.js"></script>
  </body>
</html>`;
}

function frameHtml(shellOrigin: string, path: string): string {
  const title = path.endsWith("/page-1") ? "Initial Target" : "Created Target";
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1 id="heading">${title}</h1>
    <script>window.__ICDP_ALLOWED_PARENT = ${JSON.stringify(shellOrigin)};</script>
    <script type="module" src="/frame.js"></script>
  </body>
</html>`;
}

async function createHarness(): Promise<Harness> {
  let appOrigin = "";
  const relay = await serveRelay({
    product: "icdp-lifecycle-e2e",
    fallback(request, response) {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/shell.js")
        return send(response, "text/javascript; charset=utf-8", shellScript);
      if (path === "/shell")
        return send(response, "text/html; charset=utf-8", shellHtml(appOrigin, relay.hostWsUrl));
      response.writeHead(404).end("not found");
    },
  });
  const hostOrigin = `http://127.0.0.1:${relay.hostPort}`;
  const appServer = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/frame.js") return send(response, "text/javascript; charset=utf-8", frameScript);
    return send(response, "text/html; charset=utf-8", frameHtml(hostOrigin, path));
  });
  appOrigin = `http://127.0.0.1:${await listen(appServer)}`;
  let shellTargetId: string | undefined;
  let shellSessionId: string | undefined;
  try {
    shellTargetId = await chrome.open(`${hostOrigin}/shell`);
    const attached = await chrome.client.send("Target.attachToTarget", {
      targetId: shellTargetId,
      flatten: true,
    });
    shellSessionId = (attached.result as { sessionId: string }).sessionId;
    await until(async () => {
      const status = (await (
        await fetch(`http://127.0.0.1:${relay.browserPort}/icdp/status`)
      ).json()) as { hostConnected: boolean; targets: Array<{ url: string }> };
      return status.hostConnected && status.targets.length === 1 && status.targets[0]?.url !== "";
    }, "real Chromium Host and Frame handshake");
    const harness: Harness = {
      browserOrigin: `http://127.0.0.1:${relay.browserPort}`,
      browserWsUrl: relay.browserWsUrl,
      hostOrigin,
      async evaluate(expression) {
        const response = await chrome.client.send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          shellSessionId,
        );
        const result = response.result as
          | {
              exceptionDetails?: { text?: string };
              result?: { description?: string; value?: unknown };
            }
          | undefined;
        if (response.error || result?.exceptionDetails) {
          throw new Error(
            response.error?.message ??
              result?.result?.description ??
              result?.exceptionDetails?.text ??
              "Chrome evaluation failed",
          );
        }
        return result?.result?.value;
      },
      async reload() {
        await chrome.client.send("Page.reload", {}, shellSessionId);
      },
      async close() {
        activeHarnesses.delete(harness);
        try {
          if (shellTargetId) {
            await chrome.client.send("Target.closeTarget", { targetId: shellTargetId });
            shellTargetId = undefined;
          }
        } finally {
          await Promise.allSettled([stop(appServer), relay.stop()]);
        }
      },
    };
    activeHarnesses.add(harness);
    return harness;
  } catch (error) {
    if (shellTargetId) {
      await chrome.client
        .send("Target.closeTarget", { targetId: shellTargetId })
        .catch(() => undefined);
    }
    await Promise.allSettled([stop(appServer), relay.stop()]);
    throw error;
  }
}

beforeAll(async () => {
  [frameScript, shellScript] = await Promise.all([
    bundleBrowser("tests/fixtures/target-lifecycle-frame-entry.ts"),
    bundleBrowser("tests/fixtures/target-lifecycle-shell-entry.ts"),
  ]);
  chrome = await startChrome();
});

afterAll(async () => {
  await chrome?.close();
});

afterEach(async () => {
  for (const client of Array.from(activeClients)) client.close();
  await Promise.allSettled(Array.from(activeHarnesses, (harness) => harness.close()));
});

describe("real Chromium Target lifecycle", { timeout: 120_000 }, () => {
  test("discovers browser and page Targets through Chromium-shaped HTTP and WebSockets", async () => {
    const harness = await createHarness();
    const client = await CdpClient.open(harness.browserWsUrl);
    try {
      const [versionResponse, jsonResponse, listResponse, statusResponse, hostResponse] =
        await Promise.all([
          fetch(`${harness.browserOrigin}/json/version`),
          fetch(`${harness.browserOrigin}/json`),
          fetch(`${harness.browserOrigin}/json/list`),
          fetch(`${harness.browserOrigin}/icdp/status`),
          fetch(`${harness.hostOrigin}/json/version`),
        ]);
      expect([
        versionResponse.status,
        jsonResponse.status,
        listResponse.status,
        statusResponse.status,
        hostResponse.status,
      ]).toEqual([200, 200, 200, 200, 404]);
      expect(versionResponse.headers.get("content-type")?.toLowerCase()).toBe(
        "application/json; charset=utf-8",
      );

      const version = (await versionResponse.json()) as Record<string, unknown>;
      const json = (await jsonResponse.json()) as Array<Record<string, unknown>>;
      const list = (await listResponse.json()) as Array<Record<string, unknown>>;
      const status = (await statusResponse.json()) as Record<string, unknown>;
      expect(version).toMatchObject({
        Browser: "icdp-lifecycle-e2e",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: harness.browserWsUrl,
      });
      expect(json).toEqual(list);
      expect(list).toEqual([
        expect.objectContaining({
          id: "page-1",
          title: "Initial Target",
          type: "page",
          url: expect.stringContaining("/target/page-1"),
          webSocketDebuggerUrl: expect.stringContaining("/devtools/page/page-1"),
        }),
      ]);
      expect(status).toMatchObject({ hostConnected: true, clients: 1 });

      const browserVersion = await client.send("Browser.getVersion");
      expect(browserVersion.result).toMatchObject({
        product: "icdp-lifecycle-e2e",
        protocolVersion: "1.3",
      });
      const pages = await client.send("Target.getTargets");
      expect(pages.result).toEqual({
        targetInfos: [
          expect.objectContaining({ targetId: "page-1", type: "page", attached: false }),
        ],
      });
      const browsers = await client.send("Target.getTargets", { filter: [{ type: "browser" }] });
      expect(browsers.result).toEqual({ targetInfos: [] });

      const direct = await CdpClient.open(String(list[0]?.webSocketDebuggerUrl));
      try {
        const title = await direct.send("Runtime.evaluate", {
          expression: "document.title",
          returnByValue: true,
        });
        expect(title).toEqual({
          id: 1,
          result: { result: { type: "string", value: "Initial Target" } },
        });
      } finally {
        direct.close();
      }
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("gives each browser connection its own browser Target identity", async () => {
    const harness = await createHarness();
    const first = await CdpClient.open(harness.browserWsUrl);
    const second = await CdpClient.open(harness.browserWsUrl);
    try {
      const firstInfo = await first.send("Target.getTargetInfo");
      const secondInfo = await second.send("Target.getTargetInfo");
      expect(firstInfo.result).toMatchObject({
        targetInfo: {
          type: "browser",
          title: "",
          url: "",
          attached: true,
          canAccessOpener: false,
        },
      });
      expect(secondInfo.result).toMatchObject({
        targetInfo: {
          type: "browser",
          title: "",
          url: "",
          attached: true,
          canAccessOpener: false,
        },
      });
      expect(
        (firstInfo.result as { targetInfo: { targetId: string } }).targetInfo.targetId,
      ).not.toBe((secondInfo.result as { targetInfo: { targetId: string } }).targetInfo.targetId);
    } finally {
      second.close();
      first.close();
      await harness.close();
    }
  });

  test("reports other browser connections through the discovery lifecycle", async () => {
    const harness = await createHarness();
    const observer = await CdpClient.open(harness.browserWsUrl);
    let other: CdpClient | undefined;
    try {
      const observerInfo = await observer.send("Target.getTargetInfo");
      const observerTargetId = (observerInfo.result as { targetInfo: { targetId: string } })
        .targetInfo.targetId;
      const discoverFrom = observer.messages.length;
      const discovered = await observer.send("Target.setDiscoverTargets", {
        discover: true,
        filter: [{ type: "browser" }],
      });
      const observerCreated = await observer.event(
        "Target.targetCreated",
        (message) => {
          const info = (
            message.params as
              | { targetInfo?: { attached?: boolean; targetId?: string; type?: string } }
              | undefined
          )?.targetInfo;
          return (
            info?.targetId === observerTargetId && info.type === "browser" && info.attached === true
          );
        },
        discoverFrom,
      );
      expect(observer.messages.indexOf(observerCreated)).toBeLessThan(
        observer.messages.indexOf(discovered),
      );

      const createFrom = observer.messages.length;
      other = await CdpClient.open(harness.browserWsUrl);
      const created = await observer.event(
        "Target.targetCreated",
        (message) => {
          const info = (
            message.params as
              | { targetInfo?: { attached?: boolean; targetId?: string; type?: string } }
              | undefined
          )?.targetInfo;
          return (
            info?.targetId !== observerTargetId &&
            info?.type === "browser" &&
            info.attached === false
          );
        },
        createFrom,
      );
      const otherTargetId = (created.params as { targetInfo: { targetId: string } }).targetInfo
        .targetId;
      const attached = await observer.event(
        "Target.targetInfoChanged",
        (message) => {
          const info = (
            message.params as
              | { targetInfo?: { attached?: boolean; targetId?: string; type?: string } }
              | undefined
          )?.targetInfo;
          return (
            info?.targetId === otherTargetId && info.type === "browser" && info.attached === true
          );
        },
        createFrom,
      );
      expect(observer.messages.indexOf(created)).toBeLessThan(observer.messages.indexOf(attached));
      expect(await other.send("Target.getTargetInfo")).toMatchObject({
        result: { targetInfo: { targetId: otherTargetId, attached: true } },
      });
      expect(
        await observer.send("Target.getTargetInfo", { targetId: otherTargetId }),
      ).toMatchObject({
        result: { targetInfo: { targetId: otherTargetId, attached: true } },
      });
      expect(
        await observer.send("Target.getTargets", { filter: [{ type: "browser" }] }),
      ).toMatchObject({ result: { targetInfos: [] } });

      const destroyFrom = observer.messages.length;
      other.close();
      other = undefined;
      const detached = await observer.event(
        "Target.targetInfoChanged",
        (message) => {
          const info = (
            message.params as { targetInfo?: { attached?: boolean; targetId?: string } } | undefined
          )?.targetInfo;
          return info?.targetId === otherTargetId && info.attached === false;
        },
        destroyFrom,
      );
      const destroyed = await observer.event(
        "Target.targetDestroyed",
        (message) =>
          (message.params as { targetId?: string } | undefined)?.targetId === otherTargetId,
        destroyFrom,
      );
      expect(observer.messages.indexOf(detached)).toBeLessThan(
        observer.messages.indexOf(destroyed),
      );
      expect(
        await observer.send("Target.getTargetInfo", { targetId: otherTargetId }),
      ).toMatchObject({
        error: { code: -32602, message: "No target with given id found" },
      });
    } finally {
      other?.close();
      observer.close();
      await harness.close();
    }
  });

  test("updates discovered Target metadata after same-document navigation", async () => {
    const harness = await createHarness();
    const client = await CdpClient.open(harness.browserWsUrl);
    try {
      await client.send("Target.setDiscoverTargets", { discover: true });
      const initial = await client.send("Target.getTargetInfo", { targetId: "page-1" });
      const initialUrl = (initial.result as { targetInfo: { url: string } }).targetInfo.url;
      const expectedUrl = new URL(initialUrl);
      expectedUrl.search = "?state=updated";
      expectedUrl.hash = "#section";
      const attached = await client.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const sessionId = (attached.result as { sessionId: string }).sessionId;
      const changedFrom = client.messages.length;

      await client.send(
        "Runtime.evaluate",
        {
          expression: 'history.pushState({}, "", location.pathname + "?state=updated#section")',
        },
        sessionId,
      );

      const changed = await client.event(
        "Target.targetInfoChanged",
        (message) => {
          const info = (
            message.params as { targetInfo?: { targetId?: string; url?: string } } | undefined
          )?.targetInfo;
          return (
            info?.targetId === "page-1" &&
            info.url?.endsWith("/target/page-1?state=updated#section") === true
          );
        },
        changedFrom,
      );
      const targetInfo = (changed.params as { targetInfo: { targetId: string; url: string } })
        .targetInfo;
      expect(targetInfo.url).toBe(expectedUrl.href);

      expect(await client.send("Target.getTargetInfo", { targetId: "page-1" })).toMatchObject({
        result: {
          targetInfo: {
            targetId: "page-1",
            url: targetInfo.url,
          },
        },
      });
      await until(async () => {
        const targets = (await (
          await fetch(`${harness.browserOrigin}/json/list`)
        ).json()) as Array<{ id: string; url: string }>;
        return targets.some((target) => target.id === "page-1" && target.url === targetInfo.url);
      }, "/json/list metadata update");
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("updates discovered Target metadata after a title mutation", async () => {
    const harness = await createHarness();
    const client = await CdpClient.open(harness.browserWsUrl);
    try {
      await client.send("Target.setDiscoverTargets", { discover: true });
      const attached = await client.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const sessionId = (attached.result as { sessionId: string }).sessionId;
      const changedFrom = client.messages.length;

      await client.send(
        "Runtime.evaluate",
        { expression: 'document.title = "Updated Target"' },
        sessionId,
      );

      const changed = await client.event(
        "Target.targetInfoChanged",
        (message) => {
          const info = (
            message.params as { targetInfo?: { targetId?: string; title?: string } } | undefined
          )?.targetInfo;
          return info?.targetId === "page-1" && info.title === "Updated Target";
        },
        changedFrom,
      );
      const targetInfo = (changed.params as { targetInfo: { targetId: string; title: string } })
        .targetInfo;
      expect(targetInfo.title).toBe("Updated Target");

      expect(await client.send("Target.getTargetInfo", { targetId: "page-1" })).toMatchObject({
        result: {
          targetInfo: {
            targetId: "page-1",
            title: "Updated Target",
          },
        },
      });
      await until(async () => {
        const targets = (await (
          await fetch(`${harness.browserOrigin}/json/list`)
        ).json()) as Array<{ id: string; title: string }>;
        return targets.some(
          (target) => target.id === "page-1" && target.title === "Updated Target",
        );
      }, "/json/list title update");
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("closes a direct page socket after ordered terminal Session events", async () => {
    const harness = await createHarness();
    const list = (await (await fetch(`${harness.browserOrigin}/json/list`)).json()) as Array<{
      webSocketDebuggerUrl: string;
    }>;
    const direct = await CdpClient.open(list[0]!.webSocketDebuggerUrl);
    try {
      const nested = await direct.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const nestedSessionId = (nested.result as { sessionId: string }).sessionId;
      const from = direct.messages.length;
      const closed = await direct.send("Target.closeTarget", { targetId: "page-1" });
      expect(closed.result).toEqual({ success: true });
      const closeEvent = await direct.waitClosed();
      expect(closeEvent.code).toBeGreaterThanOrEqual(0);
      const terminal = direct.messages.slice(from);
      expect(terminal.slice(0, 3)).toEqual([
        closed,
        {
          method: "Inspector.detached",
          params: { reason: "Render process gone." },
        },
        {
          method: "Inspector.detached",
          params: { reason: "Render process gone." },
          sessionId: nestedSessionId,
        },
      ]);
      expect(terminal.slice(3)).toEqual(
        terminal.length === 3
          ? []
          : [{ method: "Inspector.detached", params: { reason: "target_closed" } }],
      );
      expect(terminal.some((message) => message.method === "Target.detachedFromTarget")).toBe(
        false,
      );
    } finally {
      direct.close();
      await harness.close();
    }
  });

  test("creates, attaches, detaches, and closes a ready page in Chromium event order", async () => {
    const harness = await createHarness();
    const client = await CdpClient.open(harness.browserWsUrl);
    try {
      await client.send("Target.setDiscoverTargets", { discover: true });
      const createFrom = client.messages.length;
      const created = await client.send("Target.createTarget", {
        url: "https://client.example/created",
      });
      const targetId = (created.result as { targetId?: string } | undefined)?.targetId;
      expect(targetId).toMatch(/^created-/);
      const createdEvent = await client.event(
        "Target.targetCreated",
        (message) =>
          (message.params as { targetInfo?: { targetId?: string } } | undefined)?.targetInfo
            ?.targetId === targetId,
        createFrom,
      );
      const changedEvent = await client.event(
        "Target.targetInfoChanged",
        (message) =>
          (message.params as { targetInfo?: { targetId?: string; url?: string } } | undefined)
            ?.targetInfo?.targetId === targetId,
        createFrom,
      );
      expect((changedEvent.params as { targetInfo: { url: string } }).targetInfo.url).toContain(
        `/target/${targetId}`,
      );
      expect(client.messages.indexOf(createdEvent)).toBeLessThan(client.messages.indexOf(created));

      const attachFrom = client.messages.length;
      const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = (attached.result as { sessionId: string }).sessionId;
      const attachedEvent = await client.event(
        "Target.attachedToTarget",
        (message) =>
          (message.params as { sessionId?: string } | undefined)?.sessionId === sessionId,
        attachFrom,
      );
      const attachedInfo = await client.event(
        "Target.targetInfoChanged",
        (message) => {
          const info = (
            message.params as { targetInfo?: { attached?: boolean; targetId?: string } } | undefined
          )?.targetInfo;
          return info !== undefined && info.targetId === targetId && info.attached === true;
        },
        attachFrom,
      );
      expect([
        client.messages.indexOf(attachedInfo),
        client.messages.indexOf(attachedEvent),
        client.messages.indexOf(attached),
      ]).toEqual(
        [
          client.messages.indexOf(attachedInfo),
          client.messages.indexOf(attachedEvent),
          client.messages.indexOf(attached),
        ].toSorted((left, right) => left - right),
      );
      const location = await client.send(
        "Runtime.evaluate",
        { expression: "location.pathname", returnByValue: true },
        sessionId,
      );
      expect(location.result).toEqual({
        result: { type: "string", value: `/target/${targetId}` },
      });

      const detachFrom = client.messages.length;
      const detached = await client.send("Target.detachFromTarget", { sessionId });
      const detachedEvent = await client.event(
        "Target.detachedFromTarget",
        (message) =>
          (message.params as { sessionId?: string } | undefined)?.sessionId === sessionId,
        detachFrom,
      );
      const detachedInfo = await client.event(
        "Target.targetInfoChanged",
        (message) => {
          const info = (
            message.params as { targetInfo?: { attached?: boolean; targetId?: string } } | undefined
          )?.targetInfo;
          return info !== undefined && info.targetId === targetId && info.attached === false;
        },
        detachFrom,
      );
      expect([
        client.messages.indexOf(detachedEvent),
        client.messages.indexOf(detachedInfo),
        client.messages.indexOf(detached),
      ]).toEqual(
        [
          client.messages.indexOf(detachedEvent),
          client.messages.indexOf(detachedInfo),
          client.messages.indexOf(detached),
        ].toSorted((left, right) => left - right),
      );

      const reattached = await client.send("Target.attachToTarget", { targetId, flatten: true });
      const finalSessionId = (reattached.result as { sessionId: string }).sessionId;
      const closeFrom = client.messages.length;
      const closed = await client.send("Target.closeTarget", { targetId });
      expect(closed.result).toEqual({ success: true });
      await client.event(
        "Target.targetDestroyed",
        (message) => (message.params as { targetId?: string } | undefined)?.targetId === targetId,
        closeFrom,
      );
      const terminal = client.messages
        .slice(closeFrom)
        .filter(
          (message) =>
            message.id === closed.id ||
            (message.method === "Inspector.detached" && message.sessionId === finalSessionId) ||
            (message.method === "Target.targetInfoChanged" &&
              (
                message.params as
                  | { targetInfo?: { attached?: boolean; targetId?: string } }
                  | undefined
              )?.targetInfo?.targetId === targetId &&
              (message.params as { targetInfo: { attached: boolean } }).targetInfo.attached ===
                false) ||
            (message.method === "Target.detachedFromTarget" &&
              (message.params as { sessionId?: string } | undefined)?.sessionId ===
                finalSessionId) ||
            (message.method === "Target.targetDestroyed" &&
              (message.params as { targetId?: string } | undefined)?.targetId === targetId),
        );
      expect(terminal.map((message) => message.id ?? message.method)).toEqual([
        closed.id,
        "Inspector.detached",
        "Target.targetInfoChanged",
        "Target.detachedFromTarget",
        "Target.targetDestroyed",
      ]);
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("routes nested Target events on the parent envelope and child commands by flat session", async () => {
    const harness = await createHarness();
    const client = await CdpClient.open(harness.browserWsUrl);
    const other = await CdpClient.open(harness.browserWsUrl);
    try {
      const parent = await client.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const parentSessionId = (parent.result as { sessionId: string }).sessionId;
      const created = await client.send("Target.createTarget", {
        url: "https://client.example/nested",
      });
      const targetId = (created.result as { targetId: string }).targetId;

      const nestedFrom = client.messages.length;
      const nested = await client.send(
        "Target.attachToTarget",
        { targetId, flatten: true },
        parentSessionId,
      );
      const childSessionId = (nested.result as { sessionId: string }).sessionId;
      expect(nested.sessionId).toBe(parentSessionId);
      const nestedEvent = await client.event(
        "Target.attachedToTarget",
        (message) =>
          message.sessionId === parentSessionId &&
          (message.params as { sessionId?: string } | undefined)?.sessionId === childSessionId,
        nestedFrom,
      );
      expect(client.messages.indexOf(nestedEvent)).toBeLessThan(client.messages.indexOf(nested));

      const childResult = await client.send(
        "Runtime.evaluate",
        { expression: "location.pathname", returnByValue: true },
        childSessionId,
      );
      expect(childResult).toMatchObject({
        sessionId: childSessionId,
        result: { result: { value: `/target/${targetId}` } },
      });
      const foreign = await other.send(
        "Runtime.evaluate",
        { expression: "document.title", returnByValue: true },
        childSessionId,
      );
      expect(foreign).toMatchObject({
        error: { code: -32001, message: "Session with given id not found." },
      });

      const detachFrom = client.messages.length;
      const detached = await client.send(
        "Target.detachFromTarget",
        { sessionId: childSessionId },
        parentSessionId,
      );
      const detachedEvent = await client.event(
        "Target.detachedFromTarget",
        (message) =>
          message.sessionId === parentSessionId &&
          (message.params as { sessionId?: string } | undefined)?.sessionId === childSessionId,
        detachFrom,
      );
      expect(detached.sessionId).toBe(parentSessionId);
      expect(client.messages.indexOf(detachedEvent)).toBeLessThan(
        client.messages.indexOf(detached),
      );

      await client.send("Target.closeTarget", { targetId });
      await client.send("Target.detachFromTarget", { sessionId: parentSessionId });
    } finally {
      other.close();
      client.close();
      await harness.close();
    }
  });

  test("auto-attaches existing and new pages and detaches them before disable returns", async () => {
    const harness = await createHarness();
    const client = await CdpClient.open(harness.browserWsUrl);
    try {
      const enableFrom = client.messages.length;
      const enabled = await client.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      const initialAttached = await client.event(
        "Target.attachedToTarget",
        (message) =>
          (message.params as { targetInfo?: { targetId?: string } } | undefined)?.targetInfo
            ?.targetId === "page-1",
        enableFrom,
      );
      const initialSessionId = (initialAttached.params as { sessionId: string }).sessionId;
      expect(client.messages.indexOf(initialAttached)).toBeLessThan(
        client.messages.indexOf(enabled),
      );

      const metadataFrom = client.messages.length;
      await client.send(
        "Runtime.evaluate",
        { expression: 'document.title = "Auto-attached Target"' },
        initialSessionId,
      );
      await client.event(
        "Target.targetInfoChanged",
        (message) => {
          const info = (
            message.params as { targetInfo?: { targetId?: string; title?: string } } | undefined
          )?.targetInfo;
          return info?.targetId === "page-1" && info.title === "Auto-attached Target";
        },
        metadataFrom,
      );

      const createFrom = client.messages.length;
      const created = await client.send("Target.createTarget", {
        url: "https://client.example/auto",
      });
      const targetId = (created.result as { targetId: string }).targetId;
      const newAttached = await client.event(
        "Target.attachedToTarget",
        (message) =>
          (message.params as { targetInfo?: { targetId?: string } } | undefined)?.targetInfo
            ?.targetId === targetId,
        createFrom,
      );
      const newSessionId = (newAttached.params as { sessionId: string }).sessionId;
      expect(client.messages.indexOf(newAttached)).toBeLessThan(client.messages.indexOf(created));
      expect(
        await client.send(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          newSessionId,
        ),
      ).toMatchObject({
        sessionId: newSessionId,
        result: { result: { value: "Created Target" } },
      });

      const disableFrom = client.messages.length;
      const disabled = await client.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      await until(
        () =>
          client.messages
            .slice(disableFrom)
            .filter((message) => message.method === "Target.detachedFromTarget").length === 2,
        "both auto-attached Sessions to detach",
      );
      const detachEvents = client.messages
        .slice(disableFrom)
        .filter((message) => message.method === "Target.detachedFromTarget");
      expect(
        new Set(detachEvents.map((message) => (message.params as { sessionId: string }).sessionId)),
      ).toEqual(new Set([initialSessionId, newSessionId]));
      expect(
        detachEvents.every(
          (message) => client.messages.indexOf(message) < client.messages.indexOf(disabled),
        ),
      ).toBe(true);
      expect(
        await client.send(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          newSessionId,
        ),
      ).toMatchObject({ error: { code: -32001 } });
      await client.send("Target.closeTarget", { targetId });
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("returns Chromium protocol errors and rejects an unknown direct Target", async () => {
    const harness = await createHarness();
    const client = await CdpClient.open(harness.browserWsUrl);
    try {
      const malformed = await client.exchange(
        "{",
        (message) => message.id === undefined && message.error?.code === -32700,
      );
      const invalidRequest = await client.exchange(
        '{"id":700,"method":42}',
        (message) => message.id === 700,
      );
      const unknownMethod = await client.send("NoSuch.domain");
      const invalidParams = await client.send("Target.attachToTarget");
      const serverError = await client.send("Target.setRemoteLocations", { locations: [] });
      const staleSession = await client.send(
        "Runtime.evaluate",
        { expression: "1" },
        "missing-session",
      );
      expect([
        malformed.error,
        invalidRequest.error,
        unknownMethod.error,
        invalidParams.error,
        serverError.error,
        staleSession.error,
      ]).toEqual([
        expect.objectContaining({ code: -32700 }),
        { code: -32600, message: "Message must have string 'method' property" },
        { code: -32601, message: "'NoSuch.domain' wasn't found" },
        {
          code: -32602,
          message: "Invalid parameters",
          data: "Failed to deserialize params.targetId - BINDINGS: mandatory field missing at position 8",
        },
        { code: -32000, message: "Not supported" },
        { code: -32001, message: "Session with given id not found." },
      ]);

      const missing = new WebSocket(
        harness.browserWsUrl.replace("/devtools/browser", "/devtools/page/missing"),
      );
      let rejected: { close: CloseEvent; error: boolean; opened: boolean };
      try {
        rejected = await bounded(
          new Promise<{ close: CloseEvent; error: boolean; opened: boolean }>((resolve) => {
            let error = false;
            let opened = false;
            missing.addEventListener("open", () => {
              opened = true;
            });
            missing.addEventListener("error", () => {
              error = true;
            });
            missing.addEventListener("close", (close) => resolve({ close, error, opened }), {
              once: true,
            });
          }),
          "unknown direct Target rejection",
        );
      } finally {
        missing.close();
      }
      expect(rejected.error || (rejected.opened && rejected.close.code !== 1000)).toBe(true);
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("isolates multiple clients and gives a reconnect a fresh Session", async () => {
    const harness = await createHarness();
    const first = await CdpClient.open(harness.browserWsUrl);
    const survivor = await CdpClient.open(harness.browserWsUrl);
    let reconnect: CdpClient | undefined;
    try {
      await survivor.send("Target.setDiscoverTargets", { discover: true });
      const firstAttach = await first.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const firstSessionId = (firstAttach.result as { sessionId: string }).sessionId;
      const firstBeforeSurvivorAttach = first.messages.length;
      const survivorAttach = await survivor.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const survivorSessionId = (survivorAttach.result as { sessionId: string }).sessionId;
      expect(firstSessionId).not.toBe(survivorSessionId);
      expect(
        first.messages
          .slice(firstBeforeSurvivorAttach)
          .some((message) => message.method === "Target.attachedToTarget"),
      ).toBe(false);
      expect(
        survivor.messages.some(
          (message) =>
            message.method === "Target.attachedToTarget" &&
            (message.params as { sessionId?: string } | undefined)?.sessionId === survivorSessionId,
        ),
      ).toBe(true);
      expect(
        await survivor.send(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          survivorSessionId,
        ),
      ).toMatchObject({ result: { result: { value: "Initial Target" } } });

      const firstDisconnectFrom = survivor.messages.length;
      first.close();
      await first.waitClosed();
      await until(async () => {
        const status = (await (await fetch(`${harness.browserOrigin}/icdp/status`)).json()) as {
          clients: number;
        };
        return status.clients === 1;
      }, "first Client disconnect");
      expect(
        survivor.messages.slice(firstDisconnectFrom).some((message) => {
          const info = (
            message.params as { targetInfo?: { attached?: boolean; targetId?: string } } | undefined
          )?.targetInfo;
          return info?.targetId === "page-1" && info.attached === false;
        }),
      ).toBe(false);
      expect(
        survivor.messages
          .slice(firstDisconnectFrom)
          .some((message) => message.method === "Target.detachedFromTarget"),
      ).toBe(false);
      expect(await survivor.send("Target.getTargetInfo", { targetId: "page-1" })).toMatchObject({
        result: { targetInfo: { attached: true, targetId: "page-1" } },
      });

      const detachFrom = survivor.messages.length;
      const detached = await survivor.send("Target.detachFromTarget", {
        sessionId: survivorSessionId,
      });
      const detachedInfo = await survivor.event(
        "Target.targetInfoChanged",
        (message) =>
          (message.params as { targetInfo?: { attached?: boolean; targetId?: string } } | undefined)
            ?.targetInfo?.targetId === "page-1" &&
          (message.params as { targetInfo: { attached: boolean } }).targetInfo.attached === false,
        detachFrom,
      );
      expect(survivor.messages.indexOf(detachedInfo)).toBeLessThan(
        survivor.messages.indexOf(detached),
      );

      reconnect = await CdpClient.open(harness.browserWsUrl);
      expect(
        await reconnect.send(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          firstSessionId,
        ),
      ).toMatchObject({ error: { code: -32001 } });
      const fresh = await reconnect.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const freshSessionId = (fresh.result as { sessionId: string }).sessionId;
      expect(freshSessionId).not.toBe(firstSessionId);
      expect(await survivor.send("Browser.getVersion")).toMatchObject({
        result: { product: "icdp-lifecycle-e2e" },
      });
      expect(
        await reconnect.send(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          freshSessionId,
        ),
      ).toMatchObject({ result: { result: { value: "Initial Target" } } });
    } finally {
      reconnect?.close();
      survivor.close();
      first.close();
      await harness.close();
    }
  });

  test("preserves a flat Session and queued reply across a transient Host reconnect", async () => {
    const harness = await createHarness();
    const client = await CdpClient.open(harness.browserWsUrl);
    try {
      const attached = await client.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const sessionId = (attached.result as { sessionId: string }).sessionId;
      let delayedSettled = false;
      const delayed = client.send(
        "Runtime.evaluate",
        {
          expression:
            "new Promise(resolve => { (globalThis.__ICDP_TEST_RESOLVERS ??= {}).delayed = () => resolve('replayed') })",
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      void delayed.then(
        () => {
          delayedSettled = true;
        },
        () => {
          delayedSettled = true;
        },
      );
      expect(
        await client.send(
          "Runtime.evaluate",
          {
            expression: "typeof globalThis.__ICDP_TEST_RESOLVERS?.delayed",
            returnByValue: true,
          },
          sessionId,
        ),
      ).toMatchObject({ result: { result: { value: "function" } } });

      await harness.evaluate("window.__ICDP_CONTROL.dropRelay()");
      await until(async () => {
        const status = (await (await fetch(`${harness.browserOrigin}/icdp/status`)).json()) as {
          hostConnected: boolean;
          targets: unknown[];
        };
        return !status.hostConnected && status.targets.length === 0;
      }, "Host uplink loss");
      expect(await client.send("Browser.getVersion")).toMatchObject({
        error: { code: -32000, message: "Host is not connected" },
      });
      expect(delayedSettled).toBe(false);
      await harness.evaluate("window.__ICDP_CONTROL.resolve('delayed')");
      expect(delayedSettled).toBe(false);
      expect(await delayed).toMatchObject({
        sessionId,
        result: { result: { type: "string", value: "replayed" } },
      });
      await until(async () => {
        const status = (await (await fetch(`${harness.browserOrigin}/icdp/status`)).json()) as {
          hostConnected: boolean;
          targets: unknown[];
        };
        return status.hostConnected && status.targets.length === 1;
      }, "same Host reconnect");
      expect(
        await client.send(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          sessionId,
        ),
      ).toMatchObject({
        sessionId,
        result: { result: { value: "Initial Target" } },
      });
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("closes old clients when a replacement Host connects and accepts a fresh client", async () => {
    const harness = await createHarness();
    const oldClient = await CdpClient.open(harness.browserWsUrl);
    let freshClient: CdpClient | undefined;
    try {
      const attached = await oldClient.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const oldSessionId = (attached.result as { sessionId?: string }).sessionId;
      expect(oldSessionId).toEqual(expect.any(String));
      expect(oldSessionId).not.toBe("");

      await harness.reload();
      const closed = await oldClient.waitClosed();
      expect({ code: closed.code, reason: closed.reason }).toEqual({
        code: 1012,
        reason: "Host instance replaced",
      });
      await until(async () => {
        const status = (await (await fetch(`${harness.browserOrigin}/icdp/status`)).json()) as {
          hostConnected: boolean;
          targets: Array<{ targetId: string; url: string }>;
        };
        return (
          status.hostConnected &&
          status.targets.length === 1 &&
          status.targets[0]?.targetId === "page-1" &&
          status.targets[0].url.endsWith("/target/page-1")
        );
      }, "replacement Host Target");

      freshClient = await CdpClient.open(harness.browserWsUrl);
      const freshAttach = await freshClient.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const freshSessionId = (freshAttach.result as { sessionId: string }).sessionId;
      expect(
        await freshClient.send(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          freshSessionId,
        ),
      ).toMatchObject({ result: { result: { value: "Initial Target" } } });
    } finally {
      freshClient?.close();
      oldClient.close();
      await harness.close();
    }
  });

  test("drops a late async reply before a reconnect reuses its request id", async () => {
    const harness = await createHarness();
    const oldClient = await CdpClient.open(harness.browserWsUrl);
    let newClient: CdpClient | undefined;
    try {
      const attached = await oldClient.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const oldSessionId = (attached.result as { sessionId: string }).sessionId;
      const lateId = await oldClient.post(
        "Runtime.evaluate",
        {
          expression:
            "new Promise(resolve => { (globalThis.__ICDP_TEST_RESOLVERS ??= {}).late = () => resolve('stale') })",
          awaitPromise: true,
          returnByValue: true,
        },
        oldSessionId,
      );
      expect(lateId).toBe(2);
      expect(
        await oldClient.send(
          "Runtime.evaluate",
          {
            expression: "typeof globalThis.__ICDP_TEST_RESOLVERS?.late",
            returnByValue: true,
          },
          oldSessionId,
        ),
      ).toMatchObject({ result: { result: { value: "function" } } });
      expect(oldClient.messages.some((message) => message.id === lateId)).toBe(false);

      oldClient.close();
      await oldClient.waitClosed();
      await until(async () => {
        const status = (await (await fetch(`${harness.browserOrigin}/icdp/status`)).json()) as {
          clients: number;
        };
        return status.clients === 0;
      }, "old Client removal");

      newClient = await CdpClient.open(harness.browserWsUrl);
      const freshAttach = await newClient.send("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      });
      const freshSessionId = (freshAttach.result as { sessionId?: string }).sessionId;
      expect(freshSessionId).toEqual(expect.any(String));
      expect(freshSessionId).not.toBe("");
      const reused = await newClient.send("Browser.getVersion");
      expect(reused.id).toBe(lateId);
      expect(reused.result).toMatchObject({ product: "icdp-lifecycle-e2e" });
      await harness.evaluate("window.__ICDP_CONTROL.resolve('late')");
      await newClient.send("Browser.getVersion");
      expect(newClient.messages.filter((message) => message.id === lateId)).toEqual([reused]);
    } finally {
      newClient?.close();
      oldClient.close();
      await harness.close();
    }
  });
});
