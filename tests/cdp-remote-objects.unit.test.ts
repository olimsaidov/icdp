import { runInNewContext } from "node:vm";

import { expect, test } from "vitest";

import { RemoteObjectStore } from "../src/frame/cdp/remote-objects.ts";

// Adapted from Chromium:
// third_party/blink/web_tests/http/tests/inspector-protocol/runtime/
// remote-object-id-cross-process.js
// Chromium rejects a handle after its owning execution context disappears. Store
// instances model that context boundary without depending on Chromium itself.
test("scopes opaque handles to an execution context and stores them per Session", () => {
  const owner = new RemoteObjectStore("10.20");
  const sameContext = new RemoteObjectStore("10.20");
  const foreignContext = new RemoteObjectStore("30.40");
  const value = { answer: 42 };

  const remote = owner.wrap(value);

  expect(remote).toMatchObject({
    type: "object",
    className: "Object",
    description: "Object",
  });
  expect(remote.objectId).toBe("10.20.1");
  expect(remote.objectId).not.toContain("answer");
  expect(owner.resolve(remote.objectId!)).toBe(value);
  expect(owner.resolve("+10.+20.+1")).toBe(value);
  expect(() => sameContext.resolve(remote.objectId!)).toThrow(
    "Could not find object with given id",
  );
  expect(() => foreignContext.resolve(remote.objectId!)).toThrow(
    "Cannot find context with specified id",
  );

  const sameContextRemote = sameContext.wrap({ answer: 7 });
  expect(sameContextRemote.objectId).toBe(remote.objectId);
  expect(sameContext.resolve(remote.objectId!)).toEqual({ answer: 7 });

  expect(() => owner.resolve(remote.objectId!.replace(/\d+$/, "0"))).toThrow(
    "Could not find object with given id",
  );
  expect(() => owner.resolve("10.20.-1")).toThrow("Could not find object with given id");
  expect(() => owner.resolve("10.20.9223372036854775808")).toThrow("Invalid remote object id");
  expect(() => owner.resolve("10.2147483648.1")).toThrow("Invalid remote object id");
  expect(() => owner.resolve("10.20.-2147483649")).toThrow("Invalid remote object id");
  expect(() => owner.resolve("bad:1")).toThrow("Invalid remote object id");

  const releasable = owner.wrap({ releasable: true });
  owner.releaseObject("+10.+20.+2");
  expect(() => owner.resolve(releasable.objectId!)).toThrow("Could not find object with given id");
});

// Ported from V8's Chromium inspector coverage:
// v8/test/inspector/runtime/evaluate-unserializable.js and remote-object.js
test("uses native RemoteObject shapes for primitives and unserializable values", () => {
  const store = new RemoteObjectStore();

  expect(store.wrap(undefined)).toEqual({ type: "undefined" });
  expect(store.wrap(null)).toEqual({ type: "object", subtype: "null", value: null });
  expect(store.wrap("hello")).toEqual({ type: "string", value: "hello" });
  expect(store.wrap(true)).toEqual({ type: "boolean", value: true });
  expect(store.wrap(2.5)).toEqual({ type: "number", description: "2.5", value: 2.5 });
  expect(store.wrap(Number.NaN)).toEqual({
    type: "number",
    description: "NaN",
    unserializableValue: "NaN",
  });
  expect(store.wrap(Number.POSITIVE_INFINITY)).toEqual({
    type: "number",
    description: "Infinity",
    unserializableValue: "Infinity",
  });
  expect(store.wrap(Number.NEGATIVE_INFINITY)).toEqual({
    type: "number",
    description: "-Infinity",
    unserializableValue: "-Infinity",
  });
  expect(store.wrap(-0)).toEqual({
    type: "number",
    description: "-0",
    unserializableValue: "-0",
  });
  expect(store.wrap(1n)).toEqual({
    type: "bigint",
    description: "1n",
    unserializableValue: "1n",
  });
});

