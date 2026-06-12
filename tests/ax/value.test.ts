// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import { byRole } from "./_dump.ts";
import { build, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

// Mirrors the value-bearing portions of the nameSources/getFullAXTree goldens.
describe("value handling", () => {
  test("text input value is the current string value", () => {
    const nodes = build(`<input type="text" value="hello">`);
    expect(byRole(nodes, "textbox")?.value).toEqual({ type: "string", value: "hello" });
  });

  test("range input value is a number", () => {
    const nodes = build(`<input type="range" min="0" max="10" value="4">`);
    expect(byRole(nodes, "slider")?.value).toEqual({ type: "number", value: 4 });
  });

  test("progress value is a number", () => {
    const nodes = build(`<progress value="0.3" max="1"></progress>`);
    expect(byRole(nodes, "progressbar")?.value).toEqual({ type: "number", value: 0.3 });
  });

  test("aria-valuenow on a custom slider becomes a number value", () => {
    const nodes = build(
      `<div role="slider" aria-valuenow="7" aria-valuemin="0" aria-valuemax="10">x</div>`,
    );
    expect(byRole(nodes, "slider")?.value).toEqual({ type: "number", value: 7 });
  });

  test("aria-valuenow is clamped to the resolved min/max", () => {
    const over = build(
      `<div role="slider" aria-valuenow="50" aria-valuemin="0" aria-valuemax="10">x</div>`,
    );
    expect(byRole(over, "slider")?.value).toEqual({ type: "number", value: 10 });
  });

  test("<select> value is the displayed text of the selected option, not el.value", () => {
    const nodes = build(
      `<select><option value="us">United States</option><option value="ca">Canada</option></select>`,
    );
    expect(byRole(nodes, "combobox")?.value).toEqual({ type: "string", value: "United States" });
  });

  test("<select multiple> has no single value", () => {
    const nodes = build(
      `<select multiple><option selected>a</option><option selected>b</option></select>`,
    );
    expect(byRole(nodes, "listbox")?.value).toBeUndefined();
  });

  test("indeterminate <progress> has no value", () => {
    const nodes = build(`<progress></progress>`); // no value attr => indeterminate
    expect(byRole(nodes, "progressbar")?.value).toBeUndefined();
  });

  test("a contenteditable textbox reports its text as the value", () => {
    const nodes = build(`<div role="textbox" contenteditable="true">hello</div>`);
    expect(byRole(nodes, "textbox")?.value).toEqual({ type: "string", value: "hello" });
  });

  test("password value is masked, not cleartext", () => {
    const nodes = build(`<input type="password" value="hunter2">`);
    expect(byRole(nodes, "textbox")?.value).toEqual({ type: "string", value: "•••••••" });
  });

  test("empty text input / number input omit the value", () => {
    expect(byRole(build(`<input type="text" value="">`), "textbox")?.value).toBeUndefined();
    expect(byRole(build(`<input type="number">`), "spinbutton")?.value).toBeUndefined();
  });
});
