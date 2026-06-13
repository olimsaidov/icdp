import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "frame/index": "src/frame/index.ts",
    "host/index": "src/host/index.ts",
    "relay/core": "src/relay/core.ts",
    "relay/node": "src/relay/node.ts",
    protocol: "src/protocol.ts",
  },
  format: "esm",
  dts: true,
  // Bundle each entry into a self-contained ESM file and inline the browser-side
  // runtime deps (chobitsu is CJS/UMD; aria-query and dom-accessibility-api too).
  // Absorbing them here means the published frame/host entries have no bare
  // imports, so a consumer's bundler (Next, Vite, …) never has to transpile us.
  // `ws` stays external — it's only used by the Node relay and Node resolves it.
  deps: { alwaysBundle: ["chobitsu", "aria-query", "dom-accessibility-api"] },
});
