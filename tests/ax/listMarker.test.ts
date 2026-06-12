// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { byRole, dumpTree } from "./_dump.ts";
import { build, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

// ListMarker generation. Verified: getComputedStyle(li).display === "list-item"
// fires in jsdom for both <ol> and <ul>, so these tests exercise the impl's
// <ol>-only / numeric-only guard rather than a jsdom limitation.
describe("list markers", () => {
  test("ordered list items get a numbered ListMarker with a StaticText child", () => {
    const nodes = build(`<ol><li>first</li><li>second</li></ol>`);
    const markers = nodes.filter((node) => node.role?.value === "ListMarker");
    expect(markers).toHaveLength(2);
    expect(markers[0]?.name).toEqual({ type: "computedString", value: "1. " });
    expect(markers[1]?.name).toEqual({ type: "computedString", value: "2. " });
    // each marker has a StaticText child carrying the same text
    const markerChild = nodes.find((node) => node.nodeId === markers[0]?.childIds?.[0]);
    expect(markerChild?.role?.value).toBe("StaticText");
    expect(markerChild?.name?.value).toBe("1. ");
  });

  test("ordered list honors the start attribute", () => {
    const nodes = build(`<ol start="5"><li>a</li><li>b</li></ol>`);
    const markers = nodes.filter((node) => node.role?.value === "ListMarker");
    expect(markers.map((m) => m.name?.value)).toEqual(["5. ", "6. "]);
  });

  test("the full ordered-list dump", () => {
    const nodes = build(`<ol><li>alpha</li><li>beta</li></ol>`);
    expect("\n" + dumpTree(nodes) + "\n").toMatchInlineSnapshot(`
      "
      RootWebArea "Fixture"
        document

          list
            listitem
              ListMarker "1. "
                StaticText "1. "
              StaticText "alpha"
            listitem
              ListMarker "2. "
                StaticText "2. "
              StaticText "beta"
      "
    `);
  });

  // --- Divergence guards ---

  test("DIVERGENCE: unordered <ul> items get NO ListMarker (Chromium emits disc markers)", () => {
    const nodes = build(`<ul><li>x</li><li>y</li></ul>`);
    expect(nodes.filter((node) => node.role?.value === "ListMarker")).toHaveLength(0);
    expect(byRole(nodes, "list")).toBeDefined();
  });
});
