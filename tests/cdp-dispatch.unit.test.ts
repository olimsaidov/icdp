import { expect, test } from "vitest";

import { parseCdpCommand, validateCdpParams, type CdpParamSchema } from "../src/cdp-dispatch.ts";

function nestedJson(depth: number): string {
  return `${'{"value":'.repeat(depth)}0${"}".repeat(depth)}`;
}

// Literal TypeScript adaptations of Chromium's
// third_party/inspector_protocol/crdtp/dispatch_test.cc envelope cases.
test("malformed JSON returns a parse-error notification", () => {
  expect(parseCdpCommand("{")).toEqual({
    ok: false,
    response: {
      error: { code: -32700, message: "Message must be valid JSON" },
    },
  });
});

// Adapted from Chromium's crdtp/json_test.cc JsonParserTest.Whitespace.
test("CRDTP vertical-tab and form-feed whitespace is accepted", () => {
  expect(parseCdpCommand('\n  {\n"id"\n:\v42,\f"method"\t:\r"Test.run"\t}\t')).toEqual({
    ok: true,
    command: { id: 42, method: "Test.run", params: {} },
  });
});

test("CRDTP line comments are accepted between tokens", () => {
  expect(parseCdpCommand('{"id":42,// comment\n"method":"Test.run"}')).toEqual({
    ok: true,
    command: { id: 42, method: "Test.run", params: {} },
  });
});

test("CRDTP block comments are accepted without changing string contents", () => {
  expect(
    parseCdpCommand(
      '/* before */{"id"/* key */:42,"method":"Test.run","params":{"value":"/* text */"}}/* after */',
    ),
  ).toEqual({
    ok: true,
    command: {
      id: 42,
      method: "Test.run",
      params: { value: "/* text */" },
    },
  });
});

test("unterminated CRDTP block comments are rejected", () => {
  expect(parseCdpCommand('{"id":42,/* never closes')).toEqual({
    ok: false,
    response: {
      error: { code: -32700, message: "Message must be valid JSON" },
    },
  });
});

test("JSON number overflow returns a parse-error notification", () => {
  expect(parseCdpCommand('{"id":1e400,"method":"Test.run"}')).toEqual({
    ok: false,
    response: {
      error: { code: -32700, message: "Message must be valid JSON" },
    },
  });
  expect(parseCdpCommand('{"id":1,"method":"Test.run","params":{"value":1e400}}')).toEqual({
    ok: false,
    response: {
      error: { code: -32700, message: "Message must be valid JSON" },
    },
  });
});

test("JSON nesting follows Chromium's 300-container limit", () => {
  expect(parseCdpCommand(nestedJson(300))).toMatchObject({
    ok: false,
    response: { error: { code: -32600 } },
  });
  expect(parseCdpCommand(nestedJson(301))).toEqual({
    ok: false,
    response: {
      error: { code: -32700, message: "Message must be valid JSON" },
    },
  });
});

test("duplicate top-level properties retain an id parsed before the error", () => {
  expect(parseCdpCommand('{"id":1,"id":2,"method":"Test.run"}')).toEqual({
    ok: false,
    response: {
      id: 1,
      error: { code: -32700, message: "Message has duplicate property 'id'" },
    },
  });
});

test("an earlier unknown property wins over a later duplicate", () => {
  expect(parseCdpCommand('{"id":42,"unknown":true,"id":43,"method":"Test.run"}')).toEqual({
    ok: false,
    response: {
      id: 42,
      error: {
        code: -32600,
        message: "Message has property other than 'id', 'method', 'sessionId', 'params'",
      },
    },
  });
});

test("duplicate detection parses the first property value, not JSON.parse's last value", () => {
  expect(parseCdpCommand('{"id":42,"id":"bad","method":"Test.run"}')).toEqual({
    ok: false,
    response: {
      id: 42,
      error: { code: -32700, message: "Message has duplicate property 'id'" },
    },
  });
});

test("commands must be JSON objects", () => {
  expect(parseCdpCommand("[]")).toEqual({
    ok: false,
    response: {
      error: { code: -32600, message: "Message must be an object" },
    },
  });
});

