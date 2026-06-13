// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import {
  getAXNodeAndAncestors,
  getChildAXNodes,
  getFullAXTree,
  getPartialAXTree,
  getRootAXNode,
  queryAXTree,
} from "../../src/frame/ax-tree.ts";
import { byRole, dumpTree, stabilize } from "./_dump.ts";
import { build, buildContext, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

// The CDP Accessibility read-method surface and the shape of the tree they
// serialize. Byte-exact replay of Chromium's own method goldens lives in
// conformance.test.ts; this file pins the invariants in a readable form and
// covers cases the goldens don't (depth, no-target back-compat).
describe("read-method surface", () => {
  // --- getFullAXTree: the serialized tree ---

  test("role+name tree-walk dump", () => {
    const nodes = build(
      `<main>` +
        `<h1>Title</h1>` +
        `<a href="/dest">A link</a>` +
        `<button>Go</button>` +
        `<div>anon wrapper</div>` +
        `</main>`,
    );
    // The one divergence here vs Chromium: no InlineTextBox leaf under each
    // StaticText (a layout-engine ceiling). html/body are ignored wrappers
    // (spliced out of this dump) and the anonymous <div> is an unignored
    // `generic` node — both Chromium-exact.
    expect("\n" + dumpTree(nodes) + "\n").toMatchInlineSnapshot(`
      "
      RootWebArea "Fixture"
        main
          heading "Title"
            StaticText "Title"
          link "A link"
            StaticText "A link"
          button "Go"
            StaticText "Go"
          generic
            StaticText "anon wrapper"
      "
    `);
  });

  test("nodes form a single rooted tree addressed by childIds", () => {
    const nodes = build("<button>Go</button>");
    const roots = nodes.filter((node) => !node.parentId);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.role?.value).toBe("RootWebArea");
    // every childId resolves to an emitted node
    const ids = new Set(nodes.map((node) => node.nodeId));
    for (const node of nodes)
      for (const child of node.childIds ?? []) expect(ids.has(child)).toBe(true);
  });

  test("RootWebArea name is the document title, empty when untitled (no href fallback)", () => {
    expect(byRole(build(`<p>x</p>`, ""), "RootWebArea")?.name?.value).toBe("");
    expect(byRole(build(`<p>x</p>`, "My Page"), "RootWebArea")?.name?.value).toBe("My Page");
  });

  test("RootWebArea backendDOMNodeId targets the Document, not <html>", () => {
    const nodes = build("<p>hi</p>");
    const root = byRole(nodes, "RootWebArea");
    // <html> serializes as an ignored role:none child of the root
    const htmlNode = nodes.find((node) => node.parentId === root?.nodeId);
    expect(typeof root?.backendDOMNodeId).toBe("number");
    expect(htmlNode?.ignored).toBe(true);
    expect(root?.backendDOMNodeId).not.toBe(htmlNode?.backendDOMNodeId);
  });

  test("frameId is emitted only on the root (RootWebArea)", () => {
    const nodes = build("<main><button>Go</button></main>");
    const withFrameId = nodes.filter((node) => node.frameId !== undefined);
    expect(withFrameId).toHaveLength(1);
    expect(withFrameId[0]?.role?.value).toBe("RootWebArea");
    expect(byRole(nodes, "button")?.frameId).toBeUndefined();
  });

  test("a serialized node carries chromeRole, ordered name.sources, and properties", () => {
    const button = byRole(build("<button>Go</button>"), "button");
    expect(button).toBeDefined();
    expect(stabilize(button!)).toMatchInlineSnapshot(`
      {
        "backendDOMNodeId": "<number>",
        "childIds": "<object>",
        "chromeRole": {
          "type": "internalRole",
          "value": 9,
        },
        "ignored": false,
        "name": {
          "sources": [
            {
              "attribute": "aria-labelledby",
              "type": "relatedElement",
            },
            {
              "attribute": "aria-label",
              "type": "attribute",
            },
            {
              "nativeSource": "label",
              "type": "relatedElement",
            },
            {
              "type": "contents",
              "value": {
                "type": "computedString",
                "value": "Go",
              },
            },
            {
              "attribute": "title",
              "superseded": true,
              "type": "attribute",
            },
          ],
          "type": "computedString",
          "value": "Go",
        },
        "nodeId": "<string>",
        "parentId": "<string>",
        "properties": [
          {
            "name": "invalid",
            "value": {
              "type": "token",
              "value": "false",
            },
          },
          {
            "name": "focusable",
            "value": {
              "type": "booleanOrUndefined",
              "value": true,
            },
          },
        ],
        "role": {
          "type": "role",
          "value": "button",
        },
      }
    `);
  });

  test("getFullAXTree honors the depth param (shallow tree omits deep descendants)", () => {
    const { options } = buildContext(
      `<main><section><article><button>deep</button></article></section></main>`,
    );
    const full = getFullAXTree(options).nodes;
    const shallow = getFullAXTree(options, 2).nodes;
    expect(full.some((node) => node.role?.value === "button")).toBe(true);
    expect(shallow.length).toBeLessThan(full.length);
    expect(shallow.some((node) => node.role?.value === "button")).toBe(false);
  });

  // --- the node-addressed read methods ---

  test("getRootAXNode returns the RootWebArea", () => {
    const { options } = buildContext(`<main><button>Go</button></main>`);
    const { node } = getRootAXNode(options);
    expect(node.role?.value).toBe("RootWebArea");
    expect(node.parentId).toBeUndefined();
  });

  test("getChildAXNodes follows ignored children one extra layer (Chromium AddChildren)", () => {
    const { options } = buildContext(`<main><button>Go</button></main>`);
    const root = getRootAXNode(options).node;
    const children = getChildAXNodes(options, root.nodeId).nodes;
    // the root's direct child is the ignored <html>; ignored wrappers are
    // emitted AND followed through, surfacing <main> in the same response
    expect(children[0]?.nodeId).toBe(root.childIds?.[0]);
    expect(children.some((child) => child.role?.value === "main")).toBe(true);
  });

  test("getAXNodeAndAncestors returns the node up through the root", () => {
    const { options, backendIdFor } = buildContext(`<main><button>Go</button></main>`);
    const chain = getAXNodeAndAncestors(options, backendIdFor("button")).nodes;
    expect(chain[0]?.role?.value).toBe("button");
    expect(chain.at(-1)?.role?.value).toBe("RootWebArea");
  });

  test("getPartialAXTree(target) returns the node, ancestors, and relatives — not far subtrees", () => {
    const { options, backendIdFor } = buildContext(
      `<main><button>Go</button><nav><a href="/x">FarLink</a></nav></main>`,
    );
    const partial = getPartialAXTree(options, backendIdFor("button")).nodes;
    const roles = partial.map((node) => node.role?.value);
    expect(roles).toContain("button"); // the target
    expect(roles).toContain("RootWebArea"); // an ancestor
    // a far cousin's leaf text is NOT pulled in:
    expect(partial.some((node) => node.name?.value === "FarLink")).toBe(false);
  });

  test("getPartialAXTree() with no target returns the full tree (back-compat)", () => {
    const { options } = buildContext(`<main><button>Go</button></main>`);
    expect(getPartialAXTree(options).nodes.length).toBe(getFullAXTree(options).nodes.length);
  });

  test("queryAXTree finds nodes by role and by accessible name", () => {
    const { options, backendIdFor } = buildContext(
      `<main><button>Go</button><button>Stop</button></main>`,
    );
    const buttons = queryAXTree(options, { target: backendIdFor("main"), role: "button" }).nodes;
    expect(buttons).toHaveLength(2);
    const stop = queryAXTree(options, { role: "button", accessibleName: "Stop" }).nodes;
    expect(stop.map((node) => node.name?.value)).toEqual(["Stop"]);
  });
});
