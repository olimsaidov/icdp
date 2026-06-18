# icdp playground

A runnable demo of the full icdp topology, ready to be driven with agent-browser.

```sh
npm run playground
```

Starts everything on fixed ports: a shell page (Host) at `http://127.0.0.1:3000`, a private CDP endpoint on port `9222`, and **two cross-origin targets** from `http://127.0.0.1:3001`:

- **`playground`** — a feature-dense app: forms of every input type, SPA tabs via `history.pushState`, async zones (delayed lab results, toast, late-appearing button), console buttons, shadow DOM, a nested srcdoc iframe, hidden cases that must _not_ appear in snapshots, mouse pad / scroll boxes / offscreen inputs, full navigation to `/page-two`, and `window.playgroundState()` for `eval` assertions (also rendered live on the page).
- **`todo`** — a second target, so multi-target discovery (`Target.getTargets`, `/json/list`) has something to find.

Beyond those two boot slots, a connected Client can open Targets on demand: the shell passes `onCreateTarget` / `onCloseTarget` to `IcdpHost`, so a Client's `Target.createTarget` materialises a fresh iframe as another panel in the **same targets grid** — indistinguishable from the boot two — and `Target.closeTarget` tears it down. createTarget resolves only once the new Target finishes its handshake, and one that never connects is rolled back automatically instead of lingering.

The shell itself shows every target in one uniform grid, a live target table, a console panel fed by a **local session** (click the app's console buttons and watch logs arrive with no relay in that path), and per-target **Reload / Close** buttons to exercise stable target identity and lifecycle churn.

## Driving it

Open the shell in any browser, then:

```sh
agent-browser open http://127.0.0.1:3000
agent-browser --cdp 9222 wait --text "icdp Playground"   # first command syncs the model
agent-browser --cdp 9222 snapshot -i
agent-browser --cdp 9222 scrollintoview "#load-data"     # below-fold targets need this first
agent-browser --cdp 9222 click "#load-data"
agent-browser --cdp 9222 wait --text "Lab results loaded"
agent-browser --cdp 9222 eval "window.playgroundState()"
```

### Client-created targets

agent-browser's `tab` commands map straight onto the lifecycle methods the shell now handles:

```sh
agent-browser --cdp 9222 tab list                                # Target.getTargets
agent-browser --cdp 9222 tab new http://127.0.0.1:3001/page-two  # Target.createTarget -> new iframe
agent-browser --cdp 9222 tab new http://127.0.0.1:3001/todo
agent-browser --cdp 9222 tab close t3                            # Target.closeTarget -> iframe removed
```

Each `tab new` appears as another panel in the targets grid, identical to the boot two; `tab close` removes it (and a boot target is no different — closing it works the same way). Point `tab new` at a non-app origin (e.g. `https://example.com`, which carries no Frame Agent) to watch the create **time out and roll the half-made Target back** instead of leaving a zombie — the v0.2.0 await-connect contract in action.

Things to try: fill the intake form and submit it (the submit logs to the shell console panel), switch SPA tabs and use `wait --url` / `back` / `forward`, race the async buttons with `wait --text` and `wait --fn`, snapshot and confirm the hidden cases are absent, navigate to `/page-two` and back (target identity survives), reload or unpair a target from the shell and watch the target table, open and close Targets from the Client with `tab new` / `tab close`, and run `screenshot` to see it fail gracefully (intentionally unsupported).

`ICDP_DEBUG=1 npm run playground` logs all relay traffic. Status endpoint: `http://127.0.0.1:9222/icdp/status`. Override ports with `ICDP_PLAYGROUND_HOST_PORT`, `ICDP_PLAYGROUND_CDP_PORT`, and `ICDP_PLAYGROUND_APP_PORT`.

## Quirks to know

- Coordinate-based clicks resolve via `elementFromPoint` inside the frame, so **scroll below-fold elements into view before clicking** (`scrollintoview <sel>`), or the click silently misses. Inherited from the prior art.
- If agent-browser starts answering everything from `about:blank`, its daemon has gone stale — `pkill -f agent-browser` and retry. Known agent-browser 0.27 issue, not an icdp one.
