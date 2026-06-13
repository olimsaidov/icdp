---
description: "How icdp synthesizes a Chromium-shaped accessibility tree from the real DOM, and how that fidelity is tested."
---

# The accessibility tree

A [Client](/explanation/concepts) addresses elements through the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/), and for an accessibility-driven Client the protocol surface that matters most is the `Accessibility` domain. agent-browser's `snapshot -i` reads it, and its semantic locators — `find role button --name "Save"` — resolve against it. So the accessibility (AX) tree is not a peripheral feature of icdp: it is the addressing layer. If the tree icdp returns does not match what a real Chromium browser would have returned, the Client cannot find, name, or click the element, and nothing downstream works.

This page explains why the [Frame Agent](/explanation/concepts) builds an AX tree at all, how it builds one, and how its shape is held to a Chromium-equivalent standard. For the method signatures and behavior, see the [frame reference](/reference/frame) and the [CDP support matrix](/reference/cdp-support).

## Why a synthesized tree

In a real CDP session the AX tree comes from the browser's own accessibility engine, computed from layout. icdp has no browser engine — the [Host](/explanation/concepts), Relay, and Client run as plain JavaScript and the embedded app runs in an ordinary iframe. There is no debugging backend to ask for an accessibility snapshot.

The Frame Agent runs *inside* the iframe'd app, where it does have the one thing the AX tree is computed from: the live DOM, with its attributes, ARIA, labels, and shadow roots all reachable. It therefore synthesizes the CDP `Accessibility` tree in page JavaScript, walking the real document and computing each node's role, accessible name, properties, and parent/child relationships the way Chromium would.

The bar is deliberate. icdp does not aim to reproduce every nuance of Chromium's accessibility implementation; it aims to reproduce the shape agent-browser depends on — roles, accessible names, the ignored/included distinction, and the tree structure that semantic locators traverse. Cases that a layout-less, single-frame DOM fundamentally cannot reproduce (such as `InlineTextBox` leaves, which require layout, and cross-frame iframe sections) are treated as a known ceiling rather than a target.

## How the tree is built

Role and name computation are the load-bearing parts, and icdp leans on two standard libraries for them rather than hand-rolling the ARIA spec:

- [`aria-query`](https://www.npmjs.com/package/aria-query) supplies the canonical ARIA role table. The Frame Agent imports its `roles` map to validate computed roles and to map between ARIA roles and Chromium's internal role names.
- [`dom-accessibility-api`](https://www.npmjs.com/package/dom-accessibility-api) supplies `getRole` (an element's computed ARIA role) and accessible-description computation, used as inputs to icdp's own Chromium-aligned role and name resolution.

On top of those, `ax-tree.ts` carries the Chromium-specific machinery the standard libraries do not provide: native-element roles (for example, `<a href>` maps to `link`, `<summary>` inside `<details>` maps to a disclosure triangle, `<input>` types map to their respective roles), the ordered accessible-name source list that mirrors Chromium's `NameSources`, the ignored/included classification, and serialization to the protocol's `AXNode` wire shape — including the distinction between ARIA wire roles and Chromium's internal roles. A DOM-to-backend-node registry keeps the identity that lets a Client resolve a returned AX node back to a real element.

The Frame Agent registers exactly these `Accessibility` methods against that machinery (see the [CDP support matrix](/reference/cdp-support)):

```text
Accessibility.getFullAXTree
Accessibility.getPartialAXTree
Accessibility.getRootAXNode
Accessibility.getChildAXNodes
Accessibility.getAXNodeAndAncestors
Accessibility.queryAXTree
```

`getFullAXTree` walks the document depth-first into the protocol node list (with an optional `depth` cap); `queryAXTree` filters a subtree by accessible name and/or role and is what backs a semantic locator's search. The remaining methods fetch a single node, its children, or its ancestor chain. None of them mutate the DOM — they read the document as it stands when the call arrives.

::: info Synthesized, not observed
Because the tree is computed from the current DOM on each call, it always reflects the live document — after a route change, a re-render, or a shadow-DOM update. There is no cached snapshot to invalidate.
:::

## Conformance: validated against Chromium goldens

A synthesized tree is only useful if it matches the real thing, so the shape is pinned to Chromium's own output. The conformance suite under `tests/ax` is a byte-for-byte replay of Chromium's `inspector-protocol` accessibility goldens.

The mechanics are deliberately self-contained so the suite runs anywhere, including CI:

- Each case drives icdp's `ax-tree.ts` over a fixture derived from a Chromium golden, then renders the result through a port of Chromium's own dump formatters (`testRunner.log`, the per-golden tree printers, the `dumpAccessibilityNodes` flow).
- The expected output is **vendored** into the suite — produced from a local Chromium checkout by `npm run gen:conformance` and embedded, so the test run itself reads no Chromium source.
- The actual dump is asserted equal to the vendored expected output. URL property values, which differ between the jsdom test document and Chromium's test server, are masked on both sides because the host and path are not what these goldens verify.

A handful of cases are marked as *ceiling* cases: the `InlineTextBox` leaves and cross-frame iframe sections that a layout-less single-frame DOM cannot reproduce. These have no vendored golden; the suite only confirms the driver produces a dump for them, rather than asserting an exact tree.

::: tip Regenerating goldens
After a Chromium sync, or when adding a case, the vendored expected output is regenerated with `npm run gen:conformance` against a local Chromium checkout. The committed suite then runs with no Chromium dependency.
:::

## Known divergences

icdp reproduces Chromium's accessibility output closely enough to pass the vendored goldens, but it is a synthesis, not the engine, and a small number of Chromium behaviors are knowingly out of reach or knowingly approximated. Where icdp deviates, the divergence is documented at the point of deviation in `ax-tree.ts` rather than hidden — the comments there are the authoritative record of where the synthesized tree and a real Chromium tree part ways, and the ceiling cases above are the clearest examples. The practical consequence is the same one stated at the top: the compatibility contract is agent-browser's support matrix. Within that matrix the tree is held to the goldens; outside it, fidelity is best-effort and not promised.
