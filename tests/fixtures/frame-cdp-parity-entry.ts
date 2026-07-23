import { startFrameAgent } from "../../src/frame/index.ts";
import { IcdpHost } from "../../src/host/index.ts";

declare global {
  interface Window {
    __ICDP_APP_ORIGIN: string;
    __ICDP_PARENT_ORIGIN: string;
    __ICDP_RELAY_WS: string;
  }
}

if (window.parent === window && document.getElementById("preview")) {
  const iframe = document.getElementById("preview") as HTMLIFrameElement;
  const host = new IcdpHost();
  host.pair(iframe, { targetId: "parity-frame", origins: [window.__ICDP_APP_ORIGIN] });
  host.connectRelay({ url: window.__ICDP_RELAY_WS });
} else if (window.parent !== window) {
  startFrameAgent({ allowedParents: [window.__ICDP_PARENT_ORIGIN] });
}
