---
layout: home

hero:
  name: icdp
  text: Chromium-shaped CDP for iframe apps
  tagline: Inspect and drive a cooperative embedded app without opening a browser debugging port.
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
  - title: Works across origins
    details: The embedded app opts in with a small script and answers commands against its own live page. Nothing is injected from outside, so it works even when the iframe is on a different origin than the page around it.
    link: /guides/embed-the-frame-agent
  - title: No debugging port
    details: Ordinary page JavaScript answers the document-facing commands. The browser running the app does not expose a remote-debugging session.
    link: /explanation/architecture
  - title: No server required
    details: Code in the parent page can drive and read the embedded app directly. A console panel or debug overlay works with no server anywhere in the path.
    link: /guides/local-console-panel
  - title: Works with the tools you know
    details: Clients connect through Chromium's flat-session message shapes. Commands outside the explicit supported subset return protocol errors.
    link: /explanation/flat-session-protocol
  - title: Survives reloads and navigation
    details: Reloads and page-to-page navigation keep your handle on the app, so you don't re-attach after every transition. A command caught mid-navigation fails cleanly instead of running against the wrong page.
    link: /explanation/target-lifecycle
  - title: Small, focused modules
    details: Pick only what each part of your app needs — one piece for the embedded app, one for the parent page, one for the server.
    link: /reference/
---

## How it works

A CDP automation tool drives an app running inside an iframe, including a
cross-origin one, with no browser debugging session. The Relay carries raw CDP;
the Host owns Targets and Sessions; the embedded Frame Agent implements the
document-facing subset against its own live DOM.

```mermaid
flowchart TD
    C["CDP Client"] -->|"raw CDP"| R["Relay"]
    R -->|"client id + raw CDP"| H["Host in your page"]
    H -->|"session-scoped MessagePort"| F["Frame Agent in the iframe"]
```

## Try it live

The demo uses **agent-browser compiled to WebAssembly** as one real CDP Client.
It drives the iframe through icdp entirely inside this page; the library itself
remains Client-independent.

<ClientOnly>
  <LiveDemo />
</ClientOnly>

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
