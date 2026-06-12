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
  unbundle: true,
});
