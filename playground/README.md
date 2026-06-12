# icdp playground

A runnable demo of the full icdp topology, ready to be driven with agent-browser.

```sh
npm run playground
```

Starts everything on fixed ports: a shell page (Host) at `http://127.0.0.1:9222` embedding **two cross-origin targets** from `http://127.0.0.1:9223`:

- **`playground`** — a feature-dense app: forms of every input type, SPA tabs via `history.pushState`, async zones (delayed lab results, toast, late-appearing button), console buttons, shadow DOM, a nested srcdoc iframe, hidden cases that must _not_ appear in snapshots, mouse pad / scroll boxes / offscreen inputs, full navigation to `/page-two`, and `window.playgroundState()` for `eval` assertions (also rendered live on the page).
- **`todo`** — a second target, so multi-target discovery (`Target.getTargets`, `/json/list`) has something to find.

The shell itself shows the live target table, a console panel fed by a **local session** (click the app's console buttons and watch logs arrive with no relay in that path), and per-target **Reload / Unpair** buttons to exercise stable target identity and lifecycle churn.

## Driving it

Open the shell in any browser, then:

```sh
agent-browser open http://127.0.0.1:9222
agent-browser --cdp 9222 wait --text "icdp Playground"   # first command syncs the model
agent-browser --cdp 9222 snapshot -i
agent-browser --cdp 9222 scrollintoview "#load-data"     # below-fold targets need this first
agent-browser --cdp 9222 click "#load-data"
agent-browser --cdp 9222 wait --text "Lab results loaded"
agent-browser --cdp 9222 eval "window.playgroundState()"
```

Things to try: fill the intake form and submit it (the submit logs to the shell console panel), switch SPA tabs and use `wait --url` / `back` / `forward`, race the async buttons with `wait --text` and `wait --fn`, snapshot and confirm the hidden cases are absent, navigate to `/page-two` and back (target identity survives), reload or unpair a target from the shell and watch the target table, and run `screenshot` to see it fail gracefully (intentionally unsupported).

`ICDP_DEBUG=1 npm run playground` logs all relay traffic. Status endpoint: `http://127.0.0.1:9222/icdp/status`. Override the port with `ICDP_PLAYGROUND_PORT`.

## Quirks to know

- Coordinate-based clicks resolve via `elementFromPoint` inside the frame, so **scroll below-fold elements into view before clicking** (`scrollintoview <sel>`), or the click silently misses. Inherited from the prior art.
- If agent-browser starts answering everything from `about:blank`, its daemon has gone stale — `pkill -f agent-browser` and retry. Known agent-browser 0.27 issue, not an icdp one.
