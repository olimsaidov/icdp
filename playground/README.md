# icdp playground

A runnable demo of the complete icdp topology, designed for any flat-session
CDP Client.

```sh
npm run playground
```

It starts a shell page (Host) at `http://127.0.0.1:3000`, a browser-level CDP
endpoint on port `9222`, and two cross-origin Targets from
`http://127.0.0.1:3001`:

- **`playground`** — forms, SPA history, async zones, console events, shadow
  DOM, hidden content, scrolling, navigation, and `window.playgroundState()`.
- **`todo`** — a second Target for multi-Target discovery.

The Host also implements `Target.createTarget` and `Target.closeTarget`. A
created Target appears as another iframe in the same grid and does not resolve
until its Frame Agent completes the handshake.

## Inspect through raw CDP

Open the shell in a browser, then run the minimal sample protocol flow from
another terminal:

```sh
node playground/cdp-client.mjs
```

The sample:

1. reads `http://127.0.0.1:9222/json/version`;
2. opens the returned browser WebSocket;
3. calls `Target.getTargets`;
4. attaches with `Target.attachToTarget({ flatten: true })`;
5. sends Session-scoped `Runtime`, `DOM`, and `Accessibility` commands.

Pass a discovery origin and Target id to select a specific Target:

```sh
node playground/cdp-client.mjs http://127.0.0.1:9222 todo
```

Any CDP implementation that supports flat Target Sessions can use the same
endpoint. The exact method surface is documented in
`docs/reference/cdp-support.md`.

The shell itself also opens a local Session for console events, so you can
compare the server-free Host path with the remote Relay path.

`ICDP_DEBUG=1 npm run playground` logs all Relay traffic. Override ports with
`ICDP_PLAYGROUND_HOST_PORT`, `ICDP_PLAYGROUND_CDP_PORT`, and
`ICDP_PLAYGROUND_APP_PORT`.
