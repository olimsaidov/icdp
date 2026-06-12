/**
 * Conformance suite ported from health-workspaces wmlet
 * (wmlet/cdp/tests/agent-browser-driver.e2e.test.ts), adapted to the icdp
 * topology: the fixture app runs CROSS-ORIGIN in an iframe inside a shell page
 * (Host), the real Relay serves the browser endpoint, and agent-browser is
 * both the real browser (host session opens the shell) and the CDP Client.
 *
 * Client attachment uses the per-command `--cdp <port>` flag: agent-browser
 * 0.27's session-bound `connect` no longer routes follow-up commands over the
 * connection (verified against real Chrome too). The daemon's page model syncs
 * from live CDP on the first `wait`, so the harness issues one before tests.
 */
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { rolldown } from "rolldown";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { serveRelay } from "../src/relay/node.ts";

type AgentCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: any;
};

type RunAgentOptions = {
  allowFailure?: boolean;
  json?: boolean;
  timeoutMs?: number;
};

type AgentHarness = {
  /** Origin of the embedded app (the iframe), which is what CDP observes. */
  origin: string;
  run: (args: string[], options?: RunAgentOptions) => Promise<AgentCommandResult>;
  reset: (path?: string) => Promise<void>;
  close: () => Promise<void>;
};

let frameScript = "";
let shellScript = "";
const activeSessions = new Set<string>();

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

beforeAll(async () => {
  frameScript = await bundleBrowser("tests/fixtures/frame-entry.ts");
  shellScript = await bundleBrowser("tests/fixtures/shell-entry.ts");
});

afterAll(async () => {
  for (const session of Array.from(activeSessions)) {
    await runAgent(session, ["close"], { allowFailure: true, json: false, timeoutMs: 10_000 });
  }
});

function agentSessionName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseJsonLine(stdout: string): any | undefined {
  const line = stdout
    .trim()
    .split(/\n/)
    .reverse()
    .find((item) => item.trim().startsWith("{"));
  if (!line) return undefined;
  return JSON.parse(line);
}

