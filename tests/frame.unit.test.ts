// @vitest-environment jsdom
import { expect, test, vi } from "vitest";

import { startFrameAgent } from "../src/frame/index.ts";

test("the frame agent re-announces and dispatches session-scoped CDP commands", async () => {
  const postMessage = vi.fn();
  const parent = { postMessage };
  Object.defineProperty(window, "parent", { value: parent });
  vi.spyOn(window, "setInterval").mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);
  const originalLog = vi.fn();
  vi.stubGlobal("console", { log: originalLog });
  document.title = "Restored app";

  startFrameAgent({ allowedParents: ["https://host.test"] });
  postMessage.mockClear();
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
  expect(postMessage).not.toHaveBeenCalled();

  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  expect(postMessage).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledWith(
    {
      icdp: "hello",
      title: "Restored app",
      url: location.href,
      v: 5,
    },
    "https://host.test",
  );

  const framePort = {
    close: vi.fn(),
    onmessage: null,
    postMessage: vi.fn(),
  } as unknown as MessagePort;
  document.title = "Changed before welcome";
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { icdp: "welcome", v: 5 },
      origin: "https://host.test",
      ports: [framePort],
      source: parent as unknown as WindowProxy,
    }),
  );
  expect(framePort.postMessage).toHaveBeenCalledOnce();
  expect(JSON.parse(String(vi.mocked(framePort.postMessage).mock.calls[0]?.[0]))).toEqual({
    kind: "metadata",
    info: { title: "Changed before welcome", url: location.href },
  });
  vi.mocked(framePort.postMessage).mockClear();

  framePort.onmessage?.(
    new MessageEvent("message", {
      data: JSON.stringify({
        kind: "attach",
        sessionId: "session-a",
        state: { enabledDomains: [] },
      }),
    }),
  );
  framePort.onmessage?.(
    new MessageEvent("message", {
      data: JSON.stringify({
        kind: "command",
        sessionId: "session-a",
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: "1 + 1" },
      }),
    }),
  );
  await vi.waitFor(() => expect(framePort.postMessage).toHaveBeenCalledOnce());
  expect(JSON.parse(String(vi.mocked(framePort.postMessage).mock.calls[0]?.[0]))).toEqual({
    kind: "response",
    sessionId: "session-a",
    id: 1,
    result: { result: { type: "number", description: "2", value: 2 } },
  });

  framePort.onmessage?.(
    new MessageEvent("message", {
      data: JSON.stringify({
        kind: "command",
        sessionId: "session-a",
        id: 2,
        method: "Page.captureScreenshot",
        params: {},
      }),
    }),
  );
  await vi.waitFor(() => expect(framePort.postMessage).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(vi.mocked(framePort.postMessage).mock.calls[1]?.[0]))).toEqual({
    kind: "response",
    sessionId: "session-a",
    id: 2,
    error: { code: -32601, message: "'Page.captureScreenshot' wasn't found" },
  });

  (console as unknown as { log: unknown }).log = null;
  expect((console as unknown as { log: unknown }).log).toBeNull();
  const replacementLog = vi.fn();
  (console as unknown as { log: unknown }).log = replacementLog;
  (console as unknown as { log: (...args: unknown[]) => void }).log("after assignment");
  expect(replacementLog).toHaveBeenCalledWith("after assignment");

  const staleOnMessage = framePort.onmessage;
  const replacementPort = {
    close: vi.fn(),
    onmessage: null,
    postMessage: vi.fn(),
  } as unknown as MessagePort;
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { icdp: "welcome", v: 5 },
      origin: "https://host.test",
      ports: [replacementPort],
      source: parent as unknown as WindowProxy,
    }),
  );
  staleOnMessage?.call(
    framePort,
    new MessageEvent("message", {
      data: JSON.stringify({
        kind: "command",
        sessionId: "session-a",
        id: 3,
        method: "Runtime.evaluate",
        params: { expression: "3" },
      }),
    }),
  );
  await Promise.resolve();
  expect(replacementPort.postMessage).not.toHaveBeenCalled();
});
