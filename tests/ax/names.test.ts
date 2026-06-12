// @vitest-environment jsdom
import type Protocol from "devtools-protocol";
import { afterEach, describe, expect, test } from "vitest";

import { byRole } from "./_dump.ts";
import { build, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

type AXNode = ReturnType<typeof build>[number];
function sourcesOf(node: AXNode | undefined) {
  return (node?.name as { sources?: Protocol.Accessibility.AXValueSource[] })?.sources;
}

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

  // --- name.sources[] (mirrors accessibility-nameSources-buttons) ---

  test("an empty button lists all candidate sources in order, none winning", () => {
    const button = byRole(build(`<button></button>`), "button");
    const sources = sourcesOf(button);
    expect(sources?.map((s) => [s.type, s.attribute ?? s.nativeSource])).toEqual([
      ["relatedElement", "aria-labelledby"],
      ["attribute", "aria-label"],
      ["relatedElement", "label"],
      ["contents", undefined],
      ["attribute", "title"],
    ]);
    expect(sources?.every((s) => s.value === undefined)).toBe(true);
  });

  test("contents wins; a later title source is marked superseded", () => {
    const sources = sourcesOf(byRole(build(`<button>button2-content</button>`), "button"));
    const contents = sources?.find((s) => s.type === "contents");
    const title = sources?.find((s) => s.attribute === "title");
    expect(contents?.value).toEqual({ type: "computedString", value: "button2-content" });
    expect(title?.superseded).toBe(true);
    expect(title?.value).toBeUndefined(); // title absent -> no value, just superseded
  });

  test("a superseded but present title carries attributeValue + value", () => {
    const sources = sourcesOf(byRole(build(`<button title="t8">content8</button>`), "button"));
    const title = sources?.find((s) => s.attribute === "title");
    expect(title?.superseded).toBe(true);
    expect(title?.attributeValue).toEqual({ type: "string", value: "t8" });
    expect(title?.value).toEqual({ type: "computedString", value: "t8" });
  });

  test("aria-label wins over contents/title", () => {
    const sources = sourcesOf(
      byRole(build(`<button aria-label="L" title="t">content</button>`), "button"),
    );
    const ariaLabel = sources?.find((s) => s.attribute === "aria-label");
    expect(ariaLabel?.value).toEqual({ type: "computedString", value: "L" });
    expect(sources?.find((s) => s.type === "contents")?.superseded).toBe(true);
    expect(sources?.find((s) => s.attribute === "title")?.superseded).toBe(true);
  });

  test("a dead aria-labelledby reference is marked invalid", () => {
    const sources = sourcesOf(
      byRole(build(`<div role="group" aria-labelledby="nope">x</div>`), "group"),
    );
    expect(sources?.[0]?.invalid).toBe(true);
  });
});
