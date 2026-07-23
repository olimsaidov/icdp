# icdp

A cooperative, Chromium-shaped CDP endpoint for iframe applications.

icdp lets a CDP client inspect and drive an embedded app, including a
cross-origin iframe, without opening Chromium's remote-debugging port. The app
ships a small Frame Agent; the parent-window Host owns Targets and Sessions;
the Relay only carries raw WebSocket frames and serves discovery metadata.

This is an honest in-page subset of CDP, not a browser debugger. DOM,
accessibility, Runtime, synthetic input, same-origin navigation, storage
estimates, and page-created network activity are supported. Browser
compositor output, trusted native input, the browser network stack, workers,
OOPIFs, and V8 debugging are not.

**[Documentation](https://olimsaidov.github.io/icdp/)** ·
[npm](https://www.npmjs.com/package/@olimsaidov/icdp)

```sh
npm install @olimsaidov/icdp
```

MIT
