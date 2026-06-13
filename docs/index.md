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
  - title: Works across origins
    details: The embedded app opts in with a small script and answers commands against its own live page. Nothing is injected from outside, so it works even when the iframe is on a different origin than the page around it.
    link: /guides/embed-the-frame-agent
  - title: No real browser required
    details: Ordinary page JavaScript answers the commands, so the whole thing runs anywhere a page exists — headless tests, CI, even jsdom — with no Chromium and no debugging session.
    link: /explanation/architecture
  - title: No server required
    details: Code in the parent page can drive and read the embedded app directly. A console panel or debug overlay works with no server anywhere in the path.
    link: /guides/local-console-panel
  - title: Works with the tools you know
    details: It speaks the standard Chrome DevTools Protocol, so existing tools connect as they are — agent-browser is fully supported, and chrome-remote-interface and Playwright over CDP connect too.
    link: /explanation/flat-session-protocol
  - title: Survives reloads and navigation
    details: Reloads and page-to-page navigation keep your handle on the app, so you don't re-attach after every transition. A command caught mid-navigation fails cleanly instead of running against the wrong page.
    link: /explanation/target-lifecycle
  - title: Small, focused modules
    details: Pick only what each part of your app needs — one piece for the embedded app, one for the parent page, one for the server.
    link: /reference/
---

## How it works

A CDP automation tool drives an app running inside an iframe — even a cross-origin
one — with no real browser debugging session. Your tool speaks standard Chrome
DevTools Protocol to a small web server; the server connects to the web page that
hosts the iframe; that page passes each command into the embedded app, which runs
it against its own live DOM.

```mermaid
flowchart TD
    C["agent-browser / Playwright"] -->|"speaks CDP"| R["Web server"]
    R -->|"connects to"| H["Your web page"]
    H -->|"embeds"| F["The app in an iframe"]
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
