import {
  CDP_INVALID_PARAMS,
  CDP_INVALID_REQUEST,
  CDP_PARSE_ERROR,
  type CdpError,
} from "./protocol.ts";

export type CdpCommand = {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};

export type CdpCommandErrorResponse = {
  id?: number;
  error: CdpError;
};

export type CdpCommandParseResult =
  | { ok: true; command: CdpCommand }
  | { ok: false; response: CdpCommandErrorResponse };

export type CdpParamType = "array" | "boolean" | "integer" | "number" | "object" | "string";

export type CdpParamSchema = {
  optional?: Record<string, CdpParamType>;
  required?: Record<string, CdpParamType>;
};

type TopLevelProperty = {
  name: string;
  value: unknown;
};

function normalizeCrdtpJson(raw: string): string {
  const characters = [...raw];
  let escaped = false;
  let inString = false;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "\v" || character === "\f") {
      characters[index] = " ";
    } else if (character === "/" && characters[index + 1] === "/") {
      let end = index + 2;
      while (end < characters.length && characters[end] !== "\n" && characters[end] !== "\r") {
        end++;
      }
      characters.fill(" ", index, end);
      index = end - 1;
    } else if (character === "/" && characters[index + 1] === "*") {
      let end = index + 2;
      while (
        end + 1 < characters.length &&
        (characters[end] !== "*" || characters[end + 1] !== "/")
      ) {
        end++;
      }
      if (end + 1 < characters.length) {
        end += 2;
        characters.fill(" ", index, end);
        index = end - 1;
      }
    }
  }
  return characters.join("");
}

function stringEnd(raw: string, start: number): number {
  for (let index = start + 1; index < raw.length; index++) {
    if (raw[index] === "\\") index++;
    else if (raw[index] === '"') return index + 1;
  }
  return raw.length;
}

function skipWhitespace(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && /\s/.test(raw[index]!)) index++;
  return index;
}

function isWithinJsonDepthLimit(raw: string): boolean {
  let depth = 0;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') {
      index = stringEnd(raw, index) - 1;
    } else if (character === "{" || character === "[") {
      depth++;
      if (depth > 300) return false;
    } else if (character === "}" || character === "]") {
      depth--;
    }
  }
  return true;
}

function parseJsonValue(raw: string): unknown {
  if (!isWithinJsonDepthLimit(raw)) {
    throw new SyntaxError("JSON nesting exceeds Chromium's limit");
  }
  return JSON.parse(raw, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new SyntaxError("JSON number is outside the finite double range");
    }
    return value;
  }) as unknown;
}

function valueEnd(raw: string, start: number): number {
  const first = raw[start];
  if (first === '"') return stringEnd(raw, start);
  if (first !== "{" && first !== "[") {
    let index = start;
    while (index < raw.length && raw[index] !== "," && raw[index] !== "}") index++;
    return index;
  }

  let depth = 0;
  for (let index = start; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') {
      index = stringEnd(raw, index) - 1;
    } else if (character === "{" || character === "[") {
      depth++;
    } else if (character === "}" || character === "]") {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return raw.length;
}

function scanTopLevelProperties(raw: string): TopLevelProperty[] {
  const properties: TopLevelProperty[] = [];
  let index = skipWhitespace(raw, 0) + 1;
  while (index < raw.length) {
    index = skipWhitespace(raw, index);
    if (raw[index] === "}") break;

    const keyEnd = stringEnd(raw, index);
    const name = JSON.parse(raw.slice(index, keyEnd)) as string;
    index = skipWhitespace(raw, keyEnd);
    index = skipWhitespace(raw, index + 1);

    const end = valueEnd(raw, index);
    properties.push({
      name,
      value: parseJsonValue(raw.slice(index, end)),
    });
    index = skipWhitespace(raw, end);
    if (raw[index] === ",") index++;
  }
  return properties;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -2_147_483_648 &&
    value <= 2_147_483_647
  );
}

function invalidRequest(message: string, id?: number): CdpCommandParseResult {
  return {
    ok: false,
    response: {
      ...(id !== undefined ? { id } : {}),
      error: { code: CDP_INVALID_REQUEST, message },
    },
  };
}

function parseError(message: string, id?: number): CdpCommandParseResult {
  return {
    ok: false,
    response: {
      ...(id !== undefined ? { id } : {}),
      error: { code: CDP_PARSE_ERROR, message },
    },
  };
}

