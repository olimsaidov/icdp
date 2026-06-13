---
description: "Add icdp to an app built with Next.js, Vite, Remix, or any bundler — the client-only import pattern and the one bundler setting you might need."
---

# Use icdp in a bundler app

You are adding icdp to an app built with a framework or bundler — Next.js, Vite,
Remix, SvelteKit, Astro — and you want it to work without fighting the build. Two
things matter: **where** icdp runs, and **how** your bundler treats it.

## icdp's browser entries are client-side

`@olimsaidov/icdp/frame` and `@olimsaidov/icdp/host` are browser code. They touch
`window`, `postMessage`, and `MessagePort`, so they must run in the browser, never
during server-side rendering. `@olimsaidov/icdp/relay/node` is the opposite — it is
server-only (it uses `node:http` and `ws`) and belongs in a route handler or a
standalone process, never in a client component.

## Import the browser entries lazily

In a server-rendered framework, a top-level `import` of `/frame` or `/host` would
evaluate browser-only code on the server and crash the render. Load them inside a
browser-only effect with a dynamic `import()`:

```tsx
"use client";

import { useEffect } from "react";
// Type-only imports are erased at compile time, so they are safe at the top level:
import type { LocalSession } from "@olimsaidov/icdp/host";

export function HostPanel({ iframe }: { iframe: HTMLIFrameElement }) {
  useEffect(() => {
    let active = true;
    void (async () => {
      const { IcdpHost } = await import("@olimsaidov/icdp/host");
      if (!active) return;
      const host = new IcdpHost();
      host.pair(iframe, { targetId: "demo", origins: [window.location.origin] });
      const session: LocalSession = host.attach("demo");
      await session.send("Runtime.enable");
      // …drive the iframe over CDP…
    })();
    return () => {
      active = false;
    };
  }, [iframe]);
}
```

The embedded app boots the [Frame Agent](/explanation/concepts) the same way — a
deferred `import("@olimsaidov/icdp/frame")` inside an effect, then
`startFrameAgent({ allowedParents })`. See [Embed the Frame Agent](/guides/embed-the-frame-agent).

::: tip Why deferred, not just `"use client"`
`"use client"` marks a component as client-rendered, but a framework may still
*evaluate the module* on the server to produce the initial HTML. The dynamic
`import()` inside an effect guarantees icdp only loads in the browser.
:::

## Bundler configuration

icdp's `frame` and `host` entries are published as **self-contained ESM** — their
runtime dependencies (including [`chobitsu`](https://github.com/liriliri/chobitsu),
which is CommonJS) are inlined — so a modern bundler consumes them directly with no
extra setup.

If your bundler externalizes `node_modules` and you hit an ESM/CommonJS interop
error during build, opt the package into your bundler's own compilation:

::: code-group

```ts [next.config.ts]
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Compile icdp into the client bundle instead of treating it as external.
  transpilePackages: ["@olimsaidov/icdp"],
};

export default nextConfig;
```

```ts [vite.config.ts]
import { defineConfig } from "vite";

export default defineConfig({
  // Vite pre-bundles dependencies; force icdp through it if interop ever bites.
  optimizeDeps: { include: ["@olimsaidov/icdp/host", "@olimsaidov/icdp/frame"] },
});
```

:::

## Driving a cross-origin iframe in development

icdp exists to drive a **cross-origin** iframe, and you may serve the embedded app
from a different origin than its host (for example the parent on `localhost` and the
frame on `127.0.0.1`). Next.js 15+ blocks cross-origin requests to the dev server by
default; allow both origins:

```ts [next.config.ts]
const nextConfig = {
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};
```

The handshake, bridge, and CDP surface are identical for same-origin and
cross-origin frames — the only difference is that each origin must be on the Frame
Agent's `allowedParents` (and the [Host](/explanation/concepts)'s `origins`).

## See also

- [Embed the Frame Agent](/guides/embed-the-frame-agent) — the embedded-app side.
- [Pair an iframe as a Target](/guides/pair-an-iframe) — the parent-window side.
- [`/frame`](/reference/frame) and [`/host`](/reference/host) — the API these imports expose.
