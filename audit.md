# AX-tree conformance audit — what's left

**Method**: I ported Chromium's test harness byte-for-byte (the `accessibility-dumpAccessibilityNodes.js` flow, `testRunner.log`'s alphabetical-key formatter, the tree-rebuild dumps) into an untracked runner at `tests/ax/conformance-audit.test.ts`, reproduced all 21 reachable golden fixtures in jsdom, and diffed our output against each `-expected.txt` in `/tmp/ax-audit/`. Everything below is proven against a golden (file refs given). The previous session's claim of "full reachable parity" does not hold — the nameSources _content_ is in good shape (options is byte-exact modulo `chromeRole`; summary/labelledby payloads match), but there are ~35 real divergences, several of them systemic.

---

## P0 — systemic wire-shape (pollutes every golden)

**1. `getPartialAXTree(fetchRelatives=false)` must return exactly one node.**
Ours returns the full ancestor chain (`ax-tree.ts:1171` builds `picked` from `ancestorChain` unconditionally). Chromium returns just the inspected node and exits (`inspector_accessibility_agent.cc:187-190`). Proof: every dumpNode golden; my runner's notes log "expected exactly one node, got 3/4/5" for all 60+ node dumps. Fix: when `fetchRelatives===false`, return `{nodes: [start]}`.

**2. `fetchRelatives=true` shape: target + target's children + ancestor chain — no siblings.**
Ours adds the parent's _other children_ (`ax-tree.ts:1174-1180`). Chromium runs `AddChildren(target)` then `AddAncestors` (chain only), and when the target is ignored/no-AX it _prepends the target's id into the first ancestor's `childIds`_ (`inspector_accessibility_agent.cc:68-100`). Proof: `accessibility-getTreeWithNoAXNode-expected.txt:3-8` shows a pure chain `RootWebArea → none → none → main → article → *none`; ours dumps every sibling at each level (`accessibility-ignoredNodes` tree dumps, all 20 of them). Also `AddChildren` follows ignored children one extra layer (`:58-62`) — applies to `getChildAXNodes` too (`:366`).

**3. `html`/`body`/`head` model is wrong.**

- Chromium: `html` and `body` are **ignored**, serialized `role: none`, reason `uninteresting`, present in the tree with childIds/parentId (`accessibility-getAXNodeAndAncestors-expected.txt:103-148`).
- Ours: `html` is **unignored role `document`** (via `getRole()` at `ax-tree.ts:117`), `body` is collapsed away entirely, and `head` is emitted as an ignored `notRendered` node (visible as a blank line in tree dumps).
- Chromium emits **nothing** for `head`/`style`/`script`; inspecting such a node directly returns the special no-AX-node form: `nodeId "0"`, `role none`, `chromeRole 0`, `ignoredReasons [notRendered]`, **no childIds/parentId/properties** (`inspector_type_builder_helper.cc:771-788`, proof `accessibility-getNodeWithNoAXNode-expected.txt`). Ours returns a normal ignored node with childIds+parentId; `getPartialAXTree`/`getAXNodeAndAncestors` on an unemitted node return `[]` (`ax-tree.ts:1170`, `1213`) instead of that form.

**4. `properties` must exist (possibly `[]`) on every unignored node.**
`BuildProtocolAXNodeForUnignoredAXObject` always sets it (`inspector_type_builder_helper.cc:905`). Ours omits it for StaticText (`ax-tree.ts:997-1006`), RootWebArea (`:1012-1022`), and role-less named nodes (`:1109`). Chromium's harness hard-fails on this (`checkExists("properties")`). Additionally:

- **RootWebArea properties = `[focusable:true, url:<document URL>]`** and its name has the quirky sources list `[aria-labelledby, aria-label, aria-label (superseded), nativeSource:title]` (`accessibility-getAXNodeAndAncestors-expected.txt:148-200`, `accessibility-getRootNode-expected.txt:15-43`). Ours has neither sources nor properties on the root.
- **`image` nodes carry a `url` property** (img1 in `accessibility-nameSources-img-figure-expected.txt`). Ours emits `url` only for links (`ax-tree.ts:917`).
- **StaticText nodes get `name.sources: [{type: contents, value}]`** (`accessibility-query-axtree-expected.txt:52-80`).

