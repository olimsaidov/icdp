---
description: "Step-by-step instructions for embedding the Frame Agent, pairing iframes, running a Relay, and driving Targets."
---

# How-to guides

Step-by-step instructions for readers who already worked through the
[tutorial](/tutorial/) and know the [vocabulary](/explanation/concepts) — Frame
Agent, Host, Relay, Client, Target, Pairing, Session. Each guide solves one task
and assumes the fundamentals.

- **Make an app answer CDP from inside its own iframe** — [Embed the Frame Agent](/guides/embed-the-frame-agent).
- **Register an iframe as a Target on the Host** — [Pair an iframe as a Target](/guides/pair-an-iframe).
- **Read a Target's events and run commands with no server in the path** — [Tap a Target locally](/guides/local-console-panel).
- **Expose a Chrome-compatible CDP endpoint for external Clients** — [Run a Relay](/guides/run-a-relay).
- **Snapshot, locate, and act on a Target from the CLI** — [Drive a Target with agent-browser](/guides/drive-with-agent-browser).
- **Let a Client open and close Targets via `Target.createTarget` / `Target.closeTarget`** — [Client-driven Targets](/guides/client-driven-targets).
- **Run the Relay outside Node on a runtime-agnostic core** — [Embed a Relay in another runtime](/guides/embed-a-relay-in-another-runtime).
- **Add icdp to a Next.js / Vite / framework app without fighting the build** — [Use in a bundler app](/guides/use-in-a-bundler-app).