// Ported from v8/test/inspector/runtime/remote-object.js.
test("classifies reference values with Chromium-compatible type metadata", () => {
  const store = new RemoteObjectStore();
  const expected = 42;
  const fn = function answer() {
    return expected;
  };
  const regexp = /cdp/gi;
  regexp.toString = () => "user code must not run";

  expect(store.wrap(fn)).toMatchObject({
    type: "function",
    className: "Function",
    description: expect.stringContaining("function answer"),
    objectId: expect.any(String),
  });
  expect(store.wrap(Symbol("token"))).toMatchObject({
    type: "symbol",
    description: "Symbol(token)",
    objectId: expect.any(String),
  });
  expect(store.wrap([1, 2])).toMatchObject({
    type: "object",
    subtype: "array",
    className: "Array",
    description: "Array(2)",
  });
  expect(store.wrap(new Map([["key", "value"]]))).toMatchObject({
    type: "object",
    subtype: "map",
    className: "Map",
    description: "Map(1)",
  });
  expect(store.wrap(new Set(["value"]))).toMatchObject({
    type: "object",
    subtype: "set",
    className: "Set",
    description: "Set(1)",
  });
  expect(store.wrap(regexp)).toMatchObject({
    type: "object",
    subtype: "regexp",
    className: "RegExp",
    description: "/cdp/gi",
  });
});

test("classifies Symbol.toStringTag without invoking or trusting page accessors", () => {
  const store = new RemoteObjectStore();
  let getterCalls = 0;
  const accessorTag = Object.defineProperty({}, Symbol.toStringTag, {
    get() {
      getterCalls += 1;
      return "Map";
    },
  });

  expect(store.wrap(accessorTag)).toMatchObject({
    type: "object",
    className: "Object",
    description: "Object",
  });
  expect(getterCalls).toBe(0);

  for (const tag of ["Map", "Date", "NodeList", "TrustedHTML", "Error", "Promise"]) {
    const spoofed = Object.defineProperty({}, Symbol.toStringTag, { value: tag });
    const remote = store.wrap(spoofed);
    expect(remote).toMatchObject({
      type: "object",
      className: tag,
      description: tag,
    });
    expect(remote).not.toHaveProperty("subtype");
  }

  const spoofedError = Object.defineProperty(new TypeError("bad input"), Symbol.toStringTag, {
    value: "Map",
  });
  expect(store.wrap(spoofedError)).toMatchObject({
    type: "object",
    subtype: "error",
    className: "TypeError",
    description: expect.stringContaining("TypeError: bad input"),
  });
});

// Further cases ported from v8/test/inspector/runtime/remote-object.js.
test("reports Chromium subtypes and constructor names for built-in references", () => {
  class Widget {
    readonly kind = "widget";
  }

  const store = new RemoteObjectStore();
  const date = new Date("2020-01-02T03:04:05.000Z");
  const buffer = new ArrayBuffer(8);

  expect(store.wrap(new Widget())).toMatchObject({
    type: "object",
    className: "Widget",
    description: "Widget",
  });
  expect(store.wrap(date)).toMatchObject({
    type: "object",
    subtype: "date",
    className: "Date",
    description: date.toString(),
  });
  expect(store.wrap(new TypeError("bad input"))).toMatchObject({
    type: "object",
    subtype: "error",
    className: "TypeError",
    description: expect.stringContaining("TypeError: bad input"),
  });
  expect(store.wrap(new WeakMap())).toMatchObject({
    type: "object",
    subtype: "weakmap",
    className: "WeakMap",
    description: "WeakMap",
  });
  expect(store.wrap(Promise.resolve(42))).toMatchObject({
    type: "object",
    subtype: "promise",
    className: "Promise",
    description: "Promise",
  });
  expect(store.wrap(new Uint8Array(3))).toMatchObject({
    type: "object",
    subtype: "typedarray",
    className: "Uint8Array",
    description: "Uint8Array(3)",
  });
  expect(store.wrap(buffer)).toMatchObject({
    type: "object",
    subtype: "arraybuffer",
    className: "ArrayBuffer",
    description: "ArrayBuffer(8)",
  });
  expect(store.wrap(new DataView(buffer, 2, 4))).toMatchObject({
    type: "object",
    subtype: "dataview",
    className: "DataView",
    description: "DataView(4)",
  });
  expect(store.wrap(new Map([[1, 2]]).entries())).toMatchObject({
    type: "object",
    subtype: "iterator",
    className: "MapIterator",
    description: "MapIterator",
  });
  expect(store.wrap(new Set([1]).values())).toMatchObject({
    type: "object",
    subtype: "iterator",
    className: "SetIterator",
    description: "SetIterator",
  });
  const arrayIterator = store.wrap([1].values());
  expect(arrayIterator).toMatchObject({
    type: "object",
    className: "Array Iterator",
    description: "Array Iterator",
  });
  expect(arrayIterator).not.toHaveProperty("subtype");
  const stringIterator = store.wrap("x"[Symbol.iterator]());
  expect(stringIterator).toMatchObject({
    type: "object",
    className: "StringIterator",
    description: "StringIterator",
  });
  expect(stringIterator).not.toHaveProperty("subtype");
  expect(store.wrap((function* () {})())).toMatchObject({
    type: "object",
    subtype: "generator",
    className: "Generator",
    description: "Generator",
  });
  expect(store.wrap((async function* () {})())).toMatchObject({
    type: "object",
    subtype: "generator",
    className: "AsyncGenerator",
    description: "AsyncGenerator",
  });
  expect(store.wrap(new WebAssembly.Memory({ initial: 1 }))).toMatchObject({
    type: "object",
    subtype: "webassemblymemory",
    className: "Memory",
    description: "Memory(1)",
  });
});

