import { startFrameAgent } from "../../src/frame/index.ts";

declare global {
  interface Window {
    __ICDP_ALLOWED_PARENTS?: string[] | "*";
  }
}

startFrameAgent({ allowedParents: window.__ICDP_ALLOWED_PARENTS ?? "*" });
