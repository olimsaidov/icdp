---
description: "Connect any flat-session CDP Client to an icdp Relay."
---

# Connect a CDP Client

icdp exposes a browser-level WebSocket plus a direct WebSocket for every
Target. Use the browser endpoint and Chromium's flat-session protocol when one
connection must manage multiple Targets. Use a `/json/list` entry's
`webSocketDebuggerUrl` when the Client expects a traditional sessionless page
endpoint.

Use any CDP library or WebSocket implementation that lets you send these
standard message envelopes. This complete Node example uses the `ws` package:

```js
import WebSocket from "ws";

const version = await fetch("http://127.0.0.1:9222/json/version").then((response) =>
  response.json(),
);
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

let nextId = 0;
const pending = new Map();

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id === undefined) {
    console.log("event", message.method, message.params);
    return;
  }

  const request = pending.get(message.id);
  pending.delete(message.id);
  if (!request) return;
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function send(method, params = {}, sessionId) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const { targetInfos } = await send("Target.getTargets");
const target = targetInfos[0];
if (!target) throw new Error("No Targets are available");

const { sessionId } = await send("Target.attachToTarget", {
  targetId: target.targetId,
  flatten: true,
});

await send("Runtime.enable", {}, sessionId);
const { result } = await send(
  "Runtime.evaluate",
  { expression: "document.title", returnByValue: true },
  sessionId,
);
console.log(result.value);

socket.close();
```

The wire sequence is the same regardless of Client implementation:

1. Read `/json/version` and open its `webSocketDebuggerUrl`.
2. Send `Target.getTargets`.
3. Send `Target.attachToTarget` with `flatten: true`.
4. Put the returned `sessionId` on every command for that Target.
5. Treat messages with `method` and no `id` as events for their `sessionId`.

For a direct Target connection, fetch `/json/list`, select an entry, and open
its `webSocketDebuggerUrl`. Send Target commands on that socket without a
`sessionId`; results and implicit-Session events omit it as well.

Domain state is Session-local. Enable `Runtime`, `Page`, `Network`,
`Accessibility`, or another event-producing domain separately on every
attachment that needs it. Detach with `Target.detachFromTarget`; closing the
browser WebSocket also tears down all of that Client's Sessions.

icdp implements the methods listed in the
[CDP support matrix](/reference/cdp-support). Unsupported methods return the
standard `-32601` method-not-found error. Do not infer support from the Client's
API surface.