test("recognizes branded values created in another JavaScript realm", () => {
  const store = new RemoteObjectStore();
  const crossRealm = runInNewContext(`({
    error: new TypeError("cross-realm"),
    promise: Promise.resolve(42)
  })`) as { error: TypeError; promise: Promise<number> };

  expect(store.wrap(crossRealm.error)).toMatchObject({
    type: "object",
    subtype: "error",
    className: "TypeError",
    description: expect.stringContaining("TypeError: cross-realm"),
  });
  expect(store.wrap(crossRealm.promise)).toMatchObject({
    type: "object",
    subtype: "promise",
    className: "Promise",
    description: "Promise",
  });
});

test("does not confuse forged Error prototypes with genuine cross-realm errors", () => {
  const store = new RemoteObjectStore();
  const forged = Object.assign(Object.create(Error.prototype) as object, {
    stack: "fake",
  });
  const crossRealm = runInNewContext(`({
    forged: Object.assign(Object.create(Error.prototype), { stack: "fake" }),
    withoutStack: (() => {
      const error = new TypeError("cross-realm");
      delete error.stack;
      return error;
    })()
  })`) as { forged: object; withoutStack: TypeError };

  for (const value of [forged, crossRealm.forged]) {
    const remote = store.wrap(value);
    expect(remote).toMatchObject({
      type: "object",
      className: "Error",
      description: "Error",
    });
    expect(remote).not.toHaveProperty("subtype");
  }
  expect(store.wrap(crossRealm.withoutStack)).toMatchObject({
    type: "object",
    subtype: "error",
    className: "TypeError",
    description: expect.stringContaining("TypeError: cross-realm"),
  });
});

// Ported from Chromium's runtime-evaluate-return-by-value.js and the broader
// v8/test/inspector/runtime/remote-object.js return-by-value matrix.
test("returns JSON values by value and reports Chromium's serialization failures", () => {
  const store = new RemoteObjectStore();
  const source = { answer: 42, missing: undefined, array: [1, undefined] };

  const remote = store.wrap(source, { returnByValue: true });

  expect(remote).toEqual({
    type: "object",
    value: { answer: 42, array: [1, null] },
  });
  expect(remote).not.toHaveProperty("objectId");

  expect(
    store.wrap(
      function answer() {
        return 42;
      },
      { returnByValue: true },
    ),
  ).toEqual({ type: "function", value: {} });

  expect(() => store.wrap(Symbol("nope"), { returnByValue: true })).toThrow(
    "Object couldn't be returned by value",
  );

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => store.wrap(cyclic, { returnByValue: true })).toThrow(
    "Object reference chain is too long",
  );

  let getterCalls = 0;
  const getterCycle: { readonly self?: unknown } = {};
  Object.defineProperty(getterCycle, "self", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return getterCycle;
    },
  });
  expect(() => store.wrap(getterCycle, { returnByValue: true })).toThrow(
    "Object reference chain is too long",
  );
  expect(getterCalls).toBe(1_000);
});

