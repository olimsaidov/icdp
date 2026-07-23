// @vitest-environment jsdom
import { globSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

const before = {
  addEventListener: EventTarget.prototype.addEventListener,
  attachShadow: Element.prototype.attachShadow,
  consoleLog: console.log,
  dialogClose: HTMLDialogElement.prototype.close,
  dialogShowModal: HTMLDialogElement.prototype.showModal,
  fetch: window.fetch,
  webSocket: window.WebSocket,
  xhrOpen: XMLHttpRequest.prototype.open,
};

test("importing the frame agent leaves page APIs untouched", async () => {
  await import("../src/frame/index.ts");

  expect({
    addEventListener: EventTarget.prototype.addEventListener,
    attachShadow: Element.prototype.attachShadow,
    consoleLog: console.log,
    dialogClose: HTMLDialogElement.prototype.close,
    dialogShowModal: HTMLDialogElement.prototype.showModal,
    fetch: window.fetch,
    webSocket: window.WebSocket,
    xhrOpen: XMLHttpRequest.prototype.open,
  }).toEqual(before);
});

test("product sources outside the explicit demo stay Client-independent", () => {
  const demoFiles = new Set([
    "docs/.vitepress/config.ts",
    "docs/.vitepress/theme/components/LiveDemo.vue",
    "docs/index.md",
    "docs/scripts/frame-agent-entry.ts",
  ]);
  const files = [
    "CONTEXT.md",
    ...globSync("src/**/*"),
    ...globSync("docs/**/*"),
    ...globSync("playground/**/*"),
  ].filter(
    (file) =>
      /\.(?:html|js|json|md|mjs|mts|ts|vue)$/.test(file) &&
      !file.startsWith("docs/.vitepress/dist/"),
  );

  const coupled = files.filter(
    (file) =>
      !demoFiles.has(file) &&
      (/agent-browser/i.test(file) || /agent-browser/i.test(readFileSync(file, "utf8"))),
  );
  expect(coupled).toEqual([]);
});
