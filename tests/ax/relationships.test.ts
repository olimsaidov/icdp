// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { byRole, prop } from "./_dump.ts";
import { build, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

// Mirrors accessibility-getRelationships. relatedNodes idref expansion is
// reproducible; the divergences are spurious `text` on idref relations and order.
describe("ARIA relationships", () => {
  test("aria-labelledby produces a nodeList relation with related nodes", () => {
    const nodes = build(
      `<span id="lbl">My Label</span><div role="group" aria-labelledby="lbl">x</div>`,
    );
    const controls = prop(byRole(nodes, "group"), "labelledby");
    expect(controls?.type).toBe("nodeList");
    expect(controls?.relatedNodes?.[0]?.idref).toBe("lbl");
    expect(controls?.relatedNodes?.[0]?.text).toBe("My Label");
  });

  test("aria-controls produces an idrefList relation", () => {
    const nodes = build(`<button aria-controls="panel">x</button><div id="panel">p</div>`);
    const controls = prop(byRole(nodes, "button"), "controls");
    expect(controls?.type).toBe("idrefList");
    expect(controls?.value).toBe("panel");
    expect(controls?.relatedNodes?.[0]?.idref).toBe("panel");
  });

  test("aria-activedescendant produces an idref relation with no value", () => {
    const nodes = build(
      `<div role="listbox" aria-activedescendant="opt1"><div role="option" id="opt1">o</div></div>`,
    );
    const ad = prop(byRole(nodes, "listbox"), "activedescendant");
    expect(ad?.type).toBe("idref");
    expect(ad?.value).toBeUndefined(); // omitValue: true
    expect(ad?.relatedNodes?.[0]?.idref).toBe("opt1");
  });

  test("idref/idrefList relations omit `text`; only labelledby (nodeList) carries it", () => {
    const nodes = build(`<button aria-controls="panel">x</button><div id="panel">Panel Text</div>`);
    const controls = prop(byRole(nodes, "button"), "controls")?.relatedNodes?.[0];
    expect(controls).not.toHaveProperty("text");
    // labelledby keeps text:
    const labelled = build(
      `<span id="l">Label</span><div role="group" aria-labelledby="l">x</div>`,
    );
    expect(prop(byRole(labelled, "group"), "labelledby")?.relatedNodes?.[0]?.text).toBe("Label");
  });
});
