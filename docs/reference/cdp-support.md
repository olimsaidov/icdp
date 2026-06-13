---
description: "The exact CDP domains and methods the Frame Agent implements, and what is intentionally unsupported."
---

# CDP support matrix

The [Frame Agent](/explanation/concepts) emulates a subset of the Chrome DevTools Protocol against the real DOM. It registers exactly the domains and methods below; every other command returns a CDP error. The lists here are the `cdp.register(...)` calls in `src/frame/index.ts` — not the wider CDP surface a real browser exposes.

Browser- and Target-level registry methods (`Target.getTargets`, `Target.attachToTarget`, `Target.setAutoAttach`, `Browser.getVersion`, …) are answered by the [Relay](/explanation/concepts), not the Frame Agent. They read the Relay's own session and Target state and never reach the iframe. See the [Relay reference](/reference/relay) for that list and the [flat-session protocol](/explanation/flat-session-protocol) for how Clients address Targets.

## Implemented domains

### Accessibility

| Method | Behavior |
| --- | --- |
| `disable` | No-op. |
| `enable` | No-op. |
| `getFullAXTree` | Full accessibility tree, honoring `depth`. |
| `getPartialAXTree` | Subtree at a node; `fetchRelatives` defaults to `true`. |
| `getRootAXNode` | The root AX node. |
| `getChildAXNodes` | Child AX nodes of a given AX node `id`. |
| `getAXNodeAndAncestors` | A node and its ancestor chain; requires a `nodeId` or `backendNodeId`. |
| `queryAXTree` | AX nodes under a target, filtered by `accessibleName` and `role`. |

See [Accessibility tree](/explanation/accessibility-tree) for how the tree is computed and where it diverges from Chromium.

### Animation

| Method | Behavior |
| --- | --- |
| `enable` | No-op. |

### Autofill

| Method | Behavior |
| --- | --- |
| `setAddresses` | No-op. |

### CSS

| Method | Behavior |
| --- | --- |
| `disable` | No-op. |
| `enable` | No-op. |
| `getComputedStyleForNode` | Computed style for a node as `{ name, value }` pairs. |

### DOM

The DOM domain unifies `nodeId` with `backendNodeId`, so either resolves the same node.

| Method | Behavior |
| --- | --- |
| `describeNode` | Describe a node by `backendNodeId`/`nodeId` (defaults to node `1`). |
| `discardSearchResults` | Drop a stored search by `searchId`. |
| `enable` | No-op. |
| `focus` | Focus an `HTMLElement` by node id. |
| `getAttributes` | Flat `[name, value, …]` attribute list for an element. |
| `getBoxModel` | Box model from `getBoundingClientRect` (content/padding/border/margin share the rect). |
| `getContentQuads` | Single content quad derived from the box model. |
| `getDocument` | Document root, honoring `depth` (defaults to `1`). |
| `getOuterHTML` | `outerHTML` of an element or document. |
| `getSearchResults` | Slice stored search node ids by `fromIndex`/`toIndex`. |
| `performSearch` | Match by CSS selector, falling back to case-insensitive text search; returns a `searchId`. |
| `pushNodesByBackendIdsToFrontend` | Echo the requested `backendNodeIds` as node ids. |
| `querySelector` | First match under a root node (or document); `0` when none. |
| `querySelectorAll` | All matches under a root node (or document). |
| `requestChildNodes` | Emit `DOM.setChildNodes` for a node's children at `depth` (defaults to `1`). |
| `resolveNode` | Wrap a node id as a `backend:<id>` remote object. |
| `scrollIntoViewIfNeeded` | Scroll the element to block/inline center. |

### Input

| Method | Behavior |
| --- | --- |
| `dispatchKeyEvent` | Dispatch `keydown`/`keyup`; `Backspace` deletes backward and `text` is inserted into the active element. |
| `dispatchMouseEvent` | Resolve the target via `elementFromPoint`, then dispatch move/over/enter, down, up + synthetic `click`/`dblclick`, or wheel + scroll. |
| `insertText` | Insert text into the active input, textarea, or contenteditable element. |

::: warning
`dispatchMouseEvent` resolves the target with `document.elementFromPoint`. A below-the-fold element must be scrolled into view first, or the click silently misses. See [Drive with agent-browser](/guides/drive-with-agent-browser).
:::

### Network

| Method | Behavior |
| --- | --- |
| `emulateNetworkConditionsByRule` | Returns synthetic `ruleIds` for the matched conditions; applies no real throttling. |
| `overrideNetworkState` | No-op. |
| `setBlockedURLs` | No-op. |

### Page

| Method | Behavior |
| --- | --- |
| `addScriptToEvaluateOnNewDocument` | Returns a synthetic `identifier`; no script is installed. |
| `getFrameTree` | Single-frame tree for the embedded document. |
| `getResourceTree` | Frame tree with an empty `resources` list. |
| `navigate` | **Same-origin only.** Navigating outside the embedded app's origin throws. |

::: info
`navigate` sets `location.href` for a same-origin URL. A cross-origin URL throws — the embedded app's origin is the navigation boundary. Reloads and same-origin navigations keep the same `targetId`; see [Target lifecycle](/explanation/target-lifecycle).
:::

### Runtime

| Method | Behavior |
| --- | --- |
| `addBinding` | No-op. |
| `callFunctionOn` | Indirect-eval a function declaration against a `backend:<id>` object or `window`; supports `awaitPromise`. |
| `enable` | Emits `Runtime.executionContextCreated` (context id `1`, name `top`) and flushes queued events. |
| `evaluate` | Indirect-eval an expression; supports `awaitPromise`. |
| `runIfWaitingForDebugger` | No-op. |

Runtime events (including `Runtime.consoleAPICalled` from the console bridge) are queued until `Runtime.enable`, capped at ~200, then flushed. The single execution context has id `1` and name `top`.

### Storage

| Method | Behavior |
| --- | --- |
| `getStorageKey` | Returns the document origin as the `storageKey`. |

## No-op methods

These are registered so domain enables and setup calls succeed, but they have no effect:

- `Animation.enable`
- `Autofill.setAddresses`
- `Network.overrideNetworkState`
- `Network.setBlockedURLs`
- `Runtime.addBinding`
- `Runtime.runIfWaitingForDebugger`

The `disable`/`enable` handlers on `Accessibility` and `CSS`, and `DOM.enable`, are also no-ops; the Frame Agent holds no per-domain state to toggle. (`DOM.disable` is not registered.)

## Unknown methods

A method the Frame Agent has not registered returns a CDP error with code `-32000` (`CDP_SERVER_ERROR`) and message `Method not found: <method>`. Commands in flight when the document dies fail with the same code. See the [Frame reference](/reference/frame) for the full request path and the [protocol reference](/reference/protocol) for the error constants.

## Intentionally unsupported

Page JavaScript cannot provide these capabilities, so they are out of scope by design — not pending work:

- Screenshots
- PDF generation
- File uploads
- Drag-and-drop
- Dialogs
- Real network interception

The compatibility bar is [agent-browser](/guides/drive-with-agent-browser)'s support matrix: AX-tree snapshots, semantic locators, click/fill/type, eval, waits, console, and SPA history. Raw Playwright over `connectOverCDP` is best-effort, not promised — it exercises commands outside this matrix and will hit the unknown-method error above.