async function runAgent(
  session: string,
  args: string[],
  options: RunAgentOptions = {},
): Promise<AgentCommandResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const command = ["--session", session, ...(options.json === false ? [] : ["--json"]), ...args];

  const result = await new Promise<AgentCommandResult>((resolve) => {
    const proc = spawn("agent-browser", command, { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${error}`, json: undefined });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, json: parseJsonLine(stdout) });
    });
  });

  if (!options.allowFailure && result.exitCode !== 0) {
    throw new Error(
      `agent-browser ${args.join(" ")} failed with ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function shellHtml(appOrigin: string, relayWsUrl: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>icdp shell</title>
    <style>
      body { margin: 0; }
      #preview { display: block; width: 100vw; height: 100vh; border: 0; }
    </style>
  </head>
  <body>
    <iframe id="preview" src="${appOrigin}/"></iframe>
    <script>
      window.__ICDP_APP_ORIGIN = ${JSON.stringify(appOrigin)};
      window.__ICDP_RELAY_WS = ${JSON.stringify(relayWsUrl)};
    </script>
    <script type="module" src="/shell.js"></script>
  </body>
</html>`;
}

function fixtureHtml(shellOrigin: string): string {
  const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Agent Browser CDP Fixture</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; color: #111; }
      main { padding: 24px; }
      section { margin-block: 18px; }
      label { display: block; margin-block: 6px; }
      #fixture-form { display: flex; flex-direction: column; }
      section[aria-labelledby="buttons-heading"] { order: -1; }
      input, textarea, select, button, [contenteditable] { margin: 4px; }
      button, input, textarea, select, [contenteditable] { min-height: 28px; }
      #mouse-target { width: 150px; height: 54px; background: #dff3ff; border: 1px solid #177; }
      #scroll-box { width: 260px; height: 96px; overflow: auto; border: 1px solid #888; }
      #scroll-box-inner { height: 420px; padding-top: 330px; }
      #offscreen-area { height: 1200px; padding-top: 900px; }
      #state-output { display: block; white-space: pre-wrap; border: 1px solid #ddd; padding: 6px; }
      .vis-hidden { visibility: hidden; }
      .display-none { display: none; }
      table { border-collapse: collapse; }
      td, th { border: 1px solid #aaa; padding: 4px; }
    </style>
    <script>window.__ICDP_ALLOWED_PARENTS = [${JSON.stringify(shellOrigin)}];</script>
    <script type="module" src="/frame-agent.js"></script>
  </head>
  <body>
    <main>
      <h1>Agent Browser CDP Fixture</h1>
      <p id="ready-text">Fixture ready</p>

      <nav aria-label="Primary navigation">
        <a id="titled-link" href="/linked" target="_self" title="Titled Link">Titled destination</a>
        <a id="offscreen-link" href="/offscreen-target" title="Offscreen Link">Offscreen destination</a>
      </nav>

      <form id="fixture-form">
        <section aria-labelledby="inputs-heading">
          <h2 id="inputs-heading">Inputs</h2>
          <label for="email">Email</label>
          <input id="email" data-testid="email-input" type="email" value="initial@example.test" placeholder="Email address" required aria-describedby="email-help">
          <span id="email-help">Email help text</span>

          <label>Wrapped Name <input id="wrapped-name" type="text" value="Wrapped"></label>
          <input id="password" type="password" aria-label="Password" value="secret">
          <input id="search" type="search" aria-label="Search" placeholder="Search catalog">
          <input id="url" type="url" aria-label="Profile URL" value="https://example.test/profile">
          <input id="tel" type="tel" aria-label="Phone" value="+15550100">
          <input id="number" type="number" aria-label="Quantity" min="0" max="10" value="2">
          <input id="date" type="date" aria-label="Visit date" value="2026-05-04">
          <input id="time" type="time" aria-label="Visit time" value="09:30">
          <textarea id="notes" aria-label="Visit notes" placeholder="Notes placeholder">Initial note</textarea>
          <div id="labelledby-text">Labelled by text</div>
          <input id="labelledby-input" aria-labelledby="labelledby-text" value="labelled">
          <input id="title-input" title="Title input" value="title value">
        </section>

        <section aria-labelledby="choices-heading">
          <h2 id="choices-heading">Choices</h2>
          <label><input id="follow-up" type="checkbox" aria-label="Follow-up required"> Follow-up required</label>
          <label><input id="checked-choice" type="checkbox" aria-label="Checked choice" checked> Checked choice</label>
          <label><input id="disabled-choice" type="checkbox" aria-label="Disabled choice" disabled> Disabled choice</label>
          <label><input id="required-choice" type="checkbox" aria-label="Required choice" required> Required choice</label>
          <div id="aria-disabled-choice" role="checkbox" aria-label="Aria disabled choice" aria-disabled="true" aria-checked="false" tabindex="0">Aria disabled choice</div>
          <label><input id="routine-radio" type="radio" name="urgency" aria-label="Routine" checked> Routine</label>
          <label><input id="urgent-radio" type="radio" name="urgency" aria-label="Urgent"> Urgent</label>
          <select id="care-team" aria-label="Care team">
            <option value="medical" selected>Medical</option>
            <option value="social">Social Work</option>
            <option value="blocked" disabled>Blocked</option>
          </select>
          <select id="tags" aria-label="Tags" multiple>
            <option value="alpha">Alpha</option>
            <option value="beta">Beta</option>
            <option value="gamma" disabled>Gamma</option>
          </select>
        </section>

        <section aria-labelledby="buttons-heading">
          <h2 id="buttons-heading">Buttons</h2>
          <button id="role-action" type="button">Role Action</button>
          <button id="text-action" type="button">Text Action</button>
          <button id="title-action" type="button" title="Titled action">Title Action</button>
          <button id="test-action" data-testid="test-action" type="button">Test ID Action</button>
          <button class="item-action" id="first-item" type="button">First Item</button>
          <button class="item-action" id="middle-item" type="button">Middle Item</button>
          <button class="item-action" id="last-item" type="button">Last Item</button>
          <button id="disabled-button" type="button" disabled>Disabled Button</button>
          <button id="aria-save" type="button" aria-label="Aria Save"><span aria-hidden="true">*</span></button>
          <button id="icon-only" type="button" aria-label="Icon only action"><span aria-hidden="true">#</span></button>
          <button id="image-action" type="button"><img alt="Image action" src="${pixel}" width="12" height="12"></button>
          <button id="submit-button" data-testid="submit-btn" type="submit">Submit form</button>
          <button id="reset-button" type="reset">Reset form</button>
        </section>
      </form>

      <section aria-labelledby="content-heading">
        <h2 id="content-heading">Content</h2>
        <article aria-label="Article landmark">
          <p id="copy">Stable copy for get text.</p>
          <div id="html-target"><span data-part="inner">Inner HTML</span></div>
          <ul><li>Alpha item</li><li>Beta item</li></ul>
          <table aria-label="Vitals table"><tr><th>Name</th><th>Value</th></tr><tr><td>Pulse</td><td>72</td></tr></table>
          <details id="details"><summary>Details summary</summary><p>Details body</p></details>
          <div id="editable" contenteditable="true" role="textbox" aria-label="Editable notes"></div>
          <dialog id="native-dialog" aria-label="Native Dialog"><p>Dialog body</p></dialog>
          <div id="drag-source" draggable="true">Drag source</div>
          <div id="drop-target">Drop target</div>
          <shadow-control></shadow-control>
          <iframe id="fixture-frame" title="Fixture frame" srcdoc="<button>Frame action</button>"></iframe>
        </article>
      </section>

      <section aria-labelledby="hidden-heading">
        <h2 id="hidden-heading">Hidden cases</h2>
        <button id="hidden-attr" hidden>Hidden attr action</button>
        <button id="display-none" class="display-none">Display none action</button>
        <button id="visibility-hidden" class="vis-hidden">Visibility hidden action</button>
        <div inert><button id="inert-action">Inert action</button></div>
        <div aria-hidden="true"><button id="aria-hidden-action">Aria hidden action</button></div>
      </section>

      <section aria-labelledby="interaction-heading">
        <h2 id="interaction-heading">Interaction state</h2>
        <button id="mouse-target" type="button">Mouse Target</button>
        <input id="keyboard-input" aria-label="Keyboard input" value="">
        <div id="scroll-box"><div id="scroll-box-inner"><button id="scroll-box-button" type="button">Scroll Box Button</button></div></div>
        <output id="state-output" data-testid="state-output"></output>
      </section>

      <div id="offscreen-area">
        <label for="offscreen-input">Offscreen control</label>
        <input id="offscreen-input" value="offscreen">
      </div>
    </main>

    <script>
      const previousLoad = Number(window.name);
      window.name = String(Number.isFinite(previousLoad) ? previousLoad + 1 : 1);
      window.__fixture = {
        ready: true,
        clicks: {},
        dblClicks: 0,
        hover: false,
        focus: "",
        submits: 0,
        inputs: [],
        changes: [],
        keys: [],
        mouse: { moves: 0, downs: 0, ups: 0, wheels: 0 },
      };
      const stateOutput = document.getElementById("state-output");
      function recordClick(id) {
        window.__fixture.clicks[id] = (window.__fixture.clicks[id] || 0) + 1;
        renderState();
      }
      function renderState() {
        stateOutput.textContent = JSON.stringify(window.fixtureState());
      }
      window.fixtureState = () => ({
        ...window.__fixture,
        loadCount: Number(window.name),
        url: location.href,
        email: document.getElementById("email").value,
        search: document.getElementById("search").value,
        notes: document.getElementById("notes").value,
        keyboard: document.getElementById("keyboard-input").value,
        editable: document.getElementById("editable").textContent,
        followUp: document.getElementById("follow-up").checked,
        checkedChoice: document.getElementById("checked-choice").checked,
        urgent: document.getElementById("urgent-radio").checked,
        careTeam: document.getElementById("care-team").value,
        tags: Array.from(document.getElementById("tags").selectedOptions).map((option) => option.value),
        scrollY: window.scrollY,
        scrollBoxTop: document.getElementById("scroll-box").scrollTop,
        offscreenTop: Math.round(document.getElementById("offscreen-input").getBoundingClientRect().top),
      });
      customElements.define("shadow-control", class extends HTMLElement {
        connectedCallback() {
          if (this.shadowRoot) return;
          this.attachShadow({ mode: "open" }).innerHTML = '<button id="shadow-action" type="button">Shadow Action</button>';
          this.shadowRoot.getElementById("shadow-action").addEventListener("click", () => recordClick("shadow-action"));
        }
      });
      for (const button of document.querySelectorAll("button")) {
        button.addEventListener("click", () => recordClick(button.id || button.textContent.trim()));
        button.addEventListener("dblclick", () => { window.__fixture.dblClicks += 1; renderState(); });
        button.addEventListener("mouseenter", () => { if (button.id === "mouse-target" || button.id === "role-action") window.__fixture.hover = true; renderState(); });
        button.addEventListener("focus", () => { window.__fixture.focus = button.id; renderState(); });
      }
      for (const control of document.querySelectorAll("input, textarea, select, [contenteditable]")) {
        control.addEventListener("focus", () => { window.__fixture.focus = control.id; renderState(); });
        control.addEventListener("input", () => { window.__fixture.inputs.push(control.id); renderState(); });
        control.addEventListener("change", () => { window.__fixture.changes.push(control.id); renderState(); });
      }
      document.getElementById("fixture-form").addEventListener("submit", (event) => {
        event.preventDefault();
        window.__fixture.submits += 1;
        renderState();
      });
      document.addEventListener("keydown", (event) => { window.__fixture.keys.push("down:" + event.key); renderState(); });
      document.addEventListener("keyup", (event) => { window.__fixture.keys.push("up:" + event.key); renderState(); });
      document.addEventListener("mousemove", () => { window.__fixture.mouse.moves += 1; renderState(); });
      document.addEventListener("mousedown", () => { window.__fixture.mouse.downs += 1; renderState(); });
      document.addEventListener("mouseup", () => { window.__fixture.mouse.ups += 1; renderState(); });
      document.addEventListener("wheel", () => { window.__fixture.mouse.wheels += 1; renderState(); }, { passive: true });
      renderState();
    </script>
  </body>
</html>`;
}

function sendJs(response: ServerResponse, source: string): void {
  response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
  response.end(source);
}

function sendHtml(response: ServerResponse, source: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(source);
}

async function createHarness(): Promise<AgentHarness> {
  const hostSession = agentSessionName("icdp-shell");
  const targetSession = agentSessionName("icdp-target");
  activeSessions.add(hostSession);
  activeSessions.add(targetSession);

  let appOrigin = "";
  let shellOrigin = "";

  const relay = await serveRelay({
    product: "icdp-e2e/0.1",
    fallback: (request, response) => {
      const url = new URL(request.url ?? "/", "http://shell");
      if (url.pathname === "/shell.js") return sendJs(response, shellScript);
      sendHtml(response, shellHtml(appOrigin, relay.hostWsUrl));
    },
  });

  const appServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://app");
    if (url.pathname === "/frame-agent.js") return sendJs(response, frameScript);
    sendHtml(response, fixtureHtml(shellOrigin));
  });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));

  shellOrigin = `http://127.0.0.1:${relay.port}`;
  appOrigin = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

  async function status(): Promise<{
    hostConnected: boolean;
    targets: Array<{ targetId: string; url: string }>;
  }> {
    const response = await fetch(`${shellOrigin}/icdp/status`);
    return (await response.json()) as {
      hostConnected: boolean;
      targets: Array<{ targetId: string; url: string }>;
    };
  }

  async function waitForTargetUrl(
    predicate: (url: string) => boolean,
    what: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const start = Date.now();
    while (true) {
      const current = await status();
      const url = current.targets[0]?.url ?? "";
      if (current.hostConnected && predicate(url)) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${what}; status: ${JSON.stringify(current)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function close(): Promise<void> {
    await runAgent(targetSession, ["close"], {
      allowFailure: true,
      json: false,
      timeoutMs: 10_000,
    });
    await runAgent(hostSession, ["close"], { allowFailure: true, json: false, timeoutMs: 10_000 });
    activeSessions.delete(targetSession);
    activeSessions.delete(hostSession);
    appServer.closeAllConnections();
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await relay.stop();
  }

  // Real browser loads the shell; the shell's Host pairs with the cross-origin
  // iframe and uplinks to the Relay.
  const openShell = await runAgent(hostSession, ["open", shellOrigin, "--headed", "false"], {
    timeoutMs: 60_000,
  });
  expect(openShell.json?.success).toBe(true);
  await waitForTargetUrl((url) => url.startsWith(appOrigin), "frame agent pairing");

  // Every target-session command attaches through the Relay's browser endpoint.
  const cdpArgs = ["--cdp", String(relay.port)];
  const run = (args: string[], options?: RunAgentOptions) =>
    runAgent(targetSession, [...cdpArgs, ...args], options);

  // First command syncs the daemon's page model from the live target.
  const sync = await run(["wait", "--text", "Fixture ready"], { timeoutMs: 30_000 });
  expect(sync.json?.success).toBe(true);

  return {
    origin: appOrigin,
    run,
    reset: async (path = "/") => {
      const destination = `${appOrigin}${path}`;
      const open = await run(["open", destination], { allowFailure: true, timeoutMs: 30_000 });
      if (!open.json?.success) {
        // Fall back to navigating from inside the page.
        const response = await run([
          "eval",
          `location.href = ${JSON.stringify(destination)}; "navigating"`,
        ]);
        expect(response.json?.success).toBe(true);
      }
      await waitForTargetUrl((url) => url.startsWith(destination), `navigation to ${path}`);
      const resync = await run(["wait", "--text", "Fixture ready"], { timeoutMs: 30_000 });
      expect(resync.json?.success).toBe(true);
    },
    close,
  };
}

function refByRoleName(snapshot: any, role: string, name: string): string {
  for (const [id, ref] of Object.entries(snapshot.data.refs) as Array<[string, any]>) {
    if (ref.role === role && ref.name === name) return `@${id}`;
  }
  throw new Error(`No ${role} ref named ${name} in snapshot:\n${snapshot.data.snapshot}`);
}

async function evalValue(harness: AgentHarness, expression: string): Promise<any> {
  const response = await harness.run(["eval", expression]);
  expect(response.json?.success).toBe(true);
  return response.json.data.result;
}

async function fixtureState(harness: AgentHarness): Promise<any> {
  return await evalValue(harness, "window.fixtureState()");
}

describe("agent-browser against icdp (cross-origin iframe through relay + host)", () => {
  test("connects, snapshots refs and AX states, and uses snapshot refs for actions", async () => {
    const harness = await createHarness();
    try {
      const snapshot = await harness.run(["snapshot", "-i"]);
      expect(snapshot.json?.success).toBe(true);
      expect(snapshot.json.data.snapshot).toContain("Agent Browser CDP Fixture");
      expect(snapshot.json.data.snapshot).toContain('button "Aria Save"');
      expect(snapshot.json.data.snapshot).toContain('textbox "Email"');
      expect(snapshot.json.data.snapshot).toContain('checkbox "Checked choice"');
      expect(snapshot.json.data.snapshot).toContain("disabled");
      expect(snapshot.json.data.snapshot).toContain("initial@example.test");
      expect(snapshot.json.data.snapshot).not.toContain("Display none action");
      expect(snapshot.json.data.snapshot).not.toContain("Inert action");
      expect(snapshot.json.data.snapshot).not.toContain("Aria hidden action");

      const actionRef = refByRoleName(snapshot.json, "button", "Role Action");
      const emailRef = refByRoleName(snapshot.json, "textbox", "Email");
      const searchRef = refByRoleName(snapshot.json, "searchbox", "Search");
      const followRef = refByRoleName(snapshot.json, "checkbox", "Follow-up required");
      const teamRef = refByRoleName(snapshot.json, "combobox", "Care team");

      expect((await harness.run(["click", actionRef])).json?.success).toBe(true);
      expect((await harness.run(["fill", emailRef, "ref@example.test"])).json?.success).toBe(true);
      expect((await harness.run(["type", searchRef, "alpha"])).json?.success).toBe(true);
      expect((await harness.run(["check", followRef])).json?.success).toBe(true);
      expect((await harness.run(["select", teamRef, "social"])).json?.success).toBe(true);

      const state = await fixtureState(harness);
      expect(state.clicks["role-action"]).toBe(1);
      expect(state.email).toBe("ref@example.test");
      expect(state.search).toBe("alpha");
      expect(state.followUp).toBe(true);
      expect(state.careTeam).toBe("social");
    } finally {
      await harness.close();
    }
  }, 120_000);

  test("supports semantic locators without snapshot refs", async () => {
    const harness = await createHarness();
    try {
      const commands = [
        ["find", "role", "button", "click", "--name", "Role Action"],
        ["find", "text", "Text Action", "click", "--exact"],
        ["find", "label", "Email", "fill", "semantic@example.test"],
        ["find", "placeholder", "Search catalog", "fill", "semantic"],
        ["find", "alt", "Image action", "click"],
        ["find", "title", "Titled action", "click"],
        ["find", "testid", "test-action", "click"],
        ["find", "first", ".item-action", "click"],
        ["find", "last", ".item-action", "click"],
        ["find", "nth", "1", ".item-action", "click"],
      ];
      for (const command of commands) {
        const response = await harness.run(command);
        expect(response.json?.success, command.join(" ")).toBe(true);
      }

      const state = await fixtureState(harness);
      expect(state.clicks["role-action"]).toBe(1);
      expect(state.clicks["text-action"]).toBe(1);
      expect(state.email).toBe("semantic@example.test");
      expect(state.search).toBe("semantic");
      expect(state.clicks["image-action"]).toBe(1);
      expect(state.clicks["title-action"]).toBe(1);
      expect(state.clicks["test-action"]).toBe(1);
      expect(state.clicks["first-item"]).toBe(1);
      expect(state.clicks["middle-item"]).toBe(1);
      expect(state.clicks["last-item"]).toBe(1);
    } finally {
      await harness.close();
    }
  }, 120_000);

  test("returns page data and element state through get and is commands", async () => {
    const harness = await createHarness();
    try {
      expect((await harness.run(["get", "title"])).json?.data.title).toBe(
        "Agent Browser CDP Fixture",
      );
      expect((await harness.run(["get", "url"])).json?.data.url).toBe(`${harness.origin}/`);
      expect((await harness.run(["get", "text", "#copy"])).json?.data.text).toBe(
        "Stable copy for get text.",
      );
      expect((await harness.run(["get", "html", "#html-target"])).json?.data.html).toContain(
        "Inner HTML",
      );
      expect((await harness.run(["get", "value", "#email"])).json?.data.value).toBe(
        "initial@example.test",
      );
      expect((await harness.run(["get", "attr", "#titled-link", "title"])).json?.data.value).toBe(
        "Titled Link",
      );
      expect((await harness.run(["get", "count", "button"])).json?.data.count).toBeGreaterThan(10);

      const box = (await harness.run(["get", "box", "#role-action"])).json?.data;
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
      const styles = (await harness.run(["get", "styles", "#role-action"])).json?.data.styles;
      expect(styles.display).toBe("inline-block");

      expect((await harness.run(["is", "visible", "#role-action"])).json?.data.visible).toBe(true);
      expect((await harness.run(["is", "visible", "#display-none"])).json?.data.visible).toBe(
        false,
      );
      expect((await harness.run(["is", "enabled", "#role-action"])).json?.data.enabled).toBe(true);
      expect((await harness.run(["is", "enabled", "#disabled-button"])).json?.data.enabled).toBe(
        false,
      );
      expect((await harness.run(["is", "checked", "#checked-choice"])).json?.data.checked).toBe(
        true,
      );
      expect((await harness.run(["is", "checked", "#follow-up"])).json?.data.checked).toBe(false);
    } finally {
      await harness.close();
    }
  }, 120_000);

  test("drives keyboard, mouse, scroll, waits, runtime eval, and navigation", async () => {
    const harness = await createHarness();
    try {
      expect((await harness.run(["wait", "#email"])).json?.success).toBe(true);
      expect((await harness.run(["wait", "--text", "Fixture ready"])).json?.success).toBe(true);
      expect(
        (await harness.run(["wait", "--fn", "window.fixtureState().ready === true"])).json?.success,
      ).toBe(true);
      expect((await harness.run(["wait", "--load", "domcontentloaded"])).json?.success).toBe(true);

      expect((await harness.run(["focus", "#keyboard-input"])).json?.success).toBe(true);
      expect((await harness.run(["keyboard", "type", "abc"])).json?.success).toBe(true);
      expect((await harness.run(["keyboard", "inserttext", "!"])).json?.success).toBe(true);
      expect((await harness.run(["press", "Backspace"])).json?.success).toBe(true);
      expect((await harness.run(["keydown", "Shift"])).json?.success).toBe(true);
      expect((await harness.run(["keyup", "Shift"])).json?.success).toBe(true);
      let state = await fixtureState(harness);
      expect(state.keyboard).toBe("abc");
      expect(state.keys).toContain("down:Shift");
      expect(state.keys).toContain("up:Shift");

      expect((await harness.run(["scrollintoview", "#role-action"])).json?.success).toBe(true);
      expect((await harness.run(["hover", "#role-action"])).json?.success).toBe(true);
      expect((await harness.run(["dblclick", "#role-action"])).json?.success).toBe(true);
      const mouseBox = (await harness.run(["get", "box", "#mouse-target"])).json?.data;
      expect(
        (
          await harness.run([
            "mouse",
            "move",
            String(Math.round(mouseBox.x)),
            String(Math.round(mouseBox.y)),
          ])
        ).json?.success,
      ).toBe(true);
      expect((await harness.run(["mouse", "down"])).json?.success).toBe(true);
      expect((await harness.run(["mouse", "up"])).json?.success).toBe(true);
      expect((await harness.run(["mouse", "wheel", "240"])).json?.success).toBe(true);
      state = await fixtureState(harness);
      expect(state.hover).toBe(true);
      expect(state.dblClicks).toBeGreaterThan(0);
      expect(state.mouse.moves).toBeGreaterThan(0);
      expect(state.mouse.downs).toBeGreaterThan(0);
      expect(state.mouse.ups).toBeGreaterThan(0);
      expect(state.mouse.wheels).toBeGreaterThan(0);

      expect((await harness.run(["scroll", "down", "500"])).json?.success).toBe(true);
      expect((await harness.run(["scrollintoview", "#offscreen-input"])).json?.success).toBe(true);
      state = await fixtureState(harness);
      expect(state.scrollY).toBeGreaterThan(0);
      expect(state.offscreenTop).toBeLessThan(700);

      expect(await evalValue(harness, "document.getElementById('email').value")).toBe(
        "initial@example.test",
      );
      await harness.reset("/nav-a");
      expect((await harness.run(["wait", "--url", "nav-a"])).json?.success).toBe(true);
      expect(
        await evalValue(harness, "history.pushState({}, '', '/nav-b?from=push'); location.href"),
      ).toContain("/nav-b?from=push");
      expect((await harness.run(["wait", "--url", "nav-b?from=push"])).json?.success).toBe(true);
      expect((await harness.run(["back"])).json?.success).toBe(true);
      expect((await harness.run(["wait", "--url", "nav-a"])).json?.success).toBe(true);
      expect((await harness.run(["forward"])).json?.success).toBe(true);
      expect((await harness.run(["wait", "--url", "nav-b?from=push"])).json?.success).toBe(true);
      const beforeReload = (await fixtureState(harness)).loadCount;
      expect((await harness.run(["reload"])).json?.success).toBe(true);
      expect((await harness.run(["wait", "--load", "domcontentloaded"])).json?.success).toBe(true);
      expect((await fixtureState(harness)).loadCount).toBeGreaterThan(beforeReload);
    } finally {
      await harness.close();
    }
  }, 120_000);

  test("updates checkbox, radio, select, textarea, and contenteditable state", async () => {
    const harness = await createHarness();
    try {
      expect((await harness.run(["check", "#follow-up"])).json?.success).toBe(true);
      expect((await harness.run(["uncheck", "#checked-choice"])).json?.success).toBe(true);
      expect((await harness.run(["check", "#urgent-radio"])).json?.success).toBe(true);
      expect((await harness.run(["select", "#care-team", "social"])).json?.success).toBe(true);
      expect((await harness.run(["select", "#tags", "alpha", "beta"])).json?.success).toBe(true);
      expect((await harness.run(["fill", "#notes", "Updated note"])).json?.success).toBe(true);
      expect((await harness.run(["focus", "#editable"])).json?.success).toBe(true);
      expect((await harness.run(["keyboard", "inserttext", "Editable text"])).json?.success).toBe(
        true,
      );

      const state = await fixtureState(harness);
      expect(state.followUp).toBe(true);
      expect(state.checkedChoice).toBe(false);
      expect(state.urgent).toBe(true);
      expect(state.careTeam).toBe("social");
      expect(state.tags).toEqual(["alpha", "beta"]);
      expect(state.notes).toBe("Updated note");
      expect(state.editable).toBe("Editable text");
    } finally {
      await harness.close();
    }
  }, 120_000);

  test("fails gracefully for commands outside the supported CDP surface", async () => {
    const harness = await createHarness();
    try {
      const screenshot = await harness.run(["screenshot"], { allowFailure: true });
      expect(screenshot.exitCode).not.toBe(0);
      expect(screenshot.stdout + screenshot.stderr).toContain("Method not found");

      const pdf = await harness.run(["pdf", "/tmp/icdp-e2e.pdf"], { allowFailure: true });
      expect(pdf.exitCode).not.toBe(0);
      expect(pdf.stdout + pdf.stderr).toContain("Method not found");

      const frame = await harness.run(["frame", "#fixture-frame"], { allowFailure: true });
      expect(frame.exitCode).not.toBe(0);
      expect(frame.stdout + frame.stderr).toMatch(/frame|Method not found|not found/i);

      // agent-browser 0.27 added pushstate (0.26 lacked it, per the prior art's
      // matrix); it drives SPA history through eval, which the Frame Agent supports.
      const pushstate = await harness.run(["pushstate", "/pushed"]);
      expect(pushstate.json?.success).toBe(true);
      expect((await harness.run(["wait", "--url", "pushed"])).json?.success).toBe(true);
    } finally {
      await harness.close();
    }
  }, 120_000);
});
