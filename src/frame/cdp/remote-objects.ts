import type Protocol from "devtools-protocol";

const MISSING_OBJECT = "Could not find object with given id";
const INVALID_OBJECT_ID = "Invalid remote object id";
const MISSING_CONTEXT = "Cannot find context with specified id";
const CANNOT_RETURN_BY_VALUE = "Object couldn't be returned by value";
const REFERENCE_CHAIN_TOO_LONG = "Object reference chain is too long";
const INT32_MIN = -(2n ** 31n);
const INT32_MAX = 2n ** 31n - 1n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
let fallbackScope = 0;

function createScope(): string {
  fallbackScope += 1;
  return `${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)}.${fallbackScope}`;
}

function parseIntegerComponent(
  value: string,
  minimum: bigint,
  maximum: bigint,
  clamp = false,
): bigint | undefined {
  const match = /^[\t-\r ]*([+-]?\d+)$/.exec(value);
  if (!match) return;
  const integer = BigInt(match[1]!);
  if (clamp) return integer < minimum ? minimum : integer > maximum ? maximum : integer;
  return integer >= minimum && integer <= maximum ? integer : undefined;
}

function parseRemoteObjectId(value: string): { canonicalId: string; scope: string } | undefined {
  const parts = value.split(".");
  if (parts.length !== 3) return;
  // V8 parses the isolate id with strtoll, which saturates on overflow, while
  // the context and object ids must fit C++'s signed int.
  const isolateId = parseIntegerComponent(parts[0]!, INT64_MIN, INT64_MAX, true);
  const contextId = parseIntegerComponent(parts[1]!, INT32_MIN, INT32_MAX);
  const objectId = parseIntegerComponent(parts[2]!, INT32_MIN, INT32_MAX);
  if (isolateId === undefined || contextId === undefined || objectId === undefined) return;
  const scope = `${isolateId}.${contextId}`;
  return { canonicalId: `${scope}.${objectId}`, scope };
}

export interface WrapOptions {
  objectGroup?: string;
  returnByValue?: boolean;
}

interface StoredObject {
  objectGroup?: string;
  value: unknown;
  virtual?: "entries" | "entry";
}

type CollectionEntry = { key?: unknown; value: unknown };

type Getter = (this: unknown) => unknown;