**5. `chromeRole` — emit it; this is no longer a ceiling.**
Every node (ignored: always `{type: internalRole, value: 0}`; unignored: the Blink role ordinal). The comment on `CreateInternalRoleValue` says the integers are "fixed over releases" (`inspector_type_builder_helper.cc:242-246`) — a hardcoded role→ordinal table from `ui/accessibility/ax_enums.mojom` reproduces it. Observed values to seed the table: RootWebArea=144, StaticText=158, heading=96, paragraph=133, article=5, main=118, button=9, textbox=170, checkbox=14, option=127, DisclosureTriangle=37, LabelText=104, generic=88, figure=84, radiogroup=142, svg-root=99, none/ignored=0. Residual risk only where our computed role diverges from Blink's internal granularity.

**6. `queryAXTree` has six provable defects** (`accessibility-query-axtree-expected.txt:88-140`):

- **Traversal order reversed**: Chromium pushes children reversed so DFS is document-order (`inspector_accessibility_agent.cc:448`); ours pops last-child-first (`ax-tree.ts:1236-1239`). Expected `node5,node6`; ours `node6,node5` — every multi-result query.
- **Subtree-rooted queries break on collapsed wrappers**: query rooted at `div.container` returns `[]` for us because the unnamed div has no AX node (`ax-tree.ts:1095`). Expected `node5,node6`. (See item 22 — this is the generic-collapse fallout.)
- **Shadow-root target must redirect to its host** (`:392-394`); ours returns `[]` for the "Shadow input" query (expected 1 node).
- **StaticText matches need text-node backend ids.** Chromium matches StaticText nodes by name and clients skip them via `DOM.describeNode` nodeType; our StaticText reuses the parent _element's_ backend id (`ax-tree.ts:1004`), so "text content" yields `node10,node10,node11,node11,…` duplicates instead of `node10,node11,node13`.
- **Ignored nodes must not name-match**: aria-hidden/presentational/unrendered elements have empty computed names in Blink (`:462-469` uses `ComputedName()`, empty for these). Ours matches `node12` (role=presentation h1) and formerly-hidden h2s by forced name.
- **`aria-labeledby` (one-l alias) is honored by Blink**: expected "bar" results include `node1`; ours misses it (`ax-tree.ts:580` and the dom-accessibility-api path only read the double-l spelling).
- Inclusion nuance for unrendered nodes: hidden `<h2>` matches `role:heading` (expected prints `unrendered`) but hidden `<button>` does **not** match `role:button` — Blink keeps some unrendered semantic roles in-tree (headings) but not widgets. Ours matches both. Approximate with a role allowlist.

**7. `getFullAXTree(depth)` semantics**: depth counts **unignored** levels; ignored wrappers (html/body) are traversed free; all levels ≤ depth are emitted with dangling childIds allowed (`WalkAXNodesToDepth`, `inspector_accessibility_agent.cc:102-131`). Proof: `getFullAXTree-depth-expected.txt` shows `RootWebArea → generic/button → StaticText/link` for depth=2; ours burns depth on html/body and emits `RootWebArea → document → (blank)`. Ours: `ax-tree.ts:1087`, `1122-1135`.

## P1 — name.sources per-element slot tables

**8. Text inputs** (`accessibility-nameSources-input-expected.txt`, visiblity golden): Chromium emits **seven** slots: `[labelledby, aria-label, label, title, placeholder, aria-placeholder, title(again)]` — title _before_ placeholder, an `aria-placeholder` slot (type `placeholder`), and a duplicate trailing title. Title **wins** over placeholder (text3 name = `text3-title`). Ours emits five in the wrong order (`ax-tree.ts:621-625`).

**9. Button-like inputs** (`accessibility-nameSources-input-buttons-expected.txt`): slots are `[labelledby, aria-label, label, value-attribute, contents, title]` — a `value` _attribute_ slot, no placeholder slots; `input[type=submit]` surfaces the default label "Submit" as the **contents** slot's value; `input[type=image]` gets `[…, alt, value, title, type]` with the `type` attribute slot carrying the fallback. Ours has none of this (`ax-tree.ts:604-625`).

