// @vitest-environment jsdom
import { expect, test, vi } from "vitest";

import { startFrameAgent } from "../src/frame/index.ts";

vi.mock("chobitsu", () => ({
  default: {
    register: vi.fn(),
    sendRawMessage: vi.fn(),
    setOnMessage: vi.fn(),
  },
}));

test("a persisted pageshow re-announces the frame to its allowlisted parent", () => {
  const postMessage = vi.fn();
  Object.defineProperty(window, "parent", { value: { postMessage } });
  vi.spyOn(window, "setInterval").mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);
  vi.stubGlobal("console", {});
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
      v: 1,
    },
    "https://host.test",
  );
});