const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const createObject = Object.create;
const setPrototypeOf = Object.setPrototypeOf;
const ownKeys = Reflect.ownKeys;
const functionToString = Function.prototype.toString;
const objectToString = Object.prototype.toString;
const functionHasInstance = Function.prototype[Symbol.hasInstance];
const mapSize = getOwnPropertyDescriptor(Map.prototype, "size")?.get;
const setSize = getOwnPropertyDescriptor(Set.prototype, "size")?.get;
const mapForEach = Map.prototype.forEach;
const setForEach = Set.prototype.forEach;
const regexpSource = getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
const regexpFlags = (
  [
    ["hasIndices", "d"],
    ["global", "g"],
    ["ignoreCase", "i"],
    ["multiline", "m"],
    ["dotAll", "s"],
    ["unicode", "u"],
    ["unicodeSets", "v"],
    ["sticky", "y"],
  ] as const
).map(([name, flag]) => [getOwnPropertyDescriptor(RegExp.prototype, name)?.get, flag] as const);
const dateToString = Date.prototype.toString;
const weakMapHas = WeakMap.prototype.has;
const weakSetHas = WeakSet.prototype.has;
const arrayBufferByteLength = getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const dataViewByteLength = getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get;
const typedArrayTag = getOwnPropertyDescriptor(
  getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get;
const typedArrayLength = getOwnPropertyDescriptor(
  getPrototypeOf(Uint8Array.prototype),
  "length",
)?.get;
const brandProbe = {};

function globalConstructor(name: string): Function | undefined {
  const value = (globalThis as unknown as Record<string, unknown>)[name];
  return typeof value === "function" ? value : undefined;
}

function intrinsicGetter(intrinsicName: string, name: PropertyKey): Getter | undefined {
  const constructor = globalConstructor(intrinsicName) as { prototype?: object } | undefined;
  let prototype: object | null | undefined = constructor?.prototype;
  for (; prototype; prototype = getPrototypeOf(prototype) as object | null) {
    const descriptor = getOwnPropertyDescriptor(prototype, name);
    if (descriptor) return typeof descriptor.get === "function" ? descriptor.get : undefined;
  }
}

function intrinsicMethod(intrinsicName: string, name: PropertyKey): CallableFunction | undefined {
  const constructor = globalConstructor(intrinsicName) as { prototype?: object } | undefined;
  let prototype: object | null | undefined = constructor?.prototype;
  for (; prototype; prototype = getPrototypeOf(prototype) as object | null) {
    const descriptor = getOwnPropertyDescriptor(prototype, name);
    if (descriptor) return typeof descriptor.value === "function" ? descriptor.value : undefined;
  }
}

const collectionLengths = [
  ["NodeList", intrinsicGetter("NodeList", "length")],
  ["HTMLCollection", intrinsicGetter("HTMLCollection", "length")],
  ["HTMLAllCollection", intrinsicGetter("HTMLAllCollection", "length")],
  ["DOMTokenList", intrinsicGetter("DOMTokenList", "length")],
] as const;
const domExceptionName = intrinsicGetter("DOMException", "name");
const domExceptionMessage = intrinsicGetter("DOMException", "message");
const domExceptionToString = intrinsicMethod("DOMException", "toString");
const sharedArrayBufferByteLength = intrinsicGetter("SharedArrayBuffer", "byteLength");
const trustedTypes = ["TrustedHTML", "TrustedScript", "TrustedScriptURL"].map(
  (name) => [name, globalConstructor(name), intrinsicMethod(name, "toString")] as const,
);
const nodeConstructor = globalConstructor("Node");
const nodeType = intrinsicGetter("Node", "nodeType");
const nodeName = intrinsicGetter("Node", "nodeName");
const elementLocalName = intrinsicGetter("Element", "localName");
const elementId = intrinsicGetter("Element", "id");
const elementClassList = intrinsicGetter("Element", "classList");
const documentTypeName = intrinsicGetter("DocumentType", "name");
const domExceptionConstructor = globalConstructor("DOMException");
const errorConstructor = Error;
const errorIsError = (
  Error as typeof Error & {
    isError?: (value: unknown) => boolean;
  }
).isError;
const promiseConstructor = Promise;
const mapIteratorPrototype = (() => {
  try {
    return getPrototypeOf(new Map().entries()) as object;
  } catch {
    return undefined;
  }
})();
const setIteratorPrototype = (() => {
  try {
    return getPrototypeOf(new Set().values()) as object;
  } catch {
    return undefined;
  }
})();
const stringIteratorPrototype = (() => {
  try {
    return getPrototypeOf(""[Symbol.iterator]()) as object;
  } catch {
    return undefined;
  }
})();
const generatorPrototype = (() => {
  try {
    return getPrototypeOf(getPrototypeOf((function* () {})())) as object;
  } catch {
    return undefined;
  }
})();
const asyncGeneratorPrototype = (() => {
  try {
    return getPrototypeOf(getPrototypeOf((async function* () {})())) as object;
  } catch {
    return undefined;
  }
})();
const webAssemblyMemoryBuffer = (() => {
  try {
    return getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer")?.get;
  } catch {
    return undefined;
  }
})();

function callGetter<T>(getter: Getter | undefined, value: unknown): T | undefined {
  if (!getter) return;
  try {
    return Reflect.apply(getter, value, []) as T;
  } catch {
    return;
  }
}

function callMethod<T>(
  method: CallableFunction | undefined,
  value: unknown,
  args: unknown[] = [],
): T | undefined {
  if (!method) return;
  try {
    return Reflect.apply(method, value, args) as T;
  } catch {
    return;
  }
}

function isIntrinsicInstance(value: unknown, constructor: Function | undefined): boolean {
  if (!constructor) return false;
  try {
    return Reflect.apply(functionHasInstance, constructor, [value]) as boolean;
  } catch {
    return false;
  }
}

function hasPrototypeAt(value: object, expected: object | undefined, depth: number): boolean {
  if (!expected) return false;
  try {
    let prototype: object | null = value;
    for (let index = 0; index < depth; index++) {
      prototype = getPrototypeOf(prototype) as object | null;
      if (!prototype) return false;
    }
    return prototype === expected;
  } catch {}
  return false;
}

function hasNativeConstructor(value: object, name: string): boolean {
  try {
    for (
      let prototype = getPrototypeOf(value) as object | null;
      prototype;
      prototype = getPrototypeOf(prototype) as object | null
    ) {
      const constructor = getOwnPropertyDescriptor(prototype, "constructor")?.value;
      if (typeof constructor !== "function") continue;
      const intrinsicName = getOwnPropertyDescriptor(constructor, "name")?.value;
      if (
        intrinsicName === name &&
        callMethod<string>(functionToString, constructor)?.includes("[native code]")
      ) {
        return true;
      }
    }
  } catch {}
  return false;
}

function isErrorObject(value: object): boolean {
  if (errorIsError) {
    try {
      return Reflect.apply(errorIsError, errorConstructor, [value]) as boolean;
    } catch {
      return false;
    }
  }

  let hasToStringTag = false;
  try {
    for (let owner: object | null = value; owner; owner = getPrototypeOf(owner) as object | null) {
      if (getOwnPropertyDescriptor(owner, Symbol.toStringTag)) {
        hasToStringTag = true;
        break;
      }
    }
  } catch {
    return false;
  }
  if (!hasToStringTag) {
    return callMethod<string>(objectToString, value) === "[object Error]";
  }
  try {
    return (
      getOwnPropertyDescriptor(value, "stack") !== undefined &&
      (isIntrinsicInstance(value, errorConstructor) || hasNativeConstructor(value, "Error"))
    );
  } catch {
    return false;
  }
}

function constructorName(value: object, fallback: string): string {
  try {
    const prototype = getPrototypeOf(value) as object | null;
    const constructor = prototype
      ? getOwnPropertyDescriptor(prototype, "constructor")?.value
      : undefined;
    if (typeof constructor === "function") {
      const name = getOwnPropertyDescriptor(constructor, "name")?.value;
      if (typeof name === "string" && name) return name;
    }
  } catch {
    // Exotic objects can refuse prototype inspection.
  }
  return fallback;
}

function dataProperty(value: object, name: PropertyKey): unknown {
  try {
    let owner: object | null = value;
    while (owner) {
      const descriptor = getOwnPropertyDescriptor(owner, name);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
      owner = getPrototypeOf(owner) as object | null;
    }
  } catch {}
  return undefined;
}

function className(value: object, fallback: string): string {
  const tag = dataProperty(value, Symbol.toStringTag);
  return typeof tag === "string" && tag ? tag : constructorName(value, fallback);
}

function describeNode(node: object): string {
  const doctype = callGetter<string>(documentTypeName, node);
  if (doctype !== undefined) return `<!DOCTYPE ${doctype}>`;
  const localName = callGetter<string>(elementLocalName, node);
  if (localName === undefined) return callGetter<string>(nodeName, node) ?? "Node";
  let description = localName;
  const id = callGetter<string>(elementId, node);
  if (id) description += `#${id}`;
  const classes = callGetter<ArrayLike<string>>(elementClassList, node);
  if (!classes) return description;
  const classCount = classes.length;
  for (let index = 0; index < classCount; index++) {
    description += `.${classes[index]}`;
  }
  return description;
}

function describeReference(
  value: symbol | object | CallableFunction,
): Omit<Protocol.Runtime.RemoteObject, "objectId"> {
  if (typeof value === "symbol") {
    return { type: "symbol", description: String(value) };
  }
  if (typeof value === "function") {
    const description =
      callMethod<string>(functionToString, value) ?? "function () { [native code] }";
    return { type: "function", className: "Function", description };
  }
  if (
    isIntrinsicInstance(value, nodeConstructor) ||
    callGetter<number>(nodeType, value) !== undefined
  ) {
    return {
      type: "object",
      subtype: "node",
      className: constructorName(value, "Node"),
      description: describeNode(value),
    };
  }
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {}
  if (isArray) {
    return {
      type: "object",
      subtype: "array",
      className: "Array",
      description: `Array(${(value as unknown[]).length})`,
    };
  }

  const dataViewLength = callGetter<number>(dataViewByteLength, value);
  if (dataViewLength !== undefined) {
    return {
      type: "object",
      subtype: "dataview",
      className: "DataView",
      description: `DataView(${dataViewLength})`,
    };
  }

  const typedArrayName = callGetter<string>(typedArrayTag, value);
  if (typedArrayName) {
    const length = callGetter<number>(typedArrayLength, value) ?? 0;
    return {
      type: "object",
      subtype: "typedarray",
      className: typedArrayName,
      description: `${typedArrayName}(${length})`,
    };
  }

  for (const [name, lengthGetter] of collectionLengths) {
    const length = callGetter<number>(lengthGetter, value);
    if (length !== undefined) {
      return {
        type: "object",
        subtype: "array",
        className: name,
        description: `${name}(${length})`,
      };
    }
  }

  const dateDescription = callMethod<string>(dateToString, value);
  if (dateDescription !== undefined) {
    return {
      type: "object",
      subtype: "date",
      className: "Date",
      description: dateDescription,
    };
  }

  const currentMapSize = callGetter<number>(mapSize, value);
  if (currentMapSize !== undefined) {
    return {
      type: "object",
      subtype: "map",
      className: "Map",
      description: `Map(${currentMapSize})`,
    };
  }
  const currentSetSize = callGetter<number>(setSize, value);
  if (currentSetSize !== undefined) {
    return {
      type: "object",
      subtype: "set",
      className: "Set",
      description: `Set(${currentSetSize})`,
    };
  }
  if (hasPrototypeAt(value, mapIteratorPrototype, 1)) {
    return {
      type: "object",
      subtype: "iterator",
      className: "MapIterator",
      description: "MapIterator",
    };
  }
  if (hasPrototypeAt(value, setIteratorPrototype, 1)) {
    return {
      type: "object",
      subtype: "iterator",
      className: "SetIterator",
      description: "SetIterator",
    };
  }
  if (hasPrototypeAt(value, stringIteratorPrototype, 1)) {
    return {
      type: "object",
      className: "StringIterator",
      description: "StringIterator",
    };
  }
  if (hasPrototypeAt(value, generatorPrototype, 2)) {
    return {
      type: "object",
      subtype: "generator",
      className: "Generator",
      description: "Generator",
    };
  }
  if (hasPrototypeAt(value, asyncGeneratorPrototype, 2)) {
    return {
      type: "object",
      subtype: "generator",
      className: "AsyncGenerator",
      description: "AsyncGenerator",
    };
  }
  if (callMethod<boolean>(weakMapHas, value, [brandProbe]) !== undefined) {
    return {
      type: "object",
      subtype: "weakmap",
      className: "WeakMap",
      description: "WeakMap",
    };
  }
  if (callMethod<boolean>(weakSetHas, value, [brandProbe]) !== undefined) {
    return {
      type: "object",
      subtype: "weakset",
      className: "WeakSet",
      description: "WeakSet",
    };
  }

  const source = callGetter<string>(regexpSource, value);
  if (source !== undefined) {
    const flags = regexpFlags
      .filter(([getter]) => callGetter<boolean>(getter, value))
      .map(([, flag]) => flag)
      .join("");
    return {
      type: "object",
      subtype: "regexp",
      className: "RegExp",
      description: `/${source}/${flags}`,
    };
  }

  const exceptionName = callGetter<string>(domExceptionName, value);
  if (isIntrinsicInstance(value, domExceptionConstructor) || exceptionName !== undefined) {
    const name = exceptionName ?? "DOMException";
    const message = callGetter<string>(domExceptionMessage, value) ?? "";
    return {
      type: "object",
      subtype: "error",
      className: "DOMException",
      description:
        callMethod<string>(domExceptionToString, value) ??
        `${name}${message ? `: ${message}` : ""}`,
    };
  }
  if (isErrorObject(value)) {
    const name = constructorName(value, "Error");
    const stack = dataProperty(value, "stack");
    const message = dataProperty(value, "message");
    return {
      type: "object",
      subtype: "error",
      className: name,
      description:
        typeof stack === "string" && stack
          ? stack
          : `${name}${typeof message === "string" && message ? `: ${message}` : ""}`,
    };
  }
  if (isIntrinsicInstance(value, promiseConstructor) || hasNativeConstructor(value, "Promise")) {
    return {
      type: "object",
      subtype: "promise",
      className: "Promise",
      description: "Promise",
    };
  }
  for (const [name, constructor, toString] of trustedTypes) {
    if (!isIntrinsicInstance(value, constructor) && !hasNativeConstructor(value, name)) {
      continue;
    }
    return {
      type: "object",
      subtype: "trustedtype",
      className: name,
      description: callMethod<string>(toString, value) ?? name,
    };
  }

  const memoryBuffer = callGetter<ArrayBuffer>(webAssemblyMemoryBuffer, value);
  const memoryByteLength =
    callGetter<number>(arrayBufferByteLength, memoryBuffer) ??
    callGetter<number>(sharedArrayBufferByteLength, memoryBuffer);
  if (memoryByteLength !== undefined) {
    return {
      type: "object",
      subtype: "webassemblymemory",
      className: "Memory",
      description: `Memory(${memoryByteLength / 65_536})`,
    };
  }

  const byteLength = callGetter<number>(arrayBufferByteLength, value);
  if (byteLength !== undefined) {
    return {
      type: "object",
      subtype: "arraybuffer",
      className: "ArrayBuffer",
      description: `ArrayBuffer(${byteLength})`,
    };
  }
  const sharedByteLength = callGetter<number>(sharedArrayBufferByteLength, value);
  if (sharedByteLength !== undefined) {
    return {
      type: "object",
      subtype: "arraybuffer",
      className: "SharedArrayBuffer",
      description: `SharedArrayBuffer(${sharedByteLength})`,
    };
  }

  const name = className(value, "Object");
  return { type: "object", className: name, description: name };
}

function entryDescription(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (typeof value === "boolean" || typeof value === "undefined") return String(value);
  return (
    describeReference(value as symbol | object | CallableFunction).description ?? String(value)
  );
}

function isArrayIndex(name: PropertyKey): boolean {
  if (typeof name !== "string" || !/^(?:0|[1-9]\d*)$/.test(name)) {
    return false;
  }
  const index = Number(name);
  return index >= 0 && index < 4_294_967_295;
}

function parseUnserializable(value: string): number | bigint {
  switch (value) {
    case "-0":
      return -0;
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return Number.POSITIVE_INFINITY;
    case "-Infinity":
      return Number.NEGATIVE_INFINITY;
  }

  if (/^-?(?:(?:0|[1-9]\d*)|0[xX][\da-fA-F]+|0[oO][0-7]+|0[bB][01]+)n$/.test(value)) {
    const literal = value.slice(0, -1);
    if (/^-0[xXoObB]/.test(literal)) {
      return -BigInt(literal.slice(1));
    }
    return BigInt(literal);
  }

  throw new Error("Invalid unserializable value");
}

function protocolValue(value: unknown, depth = 1_000): unknown {
  if (depth <= 0) throw new Error(REFERENCE_CHAIN_TOO_LONG);
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (
    typeof value !== "object" &&
    typeof value !== "function" &&
    !(typeof value === "undefined" && value !== undefined)
  ) {
    throw new Error(CANNOT_RETURN_BY_VALUE);
  }
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, index) =>
      protocolValue(value[index], depth - 1),
    );
  }
  const result: Record<string, unknown> = createObject(null) as Record<string, unknown>;
  let names: string[];
  try {
    names = Object.keys(value);
  } catch (cause) {
    throw Object.assign(new Error("Internal error", { cause }), { code: -32603 });
  }
  for (const name of names) {
    let property: unknown;
    try {
      property = Reflect.get(value, name) as unknown;
    } catch (cause) {
      throw Object.assign(new Error("Internal error", { cause }), { code: -32603 });
    }
    if (property !== undefined) {
      result[name] = protocolValue(property, depth - 1);
    }
  }
  return result;
}

