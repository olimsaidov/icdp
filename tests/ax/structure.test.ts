// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { byRole, dumpTree } from "./_dump.ts";
import { build, resetDocument, snapshot } from "./_fixtures.ts";

afterEach(resetDocument);

// composedChildren / tree shaping: shadow DOM flattening, slot assignment, table
// section reordering, and the generic-vs-excluded wrapper rules.
describe("tree structure", () => {
  test("table thead/tbody/tfoot are reordered head, body, foot regardless of source order", () => {
    const nodes = build(
      `<table>` +
        `<tfoot><tr><td>foot</td></tr></tfoot>` +
        `<tbody><tr><td>body</td></tr></tbody>` +
        `<thead><tr><td>head</td></tr></thead>` +
        `</table>`,
    );
    const dump = dumpTree(nodes);
    expect(dump.indexOf("head")).toBeLessThan(dump.indexOf("body"));
    expect(dump.indexOf("body")).toBeLessThan(dump.indexOf("foot"));
  });

  test("shadow DOM: slotted light children appear at the slot position", () => {
    // Attach the shadow root imperatively, then snapshot without touching innerHTML.
    document.body.innerHTML = `<x-card><span>slotted text</span></x-card>`;
    const host = document.querySelector("x-card")!;
    host.attachShadow({ mode: "open" }).innerHTML = `<main><slot></slot></main>`;
    const nodes = snapshot();
    expect(byRole(nodes, "main")).toBeDefined();
    expect(dumpTree(nodes)).toContain("slotted text");
  });

  test("an anonymous unnamed block <div> is an unignored generic node (Chromium parity)", () => {
    const nodes = build(`<main><div><button>x</button></div></main>`);
    const main = byRole(nodes, "main");
    const wrapper = byRole(nodes, "generic");
    const button = byRole(nodes, "button");
    expect(wrapper?.parentId).toBe(main?.nodeId);
    expect(button?.parentId).toBe(wrapper?.nodeId);
  });

  test("an unnamed inline <span> is excluded; its text hoists to the parent", () => {
    const nodes = build(`<main><span>wrapped</span></main>`);
    const main = byRole(nodes, "main");
    const text = byRole(nodes, "StaticText");
    expect(text?.parentId).toBe(main?.nodeId);
    expect(byRole(nodes, "generic")).toBeUndefined();
  });
});

// ListMarker generation. getComputedStyle(li).display === "list-item" fires in
// jsdom for both <ol> and <ul>, so these exercise the impl's <ol>-only /
// numeric-only guard — not a jsdom limitation. <ul> disc glyphs are a ceiling.
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

  test("DIVERGENCE: unordered <ul> items get NO ListMarker (Chromium emits disc markers)", () => {
    const nodes = build(`<ul><li>x</li><li>y</li></ul>`);
    expect(nodes.filter((node) => node.role?.value === "ListMarker")).toHaveLength(0);
    expect(byRole(nodes, "list")).toBeDefined();
  });
});
