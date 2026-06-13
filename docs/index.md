---
layout: home

hero:
  name: icdp
  text: Chrome DevTools Protocol over an iframe boundary
  tagline: Drive and inspect an embedded — even cross-origin — app with real CDP tools, without a real browser debugging session.
  actions:
    - theme: brand
      text: Start the tutorial
      link: /tutorial/
    - theme: alt
      text: How-to guides
      link: /guides/
    - theme: alt
      text: API reference
      link: /reference/

features:
  - title: Cooperative & cross-origin
    details: The embedded app includes the Frame Agent itself and answers CDP against its own real DOM. The Host never injects code, so it works across an origin boundary a real debugger can't reach.
    link: /guides/embed-the-frame-agent
  - title: No real browser required
    details: Page JavaScript emulates the CDP domains, so the whole chain runs anywhere a DOM exists — headless tests, CI, jsdom — with no Chromium debugging session.
    link: /explanation/architecture
  - title: Server-optional
    details: The Host is a real session-fan-out hub, not a dumb pipe. A parent-window console panel can tap a Target with no Relay anywhere in the path.
    link: /guides/local-console-panel
  - title: Standard CDP, flat sessions
    details: Clients attach to one browser-level endpoint and route by sessionId. agent-browser is the compatibility bar; chrome-remote-interface and Playwright-over-CDP also connect.
    link: /explanation/flat-session-protocol
  - title: Stable target identity
    details: Reloads and cross-app navigations keep the same targetId; commands in flight when a document dies fail fast with a CDP error and are never replayed.
    link: /explanation/target-lifecycle
  - title: Five small entry points
    details: /frame, /host, /relay, /relay/node, and /protocol — each a focused module with a typed surface.
    link: /reference/
---

## The topology

icdp threads a single CDP conversation across an iframe boundary. A Client speaks
standard CDP to the Relay; the Relay bridges to the Host; the Host fans sessions
out to one Frame Agent per iframe.

```mermaid
flowchart TD
    C["Client"] -->|"CDP over WebSocket"| R["Relay"]
    R -->|"bridge protocol"| H["Host"]
    H -->|"MessagePort per iframe"| F["Frame Agent"]
```

## Which page do I want?

| If you want to…                                   | Go to                                  |
| ------------------------------------------------- | -------------------------------------- |
| **Learn** icdp by driving a running demo          | [Tutorial](/tutorial/)                 |
| **Solve** a specific task (embed, pair, relay, …) | [How-to Guides](/guides/)              |
| **Look up** an exact type, method, or default     | [Reference](/reference/)               |
| **Understand** why icdp is shaped the way it is   | [Explanation](/explanation/)           |

::: tip New here?
Start with the [tutorial](/tutorial/) — it boots the bundled playground and drives
a real cross-origin iframe end to end in a few minutes, then points you at the
guide or reference page for whatever you reach for next.
:::