export class RemoteObjectStore {
  private nextObjectId = 1;
  private readonly objects = new Map<string, StoredObject>();
  private readonly objectGroups = new Map<string, Set<string>>();
  private readonly virtualObjects = new WeakMap<object, NonNullable<StoredObject["virtual"]>>();

  constructor(private readonly scope = createScope()) {}

  wrap(value: unknown, options: WrapOptions = {}): Protocol.Runtime.RemoteObject {
    if (value === undefined) {
      return { type: "undefined" };
    }
    if (value === null) {
      return { type: "object", subtype: "null", value: null };
    }

    const type = typeof value;
    if (type === "string" || type === "boolean") {
      return { type, value };
    }
    if (type === "number") {
      const description = Object.is(value, -0) ? "-0" : String(value);
      if (Object.is(value, -0) || !Number.isFinite(value)) {
        return { type: "number", description, unserializableValue: description };
      }
      return { type: "number", description, value };
    }
    if (type === "bigint") {
      const description = `${value}n`;
      return { type: "bigint", description, unserializableValue: description };
    }

    if (options.returnByValue) {
      const reference = describeReference(value as object | CallableFunction);
      return { type: reference.type, value: protocolValue(value) };
    }

    const virtual =
      (type === "object" || type === "function") && value !== null
        ? this.virtualObjects.get(value as object)
        : undefined;
    if (virtual === "entries") {
      return this.wrapEntries(value as CollectionEntry[], options.objectGroup);
    }
    if (virtual === "entry") {
      return this.wrapEntry(value as CollectionEntry, options.objectGroup);
    }
    const objectId = this.bind(value, options.objectGroup);
    return { ...describeReference(value as symbol | object | CallableFunction), objectId };
  }

