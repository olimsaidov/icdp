import { IcdpHost, type LocalSession } from "../src/host/index.ts";

declare global {
  interface Window {
    __APP_ORIGIN: string;
    __RELAY_WS: string;
  }
}

const appOrigin = window.__APP_ORIGIN;
const gridEl = document.getElementById("targets-grid") as HTMLElement;

// Every target renders through one uniform panel in one grid: the two paired at
// boot and any a Client opens via Target.createTarget look and behave the same.
type Panel = { el: HTMLElement; iframe: HTMLIFrameElement; dynamic: boolean };
const panels = new Map<string, Panel>();
let dynamicCounter = 0;

// Annotated so the hooks below can reference `host` without circular inference.
const host: IcdpHost = new IcdpHost({
  // A CDP Client (e.g. `agent-browser --cdp <port> tab new <url>`) opens a Target:
  // materialise an iframe and pair it, just like a boot slot.
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
    const targetId = `tab-${++dynamicCounter}`;
    mountTarget(targetId, dest.href, true);
    // The Host awaits the new Target's handshake before the Client's
    // createTarget resolves, so its first command can't race the channel.
    return targetId;
  },
  onCloseTarget: (targetId) => {
    // The hook is the Host's policy boundary: only let a Client close Targets it
    // created. The static playground/todo slots are Host-owned — throwing here
    // surfaces a CDP error to the Client instead of orphaning their iframes.
    if (!panels.get(targetId)?.dynamic) {
      throw new Error(`Target "${targetId}" is Host-owned and cannot be closed by a Client`);
    }
    host.unpair(targetId);
  },
});

/** Build a uniform panel around a fresh iframe and pair it as `targetId`. */
function mountTarget(targetId: string, src: string, dynamic: boolean): void {
  const iframe = document.createElement("iframe");
  iframe.title = `${targetId} app`;
  iframe.src = src;

  const head = document.createElement("div");
  head.className = "panel-head";
  head.innerHTML =
    `<b>Target: <code>${targetId}</code></b>` +
    (dynamic ? '<span class="tag">CDP</span>' : "") +
    '<span class="grow"></span>';

  const reload = document.createElement("button");
  reload.textContent = "Reload";
  // Re-assigning the src attribute reloads the iframe; targetId survives (Clients
  // see Page.frameNavigated, not a new Target).
  reload.addEventListener("click", () => iframe.setAttribute("src", iframe.src));

  const action = document.createElement("button");
  if (dynamic) {
    action.textContent = "Close";
    action.addEventListener("click", () => host.unpair(targetId));
  } else {
    // Static slots toggle pair/unpair in place to exercise lifecycle churn.
    let isPaired = true;
    action.textContent = "Unpair";
    action.addEventListener("click", () => {
      isPaired = !isPaired;
      if (isPaired) host.pair(iframe, { targetId, origins: [appOrigin] });
      else host.unpair(targetId);
      action.textContent = isPaired ? "Unpair" : "Pair";
    });
  }

  head.append(reload, action);
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.append(head, iframe);
  gridEl.append(panel);
  panels.set(targetId, { el: panel, iframe, dynamic });

  host.pair(iframe, { targetId, origins: [appOrigin] });
}

// Dynamic panels die with their Target — onCloseTarget, the Close button, or the
// Host's rollback when a Target never connects. Static panels stay (their Unpair
// toggle keeps the iframe so it can be re-paired).
host.onTargets((event) => {
  if (event.kind !== "targetDestroyed") return;
  const panel = panels.get(event.targetId);
  if (!panel?.dynamic) return;
  panel.el.remove();
  panels.delete(event.targetId);
});

mountTarget("playground", `${appOrigin}/`, false);
mountTarget("todo", `${appOrigin}/todo`, false);
host.connectRelay({ url: window.__RELAY_WS });

// --- target table ------------------------------------------------------------

const statusEl = document.getElementById("targets") as HTMLElement;
function renderTargets(): void {
  const rows = host.targets().map((target) => {
    const tag = panels.get(target.targetId)?.dynamic ? ' <span class="tag">CDP</span>' : "";
    return `<tr><td><code>${target.targetId}</code>${tag}</td><td>${target.title}</td><td>${target.url || "<i>not paired yet</i>"}</td></tr>`;
  });
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
