<script setup>
// Live, in-browser demo: agent-browser compiled to WASM drives a same-page
// iframe over the Chrome DevTools Protocol — no server, no real browser session.
// Everything browser-only is loaded lazily after the user launches the demo, so
// the landing page stays light. SSR-safe: no browser imports at module scope.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { withBase } from "vitepress";

import { FRAME_VERSION } from "./frame-version";

const TARGET_ID = "demo-target";

const EXAMPLES = [
  {
    id: "checkout",
    title: "Checkout form",
    file: "checkout.html",
    blurb: "Fill a form and submit it over CDP.",
    commands: [
      'fill "#name" "Ada Lovelace"',
      'type "#email" "ada@x.com"',
      'click "#submit"',
      'get text "#status"',
    ],
  },
  {
    id: "todo",
    title: "Task list",
    file: "todo.html",
    blurb: "Add a task, then snapshot the page.",
    commands: ['fill "#new-todo" "Ship it"', 'click "#add"', "snapshot", 'get text "#count"'],
  },
  {
    id: "catalog",
    title: "Searchable table",
    file: "catalog.html",
    blurb: "Filter a table; read back the result.",
    commands: ['fill "#search" "pro"', 'get text "#results"', "snapshot"],
  },
  {
    id: "dashboard",
    title: "Tabbed dashboard",
    file: "dashboard.html",
    blurb: "Switch tabs; read state from the frame.",
    commands: ['click "#tab-revenue"', 'get text "#panel"', "eval window.dashboardState()"],
  },
  {
    id: "signin",
    title: "Sign-in & validation",
    file: "signin.html",
    blurb: "Trip validation, then sign in for real.",
    commands: [
      'click "#signin"',
      'get text "#error"',
      'fill "#email" "ada@x.com"',
      'fill "#password" "secret"',
      'click "#signin"',
    ],
  },
];

const activeIndex = ref(0);
const active = computed(() => EXAMPLES[activeIndex.value]);
const started = ref(false);
const status = ref({ kind: "idle", label: "Idle" });

const rootEl = ref(null);
const iframeEl = ref(null);
const termEl = ref(null);
// FRAME_VERSION is the Frame Agent bundle's content hash — versioning the page
// URLs with it busts every cached copy whenever src/frame changes.
const iframeSrc = computed(() => withBase("/demo/" + active.value.file + "?v=" + FRAME_VERSION));

// Non-reactive runtime handles.
const rt = shallowRef({
  host: null,
  session: null,
  agent: null,
  terminal: null,
  fit: null,
  resizeObs: null,
  connected: false,
  connectWaiters: [],
  input: "",
  history: [],
  historyIndex: null,
  running: false,
  mods: null,
});

const PROMPT = "$ ";
const C = { cyan: "[36m", dim: "[2m", green: "[32m", red: "[31m", reset: "[0m" };

function setStatus(kind, label) {
  status.value = { kind, label };
}

// ---- in-page CDP transport: answer registry methods locally, forward the rest
// to the icdp LocalSession (which routes to the Frame Agent in the iframe). ----
function makeTransport() {
  const sessionId = "icdp-session";
  return {
    async send(method, params = {}) {
      const r = rt.value;
      if (method === "Target.getTargets") {
        const t = r.host?.targets().find((x) => x.targetId === TARGET_ID);
        return {
          targetInfos: t
            ? [{ targetId: t.targetId, type: "page", title: t.title, url: t.url, attached: true }]
            : [],
        };
      }
      if (method === "Target.attachToTarget") {
        await ensureSession();
        return { sessionId };
      }
      if (method.startsWith("Target.")) return {};
      if (method === "Browser.getVersion") {
        return {
          protocolVersion: "1.3",
          product: "agent-browser-wasm",
          revision: "",
          userAgent: navigator.userAgent,
          jsVersion: "",
        };
      }
      const session = await ensureSession();
      return session.send(method, params);
    },
  };
}

