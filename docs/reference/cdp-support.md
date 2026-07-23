---
description: "The exact Chromium-shaped CDP methods icdp implements and the browser features page JavaScript cannot provide."
---

# CDP support

icdp implements a deliberately small, current CDP surface. The Frame Agent
implements exactly **38 methods**. Every name below exists in the installed
Chromium DevTools protocol schema; tests lock the list to both the
implementation and that schema.

There are no inherited methods and no successful placeholders. A method not
listed here returns `-32601`.

## Frame Agent methods

### Accessibility

```text
Accessibility.disable
Accessibility.enable
Accessibility.getAXNodeAndAncestors
Accessibility.getChildAXNodes
Accessibility.getFullAXTree
Accessibility.getPartialAXTree
Accessibility.getRootAXNode
Accessibility.queryAXTree
```

The accessibility tree is derived from the live DOM using ARIA and
HTML-accessibility rules. As in Chromium, `getFullAXTree`,
`getPartialAXTree`, and `queryAXTree` can run without enabling the domain;
`getRootAXNode`, `getChildAXNodes`, and `getAXNodeAndAncestors` require
`Accessibility.enable` in the same Session. AX ids use backend DOM ids and
are document-scoped. The in-page backend does not synthesize Chromium's
`loadComplete` or `nodesUpdated` accessibility events.

### DOM

```text
DOM.describeNode
DOM.disable
DOM.enable
DOM.getBoxModel
DOM.getDocument
DOM.querySelectorAll
DOM.requestChildNodes
DOM.requestNode
DOM.resolveNode
DOM.scrollIntoViewIfNeeded
```

Frontend `nodeId` values are allocated independently per Session. Shared
`backendNodeId` values identify nodes only within the current document.
`DOM.getDocument` resets that Session's frontend ids and implicitly enables
the domain. Its Chromium default depth is two; `DOM.describeNode` defaults to
depth zero. `DOM.requestChildNodes` materializes a container's frontend
children before subsequent mutation events. Open shadow-root metadata is
returned with ordinary nodes, and `pierce: true` traverses those roots.
`DOM.resolveNode` and `DOM.requestNode` bridge DOM ids and that Session's
Runtime object handles, including detached subtrees.

While DOM is enabled, attribute, text, insertion, and removal events are
emitted only for frontend nodes already bound in that Session. Removing a
subtree invalidates its frontend ids.

`DOM.getBoxModel` uses page layout geometry and computed margins, borders, and
padding. Text-node geometry comes from a DOM `Range`; unlike Blink's internal
`LayoutText` visual-overflow quad, it cannot preserve rotated glyph quads or
text-shadow overflow. It does not expose Chromium's layout tree or compositor
internals.

### Input

```text
Input.dispatchKeyEvent
Input.dispatchMouseEvent
Input.insertText
```

These commands dispatch DOM keyboard, pointer, mouse, wheel, input, and click
behavior inside the frame. Mouse dispatch carries supported pressure, pen,
tilt, tangential-pressure, and twist fields into synthetic `PointerEvent`s.
Keyboard, pointer, mouse, and manually cancellable `beforeinput` events are
synthetic (`Event.isTrusted === false`). Where Chromium permits it,
`Input.insertText` delegates the edit to the browser's editing command and the
resulting `input` event is browser-generated. These commands cannot reproduce
native composition, browser shortcuts, file pickers, drag-and-drop, or
privileged default actions.

### Network

```text
Network.disable
Network.enable
Network.getResponseBody
```

`Network.enable` observes page-created `fetch`, `XMLHttpRequest`, and
`WebSocket` activity from that point forward. Events use current CDP payload
shapes and are delivered only to Sessions with Network enabled. Fetch/XHR
response bodies are retained for `getResponseBody` in a bounded cache
(100 bodies and 10 MiB by default).

Observation is implemented by wrapping page APIs. It cannot see the initial
document, parser-created subresources, preloads, service workers, workers,
cache internals, browser extensions, or requests created before enable. It
does not intercept, block, modify, throttle, or faithfully expose the native
network stack. Automatic Fetch/XHR redirects produce one lifecycle:
`requestWillBeSent.request.url` is the requested URL and
`responseReceived.response.url` is the final URL under the same `requestId`.
Chromium's intermediate `redirectResponse` hops are unavailable.

### Page

```text
Page.disable
Page.enable
Page.getFrameTree
Page.navigate
Page.reload
```

