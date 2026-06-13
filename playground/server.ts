/**
 * icdp playground: a shell (Host) on the relay's port embedding two
 * cross-origin app targets, ready to be driven with agent-browser.
 *
 *   npm run playground
 *   open http://127.0.0.1:9222          <- the shell
 *   agent-browser --cdp 9222 wait --text "icdp Playground"
 */
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rolldown } from "rolldown";

import { serveRelay } from "../src/relay/node.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RELAY_PORT = Number(process.env.ICDP_PLAYGROUND_PORT ?? 9222);
const APP_PORT = RELAY_PORT + 1;
const SHELL_ORIGIN = `http://127.0.0.1:${RELAY_PORT}`;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

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

console.log("bundling shell and frame agent…");
const shellScript = await bundleBrowser(join(here, "shell-entry.ts"));
const frameScript = await bundleBrowser(join(here, "frame-entry.ts"));

function sendText(response: ServerResponse, contentType: string, body: string): void {
  response.writeHead(200, { "Content-Type": contentType });
  response.end(body);
}

function page(name: string): string {
  return readFileSync(join(here, "pages", name), "utf8")
    .replaceAll("{{APP_ORIGIN}}", APP_ORIGIN)
    .replaceAll("{{SHELL_ORIGIN}}", SHELL_ORIGIN)
    .replaceAll("{{RELAY_PORT}}", String(RELAY_PORT))
    .replaceAll("{{RELAY_WS}}", `ws://127.0.0.1:${RELAY_PORT}/icdp/host`);
}

const relay = await serveRelay({
  port: RELAY_PORT,
  product: "icdp-playground/0.1",
  fallback: (request, response) => {
    const url = new URL(request.url ?? "/", SHELL_ORIGIN);
    if (url.pathname === "/shell.js")
      return sendText(response, "application/javascript; charset=utf-8", shellScript);
    if (url.pathname === "/favicon.ico") return sendText(response, "text/plain", "");
    sendText(response, "text/html; charset=utf-8", page("shell.html"));
  },
});

const appServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", APP_ORIGIN);
  if (url.pathname === "/frame-agent.js")
    return sendText(response, "application/javascript; charset=utf-8", frameScript);
  if (url.pathname === "/favicon.ico") return sendText(response, "text/plain", "");
  if (url.pathname === "/todo")
    return sendText(response, "text/html; charset=utf-8", page("todo.html"));
  if (url.pathname === "/page-two")
    return sendText(response, "text/html; charset=utf-8", page("page-two.html"));
  sendText(response, "text/html; charset=utf-8", page("app.html"));
});
await new Promise<void>((resolve) => appServer.listen(APP_PORT, "127.0.0.1", resolve));

console.log(`
icdp playground is up.

  shell (open in your browser):   ${SHELL_ORIGIN}
  app (cross-origin, in iframes): ${APP_ORIGIN}
  CDP browser endpoint:           ${relay.browserWsUrl}
  status:                         ${SHELL_ORIGIN}/icdp/status

Drive it with agent-browser (one wait first to sync its page model):

  agent-browser open ${SHELL_ORIGIN}              # or open the shell in any browser
  agent-browser --session cdp --cdp ${RELAY_PORT} wait --text "icdp Playground"
  agent-browser --session cdp --cdp ${RELAY_PORT} snapshot -i
  agent-browser --session cdp --cdp ${RELAY_PORT} find role button click --name "Load lab results (1.5s)"
  agent-browser --session cdp --cdp ${RELAY_PORT} wait --text "Lab results loaded"
  agent-browser --session cdp --cdp ${RELAY_PORT} eval "window.playgroundState()"

Open and close Targets from the Client (Target.createTarget / closeTarget):

  agent-browser --session cdp --cdp ${RELAY_PORT} tab new ${APP_ORIGIN}/page-two
  agent-browser --session cdp --cdp ${RELAY_PORT} tab list
  agent-browser --session cdp --cdp ${RELAY_PORT} tab close t3

Things to try: forms, SPA tabs (pushstate/back/forward), async waits, console
buttons (watch the shell's local console panel), hidden-element snapshots,
scroll/offscreen, the second "todo" target, opening/closing targets from the
Client (they join the same targets grid), and the shell's Reload / Unpair
buttons for target lifecycle. ICDP_DEBUG=1 logs all relay traffic.
`);
