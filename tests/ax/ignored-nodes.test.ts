// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { dumpTree, dumpTreeWithIgnored, reasonsOf } from "./_dump.ts";
import { build, inspect, queryRole, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

// Mirrors accessibility-ignoredNodes. Hidden/ignored content is mostly EXCLUDED
// from the serialized tree (Chromium's ignored-but-included rules) and is only
// reachable by direct inspection via getPartialAXTree(fetchRelatives: false) —
// which is exactly how the Chromium goldens probe these nodes.
describe("ignored nodes", () => {
  test("display:none => ignored role:none with reason notRendered, no name", () => {
    const button = inspect(`<button style="display:none">x</button>`, "button");
    expect(button?.ignored).toBe(true);
    expect(button?.role).toEqual({ type: "role", value: "none" });
    expect(button).not.toHaveProperty("name");
    expect(reasonsOf(button)).toContain("notRendered");
  });

  test("visibility:hidden => reason notVisible", () => {
    const button = inspect(`<button style="visibility:hidden">x</button>`, "button");
    expect(reasonsOf(button)).toContain("notVisible");
  });

  test("aria-hidden=true => reason ariaHiddenElement", () => {
    const button = inspect(`<button aria-hidden="true">x</button>`, "button");
    expect(reasonsOf(button)).toContain("ariaHiddenElement");
  });

  test("inert => reason inertElement", () => {
    const button = inspect(`<button inert>x</button>`, "button");
    expect(reasonsOf(button)).toContain("inertElement");
  });

  test("aria-hidden descendants inherit ariaHiddenSubtree; inert stays inertElement", () => {
    const hidden = inspect(`<div aria-hidden="true"><button>x</button></div>`, "button");
    expect(reasonsOf(hidden)).toContain("ariaHiddenSubtree");
    // Chromium reports inertElement (plain boolean) even for inherited inertness.
    const inert = inspect(`<div inert><button>x</button></div>`, "button");
    expect(reasonsOf(inert)).toContain("inertElement");
    expect(inert?.ignoredReasons?.find((reason) => reason.name === "inertElement")?.value).toEqual({
      type: "boolean",
      value: true,
    });
  });

  test("descendants of an aria-hidden subtree stay individually inspectable", () => {
    const button = inspect(
      `<div aria-hidden="true"><section><button>Deep</button></section></div>`,
      "button",
    );
    expect(button?.ignored).toBe(true);
    expect(button?.role).toEqual({ type: "role", value: "none" });
    expect(reasonsOf(button)).toContain("ariaHiddenSubtree");
  });

  test("queryAXTree only reaches hidden nodes kept in the tree (lang/label refs)", () => {
    // content excluded from the tree is unreachable, exactly like Chromium
    expect(queryRole(`<div aria-hidden="true"><button>Deep</button></div>`, "button")).toHaveLength(
      0,
    );
    // …but hidden nodes retained in the tree (e.g. via lang) match by their
    // real role, with the name suppressed (Chromium's ComputedName)
    const kept = queryRole(`<h2 aria-hidden="true" lang="x">title</h2>`, "heading");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.ignored).toBe(true);
    expect(kept[0]?.name?.value).toBe("");
  });

  test("ignored nodes carry role:none and omit the name (direct inspection)", () => {
    const button = inspect(`<button aria-hidden="true">Save</button>`, "button");
    expect(button?.role).toEqual({ type: "role", value: "none" });
    expect(button).not.toHaveProperty("name");
  });

  test("an element-variant reason value is a plain boolean", () => {
    const button = inspect(`<button aria-hidden="true">x</button>`, "button");
    for (const reason of button?.ignoredReasons ?? [])
      expect(reason.value).toEqual({ type: "boolean", value: true });
  });

  test("an ancestor-derived reason carries a relatedNodes idref to the offending ancestor", () => {
    const button = inspect(`<div id="veil" aria-hidden="true"><button>x</button></div>`, "button");
    const reason = button?.ignoredReasons?.find((r) => r.name === "ariaHiddenSubtree");
    expect(reason?.value.type).toBe("idref");
    expect(reason?.value.relatedNodes?.[0]?.idref).toBe("veil");
  });

  test("aria-hidden subtrees are excluded from the tree entirely (text never leaks)", () => {
    const nodes = build(`<div aria-hidden="true">secret</div>`);
    expect(nodes.some((n) => n.name?.value === "secret")).toBe(false);
    // the hidden div is not in the tree at all — only direct inspection reaches it
    expect(nodes.some((n) => reasonsOf(n).includes("ariaHiddenElement"))).toBe(false);
    expect(reasonsOf(inspect(`<div aria-hidden="true">secret</div>`, "div"))).toContain(
      "ariaHiddenElement",
    );
  });

  test("explicit role=presentation => ignored presentationalRole, inherited by list items", () => {
    const html = `<ul role="presentation"><li>x</li></ul>`;
    expect(reasonsOf(inspect(html, "ul"))).toContain("presentationalRole");
    expect(reasonsOf(inspect(html, "li"))).toContain("presentationalRole");
  });

  test("role=presentation on a plain container does NOT make its children presentational", () => {
    const nodes = build(`<div role="presentation"><button>x</button></div>`);
    const button = nodes.find((node) => node.role?.value === "button");
    expect(button?.ignored).toBe(false);
    expect(button?.name?.value).toBe("x");
  });

  test("the hidden attribute maps to notRendered (Chromium has no bespoke 'hidden' reason)", () => {
    const reasons = reasonsOf(inspect(`<button hidden>x</button>`, "button"));
    expect(reasons).toContain("notRendered");
    expect(reasons).not.toContain("hidden");
  });

  test("ignored wrapper topology is visible in the non-splicing dump", () => {
    const nodes = build(`<main><span>wrapped</span><button>Shown</button></main>`);
    // html and body serialize as ignored role:none (uninteresting); the span is
    // excluded and its text hoists into <main>.
    expect("\n" + dumpTreeWithIgnored(nodes) + "\n").toMatchInlineSnapshot(`
      "
      RootWebArea "Fixture"
        (ignored) none
          (ignored) none
            main
              StaticText "wrapped"
              button "Shown"
                StaticText "Shown"
      "
    `);
    expect(dumpTree(nodes)).toContain("Shown");
  });
});