`Page.enable` starts lifecycle observation without replaying events that
already happened. A Page domain restored into a replacement document reports
that document's `Page.frameNavigated`, then reports the real
`Page.domContentEventFired` and `Page.loadEventFired` stages. Stages that occur
during the replacement handshake gap are journaled and delivered after the
Session is restored; they are never fabricated from `Page.enable`. There is one
frame id, `icdp-frame`. A same-document transport reconnect does not look like
a navigation, while a persisted `pageshow` reports
`BackForwardCacheRestore`, matching Chromium's navigation type.
`Page.navigate` accepts only an absolute URL on the current origin, validates
an optional frame id, and reserves the next document's loader id for
cross-document navigation. Fragment navigation omits `loaderId` and emits
`Page.navigatedWithinDocument`; History API changes and traversal emit the same
event from Chromium's Navigation API. A cancelled or intercepted navigation
cannot leak its reserved loader id into a later reload. `Page.reload` validates
an optional loader id before calling the page reload API.

The Frame Agent does not embed Chromium's public-suffix database, so
`Frame.domainAndRegistry` is empty. Security-origin localhost and
cross-origin-isolation metadata are derived from the live frame.

### Runtime

```text
Runtime.callFunctionOn
Runtime.disable
Runtime.enable
Runtime.evaluate
Runtime.getProperties
Runtime.releaseObject
Runtime.releaseObjectGroup
Runtime.runIfWaitingForDebugger
```

The framed page has one default execution context. `Runtime.enable` emits
`Runtime.executionContextCreated` and replays up to 200 captured console
calls. Console events and Runtime object handles are isolated per Session.

Evaluation supports CDP primitive/unserializable values, opaque object ids,
object groups, `returnByValue`, `awaitPromise`, call arguments, property
descriptors, `exceptionDetails`, and conservative `throwOnSideEffect`
handling that never executes the expression. Unsupported preview,
serialization, timeout, user-gesture, and REPL options fail explicitly. It
runs ordinary JavaScript in the page realm; there are no isolated worlds,
inspector pause state, breakpoints, debugger object previews, heap inspection,
or V8 profiler integration.

Page JavaScript also has no standard way to identify an arbitrary `Proxy`
without invoking observable traps. Runtime therefore cannot reproduce V8's
inspector-only `subtype: "proxy"` metadata for proxies created by the page.
Ordinary objects, arrays, DOM wrappers, errors, promises, typed collections,
and Trusted Types retain their Chromium RemoteObject shapes.

`Runtime.runIfWaitingForDebugger` returns success because an icdp document is
never held on Chromium's debugger-on-start gate; it does not emulate a
debugger.

### Storage

```text
Storage.getUsageAndQuota
```

The requested origin is required and must equal the framed page's current
origin. Values come from `navigator.storage.estimate()`. If the browser does
not expose an estimate, the command fails instead of returning invented
zeros.

## Host Browser/Target methods

The Host, not the Relay or Frame Agent, implements this surface for the
browser root, direct page sockets, and explicit flat Sessions:

```text
Browser.getVersion
Target.attachToTarget
Target.closeTarget
Target.createTarget
Target.detachFromTarget
Target.getTargetInfo
Target.getTargets
Target.setAutoAttach
Target.setDiscoverTargets
Target.setRemoteLocations
```

Only flat Sessions are supported. `Target.setRemoteLocations` is listed here
because the Host recognizes it and returns `-32000`, `Not supported`.
`Target.createTarget` and `Target.closeTarget` require the corresponding Host
lifecycle hook. Other browser-level methods return `-32601`.

Target destruction also emits the schema-defined `Inspector.detached`
lifecycle event before flattened detach notification or direct-socket close.
No `Inspector` commands are advertised.

## Deliberate hard limits

An in-page implementation cannot become Chromium's DevTools backend.
Specifically unsupported:

- screenshots, screencasts, PDF output, tracing, paint/layout internals, and
  compositor or GPU state;
- trusted native input, browser chrome, clipboard permissions, file chooser,
  drag interception, downloads, or dialog control;
- native request interception, response rewriting, throttling, cache control,
  document/subresource coverage, or service-worker traffic;
- duplicate names inside the `params` object retain JavaScript JSON parsing
  semantics (the last value wins); duplicate command-envelope names are
  rejected in wire order like Chromium;
- Debugger, Profiler, HeapProfiler, Memory, Audits, Security, Emulation,
  ServiceWorker, Target worker/OOPIF, and browser-process domains;
- DOM access inside child-frame documents, closed or user-agent shadow roots,
  and browser-internal trees;
- V8's inspector-only proxy identity and exact transformed text visual-overflow
  quads;
- legacy non-flat `Target.sendMessageToTarget` sessions.

Generic CDP clients may work when they stay inside the documented surface.
They should expect a protocol error, not a fabricated result, outside it.