export function parseCdpCommand(raw: string): CdpCommandParseResult {
  let value: unknown;
  let properties: TopLevelProperty[] = [];
  try {
    raw = normalizeCrdtpJson(raw);
    value = parseJsonValue(raw);
    if (isRecord(value)) properties = scanTopLevelProperties(raw);
  } catch {
    return {
      ok: false,
      response: {
        error: { code: CDP_PARSE_ERROR, message: "Message must be valid JSON" },
      },
    };
  }

  if (!isRecord(value)) {
    return invalidRequest("Message must be an object");
  }

  const seenProperties = new Set<string>();
  let id: number | undefined;
  let method: string | undefined;
  let params: Record<string, unknown> = {};
  let sessionId: string | undefined;

  // Chromium's Dispatchable is a shallow, property-order parser. Match that
  // observable behavior: an invalid or unknown property stops parsing, and a
  // valid id parsed before it is available to the root error response.
  for (const property of properties) {
    if (seenProperties.has(property.name)) {
      return parseError(`Message has duplicate property '${property.name}'`, id);
    }
    seenProperties.add(property.name);
    const propertyValue = property.value;
    if (property.name === "id") {
      if (!isInt32(propertyValue)) {
        return invalidRequest("Message must have integer 'id' property");
      }
      id = propertyValue;
    } else if (property.name === "method") {
      if (typeof propertyValue !== "string") {
        return invalidRequest("Message must have string 'method' property", id);
      }
      method = propertyValue;
    } else if (property.name === "sessionId") {
      if (typeof propertyValue !== "string") {
        return invalidRequest("Message may have string 'sessionId' property", id);
      }
      sessionId = propertyValue;
    } else if (property.name === "params") {
      if (propertyValue !== null && !isRecord(propertyValue)) {
        return invalidRequest("Message may have object 'params' property", id);
      }
      params = propertyValue ?? {};
    } else {
      return invalidRequest(
        "Message has property other than 'id', 'method', 'sessionId', 'params'",
        id,
      );
    }
  }

  if (id === undefined) {
    return invalidRequest("Message must have integer 'id' property");
  }
  if (!method) {
    return invalidRequest("Message must have string 'method' property", id);
  }

  return {
    ok: true,
    command: {
      id,
      method,
      params,
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
  };
}

function matchesParamType(value: unknown, type: CdpParamType): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return isInt32(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return isRecord(value);
  return typeof value === type;
}

function cborHeaderSize(length: number): number {
  if (length < 24) return 1;
  if (length <= 0xff) return 2;
  if (length <= 0xffff) return 3;
  return 5;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function cborValueSize(value: unknown): number {
  if (value === null || typeof value === "boolean") return 1;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
      return 9;
    }
    const magnitude = value < 0 ? -1 - value : value;
    return cborHeaderSize(magnitude);
  }
  if (typeof value === "string") {
    const length = utf8Length(value);
    return cborHeaderSize(length) + length;
  }
  if (Array.isArray(value)) {
    return 9 + value.reduce((size, item) => size + cborValueSize(item), 0);
  }
  if (isRecord(value)) {
    return (
      9 +
      Object.entries(value).reduce(
        (size, [name, item]) => size + cborValueSize(name) + cborValueSize(item),
        0,
      )
    );
  }
  return 1;
}

function bindingPosition(params: Record<string, unknown>, target: string): number {
  let position = 8;
  for (const [name, value] of Object.entries(params)) {
    position += cborValueSize(name);
    if (name === target) return position;
    position += cborValueSize(value);
  }
  return position;
}

function nestedBindingPosition(
  params: Record<string, unknown>,
  path: readonly (string | number)[],
): number {
  let current: unknown = params;
  let position = 8;
  for (const [pathIndex, segment] of path.entries()) {
    if (typeof segment === "number") {
      position += 8;
      if (!Array.isArray(current)) return position;
      for (let index = 0; index < segment; index++) {
        position += cborValueSize(current[index]);
      }
      current = current[segment];
      continue;
    }

    if (pathIndex > 0) position += 8;
    if (!isRecord(current)) return position;
    let found = false;
    for (const [name, value] of Object.entries(current)) {
      if (name === segment) {
        position += cborValueSize(name);
        current = value;
        found = true;
        break;
      }
      position += cborValueSize(name) + cborValueSize(value);
    }
    if (!found) return position;
  }
  return position;
}

function invalidParam(
  params: Record<string, unknown>,
  path: readonly (string | number)[],
  type: CdpParamType,
  missing: boolean,
  expectationOverride?: string,
): CdpError {
  const expectation =
    expectationOverride ??
    (missing
      ? "BINDINGS: mandatory field missing"
      : type === "array"
        ? "CBOR: array start expected"
        : `BINDINGS: ${
            {
              boolean: "bool",
              integer: "int32",
              number: "double",
              object: "dictionary",
              string: "string",
            }[type]
          } value expected`);
  const displayPath = path.filter((segment): segment is string => typeof segment === "string");
  return {
    code: CDP_INVALID_PARAMS,
    message: "Invalid parameters",
    data: `Failed to deserialize params.${displayPath.join(".")} - ${expectation} at position ${
      path.length === 1 && typeof path[0] === "string"
        ? bindingPosition(params, path[0])
        : nestedBindingPosition(params, path)
    }`,
  };
}

export function invalidNestedCdpParam(
  params: Record<string, unknown>,
  path: readonly (string | number)[],
  type: CdpParamType,
  options: { expectation?: string; missing?: boolean } = {},
): CdpError {
  return invalidParam(params, path, type, options.missing ?? false, options.expectation);
}

export function validateCdpParams(
  params: Record<string, unknown>,
  schema: CdpParamSchema | undefined,
  validateNested?: (name: string, value: unknown) => CdpError | undefined,
): CdpError | undefined {
  if (!schema) return;

  for (const [name, value] of Object.entries(params)) {
    const type = schema.required?.[name] ?? schema.optional?.[name];
    if (type !== undefined && !matchesParamType(value, type)) {
      return invalidParam(params, [name], type, false);
    }
    const nestedError = validateNested?.(name, value);
    if (nestedError) return nestedError;
  }
  for (const [name, type] of Object.entries(schema.required ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      return invalidParam(params, [name], type, true);
    }
  }
}
