import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rolldown } from "rolldown";

type CdpError = { code: number; message: string };

export type CdpEvent = {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: CdpError;
  sessionId?: string;
};

type RelayLike = {
  browserPort: number;
  browserWsUrl: string;
  hostPort: number;
  hostWsUrl: string;
  stop(): Promise<void>;
};

type ServeRelay = (options: {
  fallback(request: IncomingMessage, response: ServerResponse): void;
  product: string;
}) => Promise<RelayLike>;

export type NetworkNavigationHarness = {
  appOrigin: string;
  browser: CdpClient;
  nativeBrowser: CdpClient;
  chromiumProduct: string;
  icdp: CdpClient;
  evaluate(expression: string): Promise<any>;
  close(): Promise<void>;
};

export type NetworkNavigationHarnessOptions = {
  frameModule: string;
  hostModule: string;
  serveRelay: ServeRelay;
};

const CHROMIUM_PATH =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function until(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(20);
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function bundleBrowser(moduleSpecifier: string, kind: "frame" | "host"): Promise<string> {
  const id = `\0network-navigation-${kind}`;
  const source =
    kind === "frame"
      ? `
          import { startFrameAgent } from ${JSON.stringify(moduleSpecifier)};
          startFrameAgent({ allowedParents: window.__ICDP_ALLOWED_PARENTS ?? "*" });
        `
      : `
          import { IcdpHost } from ${JSON.stringify(moduleSpecifier)};
          const iframe = document.getElementById("preview");
          const host = new IcdpHost();
          host.pair(iframe, {
            targetId: "network-navigation",
            origins: [window.__ICDP_APP_ORIGIN],
          });
          host.connectRelay({ url: window.__ICDP_RELAY_WS });
        `;
  const build = await rolldown({
    input: id,
    platform: "browser",
    logLevel: "silent",
    plugins: [
      {
        name: id.slice(1),
        resolveId(sourceId) {
          return sourceId === id ? id : undefined;
        },
        load(sourceId) {
          return sourceId === id ? source : undefined;
        },
      },
    ],
  });
  try {
    const { output } = await build.generate({ format: "esm" });
    const entry = output.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
    if (!entry || entry.type !== "chunk") throw new Error(`no ${kind} browser bundle`);
    return entry.code;
  } finally {
    await build.close();
  }
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Uint8Array,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  });
  response.end(body);
}

function appHtml(hostOrigin: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>ICDP Network Fixture</title>
    <script>window.__ICDP_ALLOWED_PARENTS = [${JSON.stringify(hostOrigin)}];</script>
    <script type="module" src="/frame-agent.js"></script>
  </head>
  <body><main>Network fixture <button type="button">Network action</button></main></body>
</html>`;
}

function hostHtml(appOrigin: string, relayWsUrl: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>ICDP Host</title></head>
  <body>
    <iframe id="preview" src="${appOrigin}/"></iframe>
    <script>
      window.__ICDP_APP_ORIGIN = ${JSON.stringify(appOrigin)};
      window.__ICDP_RELAY_WS = ${JSON.stringify(relayWsUrl)};
    </script>
    <script type="module" src="/host.js"></script>
  </body>
</html>`;
}