  resolve(objectId: string): unknown {
    return this.find(objectId).value;
  }

  objectGroupName(objectId: string): string | undefined {
    return this.find(objectId).objectGroup;
  }

  releaseObject(objectId: string): void {
    const { canonicalId, entry } = this.lookup(objectId);
    this.objects.delete(canonicalId);
    if (entry.objectGroup) {
      const group = this.objectGroups.get(entry.objectGroup);
      group?.delete(canonicalId);
      if (group?.size === 0) {
        this.objectGroups.delete(entry.objectGroup);
      }
    }
  }

  releaseObjectGroup(objectGroup: string): void {
    if (!objectGroup) return;
    const members = this.objectGroups.get(objectGroup);
    if (!members) return;
    for (const objectId of members) {
      this.objects.delete(objectId);
    }
    this.objectGroups.delete(objectGroup);
  }

  decodeArgument(argument: Protocol.Runtime.CallArgument): unknown {
    if (argument.objectId !== undefined) {
      return this.resolve(argument.objectId);
    }
    if (Object.prototype.hasOwnProperty.call(argument, "value")) {
      return argument.value;
    }
    if (argument.unserializableValue !== undefined) {
      return parseUnserializable(argument.unserializableValue);
    }
    return undefined;
  }

  private bind(value: unknown, objectGroup?: string, virtual?: StoredObject["virtual"]): string {
    const objectId = `${this.scope}.${this.nextObjectId++}`;
    const entry: StoredObject = {
      value,
      ...(objectGroup ? { objectGroup } : {}),
      ...(virtual ? { virtual } : {}),
    };
    this.objects.set(objectId, entry);
    if (virtual && value !== null && (typeof value === "object" || typeof value === "function")) {
      this.virtualObjects.set(value as object, virtual);
    }
    if (objectGroup) {
      let members = this.objectGroups.get(objectGroup);
      if (!members) {
        members = new Set();
        this.objectGroups.set(objectGroup, members);
      }
      members.add(objectId);
    }
    return objectId;
  }

