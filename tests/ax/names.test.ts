// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { byRole } from "./_dump.ts";
import { build, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

// Mirrors the accessibility-nameSources-* goldens at the VALUE level. The impl
// computes names via dom-accessibility-api (the W3C AccName implementation), so
// the computed value matches Chromium; what's missing is the `sources[]` array.
describe("accessible name computation", () => {
  test("button name precedence: aria-label beats text content", () => {
    expect(byRole(build(`<button>text</button>`), "button")?.name?.value).toBe("text");
    expect(byRole(build(`<button aria-label="label">text</button>`), "button")?.name?.value).toBe(
      "label",
    );
  });

  test("aria-labelledby beats aria-label", () => {
    const nodes = build(
      `<span id="l">from id</span><button aria-labelledby="l" aria-label="lab">t</button>`,
    );
    expect(byRole(nodes, "button")?.name?.value).toBe("from id");
  });

  test("input name comes from its associated <label>", () => {
    const nodes = build(`<label for="e">Email</label><input id="e" type="text">`);
    expect(byRole(nodes, "textbox")?.name?.value).toBe("Email");
  });

  test("img name comes from alt", () => {
    expect(byRole(build(`<img alt="A cat" src="x">`), "image")?.name?.value).toBe("A cat");
  });

  test("description comes from aria-describedby", () => {
    const nodes = build(`<span id="d">More info</span><button aria-describedby="d">x</button>`);
    expect(byRole(nodes, "button")?.description).toEqual({
      type: "computedString",
      value: "More info",
    });
  });

  test("structural roles (list/table/main) are NOT named from their text content", () => {
    // Matches Chromium: SupportsNameFromContents excludes these roles.
    const nodes = build(`<main>Article body</main>`);
    expect(byRole(nodes, "main")?.name?.value ?? "").toBe("");
  });

  // --- Divergence guards ---

  test("DIVERGENCE: name.sources[] array is never emitted", () => {
    const nodes = build(`<button aria-label="x">y</button>`);
    expect(byRole(nodes, "button")?.name).not.toHaveProperty("sources");
  });
});