function whenConnected() {
  const r = rt.value;
  if (r.connected) return Promise.resolve();
  return new Promise((resolve) => r.connectWaiters.push(resolve));
}

async function ensureSession() {
  const r = rt.value;
  if (r.session) return r.session;
  await whenConnected();
  r.session = r.host.attach(TARGET_ID);
  await r.session.send("Runtime.enable");
  await r.session.send("DOM.enable");
  await r.session.send("Accessibility.enable");
  return r.session;
}

async function ensureAgent() {
  const r = rt.value;
  if (r.agent) return r.agent;
  setStatus("loading", "Loading agent…");
  const { createAgentBrowser } = r.mods.wasm;
  r.agent = await createAgentBrowser({ transport: makeTransport() });
  setStatus("ready", "Connected");
  return r.agent;
}

function onTargetsEvent() {
  const r = rt.value;
  const t = r.host?.targets().find((x) => x.targetId === TARGET_ID);
  const connected = !!(t && t.url);
  if (connected && !r.connected) {
    r.connected = true;
    for (const w of r.connectWaiters.splice(0)) w();
    if (status.value.kind === "connecting" || status.value.kind === "loading")
      setStatus("ready", "Connected");
  }
  if (!connected) r.connected = false;
}

// ---- terminal ----
function writeln(t) {
  rt.value.terminal?.writeln(t);
}
function writePrompt() {
  rt.value.terminal?.write(PROMPT);
}

function seedTerminal() {
  const r = rt.value;
  if (!r.terminal) return;
  r.terminal.clear();
  writeln(C.dim + "agent-browser, compiled to WebAssembly." + C.reset);
  writeln(C.dim + "Driving the iframe over CDP — no server." + C.reset);
  writeln("");
  writeln(active.value.blurb);
  writeln("");
  writeln(C.dim + "Try these — press ↑ to recall, Enter to run:" + C.reset);
  for (const c of active.value.commands) writeln("  " + C.cyan + "agent-browser " + c + C.reset);
  writeln("");
  // Pre-load the suggestions into the input history so ↑ walks them top-to-bottom
  // (reversed: the up-arrow recalls from the end of the array first).
  r.history = active.value.commands.map((c) => `agent-browser ${c}`).reverse();
  r.historyIndex = null;
  r.input = "";
  writePrompt();
}

async function runLine(input) {
  const trimmed = input.trim();
  if (!trimmed) return;
  if (trimmed === "clear") {
    rt.value.terminal.clear();
    return;
  }
  if (trimmed !== "agent-browser" && !trimmed.startsWith("agent-browser ")) {
    writeln(C.red + 'try:  agent-browser <command>   (e.g. ' + active.value.commands[0] + ")" + C.reset);
    return;
  }
  const cmd = trimmed === "agent-browser" ? "" : trimmed.slice("agent-browser ".length).trim();
  const agent = await ensureAgent();
  const res = await agent.run(cmd);
  if (res.stdout) for (const line of res.stdout.replace(/\r\n/g, "\n").split("\n")) writeln(line);
  if (res.stderr)
    for (const line of res.stderr.replace(/\r\n/g, "\n").split("\n")) writeln(C.red + line + C.reset);
}

