---
description: "Boot the bundled playground and inspect a cross-origin iframe through raw flat-session CDP."
---

# Tutorial: drive an embedded app end to end

This tutorial boots the complete icdp path — Relay, Host, and two cross-origin
Frame-Agent Targets — then connects a deliberately small raw CDP Client. The
Client code is ordinary WebSocket code, so every protocol step is visible and
the result does not depend on a particular automation library.

## Prerequisites

- A clone of the repository with `npm install` already run.
- Node 22 or newer.
- Any browser for viewing the playground shell.

## 1. Boot the playground

From the repository root:

```sh
npm run playground
```

The command starts:

- the Host shell at `http://127.0.0.1:3000`;
- two iframe Targets from the cross-origin app server at
  `http://127.0.0.1:3001`;
- the browser-level CDP endpoint at
  `ws://127.0.0.1:9222/devtools/browser`.

Leave the process running and open `http://127.0.0.1:3000` in a browser. The
shell shows the paired Targets, their current URLs, and a local Session that
renders console events without using the Relay.

## 2. Run the raw Client

In a second terminal:

```sh
node playground/cdp-client.mjs
```

The script reads `/json/version`, opens its `webSocketDebuggerUrl`, discovers
Targets, attaches to the first one with `flatten: true`, and sends three
Session-scoped commands:

```text
Runtime.evaluate
DOM.getDocument
Accessibility.getFullAXTree
```

It prints a JSON summary containing the Target, the evaluated document title,
the root DOM node, and the accessibility-node count. To choose a specific
Target, pass its id after the discovery URL:

```sh
node playground/cdp-client.mjs http://127.0.0.1:9222 todo
```

Open [the sample Client source](https://github.com/olimsaidov/icdp/blob/master/playground/cdp-client.mjs)
while you work through the rest of this tutorial. It is the complete Client,
not a wrapper around another API.

## 3. Read the protocol sequence

The important envelopes are:

```json
{"id":1,"method":"Target.getTargets","params":{}}
{"id":2,"method":"Target.attachToTarget","params":{"targetId":"playground","flatten":true}}
{"id":3,"sessionId":"<returned-session-id>","method":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true}}
```

Browser-level methods omit `sessionId`. Target methods include the id returned
by `Target.attachToTarget`. Events have `method`, `params`, and `sessionId`, but
no request `id`.

`/json/version` advertises the browser endpoint used above. `/json` and
`/json/list` also advertise a direct `/devtools/page/<targetId>` endpoint for
each Target. Direct connections omit `sessionId` for that Target; browser
connections use the explicit flat-session envelope shown above.

## 4. Send another supported command

The sample's `send` function accepts any method, params, and optional Session
id. For example, add this after the attach:

```js
await send("Page.enable", {}, sessionId);
const { result } = await send(
  "Runtime.evaluate",
  {
    expression: `document.querySelector("#load-data").textContent`,
    returnByValue: true,
  },
  sessionId,
);
console.log(result.value);
```

Domain state belongs to the Session. Enabling `Page` or `Network` on one
attachment does not enable it for another, and events are delivered only to
the Session that enabled their domain.

## 5. Create and close a Target

The playground Host implements the optional Target lifecycle hooks. Add these
browser-level commands to create another iframe, attach to it, and remove it:

```js
const { targetId } = await send("Target.createTarget", {
  url: "http://127.0.0.1:3001/page-two",
});

const attached = await send("Target.attachToTarget", {
  targetId,
  flatten: true,
});

await send(
  "Runtime.evaluate",
  { expression: "document.title", returnByValue: true },
  attached.sessionId,
);
await send("Target.closeTarget", { targetId });
```

The new iframe appears in the shell's Targets grid. `Target.createTarget`
resolves only after its Frame Agent completes the handshake, so the first
Session command cannot race an unconnected Target.

## 6. Observe the support boundary

The exact availability contract is the
[CDP support matrix](/reference/cdp-support). Sending an unregistered command,
for example `Page.captureScreenshot`, returns CDP error `-32601`. Page
JavaScript cannot provide browser-native screenshots, PDF generation, trusted
input, or browser-stack network interception, so icdp reports those limits
instead of pretending they succeeded.

## Where next

- [Connect a CDP Client](/guides/connect-a-cdp-client) — reuse the raw
  flat-session connection sequence in another Client.
- [Pair an iframe](/guides/pair-an-iframe) and
  [Embed the Frame Agent](/guides/embed-the-frame-agent) — wire your own app.
- [Client-driven Targets](/guides/client-driven-targets) — implement the Target
  lifecycle hooks.
- [Architecture](/explanation/architecture) and
  [Target lifecycle](/explanation/target-lifecycle) — understand ownership,
  reloads, and Session isolation.