**10. `nativeSource` kind must reflect the association**: `labelfor` (label[for]), `labelwrapped` (wrapping label), bare `label` (none/unassociated — including a wrapping `label[for=elsewhere]`, see text8). Ours hardcodes `label` (`ax-tree.ts:607`). Verified across all 12 inputs and button11.

**11. The `labelledby` property derives from the winning name source, not the attribute** (`inspector_type_builder_helper.cc:895-903`): emitted when the winning source has related objects — including **native labels** (input5 in visiblity golden: `relatedNodes: [{nodeResult: label, text: }]`, empty text still present); dropped when aria-labelledby is superseded, broken (labelledby5), or empty (labelledby6). Ours keys on attribute presence (`ax-tree.ts:916`).

**12. Element-specific slot lists**: `<figure>` = `[labelledby, aria-label, title]` — **no figcaption slot** (ours adds one, `ax-tree.ts:608-609`); `<svg>` = `[labelledby, aria-label, nativeSource:title(child <title>), title-attr]` and role **image** (chromeRole 99) — ours collapses svg entirely; `<p>` and `generic` = `[labelledby, aria-label]` only — **no title slot, no contents** (ours appends title universally at `:625`); `<label>` = internal role **LabelText**, name empty, slots `[labelledby, aria-label, title]`.

**13. Suppress `description` when it equals the name** (title won the name): summary2/figure2/button7 — ours emits a duplicate `description` (`ax-tree.ts:1101`). Conversely **summary outside `<details>`** is `generic` with `description` = its text contents (`accessibility-ignoredNodes-expected.txt`, chromeRole 88) — ours gives it role `button` via `getRole()`.

## P2 — AccName computation

**14. Contents candidates and related-node `text` need a real text-equivalent walker.** Ours uses raw `textContent` (`ax-tree.ts:617-618`, `:502-503`), so: link1's contents slot says "1 2 3 4 5 6 7" instead of "1 2 7" (skip display:none/visibility:hidden/aria-hidden descendants); button4's contents misses img alt "cake"; joining must be space-separated ("I love cake !" — ours "I love cake!", and `name.value` has the same flaw since `computeAccessibleName` joins differently). Proof: visiblity + buttons goldens.

**15. Hidden aria-labelledby targets contribute their full unfiltered subtree text**: input3 = "1 2 3 4 5 6 7" (ours "1 2 3 4 6 7"), input4 (target inside display:none) = all text (ours filters), button4 (aria-hidden target with nested aria-hidden p) = "Before Text within hidden subtree After" (ours drops the nested part).

**16. aria-labelledby is non-recursive**: self-reference uses contents without re-following (labelledby3 = "Contents Label 3", ours doubles it), chains are not followed (labelledby4 = "Contents 4", ours "Contents 4 chained"), but `aria-label` _on_ the target is used (labelledby10 ✓).

**17. Empty/broken labelledby falls through to the next source**: labelledby6 → "Contents"; ours returns "". Recommended fix for 14-17: derive `name.value` from the winning `nameSources()` candidate (one pipeline) instead of a second `computeAccessibleName` call, with a custom walker.

**18. Generic elements take no name from title or contents**: `div[title]` (node24) and the `<label>` element (node22) must not match "Accessible Name"; ours names both.

**19. StaticText boundary whitespace**: Chromium keeps the trailing space in `StaticText "Some text in a div, also a "` (`accessibility-getFullAXTree-expected.txt:6`); our `textValue` trims (`ax-tree.ts:93-95`). Partially reachable (heuristic: collapse runs, keep one boundary space when the raw node had whitespace and a rendered inline sibling follows).

## P3 — properties / value / state

**20.** `invalid: false` is also emitted for `<button>`, `input[type=button/submit/…]`, `<select>` (proof: buttons/labelledby/input-buttons/ignoredNodes goldens) — ours gates to input/textarea/select (`ax-tree.ts:763-777`). | `settable` only for text-entry fields + contenteditable — not checkbox/button-inputs/select (`:791-798` too broad). | `value` key only for text-entry inputs — ours leaks `"on"` for checkboxes and `button-value2` for button inputs (`:454-459`). | `<option>` gets `focusable: true` (options golden) — extend `isFocusable` (`:350-357`). | Native `<select>` (combobox) emits `hasPopup: menu` + `expanded: false` (`accessibility-ignoredNodes-expected.txt` select block) — ours emits neither without ARIA attributes (`:843-845`, `:877-879`).

