import { IcdpHost, type LocalSession } from "../src/host/index.ts";

declare global {
  interface Window {
    __APP_ORIGIN: string;
    __RELAY_WS: string;
  }
}

const appOrigin = window.__APP_ORIGIN;
const gridEl = document.getElementById("targets-grid") as HTMLElement;

// A target is a target: whether paired at boot or opened by a Client via
// Target.createTarget, each is just a paired iframe rendered through the same
// panel in one grid. They are indistinguishable — no badge, identical controls.
const panels = new Map<string, { el: HTMLElement; iframe: HTMLIFrameElement }>();
let tabCounter = 0;

// Annotated so the hooks below can reference `host` without circular inference.
const host: IcdpHost = new IcdpHost({
  // A Client opens a Target (e.g. `agent-browser --cdp <port> tab new <url>`):
  // materialise an iframe and pair it, exactly like a boot target.
  onCreateTarget: ({ url }) => {
    // Resolve relative/blank requests against the app origin. Only app-origin
    // pages carry a Frame Agent, so anything else won't connect — and the Host
    // rolls the half-created Target back (removed via targetDestroyed below).
    let dest: URL;
    try {
      dest = new URL(typeof url === "string" && url ? url : "/", `${appOrigin}/`);
    } catch {
      dest = new URL("/", `${appOrigin}/`);
    }
    const targetId = `tab-${++tabCounter}`;
    mountTarget(targetId, dest.href);
    // The Host awaits the new Target's handshake before the Client's
    // createTarget resolves, so its first command can't race the channel.
    return targetId;
  },
  // A Client closes a Target (`tab close`): destroy the Pairing, like the panel's
  // own Close button. Any target is closable — boot ones aren't special.
  onCloseTarget: (targetId) => host.unpair(targetId),
});

/** Build one panel around a fresh iframe and pair it as `targetId`. */
function mountTarget(targetId: string, src: string): void {
  const iframe = document.createElement("iframe");
  iframe.title = targetId;
  iframe.src = src;

  const head = document.createElement("div");
  head.className = "panel-head";
  head.innerHTML = `<b>Target: <code>${targetId}</code></b><span class="grow"></span>`;

  const reload = document.createElement("button");
  reload.textContent = "Reload";
  // Re-assigning the src attribute reloads the iframe; targetId survives (Clients
  // see Page.frameNavigated, not a new Target).
  reload.addEventListener("click", () => iframe.setAttribute("src", iframe.src));

  const close = document.createElement("button");
  close.textContent = "Close";
  close.addEventListener("click", () => host.unpair(targetId));

  head.append(reload, close);
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.append(head, iframe);
  gridEl.append(panel);
  panels.set(targetId, { el: panel, iframe });

  host.pair(iframe, { targetId, origins: [appOrigin] });
}

// A target's panel dies with the Target — the Close button, a Client's
// Target.closeTarget, or the Host's rollback when a Target never connects.
host.onTargets((event) => {
  if (event.kind !== "targetDestroyed") return;
  const panel = panels.get(event.targetId);
  if (!panel) return;
  panel.el.remove();
  panels.delete(event.targetId);
});

mountTarget("playground", `${appOrigin}/`);
mountTarget("todo", `${appOrigin}/todo`);
host.connectRelay({ url: window.__RELAY_WS });

// --- target table ------------------------------------------------------------

const statusEl = document.getElementById("targets") as HTMLElement;
function renderTargets(): void {
  const rows = host
    .targets()
    .map(
      (target) =>
        `<tr><td><code>${target.targetId}</code></td><td>${target.title}</td><td>${target.url || "<i>not paired yet</i>"}</td></tr>`,
    );
  statusEl.innerHTML =
    rows.length === 0 ? "<tr><td colspan=3><i>no targets</i></td></tr>" : rows.join("");
}
host.onTargets(() => renderTargets());
renderTargets();

// --- console panel: a LOCAL session, no relay involved -------------------------

const logEl = document.getElementById("console-log") as HTMLElement;
let consoleSession: LocalSession | null = null;

function describeArg(arg: { value?: unknown; description?: string; type?: string }): string {
  if (arg.value !== undefined) {
    return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  }
  return arg.description ?? arg.type ?? "?";
}

function appendLog(kind: string, text: string): void {
  const line = document.createElement("div");
  line.className = `log log-${kind}`;
  line.textContent = `[${kind}] ${text}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > 200) logEl.firstElementChild?.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

async function attachConsole(): Promise<void> {
  consoleSession?.detach();
  consoleSession = host.attach("playground");
  consoleSession.onEvent((method, params) => {
    if (method !== "Runtime.consoleAPICalled") return;
    const event = params as {
      type?: string;
      args?: Array<{ value?: unknown; description?: string }>;
    };
    appendLog(event.type ?? "log", (event.args ?? []).map(describeArg).join(" "));
  });
  // The frame may not have paired yet; retry until the channel is up.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await consoleSession.send("Runtime.enable");
      appendLog("shell", "console panel attached (local session, no relay)");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  appendLog("shell", "could not attach console panel");
}

host.onTargets((event) => {
  if (event.kind === "targetCreated" && event.target.targetId === "playground")
    void attachConsole();
});
void attachConsole();

document.getElementById("clear-console")?.addEventListener("click", () => {
  logEl.innerHTML = "";
});
