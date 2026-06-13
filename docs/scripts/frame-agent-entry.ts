// Boot entry for the live-demo target pages. Bundled by build-demo-frame.mjs
// into docs/public/demo/frame-agent.js and loaded by every target page so the
// in-page agent-browser (WASM) can drive it over icdp. Same-origin demo, so the
// only allowed parent is the docs site itself.
import { startFrameAgent } from "../../src/frame/index.ts";

startFrameAgent({ allowedParents: [window.location.origin] });