export class CdpClient {
  readonly events: CdpEvent[] = [];
  private readonly opened: Promise<void>;
  private readonly pending = new Map<number, (message: CdpMessage) => void>();
  private nextId = 0;
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`failed to open ${url}`)), {
        once: true,
      });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const settle = this.pending.get(message.id);
        this.pending.delete(message.id);
        settle?.(message);
      } else if (message.method) {
        this.events.push({
          method: message.method,
          params: message.params ?? {},
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        });
      }
    });
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<any> {
    await this.opened;
    const id = ++this.nextId;
    let timer: ReturnType<typeof setTimeout>;
    const response = new Promise<CdpMessage>((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 10_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    try {
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch (error) {
      clearTimeout(timer!);
      this.pending.delete(id);
      throw error;
    }
    const message = await response;
    if (message.error) {
      throw new Error(`${method}: ${message.error.message} (${message.error.code})`);
    }
    return message.result ?? {};
  }

  async waitForEvent(
    method: string,
    predicate: (params: Record<string, any>) => boolean = () => true,
    start = 0,
  ): Promise<CdpEvent> {
    let found: CdpEvent | undefined;
    await until(() => {
      found = this.events
        .slice(start)
        .find((event) => event.method === method && predicate(event.params));
      return found !== undefined;
    }, method);
    return found!;
  }

  close(): void {
    this.socket.close();
  }
}

async function launchChromium(
  url: string,
): Promise<{ client: CdpClient; close(): Promise<void>; product: string }> {
  const profile = await mkdtemp(join(tmpdir(), "icdp-network-navigation-"));
  const chromium = spawn(
    CHROMIUM_PATH,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let spawnError: Error | undefined;
  let stderr = "";
  chromium.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((resolve) => {
    chromium.once("error", (error) => {
      spawnError = error;
      resolve();
    });
    chromium.once("exit", () => resolve());
  });
  let client: CdpClient | undefined;
  const close = async (): Promise<void> => {
    client?.close();
    if (chromium.exitCode === null) chromium.kill("SIGTERM");
    await Promise.race([exited, delay(5_000)]);
    if (chromium.exitCode === null) {
      chromium.kill("SIGKILL");
      await exited;
    }
    await rm(profile, { force: true, recursive: true });
  };
  try {
    let debuggerUrl = "";
    await until(async () => {
      if (spawnError) throw new Error(`failed to start Chromium: ${spawnError.message}`);
      if (chromium.exitCode !== null) {
        throw new Error(`Chromium exited during startup (${chromium.exitCode})\n${stderr}`);
      }
      try {
        const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8"))
          .trim()
          .split(/\r?\n/);
        if (!/^\d+$/.test(port ?? "") || !path?.startsWith("/")) return false;
        debuggerUrl = `ws://127.0.0.1:${port}${path}`;
        return true;
      } catch {
        return false;
      }
    }, "Chromium DevTools endpoint");
    const cdp = new CdpClient(debuggerUrl);
    client = cdp;
    const version = await cdp.send("Browser.getVersion");
    return {
      client: cdp,
      product: String(version.product),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function createNetworkNavigationHarness(
  options: NetworkNavigationHarnessOptions,
): Promise<NetworkNavigationHarness> {
  const [frameScript, hostScript] = await Promise.all([
    bundleBrowser(options.frameModule, "frame"),
    bundleBrowser(options.hostModule, "host"),
  ]);
  let hostOrigin = "";
  const appServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://app");
    if (url.pathname === "/frame-agent.js") {
      return send(response, 200, "application/javascript; charset=utf-8", frameScript);
    }
    if (url.pathname === "/api/text") {
      return send(response, 200, "text/plain; charset=utf-8", "network-body");
    }
    if (url.pathname === "/api/binary") {
      return send(response, 200, "application/octet-stream", new Uint8Array([0, 255, 1]));
    }
    if (url.pathname === "/api/echo") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        send(response, 200, "application/json; charset=utf-8", body);
      });
      return;
    }
    if (url.pathname === "/api/failure") {
      request.socket.destroy();
      return;
    }
    if (url.pathname === "/api/redirect") {
      response.writeHead(302, { Location: "/api/text?from=redirect" });
      response.end();
      return;
    }
    send(response, 200, "text/html; charset=utf-8", appHtml(hostOrigin));
  });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  const appOrigin = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

  let relay: RelayLike | undefined;
  let chromium: { client: CdpClient; close(): Promise<void>; product: string } | undefined;
  let browser: CdpClient | undefined;
  let icdp: CdpClient | undefined;
  try {
    relay = await options.serveRelay({
      product: "icdp-network-navigation-e2e",
      fallback(request, response) {
        const url = new URL(request.url ?? "/", "http://host");
        if (url.pathname === "/host.js") {
          return send(response, 200, "application/javascript; charset=utf-8", hostScript);
        }
        send(response, 200, "text/html; charset=utf-8", hostHtml(appOrigin, relay!.hostWsUrl));
      },
    });
    hostOrigin = `http://127.0.0.1:${relay.hostPort}`;
    chromium = await launchChromium(hostOrigin);
    const browserOrigin = `http://127.0.0.1:${relay.browserPort}`;
    await until(async () => {
      const response = await fetch(`${browserOrigin}/icdp/status`);
      if (!response.ok) return false;
      const status = (await response.json()) as {
        hostConnected: boolean;
        targets: unknown[];
      };
      return status.hostConnected && status.targets.length === 1;
    }, "ICDP target");
    const targets = (await (await fetch(`${browserOrigin}/json/list`)).json()) as Array<{
      webSocketDebuggerUrl: string;
    }>;
    const targetUrl = targets[0]?.webSocketDebuggerUrl;
    if (!targetUrl) throw new Error("ICDP did not advertise a target WebSocket");
    browser = new CdpClient(relay.browserWsUrl);
    icdp = new CdpClient(targetUrl);
    await icdp.send("Runtime.enable");
    await icdp.send("Page.enable");
    await icdp.send("Network.enable");
  } catch (error) {
    browser?.close();
    icdp?.close();
    await chromium?.close();
    await relay?.stop();
    await closeServer(appServer);
    throw error;
  }

  let closed = false;
  return {
    appOrigin,
    browser,
    nativeBrowser: chromium.client,
    chromiumProduct: chromium.product,
    icdp,
    async evaluate(expression) {
      const response = await icdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text ?? `evaluation failed: ${expression}`);
      }
      return response.result?.value;
    },
    async close() {
      if (closed) return;
      closed = true;
      browser.close();
      icdp.close();
      await chromium.close();
      await relay.stop();
      await closeServer(appServer);
    },
  };
}
