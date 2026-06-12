import { IcdpHost } from "../../src/host/index.ts";

declare global {
  interface Window {
    __ICDP_APP_ORIGIN: string;
    __ICDP_RELAY_WS: string;
  }
}

const iframe = document.getElementById("preview") as HTMLIFrameElement;
const host = new IcdpHost();
host.pair(iframe, { targetId: "preview", origins: [window.__ICDP_APP_ORIGIN] });
host.connectRelay({ url: window.__ICDP_RELAY_WS });
