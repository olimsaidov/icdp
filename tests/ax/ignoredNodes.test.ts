// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { byBackendId, dumpTree, dumpTreeWithIgnored, reasonsOf } from "./_dump.ts";
import { build, buildContext, queryRole, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

// Mirrors accessibility-ignoredNodes. Ignored nodes serialize with role:none and
// no name on the getFullAXTree path (Chromium), so they're located by backend id.
describe("ignored nodes", () => {
  test("display:none => ignored role:none with reason notRendered, no name", () => {
    const { nodes, backendIdFor } = buildContext(`<button style="display:none">x</button>`);
    const button = byBackendId(nodes, backendIdFor("button"));
    expect(button?.ignored).toBe(true);
    expect(button?.role).toEqual({ type: "role", value: "none" });
    expect(button).not.toHaveProperty("name");
    expect(reasonsOf(button)).toContain("notRendered");
  });

  test("visibility:hidden => reason notVisible", () => {
    const { nodes, backendIdFor } = buildContext(`<button style="visibility:hidden">x</button>`);
    expect(reasonsOf(byBackendId(nodes, backendIdFor("button")))).toContain("notVisible");
  });

  test("aria-hidden=true => reason ariaHiddenElement", () => {
    const { nodes, backendIdFor } = buildContext(`<button aria-hidden="true">x</button>`);
    expect(reasonsOf(byBackendId(nodes, backendIdFor("button")))).toContain("ariaHiddenElement");
  });

  test("inert => reason inertElement", () => {
    const { nodes, backendIdFor } = buildContext(`<button inert>x</button>`);
    expect(reasonsOf(byBackendId(nodes, backendIdFor("button")))).toContain("inertElement");
  });

  test("descendants of aria-hidden/inert subtrees inherit the *Subtree reason", () => {
    const ariaHidden = buildContext(`<div aria-hidden="true"><button>x</button></div>`);
    expect(reasonsOf(byBackendId(ariaHidden.nodes, ariaHidden.backendIdFor("button")))).toContain(
      "ariaHiddenSubtree",
    );
    const inert = buildContext(`<div inert><button>x</button></div>`);
    expect(reasonsOf(byBackendId(inert.nodes, inert.backendIdFor("button")))).toContain(
      "inertSubtree",
    );
  });

  test("descendants of a rendered-but-ignored subtree are preserved (ignored role:none)", () => {
    const { nodes, backendIdFor } = buildContext(
      `<div aria-hidden="true"><section><button>Deep</button></section></div>`,
    );
    const button = byBackendId(nodes, backendIdFor("button"));
    expect(button?.ignored).toBe(true);
    expect(button?.role).toEqual({ type: "role", value: "none" }); // getFullAXTree anonymizes ignored
    expect(reasonsOf(button)).toContain("ariaHiddenSubtree");
  });

  test("queryAXTree still finds hidden elements by their real role (force_name_and_role)", () => {
    // getFullAXTree shows the hidden button as role:none, but queryAXTree recovers
    // its real role + name — matching Chromium.
    const found = queryRole(`<div aria-hidden="true"><button>Deep</button></div>`, "button");
    expect(found.map((node) => node.name?.value)).toEqual(["Deep"]);
  });

  test("ignored nodes carry role:none and omit the name (getFullAXTree path)", () => {
    const { nodes, backendIdFor } = buildContext(`<button aria-hidden="true">Save</button>`);
    const button = byBackendId(nodes, backendIdFor("button"));
    expect(button?.role).toEqual({ type: "role", value: "none" });
    expect(button).not.toHaveProperty("name");
  });

  test("ignoredReason value is a plain boolean", () => {
    const { nodes, backendIdFor } = buildContext(`<button aria-hidden="true">x</button>`);
    for (const reason of byBackendId(nodes, backendIdFor("button"))?.ignoredReasons ?? [])
      expect(reason.value).toEqual({ type: "boolean", value: true });
  });

  test("the hidden attribute maps to notRendered (Chromium has no bespoke 'hidden' reason)", () => {
    const { nodes, backendIdFor } = buildContext(`<button hidden>x</button>`);
    const reasons = reasonsOf(byBackendId(nodes, backendIdFor("button")));
    expect(reasons).toContain("notRendered");
    expect(reasons).not.toContain("hidden");
  });

  test("ignored subtree topology is visible in the non-splicing dump", () => {
    const nodes = build(
      `<main><button aria-hidden="true">Hidden</button><button>Shown</button></main>`,
    );
    expect("\n" + dumpTreeWithIgnored(nodes) + "\n").toMatchInlineSnapshot(`
      "
      RootWebArea "Fixture"
        document
          (ignored) none
          main
            (ignored) none
              (ignored) StaticText "Hidden"
            button "Shown"
              StaticText "Shown"
      "
    `);
    // The splicing dump (Chromium getFullAXTree style) hides the ignored button.
    expect(dumpTree(nodes)).not.toContain("Hidden");
    expect(dumpTree(nodes)).toContain("Shown");
  });
});
