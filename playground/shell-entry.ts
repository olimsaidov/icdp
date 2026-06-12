import { IcdpHost, type LocalSession } from "../src/host/index.ts";

declare global {
  interface Window {
    __APP_ORIGIN: string;
    __RELAY_WS: string;
  }
}

const appOrigin = window.__APP_ORIGIN;
const host = new IcdpHost();

type Slot = { targetId: string; path: string };
const slots: Slot[] = [
  { targetId: "playground", path: "/" },
  { targetId: "todo", path: "/todo" },
];

function frameFor(slot: Slot): HTMLIFrameElement {
  return document.getElementById(`frame-${slot.targetId}`) as HTMLIFrameElement;
}

const paired = new Set<string>();
function pair(slot: Slot): void {
  if (paired.has(slot.targetId)) return;
  host.pair(frameFor(slot), { targetId: slot.targetId, origins: [appOrigin] });
  paired.add(slot.targetId);
}

for (const slot of slots) pair(slot);
host.connectRelay({ url: window.__RELAY_WS });

// --- target status -----------------------------------------------------------

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

// --- per-slot controls ---------------------------------------------------------

for (const slot of slots) {
  const reload = document.getElementById(`reload-${slot.targetId}`);
  reload?.addEventListener("click", () => {
    const iframe = frameFor(slot);
    iframe.src = `${appOrigin}${slot.path}`;
  });

  const toggle = document.getElementById(`toggle-${slot.targetId}`) as HTMLButtonElement | null;
  toggle?.addEventListener("click", () => {
    if (paired.has(slot.targetId)) {
      host.unpair(slot.targetId);
      paired.delete(slot.targetId);
      toggle.textContent = "Pair";
    } else {
      pair(slot);
      toggle.textContent = "Unpair";
    }
    renderTargets();
  });
}

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