function setupTerminal() {
  const r = rt.value;
  const { Terminal } = r.mods.xterm;
  const { FitAddon } = r.mods.fit;
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'var(--vp-font-family-mono, "SF Mono", Menlo, Consolas, monospace)',
    fontSize: 12,
    lineHeight: 1.35,
    scrollback: 2000,
    theme: {
      background: "#0b0f14",
      foreground: "#dbe5ee",
      cursor: "#a8b1ff",
      selectionBackground: "#26384a",
      cyan: "#5ec8ff",
      green: "#7ee0a8",
      red: "#ff9b94",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(termEl.value);
  fit.fit();
  r.terminal = terminal;
  r.fit = fit;

  const redraw = () => terminal.write("\r[2K" + PROMPT + r.input);

  terminal.onData(async (data) => {
    if (r.running) {
      if (data === "") terminal.writeln("^C");
      return;
    }
    if (data === "\r") {
      const line = r.input;
      terminal.write("\r\n");
      r.input = "";
      r.historyIndex = null;
      if (line.trim()) {
        r.history.push(line);
        r.running = true;
        try {
          await runLine(line);
        } catch (e) {
          writeln(C.red + (e instanceof Error ? e.message : String(e)) + C.reset);
        } finally {
          r.running = false;
          writePrompt();
        }
      } else {
        writePrompt();
      }
      return;
    }
    if (data === "") {
      if (r.input.length > 0) {
        r.input = r.input.slice(0, -1);
        terminal.write("\b \b");
      }
      return;
    }
    if (data === "[A") {
      if (!r.history.length) return;
      r.historyIndex = r.historyIndex == null ? r.history.length - 1 : Math.max(0, r.historyIndex - 1);
      r.input = r.history[r.historyIndex] ?? "";
      redraw();
      return;
    }
    if (data === "[B") {
      if (!r.history.length || r.historyIndex == null) return;
      const next = r.historyIndex + 1;
      r.historyIndex = next >= r.history.length ? null : next;
      r.input = r.historyIndex == null ? "" : r.history[r.historyIndex] ?? "";
      redraw();
      return;
    }
    if (data >= " " && data !== "" && !data.startsWith("")) {
      r.input += data;
      terminal.write(data);
    }
  });

  const obs = new ResizeObserver(() => fit.fit());
  obs.observe(termEl.value);
  r.resizeObs = obs;
}

async function start() {
  if (started.value) return;
  started.value = true;
  setStatus("connecting", "Booting target…");
  await nextTick();

  const [host, wasm, xterm, fit] = await Promise.all([
    import("@olimsaidov/icdp/host"),
    import("@olimsaidov/agent-browser-wasm"),
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  await import("@xterm/xterm/css/xterm.css");
  const r = rt.value;
  r.mods = { host, wasm, xterm, fit };

  const icdpHost = new host.IcdpHost();
  r.host = icdpHost;
  icdpHost.onTargets(onTargetsEvent);
  icdpHost.pair(iframeEl.value, { targetId: TARGET_ID, origins: [window.location.origin] });
  onTargetsEvent();

  setupTerminal();
  seedTerminal();
}

function resetSession() {
  const r = rt.value;
  r.session?.detach();
  r.session = null;
  r.agent = null;
  r.connected = false;
  r.connectWaiters = [];
}

function selectExample(i) {
  if (i === activeIndex.value) return;
  activeIndex.value = i;
  if (!started.value) return;
  resetSession();
  setStatus("connecting", "Loading " + active.value.title + "…");
  if (iframeEl.value) iframeEl.value.src = iframeSrc.value;
  rt.value.terminal && nextTick(() => seedTerminal());
}

function reload() {
  if (!started.value || !iframeEl.value) return;
  resetSession();
  setStatus("connecting", "Reloading…");
  iframeEl.value.src = iframeSrc.value;
  nextTick(() => seedTerminal());
}

let io = null;

onMounted(() => {
  // Auto-launch when the demo scrolls into view — no launch screen, but the
  // ~1.4 MB (WASM + Frame Agent) stays off the initial page paint.
  if (!rootEl.value) {
    void start();
    return;
  }
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io?.disconnect();
        io = null;
        void start();
      }
    },
    { rootMargin: "300px 0px" },
  );
  io.observe(rootEl.value);
});

onBeforeUnmount(() => {
  io?.disconnect();
  const r = rt.value;
  r.resizeObs?.disconnect();
  r.terminal?.dispose();
  r.session?.detach();
  try {
    r.host?.unpair(TARGET_ID);
    r.host?.destroy();
  } catch {}
});
</script>