test("commands reject a missing id without inventing one", () => {
  expect(parseCdpCommand('{"method":"Test.run"}')).toEqual({
    ok: false,
    response: {
      error: { code: -32600, message: "Message must have integer 'id' property" },
    },
  });
});

test("commands must have an integer id", () => {
  expect(parseCdpCommand('{"id":"42","method":"Test.run"}')).toEqual({
    ok: false,
    response: {
      error: { code: -32600, message: "Message must have integer 'id' property" },
    },
  });
});

test("commands reject fractional ids", () => {
  expect(parseCdpCommand('{"id":1.5,"method":"Test.run"}')).toEqual({
    ok: false,
    response: {
      error: { code: -32600, message: "Message must have integer 'id' property" },
    },
  });
});

test("commands reject ids below the signed int32 range", () => {
  expect(parseCdpCommand('{"id":-2147483649,"method":"Test.run"}')).toEqual({
    ok: false,
    response: {
      error: { code: -32600, message: "Message must have integer 'id' property" },
    },
  });
});

test("commands reject ids above the signed int32 range", () => {
  expect(parseCdpCommand('{"id":2147483648,"method":"Test.run"}')).toEqual({
    ok: false,
    response: {
      error: { code: -32600, message: "Message must have integer 'id' property" },
    },
  });
});

test("commands accept the lower signed int32 id boundary", () => {
  expect(parseCdpCommand('{"id":-2147483648,"method":"Test.run"}')).toEqual({
    ok: true,
    command: { id: -2_147_483_648, method: "Test.run", params: {} },
  });
});

test("commands accept the upper signed int32 id boundary", () => {
  expect(parseCdpCommand('{"id":2147483647,"method":"Test.run"}')).toEqual({
    ok: true,
    command: { id: 2_147_483_647, method: "Test.run", params: {} },
  });
});

test("commands must have a non-empty string method", () => {
  expect(parseCdpCommand('{"id":42,"method":""}')).toEqual({
    ok: false,
    response: {
      id: 42,
      error: { code: -32600, message: "Message must have string 'method' property" },
    },
  });
});

test("commands reject a non-string method", () => {
  expect(parseCdpCommand('{"id":42,"method":42}')).toEqual({
    ok: false,
    response: {
      id: 42,
      error: { code: -32600, message: "Message must have string 'method' property" },
    },
  });
});

test("sessionId must be a string when present", () => {
  expect(parseCdpCommand('{"id":42,"method":"Test.run","sessionId":42}')).toEqual({
    ok: false,
    response: {
      id: 42,
      error: { code: -32600, message: "Message may have string 'sessionId' property" },
    },
  });
});

test("valid flattened commands preserve sessionId and default params", () => {
  expect(parseCdpCommand('{"id":42,"method":"Test.run","sessionId":"session-1"}')).toEqual({
    ok: true,
    command: {
      id: 42,
      method: "Test.run",
      sessionId: "session-1",
      params: {},
    },
  });
});

test("params must be an object when present", () => {
  expect(
    parseCdpCommand('{"id":42,"method":"Test.run","sessionId":"session-1","params":42}'),
  ).toEqual({
    ok: false,
    response: {
      id: 42,
      error: { code: -32600, message: "Message may have object 'params' property" },
    },
  });
});

test("root envelope errors are never tagged with a flattened session id", () => {
  expect(
    parseCdpCommand('{"id":42,"sessionId":"session-1","method":"Runtime.evaluate","unknown":true}'),
  ).toEqual({
    ok: false,
    response: {
      id: 42,
      error: {
        code: -32600,
        message: "Message has property other than 'id', 'method', 'sessionId', 'params'",
      },
    },
  });
});

test("params must not be an array", () => {
  expect(parseCdpCommand('{"id":42,"method":"Test.run","params":[]}')).toEqual({
    ok: false,
    response: {
      id: 42,
      error: { code: -32600, message: "Message may have object 'params' property" },
    },
  });
});

test("null params are accepted as omitted params", () => {
  expect(parseCdpCommand('{"id":42,"method":"Test.run","params":null}')).toEqual({
    ok: true,
    command: { id: 42, method: "Test.run", params: {} },
  });
});

