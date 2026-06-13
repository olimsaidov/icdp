---
description: "Connect agent-browser to a running Relay and drive an icdp Target, with the gotchas that bite first-timers."
---

# Drive a Target with agent-browser

You have a [Relay](/explanation/concepts) running and at least one [Target](/explanation/concepts) paired by a [Host](/explanation/concepts). This guide drives that Target with the `agent-browser` CLI: snapshot the page, find elements by role, click, fill, type, eval, and wait.

If you do not yet have a Relay, start one first — see [Run a Relay](/guides/run-a-relay). If you want a complete end-to-end walkthrough from zero, follow the [tutorial](/tutorial/).

## Use the per-command `--cdp` flag

Point each command at the Relay with `--cdp <relay port>`. The Relay exposes a Chrome-compatible CDP endpoint, so agent-browser attaches to a Target over the flat-session protocol with no per-Target WebSocket URL involved.

```sh
agent-browser --cdp 9222 wait --text "My App"
```

## Always issue one `wait` first

agent-browser keeps an internal page model. When it attaches to a live Target it has not seen before, that model is empty until a command syncs it from the running document. Make the **first** command a `wait` that matches something already on the page:

```sh
agent-browser --cdp 9222 wait --text "My App"   # syncs the page model from the live Target
```

After that sync, the rest of the surface works as usual:

```sh
agent-browser --cdp 9222 snapshot -i
agent-browser --cdp 9222 find role button click --name "Save"
agent-browser --cdp 9222 fill "#email" "ada@example.com"
agent-browser --cdp 9222 eval "window.playgroundState()"
agent-browser --cdp 9222 wait --text "Saved"
```

`snapshot -i` returns the accessibility-tree snapshot the Frame Agent builds from the real DOM. Semantic locators (`find role ... --name`), `click`, `fill`, `type`, `eval`, and the `wait` family (`--text`, `--url`, `--fn`) all route through the same Target.

::: warning Do not use `agent-browser connect <ws-url>`
As of agent-browser 0.27.x the session-bound `connect` no longer routes follow-up commands over the connection — only the first command lands, then the session stops responding. This reproduces against **real Chrome** too, on both the browser and page endpoints, so it is not an icdp limitation. Use the per-command `--cdp <relay port>` flag shown above instead.
:::

## Pitfalls

### Scroll below-fold elements into view before coordinate clicks

Coordinate-based clicks resolve via `elementFromPoint` inside the frame. An element below the fold has no point to hit, so the click **silently misses** — no error, no effect. Scroll it into view first:

```sh
agent-browser --cdp 9222 scrollintoview "#load-data"
agent-browser --cdp 9222 click "#load-data"
```

This is inherited behavior from the prior art, not specific to icdp.

### Restart a stale daemon answering from `about:blank`

agent-browser runs a background daemon. If it goes stale, every command starts answering from `about:blank` instead of your Target. Kill the daemon and retry:

```sh
pkill -f agent-browser
```

This is a known agent-browser 0.27 issue, not an icdp one.

## What is and isn't supported

The compatibility bar is agent-browser's own support matrix: AX-tree snapshots, semantic locators, click/fill/type, eval, the wait family, console, and SPA history. Screenshots, PDF, file uploads, drag-and-drop, dialogs, and real network interception are intentionally out — page JavaScript cannot provide them, so a command like `screenshot` fails gracefully rather than returning a fake result. An unknown method comes back as a CDP error (code `-32000`).

For the exact per-domain method list — and which methods the Relay answers itself rather than the Frame Agent — see the [CDP support matrix](/reference/cdp-support).
