// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { byRole, dumpTree } from "./_dump.ts";
import { build, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

// Role serialization. Implicit/explicit role mapping is reproducible in jsdom;
// the divergences here are casing and the internal-vs-ARIA `type` field.
describe("role mapping", () => {
  test("implicit roles for common native elements", () => {
    const cases: Array<[string, string | undefined]> = [
      ["<button>b</button>", "button"],
      [`<a href="/x">l</a>`, "link"],
      ["<a>no href</a>", undefined], // bare <a> has no role
      ["<h3>h</h3>", "heading"],
      ["<nav>n</nav>", "navigation"],
      ["<main>m</main>", "main"],
      ["<ul><li>x</li></ul>", "list"],
      ["<p>p</p>", "paragraph"],
      [`<input type="checkbox">`, "checkbox"],
      [`<input type="radio">`, "radio"],
      [`<input type="range">`, "slider"],
      [`<input type="number">`, "spinbutton"],
      [`<input type="search">`, "searchbox"],
      [`<input type="text">`, "textbox"],
      ["<textarea></textarea>", "textbox"],
      ["<select><option>o</option></select>", "combobox"],
      [`<select multiple><option>o</option></select>`, "listbox"],
      ["<table><tr><td>c</td></tr></table>", "table"],
    ];
    for (const [html, role] of cases) {
      const nodes = build(html);
      const found = role ? byRole(nodes, role) : undefined;
      if (role) expect(found, `${html} -> ${role}`).toBeDefined();
    }
  });

  test("explicit ARIA role wins and is emitted with type 'role'", () => {
    const nodes = build(`<div role="navigation">x</div>`);
    const nav = byRole(nodes, "navigation");
    expect(nav?.role).toEqual({ type: "role", value: "navigation" });
  });

  test("role='none'/'presentation' suppresses the role (text promoted, no semantic wrapper)", () => {
    const none = build(`<div role="none">plain</div>`);
    // No UNIGNORED node carries role:none for the presentational div; its text is
    // promoted. (Ignored nodes like <head> legitimately carry role:none.)
    expect(none.some((node) => !node.ignored && node.role?.value === "none")).toBe(false);
    expect(dumpTree(none)).toContain("plain");
  });

  // --- Divergence guards ---

  test("DIVERGENCE: <img> with non-empty alt maps to 'image' (Chromium internal role 'image')", () => {
    const nodes = build(`<img alt="a cat" src="x">`);
    expect(byRole(nodes, "image")?.role).toEqual({ type: "role", value: "image" });
    // empty alt => decorative => no image node
    expect(byRole(build(`<img alt="" src="x">`), "image")).toBeUndefined();
  });

  test("both role='img' and the ARIA 1.2 'image' synonym map to the image role", () => {
    expect(byRole(build(`<span role="img" aria-label="x">.</span>`), "image")).toBeDefined();
    expect(byRole(build(`<span role="image" aria-label="x">.</span>`), "image")).toBeDefined();
  });

  test("StaticText/RootWebArea internal roles carry AXValue type 'internalRole'", () => {
    const nodes = build("<p>hi</p>");
    expect(byRole(nodes, "RootWebArea")?.role?.type).toBe("internalRole");
    expect(byRole(nodes, "StaticText")?.role?.type).toBe("internalRole");
    expect(byRole(nodes, "paragraph")?.role?.type).toBe("role"); // ARIA roles stay 'role'
  });

  test("DIVERGENCE: chromeRole (numeric internal role) is never emitted", () => {
    const nodes = build("<button>b</button>");
    for (const node of nodes) expect(node).not.toHaveProperty("chromeRole");
  });
});
