// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { byRole, prop } from "./_dump.ts";
import { build, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

function propNames(node: ReturnType<typeof build>[number] | undefined): string[] {
  return (node?.properties ?? []).map((property) => property.name);
}

// Mirrors the states portions of accessibility-nameSources-input / getRelationships
// / aria-1.1. Property emission is reproducible; the divergences are about which
// states get an explicit `false` (includeFalse) and role-gating.
describe("widget & global state properties", () => {
  test("checkbox emits checked tristate (true / false)", () => {
    const checked = build(`<input type="checkbox" checked>`);
    expect(prop(byRole(checked, "checkbox"), "checked")).toEqual({
      type: "tristate",
      value: "true",
    });
    const unchecked = build(`<input type="checkbox">`);
    expect(prop(byRole(unchecked, "checkbox"), "checked")).toEqual({
      type: "tristate",
      value: "false",
    });
  });

  test("aria-checked='mixed' on a checkbox role emits tristate mixed", () => {
    const nodes = build(`<div role="checkbox" aria-checked="mixed">x</div>`);
    expect(prop(byRole(nodes, "checkbox"), "checked")).toEqual({
      type: "tristate",
      value: "mixed",
    });
  });

  test("aria-expanded emits expanded boolean (including false)", () => {
    const expanded = build(`<button aria-expanded="true">x</button>`);
    expect(prop(byRole(expanded, "button"), "expanded")).toEqual({
      type: "booleanOrUndefined",
      value: true,
    });
    const collapsed = build(`<button aria-expanded="false">x</button>`);
    expect(prop(byRole(collapsed, "button"), "expanded")).toEqual({
      type: "booleanOrUndefined",
      value: false,
    });
  });

  test("disabled control emits disabled + suppresses focusable", () => {
    const nodes = build(`<button disabled>x</button>`);
    const button = byRole(nodes, "button");
    expect(prop(button, "disabled")).toEqual({ type: "boolean", value: true });
    expect(propNames(button)).not.toContain("focusable");
  });

  test("heading emits its level", () => {
    const nodes = build(`<h4>x</h4>`);
    expect(prop(byRole(nodes, "heading"), "level")).toEqual({ type: "integer", value: 4 });
  });

  test("aria-keyshortcuts / aria-roledescription pass through", () => {
    const nodes = build(
      `<button aria-keyshortcuts="Ctrl+S" aria-roledescription="saver">x</button>`,
    );
    const button = byRole(nodes, "button");
    expect(prop(button, "keyshortcuts")).toEqual({ type: "string", value: "Ctrl+S" });
    expect(prop(button, "roledescription")).toEqual({ type: "string", value: "saver" });
  });

  // --- Role-gated states (readonly / required / multiline / multiselectable) ---
  // These match Chromium's RoleAllows* tables: emitted (incl. false) only when the
  // role qualifies.

  test("single-line textbox emits multiline:false; textarea emits multiline:true", () => {
    expect(prop(byRole(build(`<input type="text">`), "textbox"), "multiline")).toEqual({
      type: "boolean",
      value: false,
    });
    expect(prop(byRole(build(`<textarea></textarea>`), "textbox"), "multiline")).toEqual({
      type: "boolean",
      value: true,
    });
  });

  test("textbox emits readonly:false and required:false (includeFalse), true when set", () => {
    const plain = byRole(build(`<input type="text">`), "textbox");
    expect(prop(plain, "readonly")).toEqual({ type: "boolean", value: false });
    expect(prop(plain, "required")).toEqual({ type: "boolean", value: false });
    const readonly = byRole(build(`<input type="text" readonly>`), "textbox");
    expect(prop(readonly, "readonly")).toEqual({ type: "boolean", value: true });
    const required = byRole(build(`<input type="text" required>`), "textbox");
    expect(prop(required, "required")).toEqual({ type: "boolean", value: true });
  });

  test("readonly/required are role-gated: not emitted outside the allow-list", () => {
    // article is not in the readonly/required allow-list, so the aria-* flag is dropped.
    const article = byRole(build(`<div role="article" aria-required="true">x</div>`), "article");
    expect(propNames(article)).not.toContain("required");
    // a qualifying role (listbox) does emit it:
    const listbox = byRole(build(`<div role="listbox" aria-required="true">x</div>`), "listbox");
    expect(prop(listbox, "required")).toEqual({ type: "boolean", value: true });
  });

  test("multiselectable is role-gated (includeFalse): listbox emits it, combobox does not", () => {
    expect(
      propNames(byRole(build(`<select><option>a</option></select>`), "combobox")),
    ).not.toContain("multiselectable");
    const single = byRole(build(`<div role="listbox">x</div>`), "listbox");
    expect(prop(single, "multiselectable")).toEqual({ type: "boolean", value: false });
    const multi = byRole(build(`<select multiple><option>a</option></select>`), "listbox");
    expect(prop(multi, "multiselectable")).toEqual({ type: "boolean", value: true });
  });

  test("live-region root emits live (token), atomic, relevant", () => {
    const nodes = build(`<div role="status" aria-live="polite" aria-atomic="true">x</div>`);
    const status = byRole(nodes, "status");
    expect(prop(status, "live")).toEqual({ type: "token", value: "polite" });
    expect(prop(status, "atomic")).toEqual({ type: "boolean", value: true });
    expect(prop(status, "relevant")).toEqual({ type: "tokenList", value: "additions text" });
  });

  test("text editor emits editable (token) and settable", () => {
    const input = byRole(build(`<input type="text">`), "textbox");
    expect(prop(input, "editable")).toEqual({ type: "token", value: "plaintext" });
    expect(prop(input, "settable")).toEqual({ type: "booleanOrUndefined", value: true });
  });

  test("invalid defaults to token 'false' for form controls, 'true' when aria-invalid set", () => {
    expect(prop(byRole(build(`<input type="text">`), "textbox"), "invalid")).toEqual({
      type: "token",
      value: "false",
    });
    expect(
      prop(byRole(build(`<input type="text" aria-invalid="true">`), "textbox"), "invalid"),
    ).toEqual({ type: "token", value: "true" });
  });
});
