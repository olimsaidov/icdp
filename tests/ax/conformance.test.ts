// @vitest-environment jsdom
/**
 * Chromium accessibility conformance — byte-for-byte replay of the
 * inspector-protocol accessibility goldens.
 *
 * This suite is fully self-contained and runs anywhere (including CI): it drives
 * our ax-tree.ts over each golden's fixture (the harness + drivers live in
 * _conformance.ts) and asserts the dumped text against the expected output
 * VENDORED in conformance.expected.ts. The expected output is produced manually
 * from the local Chromium checkout via `npm run gen:conformance`; nothing here
 * reads the Chromium source at run time.
 *
 * Ceiling cases (InlineTextBox leaves and cross-frame iframe sections, which a
 * layout-less single-frame DOM can't reproduce) have no vendored golden and are
 * only checked to produce output. See the memory note "axtree-testing-and-conformance".
 */
import { describe, expect, test } from "vitest";

import { CASES, maskUrls, runCase } from "./_conformance.ts";
import { EXPECTED } from "./conformance.expected.ts";

describe("Chromium accessibility conformance", () => {
  for (const { name, ceiling } of CASES) {
    test(name, () => {
      const actual = runCase(name);
      if (ceiling) {
        // no byte-exact oracle; just confirm the driver produced a dump
        expect(actual.length).toBeGreaterThan(0);
        return;
      }
      const expected = EXPECTED[name];
      expect(
        expected,
        `no vendored golden for "${name}" — run \`npm run gen:conformance\``,
      ).toBeTypeOf("string");
      // URLs depend on the serving host (jsdom vs Chromium's test server) — masked on both sides.
      expect(maskUrls(actual)).toBe(maskUrls(expected!));
    });
  }

  // Cases share one jsdom document; guard that setup() fully isolates them.
  // The query fixture appends a shadow host directly under <html>, which would
  // leak into a later case if setup() only reset <head>/<body>.
  test("cases are isolated — no DOM leaks across runs", () => {
    const first = runCase("getFullAXTree-depth");
    runCase("accessibility-query-axtree");
    expect(runCase("getFullAXTree-depth")).toBe(first);
  });
});
