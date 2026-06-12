// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { byRole, dumpTree, prop, stabilize } from "./_dump.ts";
import { build, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

// Mirrors web_tests/http/tests/inspector-protocol/accessibility/accessibility-getFullAXTree.
// The inline snapshots capture our impl's ACTUAL output, so they pin current
// behavior — including confirmed divergences from Chromium that are called out
// alongside each assertion.
describe("Accessibility.getFullAXTree", () => {
  test("role+name tree-walk dump", () => {
    const nodes = build(
      `<main>` +
        `<h1>Title</h1>` +
        `<a href="/dest">A link</a>` +
        `<button>Go</button>` +
        `<div>anon wrapper</div>` +
        `</main>`,
    );
    // Divergences baked into this golden vs Chromium:
    //  - NO `InlineTextBox` leaf under each StaticText (impl never emits them).
    //  - the anonymous <div> is collapsed (generic-collapse) and its text promoted.
    expect("\n" + dumpTree(nodes) + "\n").toMatchInlineSnapshot(`
      "
      RootWebArea "Fixture"
        document

          main
            heading "Title"
              StaticText "Title"
            link "A link"
              StaticText "A link"
            button "Go"
              StaticText "Go"
            StaticText "anon wrapper"
      "
    `);
  });

  test("RootWebArea carries the document title as its name", () => {
    const nodes = build("<p>hi</p>", "Page Title");
    const root = byRole(nodes, "RootWebArea");
    expect(root?.name).toEqual({ type: "computedString", value: "Page Title" });
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

  // --- Regression guards for confirmed divergences (pin current behavior) ---

  test("internal roles use AXValue type 'internalRole'; ARIA roles use 'role'", () => {
    const nodes = build("<h1>x</h1>");
    expect(byRole(nodes, "RootWebArea")?.role?.type).toBe("internalRole");
    expect(byRole(nodes, "StaticText")?.role?.type).toBe("internalRole");
    expect(byRole(nodes, "heading")?.role?.type).toBe("role");
  });

  test("frameId is emitted only on the root (RootWebArea)", () => {
    const nodes = build("<button>Go</button>");
    const withFrameId = nodes.filter((node) => node.frameId !== undefined);
    expect(withFrameId).toHaveLength(1);
    expect(withFrameId[0]?.role?.value).toBe("RootWebArea");
    expect(byRole(nodes, "button")?.frameId).toBeUndefined();
  });

  test("RootWebArea backendDOMNodeId targets the Document, not <html>", () => {
    const nodes = build("<p>hi</p>");
    const root = byRole(nodes, "RootWebArea");
    const htmlNode = byRole(nodes, "document"); // the <html> element's own node
    expect(typeof root?.backendDOMNodeId).toBe("number");
    // distinct from the documentElement's backend id
    expect(root?.backendDOMNodeId).not.toBe(htmlNode?.backendDOMNodeId);
  });

  test("stabilized node dump masks volatile ids and exposes the payload", () => {
    const nodes = build("<button>Go</button>");
    const button = byRole(nodes, "button");
    expect(button).toBeDefined();
    expect(stabilize(button!)).toMatchInlineSnapshot(`
      {
        "backendDOMNodeId": "<number>",
        "childIds": "<object>",
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

  test("button exposes focusable property (true)", () => {
    const nodes = build("<button>Go</button>");
    expect(prop(byRole(nodes, "button"), "focusable")).toEqual({
      type: "booleanOrUndefined",
      value: true,
    });
  });
});