test("commands reject unknown envelope properties before missing method", () => {
  const expected = {
    ok: false,
    response: {
      id: 42,
      error: {
        code: -32600,
        message: "Message has property other than 'id', 'method', 'sessionId', 'params'",
      },
    },
  } as const;

  expect(parseCdpCommand('{"id":42,"unknown":true}')).toEqual(expected);
  // JavaScript reorders integer-like object keys; Chromium parses wire order.
  expect(parseCdpCommand('{"id":42,"0":true}')).toEqual(expected);
});

test("valid object params are preserved", () => {
  expect(
    parseCdpCommand('{"id":42,"method":"Runtime.evaluate","params":{"expression":"1+1"}}'),
  ).toEqual({
    ok: true,
    command: {
      id: 42,
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
    },
  });
});

test("escaped spellings of the same envelope key are duplicates", () => {
  expect(parseCdpCommand('{"id":1,"\\u0069d":2,"method":"Test.run"}')).toEqual({
    ok: false,
    response: {
      id: 1,
      error: { code: -32700, message: "Message has duplicate property 'id'" },
    },
  });
});

test("nested object keys do not become envelope keys", () => {
  expect(
    parseCdpCommand('{"id":1,"method":"Test.run","params":{"id":2,"method":"nested"}}'),
  ).toEqual({
    ok: true,
    command: {
      id: 1,
      method: "Test.run",
      params: { id: 2, method: "nested" },
    },
  });
});

test("parameter schemas reject missing required parameters", () => {
  const schema: CdpParamSchema = { required: { expression: "string" } };

  expect(validateCdpParams({}, schema)).toEqual({
    code: -32602,
    message: "Invalid parameters",
    data: "Failed to deserialize params.expression - BINDINGS: mandatory field missing at position 8",
  });
});

test("parameter schemas reject values of the wrong type", () => {
  const schema: CdpParamSchema = { required: { expression: "string" } };

  expect(validateCdpParams({ expression: 42 }, schema)).toEqual({
    code: -32602,
    message: "Invalid parameters",
    data: "Failed to deserialize params.expression - BINDINGS: string value expected at position 19",
  });
});

test("optional parameters may be omitted and are type-checked when present", () => {
  const schema: CdpParamSchema = { optional: { includeCommandLineAPI: "boolean" } };

  expect(validateCdpParams({}, schema)).toBeUndefined();
  expect(validateCdpParams({ includeCommandLineAPI: true }, schema)).toBeUndefined();
  expect(validateCdpParams({ includeCommandLineAPI: "true" }, schema)).toEqual({
    code: -32602,
    message: "Invalid parameters",
    data: "Failed to deserialize params.includeCommandLineAPI - BINDINGS: bool value expected at position 30",
  });
});

test("parameter schemas implement Chromium JSON value kinds and int32 integers", () => {
  const schema: CdpParamSchema = {
    required: {
      array: "array",
      boolean: "boolean",
      integer: "integer",
      number: "number",
      object: "object",
      string: "string",
    },
  };
  const valid = {
    array: [],
    boolean: false,
    integer: 2_147_483_647,
    number: 1.5,
    object: {},
    string: "",
  };

  expect(validateCdpParams(valid, schema)).toBeUndefined();
  expect(validateCdpParams({ ...valid, integer: 2_147_483_648 }, schema)).toEqual({
    code: -32602,
    message: "Invalid parameters",
    data: "Failed to deserialize params.integer - BINDINGS: int32 value expected at position 40",
  });
  expect(validateCdpParams({ ...valid, number: Number.POSITIVE_INFINITY }, schema)).toEqual({
    code: -32602,
    message: "Invalid parameters",
    data: "Failed to deserialize params.number - BINDINGS: double value expected at position 52",
  });

  const expressionSchema: CdpParamSchema = { required: { expression: "string" } };
  for (const [prefix, position] of [
    [2_147_483_647, 26],
    [-2_147_483_648, 26],
    [2_147_483_648, 30],
    [-2_147_483_649, 30],
  ] as const) {
    expect(validateCdpParams({ x: prefix, expression: 42 }, expressionSchema)?.data).toBe(
      `Failed to deserialize params.expression - BINDINGS: string value expected at position ${position}`,
    );
  }
});
