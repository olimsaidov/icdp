import { once } from "node:events";

import WebSocket from "ws";

const cdpHttpUrl = process.argv[2] ?? "http://127.0.0.1:9222";
const requestedTargetId = process.argv[3];
const version = await fetch(new URL("/json/version", cdpHttpUrl));
if (!version.ok) throw new Error(`CDP discovery failed with HTTP ${version.status}`);

const { webSocketDebuggerUrl } = await version.json();
if (typeof webSocketDebuggerUrl !== "string") {
  throw new Error("CDP discovery did not return webSocketDebuggerUrl");
}

const socket = new WebSocket(webSocketDebuggerUrl);
await once(socket, "open");

let nextId = 0;
const pending = new Map();

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id === undefined) return;

  const request = pending.get(message.id);
  pending.delete(message.id);
  if (!request) return;

  if (message.error) {
    const error = new Error(message.error.message);
    error.code = message.error.code;
    request.reject(error);
  } else {
    request.resolve(message.result);
  }
});

function send(method, params = {}, sessionId) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

try {
  const { targetInfos } = await send("Target.getTargets");
  const target = requestedTargetId
    ? targetInfos.find(({ targetId }) => targetId === requestedTargetId)
    : targetInfos[0];
  if (!target) throw new Error("No matching Target is available");

  const { sessionId } = await send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  await send("Runtime.enable", {}, sessionId);

  const [{ result }, { root }, { nodes }] = await Promise.all([
    send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId),
    send("DOM.getDocument", { depth: 1 }, sessionId),
    send("Accessibility.getFullAXTree", {}, sessionId),
  ]);

  console.log(
    JSON.stringify(
      {
        target: {
          targetId: target.targetId,
          title: target.title,
          url: target.url,
        },
        evaluatedTitle: result.value,
        document: {
          nodeName: root.nodeName,
          childNodeCount: root.childNodeCount,
        },
        accessibilityNodeCount: nodes.length,
      },
      null,
      2,
    ),
  );
} finally {
  socket.close();
}
