# icdp

Chrome DevTools Protocol over an iframe boundary. External CDP tools (agent-browser, chrome-remote-interface, Playwright best-effort) drive and inspect an app embedded in an iframe — including a **cross-origin** iframe — without a real browser debugging session.

```
agent-browser / CDP client
        │  WebSocket (standard CDP, flat sessions)
        ▼
      Relay   ←  @olimsaidov/icdp/relay  (+ /relay/node)   server
        │  WebSocket (bridge protocol)
        ▼
      Host    ←  @olimsaidov/icdp/host                     parent window
        │  MessagePort (per iframe)
        ▼
  Frame Agent ←  @olimsaidov/icdp/frame                    inside the iframe'd app
```

See `CONTEXT.md` for the project language (Frame Agent, Host, Relay, Client, Target, Pairing) and `docs/adr/` for architectural decisions.

## The three pieces

### Frame Agent — in the embedded app

The app under automation includes the agent itself (cooperative embedding — the Host never injects):

```ts
import { startFrameAgent } from "@olimsaidov/icdp/frame";

startFrameAgent({ allowedParents: ["https://shell.example.com"] });
```

The agent announces itself to the parent on boot and stays dormant unless the parent's origin is allowlisted. `allowedParents: "*"` hands DOM read/write/eval to **any** embedder — only for sandboxed or throwaway pages.

### Host — in the parent window

```ts
import { IcdpHost } from "@olimsaidov/icdp/host";

const host = new IcdpHost();
host.pair(iframeElement, { targetId: "preview", origins: ["https://app.example.com"] });

// Local consumption — no server needed (e.g. a console panel):
const session = host.attach("preview");
session.onEvent((method, params) => {
  /* Runtime.consoleAPICalled, ... */
});
await session.send("Runtime.enable");

// Forward everything to a Relay so external tools can connect:
const disconnect = host.connectRelay({ url: "ws://localhost:9222/icdp/host" });
```

Target identity belongs to the Pairing: reloads and navigations keep the same `targetId` (Clients see `Page.frameNavigated`); commands in flight when a document dies fail fast with `-32000`. The Relay uplink is just another consumer of the same hub — events broadcast to all attached sessions, domain enables are ref-counted.

### Relay — the server

```ts
import { serveRelay } from "@olimsaidov/icdp/relay/node";

const relay = await serveRelay({ port: 9222 });
console.log(relay.browserWsUrl); // ws://127.0.0.1:9222/devtools/browser  ← CDP clients
console.log(relay.hostWsUrl); // ws://127.0.0.1:9222/icdp/host         ← Host uplink
```

The Node adapter is built on `node:http` + `ws`. The runtime-agnostic core (`@olimsaidov/icdp/relay` → `RelayCore`) takes plain `{ send, close }` sockets, so other runtimes only need a thin adapter. HTTP discovery: `/json/version`, `/json/list`, `/icdp/status`.

One Host per Relay, new-wins: a newly connecting Host replaces a stale one, with `targetDestroyed`/`targetCreated` churn surfaced to attached Clients.

## Protocol shape

- **Flat sessions only.** Clients connect to the single browser-level endpoint and use `Target.getTargets` / `Target.attachToTarget` (or `Target.setAutoAttach`) + `sessionId` routing. There are no per-target WebSocket URLs. Session-scoped `Target.*`/`Browser.*` housekeeping (e.g. agent-browser's session-scoped `Target.setAutoAttach`) is answered by the Relay; the Frame Agent never sees it.
- **Compatibility bar: agent-browser.** The supported command surface is the prior art's support matrix (AX-tree snapshots, semantic locators, click/fill/type, eval, waits, console, SPA history). Screenshots, PDF, file uploads, drag-and-drop, dialogs, and real network interception are intentionally out — page JavaScript cannot provide them. Raw Playwright over `connectOverCDP` is best-effort, not promised.

## Driving an icdp target with agent-browser

Use the per-command `--cdp <relay port>` flag, and issue one `wait` first to sync agent-browser's page model from the live target:

```sh
agent-browser --cdp 9222 wait --text "My App"   # first command: syncs the model
agent-browser --cdp 9222 snapshot -i
agent-browser --cdp 9222 find role button click --name "Save"
```

Do not use `agent-browser connect <ws-url>`: as of agent-browser 0.27.x the session-bound connect no longer routes follow-up commands over the connection (this reproduces against real Chrome too, both browser and page endpoints — it is not an icdp limitation).

## Playground

`npm run playground` starts a runnable demo of the full topology — see [playground/README.md](./playground/README.md).

## Development

Node ≥22, VoidZero tooling (Vitest, oxlint, oxfmt, tsdown/Rolldown):

```sh
npm install
npm test             # unit + in-process integration (vitest)
npm run test:e2e     # conformance suite (needs agent-browser CLI + Chrome, ~90s)
npm run test:all     # everything
npm run check        # tsc + oxlint + oxfmt --check
npm run fmt          # oxfmt
npm run build        # tsdown -> dist/
```

The e2e conformance suite (ported from the prior art) drives the full chain with a real browser: agent-browser opens a shell page whose Host pairs with a **cross-origin** iframe running the Frame Agent, uplinked to a real Relay; a second agent-browser session then exercises snapshots, semantic locators, keyboard/mouse, navigation, and graceful failures through `--cdp`. Set `ICDP_DEBUG=1` to log all relay traffic.