  private wrapEntries(
    entries: CollectionEntry[],
    objectGroup?: string,
  ): Protocol.Runtime.RemoteObject {
    return {
      type: "object",
      subtype: "array",
      className: "Array",
      description: `Array(${entries.length})`,
      objectId: this.bind(entries, objectGroup, "entries"),
    };
  }

  private wrapEntry(entry: CollectionEntry, objectGroup?: string): Protocol.Runtime.RemoteObject {
    const description =
      "key" in entry
        ? `{${entryDescription(entry.key)} => ${entryDescription(entry.value)}}`
        : entryDescription(entry.value);
    return {
      type: "object",
      subtype: "internal#entry",
      className: "Object",
      description,
      objectId: this.bind(entry, objectGroup, "entry"),
    } as unknown as Protocol.Runtime.RemoteObject;
  }

  private collectionEntries(value: object): CollectionEntry[] | undefined {
    if (callGetter<number>(mapSize, value) !== undefined) {
      const entries: CollectionEntry[] = [];
      try {
        Reflect.apply(mapForEach, value, [
          (entryValue: unknown, key: unknown) => {
            const entry = createObject(null) as CollectionEntry;
            entry.key = key;
            entry.value = entryValue;
            this.virtualObjects.set(entry, "entry");
            entries[entries.length] = entry;
          },
        ]);
        setPrototypeOf(entries, null);
        return entries;
      } catch {
        return;
      }
    }
    if (callGetter<number>(setSize, value) !== undefined) {
      const entries: CollectionEntry[] = [];
      try {
        Reflect.apply(setForEach, value, [
          (entryValue: unknown) => {
            const entry = createObject(null) as CollectionEntry;
            entry.value = entryValue;
            this.virtualObjects.set(entry, "entry");
            entries[entries.length] = entry;
          },
        ]);
        setPrototypeOf(entries, null);
        return entries;
      } catch {
        return;
      }
    }
  }

