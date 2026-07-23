import { startFrameAgent } from "../../src/frame/index.ts";

declare global {
  interface Window {
    __ICDP_ALLOWED_PARENT: string;
    __ICDP_TEST_RESOLVERS?: Record<string, () => void>;
  }
}

startFrameAgent({ allowedParents: [window.__ICDP_ALLOWED_PARENT] });

window.addEventListener("message", (event) => {
  if (
    event.source !== window.parent ||
    event.origin !== window.__ICDP_ALLOWED_PARENT ||
    typeof event.data?.icdpResolve !== "string"
  ) {
    return;
  }
  const name = event.data.icdpResolve as string;
  const resolve = window.__ICDP_TEST_RESOLVERS?.[name];
  if (!resolve) return;
  delete window.__ICDP_TEST_RESOLVERS?.[name];
  resolve();
  window.setTimeout(
    () => window.parent.postMessage({ icdpResolved: name }, window.__ICDP_ALLOWED_PARENT),
    0,
  );
});