// Ported from v8/test/inspector/runtime/remote-object-get-properties.js.
test("returns complete data, accessor, symbol, and prototype descriptors without reading getters", () => {
  const store = new RemoteObjectStore();
  const symbol = Symbol("token");
  let getterCalls = 0;
  const value = {};
  Object.defineProperties(value, {
    answer: {
      configurable: false,
      enumerable: false,
      value: 42,
      writable: false,
    },
    computed: {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 7;
      },
    },
    [symbol]: {
      configurable: true,
      enumerable: false,
      value: 239,
      writable: true,
    },
  });
  const objectId = store.wrap(value).objectId!;

  const response = store.getProperties({ objectId, ownProperties: true });
  const properties = new Map(response.result.map((property) => [property.name, property]));

  expect(properties.get("answer")).toEqual({
    name: "answer",
    configurable: false,
    enumerable: false,
    isOwn: true,
    writable: false,
    value: { type: "number", description: "42", value: 42 },
  });
  expect(properties.get("computed")).toMatchObject({
    name: "computed",
    configurable: true,
    enumerable: true,
    isOwn: true,
    get: {
      type: "function",
      className: "Function",
      objectId: expect.any(String),
    },
    set: { type: "undefined" },
  });
  expect(properties.get("computed")).not.toHaveProperty("value");
  expect(properties.get("computed")).not.toHaveProperty("writable");
  expect(properties.get("Symbol(token)")).toMatchObject({
    name: "Symbol(token)",
    configurable: true,
    enumerable: false,
    isOwn: true,
    writable: true,
    symbol: {
      type: "symbol",
      description: "Symbol(token)",
      objectId: expect.any(String),
    },
    value: { type: "number", description: "239", value: 239 },
  });
  expect(response.internalProperties).toEqual([
    {
      name: "[[Prototype]]",
      value: expect.objectContaining({
        type: "object",
        className: "Object",
        objectId: expect.any(String),
      }),
    },
  ]);
  expect(getterCalls).toBe(0);
});

test("exposes Chromium-shaped Map and Set entries with inherited object-group lifetime", () => {
  const store = new RemoteObjectStore();
  const mapId = store.wrap(new Map([["a", 1]]), { objectGroup: "map" }).objectId!;

  const map = store.getProperties({ objectId: mapId, ownProperties: true });
  const entries = map.internalProperties?.find(
    (property) => property.name === "[[Entries]]",
  )?.value;
  expect(entries).toMatchObject({
    type: "object",
    subtype: "array",
    className: "Array",
    description: "Array(1)",
    objectId: expect.any(String),
  });

  const freshEntriesValue = store.resolve(entries!.objectId!) as CollectionEntryForTest[];
  expect(store.wrap(freshEntriesValue[0], { objectGroup: "map" })).toMatchObject({
    subtype: "internal#entry",
    className: "Object",
    description: '{"a" => 1}',
  });

  const entriesProperties = store.getProperties({
    objectId: entries!.objectId!,
    ownProperties: true,
  });
  expect(entriesProperties.internalProperties).toBeUndefined();
  expect(entriesProperties.result).toEqual([
    {
      name: "0",
      configurable: true,
      enumerable: true,
      isOwn: true,
      writable: true,
      value: {
        type: "object",
        subtype: "internal#entry",
        className: "Object",
        description: '{"a" => 1}',
        objectId: expect.any(String),
      },
    },
    {
      name: "length",
      configurable: false,
      enumerable: false,
      isOwn: true,
      writable: true,
      value: { type: "number", description: "1", value: 1 },
    },
  ]);

  const entryId = entriesProperties.result[0]!.value!.objectId!;
  expect(store.getProperties({ objectId: entryId, ownProperties: true })).toEqual({
    result: [
      {
        name: "key",
        configurable: true,
        enumerable: true,
        isOwn: true,
        writable: true,
        value: { type: "string", value: "a" },
      },
      {
        name: "value",
        configurable: true,
        enumerable: true,
        isOwn: true,
        writable: true,
        value: { type: "number", description: "1", value: 1 },
      },
    ],
  });

  const entriesValue = store.resolve(entries!.objectId!) as CollectionEntryForTest[];
  expect(Array.isArray(entriesValue)).toBe(true);
  expect(Object.getPrototypeOf(entriesValue)).toBeNull();
  expect(Object.getPrototypeOf(entriesValue[0]!)).toBeNull();

  const reboundEntries = store.wrap(entriesValue, { objectGroup: "map" });
  expect(reboundEntries).toMatchObject({
    subtype: "array",
    className: "Array",
    description: "Array(1)",
  });
  expect(
    store.getProperties({ objectId: reboundEntries.objectId!, ownProperties: true }),
  ).not.toHaveProperty("internalProperties");

  const reboundEntry = store.wrap(entriesValue[0], { objectGroup: "map" });
  expect(reboundEntry).toMatchObject({
    subtype: "internal#entry",
    className: "Object",
    description: '{"a" => 1}',
  });
  expect(
    store.getProperties({ objectId: reboundEntry.objectId!, ownProperties: true }),
  ).not.toHaveProperty("internalProperties");

  store.releaseObjectGroup("map");
  for (const objectId of [
    mapId,
    entries!.objectId!,
    entryId,
    reboundEntries.objectId!,
    reboundEntry.objectId!,
  ]) {
    expect(() => store.resolve(objectId)).toThrow("Could not find object with given id");
  }

  const setId = store.wrap(new Set(["x"])).objectId!;
  const setEntries = store
    .getProperties({ objectId: setId, ownProperties: true })
    .internalProperties?.find((property) => property.name === "[[Entries]]")?.value;
  const setEntry = store.getProperties({
    objectId: setEntries!.objectId!,
    ownProperties: true,
  }).result[0]!.value!;
  expect(setEntry).toMatchObject({
    subtype: "internal#entry",
    description: '"x"',
  });
  expect(store.getProperties({ objectId: setEntry.objectId!, ownProperties: true })).toEqual({
    result: [
      {
        name: "value",
        configurable: true,
        enumerable: true,
        isOwn: true,
        writable: true,
        value: { type: "string", value: "x" },
      },
    ],
  });
});