  private find(objectId: string): StoredObject {
    return this.lookup(objectId).entry;
  }

  private lookup(objectId: string): { canonicalId: string; entry: StoredObject } {
    const parsed = parseRemoteObjectId(objectId);
    if (!parsed) throw new Error(INVALID_OBJECT_ID);
    if (parsed.scope !== this.scope) throw new Error(MISSING_CONTEXT);
    const entry = this.objects.get(parsed.canonicalId);
    if (!entry) {
      throw new Error(MISSING_OBJECT);
    }
    return { canonicalId: parsed.canonicalId, entry };
  }

  getProperties(
    params: Protocol.Runtime.GetPropertiesRequest,
  ): Protocol.Runtime.GetPropertiesResponse {
    const source = this.find(params.objectId);
    const value = source.value;
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      throw new Error("Value with given id is not an object");
    }
    const wrapOptions: WrapOptions = source.objectGroup ? { objectGroup: source.objectGroup } : {};
    const target = value;
    const owners: object[] = [target];
    if (!params.ownProperties) {
      let prototype = getPrototypeOf(target) as object | null;
      while (prototype !== null) {
        owners.push(prototype);
        prototype = getPrototypeOf(prototype) as object | null;
      }
    }

    const seen = new Set<PropertyKey>();
    const result: Protocol.Runtime.PropertyDescriptor[] = [];
    for (const owner of owners) {
      for (const name of ownKeys(owner)) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (params.nonIndexedPropertiesOnly && isArrayIndex(name)) continue;

        const descriptor = getOwnPropertyDescriptor(owner, name);
        if (!descriptor) continue;
        const accessor = "get" in descriptor || "set" in descriptor;
        if (params.accessorPropertiesOnly && !accessor) continue;

        const property: Protocol.Runtime.PropertyDescriptor = {
          name: String(name),
          configurable: descriptor.configurable ?? false,
          enumerable: descriptor.enumerable ?? false,
          isOwn: owner === target,
        };
        if ("value" in descriptor) {
          property.writable = descriptor.writable ?? false;
          property.value = this.wrap(descriptor.value, wrapOptions);
        } else {
          property.get = this.wrap(descriptor.get, wrapOptions);
          property.set = this.wrap(descriptor.set, wrapOptions);
        }
        if (typeof name === "symbol") {
          property.symbol = this.wrap(name, wrapOptions);
        }
        result.push(property);
      }
    }

    if (params.accessorPropertiesOnly) {
      return { result };
    }
    if (source.virtual) return { result };

    const internalProperties: Protocol.Runtime.InternalPropertyDescriptor[] = [
      {
        name: "[[Prototype]]",
        value: this.wrap(getPrototypeOf(target) as object | null, wrapOptions),
      },
    ];
    const entries = this.collectionEntries(target);
    if (entries) {
      internalProperties.push({
        name: "[[Entries]]",
        value: this.wrapEntries(entries, source.objectGroup),
      });
    }
    return { result, internalProperties };
  }
}
