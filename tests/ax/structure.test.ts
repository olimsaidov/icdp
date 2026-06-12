// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { allByRole, byRole, dumpTree } from "./_dump.ts";
import { build, resetDocument, snapshot } from "./_fixtures.ts";

afterEach(resetDocument);

// composedChildren / tree shaping: shadow DOM flattening, slot assignment, table
// section reordering, and the generic-collapse heuristic.
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

  // --- Divergence guards ---

  test("DIVERGENCE: an anonymous unnamed <div> is collapsed (Chromium keeps a generic node)", () => {
    const nodes = build(`<main><div><button>x</button></div></main>`);
    // The wrapper div has no role and no name -> collapsed, button hoisted under main.
    const main = byRole(nodes, "main");
    const button = byRole(nodes, "button");
    expect(button?.parentId).toBe(main?.nodeId);
  });

  test("RootWebArea name is the document title, empty when untitled (no href fallback)", () => {
    expect(byRole(build(`<p>x</p>`, ""), "RootWebArea")?.name).toEqual({
      type: "computedString",
      value: "",
    });
    expect(byRole(build(`<p>x</p>`, "My Page"), "RootWebArea")?.name?.value).toBe("My Page");
  });

  test("frameId is emitted only on the root", () => {
    const nodes = build(`<main><button>x</button></main>`);
    expect(nodes.filter((node) => node.frameId !== undefined)).toHaveLength(1);
    expect(allByRole(nodes, "button")[0]?.frameId).toBeUndefined();
  });
});
