import {
  type FrameInfo,
  type HandshakeMessage,
  type HostToFrameMessage,
  isHandshakeMessage,
  PROTOCOL_VERSION,
} from "../protocol.ts";
import { FrameBackend } from "./cdp/session.ts";

export type FrameAgentOptions = {
  /**
   * Origins allowed to act as Host. The agent stays dormant unless the parent
   * matches. "*" hands full DOM read/write/eval to any embedder.
   */
  allowedParents: string[] | "*";
};

const ANNOUNCE_RETRIES = 10;
const ANNOUNCE_INTERVAL_MS = 300;

let started = false;
let port: MessagePort | null = null;
let backend: FrameBackend | null = null;
let consoleBridgeInstalled = false;
let reportedInfo: FrameInfo | undefined;

function sendToHost(message: unknown): void {
  port?.postMessage(JSON.stringify(message));
}

function currentInfo(): FrameInfo {
  return {
    title: document.title || location.href,
    url: location.href,
  };
}

function reportInfo(): void {
  if (!port) return;
  const info = currentInfo();
  if (info.title === reportedInfo?.title && info.url === reportedInfo.url) return;
  reportedInfo = info;
  sendToHost({ kind: "metadata", info });
}

function observeMetadata(): void {
  const navigation = (
    window as Window & {
      navigation?: EventTarget;
    }
  ).navigation;
  navigation?.addEventListener("navigatesuccess", reportInfo);
  window.addEventListener("hashchange", reportInfo);
  window.addEventListener("popstate", reportInfo);
  new MutationObserver(reportInfo).observe(document.head, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function frameBackend(): FrameBackend {
  backend ??= new FrameBackend({
    document,
    send: sendToHost,
  });
  return backend;
}

function parseFrameMessage(data: unknown): HostToFrameMessage | undefined {
  try {
    const parsed = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
    if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) return undefined;
    return parsed as HostToFrameMessage;
  } catch {
    return undefined;
  }
}

async function handleFrameMessage(data: unknown): Promise<void> {
  const message = parseFrameMessage(data);
  if (!message) return;
  const runtime = frameBackend();
  if (message.kind === "attach") {
    runtime.attach(message.sessionId, message.state.enabledDomains, message.state.domainParams);
  } else if (message.kind === "detach") {
    runtime.detach(message.sessionId);
  } else if (message.kind === "command") {
    await runtime.command(message);
  }
}

function adoptPort(next: MessagePort): void {
  port?.close();
  frameBackend().clearSessions();
  port = next;
  installConsoleBridge();
  next.onmessage = (event) => {
    if (port !== next) return;
    void handleFrameMessage(event.data);
  };
  next.start?.();
  reportInfo();
}

function installConsoleBridge(): void {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;
  const methods: Record<string, string> = {
    clear: "clear",
    debug: "debug",
    dir: "dir",
    error: "error",
    group: "startGroup",
    groupCollapsed: "startGroupCollapsed",
    groupEnd: "endGroup",
    info: "info",
    log: "log",
    table: "table",
    warn: "warning",
  };
  for (const [name, type] of Object.entries(methods)) {
    const original = (console as unknown as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    let current: unknown = original;
    const wrapped = (...args: unknown[]) => {
      const result = typeof current === "function" ? current.apply(console, args) : undefined;
      frameBackend().consoleAPICalled(type, args);
      return result;
    };
    Object.defineProperty(console, name, {
      configurable: true,
      get: () => (typeof current === "function" ? wrapped : current),
      set: (next) => {
        if (next !== wrapped) current = next;
      },
    });
  }
}

function parentAllowed(origin: string, allowed: string[] | "*"): boolean {
  return allowed === "*" || allowed.includes(origin);
}

function announce(allowed: string[] | "*"): void {
  const info = currentInfo();
  reportedInfo = info;
  const hello = {
    icdp: "hello",
    v: PROTOCOL_VERSION,
    ...info,
  } satisfies HandshakeMessage;
  for (const origin of allowed === "*" ? ["*"] : allowed) {
    try {
      window.parent.postMessage(hello, origin);
    } catch {}
  }
}

/**
 * Boot the Frame Agent. The module is inert until this function is called, and
 * the agent adopts a command channel only from an allow-listed parent.
 */
export function startFrameAgent(options: FrameAgentOptions): void {
  if (started || window.parent === window) return;
  started = true;
  frameBackend();
  observeMetadata();
  const allowed = options.allowedParents;

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !isHandshakeMessage(event.data)) return;
    if (!parentAllowed(event.origin, allowed)) return;
    if (event.data.icdp === "probe") {
      announce(allowed);
    } else if (event.data.icdp === "welcome" && event.ports[0]) {
      adoptPort(event.ports[0]);
    }
  });

  announce(allowed);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) announce(allowed);
  });

  let attempts = 0;
  const retry = window.setInterval(() => {
    if (port || ++attempts >= ANNOUNCE_RETRIES) {
      window.clearInterval(retry);
      return;
    }
    announce(allowed);
  }, ANNOUNCE_INTERVAL_MS);
}
