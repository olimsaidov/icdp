// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "vitest";

import { FRAME_METHODS, FrameBackend } from "../src/frame/cdp/session.ts";

type ProtocolFile = {
  domains: Array<{
    domain: string;
    commands?: Array<{ name: string }>;
  }>;
};

function protocolMethods(file: string): string[] {
  const protocol = JSON.parse(readFileSync(file, "utf8")) as ProtocolFile;
  return protocol.domains.flatMap((domain) =>
    (domain.commands ?? []).map((command) => `${domain.domain}.${command.name}`),
  );
}

test("the advertised Frame surface contains only current CDP commands", () => {
  const current = new Set([
    ...protocolMethods(resolve("node_modules/devtools-protocol/json/browser_protocol.json")),
    ...protocolMethods(resolve("node_modules/devtools-protocol/json/js_protocol.json")),
  ]);

  expect(FRAME_METHODS).toEqual([...new Set(FRAME_METHODS)].toSorted());
  expect(FRAME_METHODS.filter((method) => !current.has(method))).toEqual([]);
});

test("the Frame surface has no compatibility-only or false-success domains", () => {
  expect(FRAME_METHODS).not.toEqual(
    expect.arrayContaining([
      "ApplicationCache.enable",
      "CSS.setProxy",
      "DOM.getDOMNode",
      "Debugger.enable",
      "Page.setProxy",
    ]),
  );
});

test("every listed Frame method reaches an implementation branch", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  for (const [index, method] of FRAME_METHODS.entries()) {
    const id = index + 1;
    const params = method === "Page.reload" ? { loaderId: "not-the-current-loader" } : {};
    await backend.command({
      kind: "command",
      sessionId: "session-a",
      id,
      method,
      params,
    });
    const response = messages.find((message) => message.kind === "response" && message.id === id);
    expect(response, method).toBeDefined();
    expect(response?.error?.code, method).not.toBe(-32601);
  }

  backend.clearSessions();
});
