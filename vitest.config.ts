import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The e2e conformance suite drives a real browser through agent-browser;
    // its tests carry their own 120s timeouts.
    testTimeout: 15_000,
    hookTimeout: 60_000,
  },
});
