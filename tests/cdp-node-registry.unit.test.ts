// @vitest-environment jsdom
import { expect, test } from "vitest";

import { createDomRegistry } from "../src/frame/ax-tree.ts";
import { SessionNodeRegistry } from "../src/frame/cdp/node-registry.ts";

// Adapted from Blink InspectorDOMAgent binding/reset behavior.
test("frontend node ids are session bindings, not backend node ids", () => {
  document.body.innerHTML = "<main><button>Save</button></main>";
  const backend = createDomRegistry();
  const button = document.querySelector("button")!;
  const main = document.querySelector("main")!;
  backend.backendIdFor(button);
  const backendId = backend.backendIdFor(main);
  const session = new SessionNodeRegistry(backend);

  const nodeId = session.bind(main);

  expect(nodeId).not.toBe(backendId);
  expect(session.nodeForNodeId(nodeId)).toBe(main);
  expect(session.nodeForBackendId(backendId)).toBe(main);
});

test("reset invalidates frontend ids without invalidating backend ids", () => {
  const backend = createDomRegistry();
  const session = new SessionNodeRegistry(backend);
  const backendId = backend.backendIdFor(document.body);
  const oldNodeId = session.bind(document.body);

  session.reset();
  const nextNodeId = session.bind(document.body);

  expect(nextNodeId).not.toBe(oldNodeId);
  expect(session.nodeForNodeId(oldNodeId)).toBeUndefined();
  expect(session.nodeForBackendId(backendId)).toBe(document.body);
});

test("pushing backend ids binds valid nodes and returns zero for stale ids", () => {
  const backend = createDomRegistry();
  const session = new SessionNodeRegistry(backend);
  const backendId = backend.backendIdFor(document.body);

  const [nodeId, missingNodeId] = session.pushBackendIds([backendId, 999_999]);

  expect(nodeId).toBeGreaterThan(0);
  expect(session.nodeForNodeId(nodeId!)).toBe(document.body);
  expect(missingNodeId).toBe(0);
});
