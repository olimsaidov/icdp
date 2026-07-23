import { IcdpHost } from "../../src/host/index.ts";

declare global {
  interface Window {
    __ICDP_APP_ORIGIN: string;
    __ICDP_CONTROL: {
      dropRelay(): void;
      resolve(name: string): Promise<void>;
    };
    __ICDP_RELAY_WS: string;
  }
}

const frames = new Map<string, HTMLIFrameElement>();
let nextTarget = 1;
const host = new IcdpHost({
  product: "icdp-lifecycle-e2e",
  onCreateTarget: () => addTarget(`created-${nextTarget++}`),
  onCloseTarget: (targetId) => {
    frames.get(targetId)?.remove();
    frames.delete(targetId);
  },
});

function addTarget(targetId: string): string {
  const iframe = document.createElement("iframe");
  host.pair(iframe, { targetId, origins: [window.__ICDP_APP_ORIGIN] });
  frames.set(targetId, iframe);
  iframe.src = `${window.__ICDP_APP_ORIGIN}/target/${targetId}`;
  document.body.append(iframe);
  return targetId;
}

let relaySocket: WebSocket | undefined;
host.connectRelay({
  url: window.__ICDP_RELAY_WS,
  reconnectDelayMs: 3_000,
  webSocketFactory: (url) => {
    relaySocket = new WebSocket(url);
    return relaySocket;
  },
});
addTarget("page-1");
window.__ICDP_CONTROL = {
  dropRelay() {
    relaySocket?.close(4000, "test disconnect");
  },
  resolve(name) {
    return new Promise((resolve) => {
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.__ICDP_APP_ORIGIN || event.data?.icdpResolved !== name) {
          return;
        }
        window.removeEventListener("message", onMessage);
        resolve();
      };
      window.addEventListener("message", onMessage);
      for (const iframe of frames.values()) {
        iframe.contentWindow?.postMessage({ icdpResolve: name }, window.__ICDP_APP_ORIGIN);
      }
    });
  },
};