type CollectionEntryForTest = { key?: unknown; value: unknown };

test("describing collection entries does not invoke constructor name accessors", () => {
  let getterCalls = 0;
  const constructor = function EntryKey() {
    return getterCalls;
  };
  Object.defineProperty(constructor, "name", {
    configurable: true,
    get() {
      getterCalls += 1;
      return "Observed";
    },
  });
  const key = Object.create({ constructor });
  const store = new RemoteObjectStore();
  const mapId = store.wrap(new Map([[key, 1]])).objectId!;
  const entries = store
    .getProperties({ objectId: mapId, ownProperties: true })
    .internalProperties?.find((property) => property.name === "[[Entries]]")?.value;

  store.getProperties({ objectId: entries!.objectId!, ownProperties: true });

  expect(getterCalls).toBe(0);
});

test("virtual collection properties reflect replacements, additions, and holes", () => {
  const store = new RemoteObjectStore();
  const mapId = store.wrap(new Map([["a", 1]])).objectId!;
  const entries = store
    .getProperties({ objectId: mapId, ownProperties: true })
    .internalProperties?.find((property) => property.name === "[[Entries]]")?.value;
  const value = store.resolve(entries!.objectId!) as Array<unknown> & { extra?: number };

  value[0] = { replacement: true };
  value.extra = 7;
  const replaced = store.getProperties({ objectId: entries!.objectId!, ownProperties: true });
  expect(replaced.internalProperties).toBeUndefined();
  expect(replaced.result.find((property) => property.name === "0")?.value).toMatchObject({
    type: "object",
    className: "Object",
  });
  expect(replaced.result.find((property) => property.name === "0")?.value).not.toHaveProperty(
    "subtype",
    "internal#entry",
  );
  expect(replaced.result.find((property) => property.name === "extra")?.value).toEqual({
    type: "number",
    description: "7",
    value: 7,
  });

  delete value[0];
  delete value.extra;
  value.length = 2;
  const sparse = store.getProperties({ objectId: entries!.objectId!, ownProperties: true });
  expect(sparse.internalProperties).toBeUndefined();
  expect(sparse.result.map((property) => property.name)).toEqual(["length"]);
  expect(sparse.result[0]).toMatchObject({
    configurable: false,
    enumerable: false,
    writable: true,
    value: { type: "number", value: 2 },
  });
});