<template>
  <div ref="rootEl" class="ld-root">
    <div class="ld-tabs" role="tablist">
      <button
        v-for="(ex, i) in EXAMPLES"
        :key="ex.id"
        class="ld-tab"
        :class="{ active: i === activeIndex }"
        role="tab"
        :aria-selected="i === activeIndex"
        @click="selectExample(i)"
      >
        {{ ex.title }}
      </button>
    </div>

    <div class="ld-stage">
      <div class="ld-browser">
        <div class="ld-chrome">
          <span class="ld-dot red" /><span class="ld-dot amber" /><span class="ld-dot green" />
          <div class="ld-url">
            <span class="ld-url-text">/demo/{{ active.file }}</span>
            <button v-if="started" class="ld-reload" title="Reload target" @click="reload">
              <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
                <path
                  d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,0,1,16,0Z"
                />
              </svg>
            </button>
          </div>
        </div>
        <div class="ld-frame-wrap">
          <iframe v-if="started" ref="iframeEl" :src="iframeSrc" class="ld-frame" title="Demo target" />
          <div v-else class="ld-loading">
            <span class="ld-spinner" aria-hidden="true" />
            Starting agent-browser…
          </div>
        </div>
      </div>

      <div class="ld-terminal">
        <div class="ld-termhead">
          <span class="ld-eyebrow">agent-browser · wasm</span>
        </div>
        <div ref="termEl" class="ld-termsurface" />
      </div>
    </div>

    <p class="ld-note">
      The terminal is <strong>agent-browser compiled to WebAssembly</strong>, running in this tab. It
      speaks CDP to an <code>IcdpHost</code> that pairs the iframe — so commands drive a real,
      separate document with no server and no browser debugging session. That's icdp.
    </p>
  </div>
</template>

<style scoped>
.ld-root {
  margin: 8px 0 4px;
}

.ld-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.ld-tab {
  padding: 7px 13px;
  border: 1px solid var(--vp-c-border);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.ld-tab:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-text-1);
}
.ld-tab.active {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: #fff;
}

.ld-stage {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: stretch;
}

.ld-browser,
.ld-terminal {
  display: flex;
  flex-direction: column;
  height: 440px;
  border: 1px solid var(--vp-c-border);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 6px 24px rgba(16, 24, 40, 0.08);
}

.ld-chrome {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-border);
}
.ld-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.ld-dot.red {
  background: #ff5f57;
}
.ld-dot.amber {
  background: #febc2e;
}
.ld-dot.green {
  background: #28c840;
}
.ld-url {
  flex: 1;
  min-width: 0;
  margin-left: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 10px;
  border-radius: 7px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-border);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
}
.ld-url-text {
  flex: 1;
  min-width: 0;
  color: var(--vp-c-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ld-reload {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--vp-c-text-3);
  cursor: pointer;
  padding: 0;
}
.ld-reload:hover {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-brand-1);
}

.ld-frame-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  background: #fff;
}
.ld-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

.ld-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  font-size: 13px;
}
.ld-spinner {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2.5px solid var(--vp-c-divider);
  border-top-color: var(--vp-c-brand-1);
  animation: ld-spin 0.7s linear infinite;
}
@keyframes ld-spin {
  to {
    transform: rotate(360deg);
  }
}

.ld-terminal {
  background: #0b0f14;
}
.ld-termhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  background: #11161d;
  border-bottom: 1px solid #1e2630;
}
.ld-eyebrow {
  color: #7d8a99;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.ld-termsurface {
  flex: 1;
  min-height: 0;
  padding: 10px 12px;
}

.ld-note {
  margin: 14px 2px 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.6;
}

@media (max-width: 760px) {
  .ld-stage {
    grid-template-columns: 1fr;
  }
  .ld-browser,
  .ld-terminal {
    height: 380px;
  }
}
</style>
