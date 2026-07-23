import type Protocol from "devtools-protocol";

const MISSING_OBJECT = "Could not find object with given id";
const CANNOT_RETURN_BY_VALUE = "Object couldn't be returned by value";
const REFERENCE_CHAIN_TOO_LONG = "Object reference chain is too long";
let fallbackScope = 0;

function createScope(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    fallbackScope += 1;
    return `${Date.now().toString(36)}-${fallbackScope.toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}`;
  }
}

export interface WrapOptions {
  objectGroup?: string;
  returnByValue?: boolean;
}

interface StoredObject {
  objectGroup?: string;
  value: unknown;
}

function constructorName(value: object, fallback: string): string {
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    const constructor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
      : undefined;
    if (
      typeof constructor === "function" &&
      typeof constructor.name === "string" &&
      constructor.name
    ) {
      return constructor.name;
    }
  } catch {
    // Exotic objects can refuse prototype inspection.
  }
  return fallback;
}

function dataProperty(value: object, name: PropertyKey): unknown {
  let owner: object | null = value;
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return undefined;
}

function describeReference(
  value: symbol | object | CallableFunction,
): Omit<Protocol.Runtime.RemoteObject, "objectId"> {
  if (typeof value === "symbol") {
    return { type: "symbol", description: String(value) };
  }
  if (typeof value === "function") {
    let description: string;
    try {
      description = Function.prototype.toString.call(value);
    } catch {
      description = "function () { [native code] }";
    }
    return { type: "function", className: "Function", description };
  }
  if (typeof Node !== "undefined" && value instanceof Node) {
    return {
      type: "object",
      subtype: "node",
      className: constructorName(value, "Node"),
      description: value instanceof Element ? value.outerHTML : value.nodeName,
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "object",
      subtype: "array",
      className: "Array",
      description: `Array(${value.length})`,
    };
  }

  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (ArrayBuffer.isView(value)) {
    if (tag === "DataView") {
      return {
        type: "object",
        subtype: "dataview",
        className: "DataView",
        description: `DataView(${value.byteLength})`,
      };
    }
    const className = constructorName(value, tag);
    return {
      type: "object",
      subtype: "typedarray",
      className,
      description: `${className}(${(value as unknown as { length: number }).length})`,
    };
  }

  switch (tag) {
    case "Date":
      return {
        type: "object",
        subtype: "date",
        className: "Date",
        description: Date.prototype.toString.call(value),
      };
    case "Map":
      return {
        type: "object",
        subtype: "map",
        className: "Map",
        description: `Map(${Reflect.getOwnPropertyDescriptor(Map.prototype, "size")!.get!.call(
          value,
        )})`,
      };
    case "Set":
      return {
        type: "object",
        subtype: "set",
        className: "Set",
        description: `Set(${Reflect.getOwnPropertyDescriptor(Set.prototype, "size")!.get!.call(
          value,
        )})`,
      };
    case "WeakMap":
      return {
        type: "object",
        subtype: "weakmap",
        className: "WeakMap",
        description: "WeakMap",
      };
    case "WeakSet":
      return {
        type: "object",
        subtype: "weakset",
        className: "WeakSet",
        description: "WeakSet",
      };
    case "RegExp":
      return {
        type: "object",
        subtype: "regexp",
        className: "RegExp",
        description: RegExp.prototype.toString.call(value),
      };
    case "Error": {
      const className = constructorName(value, "Error");
      const stack = dataProperty(value, "stack");
      const message = dataProperty(value, "message");
      return {
        type: "object",
        subtype: "error",
        className,
        description:
          typeof stack === "string" && stack
            ? stack
            : `${className}${typeof message === "string" && message ? `: ${message}` : ""}`,
      };
    }
    case "Promise":
      return {
        type: "object",
        subtype: "promise",
        className: "Promise",
        description: "Promise",
      };
    case "ArrayBuffer":
    case "SharedArrayBuffer":
      return {
        type: "object",
        subtype: "arraybuffer",
        className: tag,
        description: `${tag}(${(value as ArrayBuffer).byteLength})`,
      };
    default: {
      const className = constructorName(value, tag);
      return { type: "object", className, description: className };
    }
  }
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

export class RemoteObjectStore {
  private readonly scope = createScope();
  private nextObjectId = 1;
  private readonly objects = new Map<string, StoredObject>();
  private readonly objectGroups = new Map<string, Set<string>>();

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
      if (type === "symbol") {
        throw new Error(CANNOT_RETURN_BY_VALUE);
      }

      const reference = describeReference(value as object | CallableFunction);
      const serializable = type === "function" ? { ...value } : value;
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(serializable);
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        throw new Error(
          message.includes("circular") || message.includes("cyclic")
            ? REFERENCE_CHAIN_TOO_LONG
            : CANNOT_RETURN_BY_VALUE,
          { cause: error },
        );
      }
      if (serialized === undefined) {
        throw new Error(CANNOT_RETURN_BY_VALUE);
      }
      return { type: reference.type, value: JSON.parse(serialized) as unknown };
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
    const entry = this.find(objectId);
    this.objects.delete(objectId);
    if (entry.objectGroup) {
      const group = this.objectGroups.get(entry.objectGroup);
      group?.delete(objectId);
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

  private bind(value: unknown, objectGroup?: string): string {
    const objectId = `${this.scope}:${this.nextObjectId++}`;
    const entry: StoredObject = objectGroup ? { value, objectGroup } : { value };
    this.objects.set(objectId, entry);
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

  private find(objectId: string): StoredObject {
    const entry = this.objects.get(objectId);
    if (!entry) {
      throw new Error(MISSING_OBJECT);
    }
    return entry;
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
      let prototype = Object.getPrototypeOf(target) as object | null;
      while (prototype !== null) {
        owners.push(prototype);
        prototype = Object.getPrototypeOf(prototype) as object | null;
      }
    }

    const seen = new Set<PropertyKey>();
    const result: Protocol.Runtime.PropertyDescriptor[] = [];
    for (const owner of owners) {
      for (const name of Reflect.ownKeys(owner)) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (params.nonIndexedPropertiesOnly && isArrayIndex(name)) continue;

        const descriptor = Object.getOwnPropertyDescriptor(owner, name);
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
          if (descriptor.get) property.get = this.wrap(descriptor.get, wrapOptions);
          if (descriptor.set) property.set = this.wrap(descriptor.set, wrapOptions);
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

    return {
      result,
      internalProperties: [
        {
          name: "[[Prototype]]",
          value: this.wrap(Object.getPrototypeOf(target) as object | null, wrapOptions),
        },
      ],
    };
  }
}