test("collection inspection uses captured object intrinsics", () => {
  const store = new RemoteObjectStore();
  const mapId = store.wrap(new Map([["a", 1]])).objectId!;
  const create = Object.create;
  const setPrototypeOf = Object.setPrototypeOf;
  let createCalls = 0;
  let setPrototypeCalls = 0;
  Object.create = ((...args: Parameters<typeof Object.create>) => {
    createCalls += 1;
    return Reflect.apply(create, Object, args);
  }) as typeof Object.create;
  Object.setPrototypeOf = ((...args: Parameters<typeof Object.setPrototypeOf>) => {
    setPrototypeCalls += 1;
    return Reflect.apply(setPrototypeOf, Object, args);
  }) as typeof Object.setPrototypeOf;
  try {
    store.getProperties({ objectId: mapId, ownProperties: true });
  } finally {
    Object.create = create;
    Object.setPrototypeOf = setPrototypeOf;
  }

  expect({ createCalls, setPrototypeCalls }).toEqual({ createCalls: 0, setPrototypeCalls: 0 });
});

// Mirrors V8RuntimeAgentImpl::getProperties' object guard.
test("rejects getProperties for a non-object handle", () => {
  const store = new RemoteObjectStore();
  const symbolId = store.wrap(Symbol("primitive")).objectId!;

  expect(() => store.getProperties({ objectId: symbolId })).toThrow(
    "Value with given id is not an object",
  );
});

// Ported from v8/test/inspector/runtime/release-object.js.
test("releases one handle or every handle derived from an object group", () => {
  const store = new RemoteObjectStore();
  const single = store.wrap({ name: "single" }).objectId!;
  const grouped = store.wrap({ child: { name: "child" } }, { objectGroup: "x" }).objectId!;
  const sibling = store.wrap({ name: "sibling" }, { objectGroup: "x" }).objectId!;
  const survivor = store.wrap({ name: "survivor" }, { objectGroup: "y" }).objectId!;
  const child = store
    .getProperties({ objectId: grouped, ownProperties: true })
    .result.find((property) => property.name === "child")!.value!.objectId!;

  expect(store.objectGroupName(grouped)).toBe("x");
  expect(store.objectGroupName(single)).toBeUndefined();

  store.releaseObject(single);

  expect(() => store.resolve(single)).toThrow("Could not find object with given id");
  expect(store.resolve(grouped)).toEqual({ child: { name: "child" } });

  store.releaseObjectGroup("x");

  for (const released of [grouped, sibling, child]) {
    expect(() => store.resolve(released)).toThrow("Could not find object with given id");
  }
  expect(store.resolve(survivor)).toEqual({ name: "survivor" });
  expect(() => store.releaseObject(single)).toThrow("Could not find object with given id");
});

// Ported from the CallArgument matrix in
// v8/test/inspector/runtime/call-function-on-async.js.
test("decodes protocol call arguments and rejects foreign or released handles", () => {
  const owner = new RemoteObjectStore();
  const foreign = new RemoteObjectStore();
  const value = { answer: 42 };
  const objectId = owner.wrap(value).objectId!;

  expect(owner.decodeArgument({})).toBeUndefined();
  expect(owner.decodeArgument({ value: null })).toBeNull();
  expect(owner.decodeArgument({ value: { nested: true } })).toEqual({ nested: true });
  expect(Object.is(owner.decodeArgument({ unserializableValue: "-0" }), -0)).toBe(true);
  expect(owner.decodeArgument({ unserializableValue: "NaN" })).toBeNaN();
  expect(owner.decodeArgument({ unserializableValue: "Infinity" })).toBe(Number.POSITIVE_INFINITY);
  expect(owner.decodeArgument({ unserializableValue: "-Infinity" })).toBe(Number.NEGATIVE_INFINITY);
  expect(owner.decodeArgument({ unserializableValue: "-0x10n" })).toBe(-16n);
  expect(owner.decodeArgument({ objectId })).toBe(value);

  expect(() => foreign.decodeArgument({ objectId })).toThrow(
    "Cannot find context with specified id",
  );
  owner.releaseObject(objectId);
  expect(() => owner.decodeArgument({ objectId })).toThrow("Could not find object with given id");
  expect(() => owner.decodeArgument({ unserializableValue: "not-a-number" })).toThrow(
    "Invalid unserializable value",
  );
});