**21. Dialog/modal** (modal + ignoredNodesModal goldens; jsdom's `showModal()` works): a modally-shown dialog gets `focusable`, `focused`, `modal: true` (no aria-modal attribute needed; use `dialog.matches(':modal')` in production, open+heuristic in jsdom); content outside an open modal is ignored with reason **`activeModalDialog`** carrying `{type: idref, relatedNodes: [dialog]}`; a closed `<dialog>` is the no-AX-node form (chromeRole 0). Ours: empty properties on the dialog, no outside-suppression (`ax-tree.ts:885` only reads the attribute).

**22. Inherited inert reports `inertElement` with a plain boolean** — not `inertSubtree`+idref (both inert buttons in ignoredNodes-expected). Our `subtreeReason` maps it to `inertSubtree` with idref (`ax-tree.ts:272-273`). The `ariaHiddenSubtree` idref shape is correct as-is (verified byte-exact).

**23. Presentational inheritance only flows to required-owned children**: the `<div>` inside `role='none' <ol>` must stay **unignored generic**; ours marks it `presentationalRole` because inheritance is keyed on the parent tag only (`ax-tree.ts:1043-1046`) — also gate on the _child_ being required-owned (li, tr/td…).

**24.** Plain `<canvas>` (no fallback) → ignored reason **`probablyPresentational`** (ours collapses it). | `<img alt="" title="x">` stays role `image` (global attribute rescues it; ours returns null at `ax-tree.ts:136` regardless of title) — proof: last node of img-figure golden, unignored image with `url` property.

**25. Unrendered (display:none) nodes exist as AXObjects but are not "included in tree"**: they don't appear in full-tree childIds or (mostly) query results, yet direct `getPartialAXTree` on them returns a real ignored node with parentId/childIds and reason notRendered (span-in-hidden-div block, ignoredNodes-expected). Ours prunes descendants entirely (no node to inspect) while _including_ the subtree root in the full tree — both halves are wrong in opposite directions.

## P4 — protocol layer (`src/frame/index.ts:551-558`)

**26.** `queryAXTree` with no target must error `"Either nodeId, backendNodeId or objectId must be specified"`; bad nodeId → `"Could not find node with given id"`; bad backendNodeId → `"No node found for given backend id"`; bad objectId → `"Invalid remote object id"` (all code -32000, `accessibility-query-axtree-errors-expected.txt`). Ours silently queries from the root / returns `[]`.

## The keep-vs-revert decision: generic-collapse

This is no longer a cosmetic divergence — the audit proves it breaks behavior: container-rooted `queryAXTree` returns nothing (P0-6), `getPartialAXTree` on a plain div returns nothing where Chromium dumps a `generic` node (labelledby golden's `div#div`), and tree shapes diverge in every dump. Chromium's actual model is element-specific: plain `<div>` → **unignored `generic`** (name only from labelledby/aria-label); `<span>`, `display:contents` wrappers → **ignored `uninteresting`** (still included, children kept); `html`/`body` → ignored `uninteresting`. My recommendation is to revert collapse in favor of that three-way model — but it's your call, and it's the single largest blast-radius change here.

## Ceiling — confirmed, with two demotions

Still ceiling: **InlineTextBox** leaves (text shaping), **`<ul>` bullet glyphs / display-locked content-visibility** (layout), **cross-frame traversal** (child-frame trees, frameId-addressed methods). Demoted to reachable: **`chromeRole`** (static ordinal table, P0-5) and the **`Iframe` placeholder leaf** in the parent tree (`accessibility-getFullAXTree-expected.txt:13` — the iframe _element_ is in our DOM; emit internal role `Iframe` with no children). The two event goldens (`nodes-updated…`, `tree-updated-events`) test push events, out of scope for the six read methods.

---

Artifacts: runner `tests/ax/conformance-audit.test.ts` (untracked), per-golden diffs in `/tmp/ax-audit/`. Two diff artifacts to ignore when re-running: expected files end with a blank line my generator doesn't add, and the query golden's `Running test:` headers come from Chromium's suite runner, not the protocol.
