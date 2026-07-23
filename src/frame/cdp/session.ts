import type Protocol from "devtools-protocol";

import {
  invalidNestedCdpParam,
  validateCdpParams,
  type CdpParamSchema,
} from "../../cdp-dispatch.ts";
import {
  CDP_INVALID_PARAMS,
  CDP_METHOD_NOT_FOUND,
  CDP_SERVER_ERROR,
  type FrameCommand,
  type FrameEvent,
  type FrameResponse,
} from "../../protocol.ts";
import {
  createDomRegistry,
  type DomRegistry,
  getAXNodeAndAncestors,
  getChildAXNodes,
  getFullAXTree,
  getPartialAXTree,
  getRootAXNode,
  queryAXTree,
} from "../ax-tree.ts";
import { NetworkObserver } from "./network-observer.ts";
import { SessionNodeRegistry } from "./node-registry.ts";
import { RemoteObjectStore } from "./remote-objects.ts";
import { cdpMonotonicTime } from "./time.ts";

export const FRAME_METHODS = Object.freeze(
  [
    "Accessibility.disable",
    "Accessibility.enable",
    "Accessibility.getAXNodeAndAncestors",
    "Accessibility.getChildAXNodes",
    "Accessibility.getFullAXTree",
    "Accessibility.getPartialAXTree",
    "Accessibility.getRootAXNode",
    "Accessibility.queryAXTree",
    "DOM.describeNode",
    "DOM.disable",
    "DOM.enable",
    "DOM.getBoxModel",
    "DOM.getDocument",
    "DOM.querySelectorAll",
    "DOM.requestChildNodes",
    "DOM.requestNode",
    "DOM.resolveNode",
    "DOM.scrollIntoViewIfNeeded",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "Network.disable",
    "Network.enable",
    "Network.getResponseBody",
    "Page.disable",
    "Page.enable",
    "Page.getFrameTree",
    "Page.navigate",
    "Page.reload",
    "Runtime.callFunctionOn",
    "Runtime.disable",
    "Runtime.enable",
    "Runtime.evaluate",
    "Runtime.getProperties",
    "Runtime.releaseObject",
    "Runtime.releaseObjectGroup",
    "Runtime.runIfWaitingForDebugger",
    "Storage.getUsageAndQuota",
  ].toSorted(),
);

type FrameBackendOptions = {
  document: Document;
  navigate?: (url: string) => void;
  reload?: () => void;
  send: (message: FrameResponse | FrameEvent) => void;
};

type ConsoleRecord = {
  type: string;
  args: unknown[];
  timestamp: number;
};

type PageLifecycleMethod = "Page.domContentEventFired" | "Page.loadEventFired";
type PageNavigationType = "Navigation" | "BackForwardCacheRestore";
type SameDocumentNavigationType = Protocol.Page.NavigatedWithinDocumentEvent["navigationType"];

type PageDeliveryState = {
  lifecycle: Set<PageLifecycleMethod>;
  navigationSequence: number;
};

const PAGE_LIFECYCLE_ORDER: PageLifecycleMethod[] = [
  "Page.domContentEventFired",
  "Page.loadEventFired",
];

const MAX_EXECUTION_CONTEXT_ID = 2_147_483_647;
let nextExecutionContextId = Math.floor(Math.random() * MAX_EXECUTION_CONTEXT_ID) + 1;

function allocateExecutionContextId(): number {
  const id = nextExecutionContextId;
  nextExecutionContextId = id === MAX_EXECUTION_CONTEXT_ID ? 1 : id + 1;
  return id;
}

function allocateUniqueExecutionContextId(contextId: number): string {
  return `${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)}.${contextId}`;
}

function isInt64Pair(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^-?\d+$/.test(part))) return false;
  const minimum = -(2n ** 63n);
  const maximum = 2n ** 63n - 1n;
  return parts.every((part) => {
    const integer = BigInt(part);
    return integer >= minimum && integer <= maximum;
  });
}

function allocateLoaderId(): string {
  return `icdp-loader-${Math.random().toString(36).slice(2)}`;
}

function isLocalhost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function textNodeIsVisible(value: string): boolean {
  return !/^[\t-\r \u1680\u2000-\u200a\u2028\u205f\u3000]*$/.test(value);
}

function protocolNodeValue(value: string): string {
  return value.length > 10_000 ? `${value.slice(0, 10_000)}…` : value;
}

function mutationAttributeName(record: MutationRecord, element: Element): string {
  const attribute = Array.from(element.attributes).find(
    (candidate) =>
      candidate.localName === record.attributeName &&
      candidate.namespaceURI === record.attributeNamespace,
  );
  if (attribute) return attribute.name;
  if (record.attributeNamespace === "http://www.w3.org/1999/xlink") {
    return `xlink:${record.attributeName}`;
  }
  const prefix = record.attributeNamespace
    ? element.lookupPrefix(record.attributeNamespace)
    : undefined;
  return prefix ? `${prefix}:${record.attributeName}` : record.attributeName!;
}

const PENDING_LOADER_ID_KEY = "__icdp_pending_loader_id__";

const FRAME_PARAM_SCHEMAS: Record<string, CdpParamSchema> = {
  "Accessibility.getPartialAXTree": {
    optional: {
      nodeId: "integer",
      backendNodeId: "integer",
      objectId: "string",
      fetchRelatives: "boolean",
    },
  },
  "Accessibility.getFullAXTree": {
    optional: { depth: "integer", frameId: "string" },
  },
  "Accessibility.getRootAXNode": {
    optional: { frameId: "string" },
  },
  "Accessibility.getAXNodeAndAncestors": {
    optional: {
      nodeId: "integer",
      backendNodeId: "integer",
      objectId: "string",
    },
  },
  "Accessibility.getChildAXNodes": {
    required: { id: "string" },
    optional: { frameId: "string" },
  },
  "Accessibility.queryAXTree": {
    optional: {
      nodeId: "integer",
      backendNodeId: "integer",
      objectId: "string",
      accessibleName: "string",
      role: "string",
    },
  },
  "DOM.describeNode": {
    optional: {
      nodeId: "integer",
      backendNodeId: "integer",
      objectId: "string",
      depth: "integer",
      pierce: "boolean",
    },
  },
  "DOM.enable": {
    optional: { includeWhitespace: "string" },
  },
  "DOM.getBoxModel": {
    optional: {
      nodeId: "integer",
      backendNodeId: "integer",
      objectId: "string",
    },
  },
  "DOM.getDocument": {
    optional: { depth: "integer", pierce: "boolean" },
  },
  "DOM.querySelectorAll": {
    required: { nodeId: "integer", selector: "string" },
  },
  "DOM.requestChildNodes": {
    required: { nodeId: "integer" },
    optional: { depth: "integer", pierce: "boolean" },
  },
  "DOM.requestNode": {
    required: { objectId: "string" },
  },
  "DOM.resolveNode": {
    optional: {
      nodeId: "integer",
      backendNodeId: "integer",
      objectGroup: "string",
      executionContextId: "integer",
    },
  },
  "DOM.scrollIntoViewIfNeeded": {
    optional: {
      nodeId: "integer",
      backendNodeId: "integer",
      objectId: "string",
      rect: "object",
    },
  },
  "Input.dispatchKeyEvent": {
    required: { type: "string" },
    optional: {
      modifiers: "integer",
      timestamp: "number",
      text: "string",
      unmodifiedText: "string",
      keyIdentifier: "string",
      code: "string",
      key: "string",
      windowsVirtualKeyCode: "integer",
      nativeVirtualKeyCode: "integer",
      autoRepeat: "boolean",
      isKeypad: "boolean",
      isSystemKey: "boolean",
      location: "integer",
      commands: "array",
    },
  },
  "Input.dispatchMouseEvent": {
    required: { type: "string", x: "number", y: "number" },
    optional: {
      modifiers: "integer",
      timestamp: "number",
      button: "string",
      buttons: "integer",
      clickCount: "integer",
      force: "number",
      tangentialPressure: "number",
      tiltX: "number",
      tiltY: "number",
      twist: "integer",
      deltaX: "number",
      deltaY: "number",
      pointerType: "string",
    },
  },
  "Input.insertText": {
    required: { text: "string" },
  },
  "Network.enable": {
    optional: {
      maxTotalBufferSize: "integer",
      maxResourceBufferSize: "integer",
      maxPostDataSize: "integer",
      reportDirectSocketTraffic: "boolean",
      enableDurableMessages: "boolean",
    },
  },
  "Network.getResponseBody": {
    required: { requestId: "string" },
  },
  "Page.enable": {
    optional: { enableFileChooserOpenedEvent: "boolean" },
  },
  "Page.navigate": {
    required: { url: "string" },
    optional: {
      referrer: "string",
      transitionType: "string",
      frameId: "string",
      referrerPolicy: "string",
    },
  },
  "Page.reload": {
    optional: {
      ignoreCache: "boolean",
      scriptToEvaluateOnLoad: "string",
      loaderId: "string",
    },
  },
  "Runtime.callFunctionOn": {
    required: { functionDeclaration: "string" },
    optional: {
      objectId: "string",
      arguments: "array",
      silent: "boolean",
      returnByValue: "boolean",
      generatePreview: "boolean",
      userGesture: "boolean",
      awaitPromise: "boolean",
      executionContextId: "integer",
      objectGroup: "string",
      throwOnSideEffect: "boolean",
      uniqueContextId: "string",
      serializationOptions: "object",
    },
  },
  "Runtime.evaluate": {
    required: { expression: "string" },
    optional: {
      objectGroup: "string",
      includeCommandLineAPI: "boolean",
      silent: "boolean",
      contextId: "integer",
      returnByValue: "boolean",
      generatePreview: "boolean",
      userGesture: "boolean",
      awaitPromise: "boolean",
      throwOnSideEffect: "boolean",
      timeout: "number",
      disableBreaks: "boolean",
      replMode: "boolean",
      allowUnsafeEvalBlockedByCSP: "boolean",
      uniqueContextId: "string",
      serializationOptions: "object",
    },
  },
  "Runtime.getProperties": {
    required: { objectId: "string" },
    optional: {
      ownProperties: "boolean",
      accessorPropertiesOnly: "boolean",
      generatePreview: "boolean",
      nonIndexedPropertiesOnly: "boolean",
    },
  },
  "Runtime.releaseObject": {
    required: { objectId: "string" },
  },
  "Runtime.releaseObjectGroup": {
    required: { objectGroup: "string" },
  },
  "Storage.getUsageAndQuota": {
    required: { origin: "string" },
  },
};

function protocolError(
  code: number,
  message: string,
  data?: unknown,
): Error & { code: number; data?: unknown } {
  return Object.assign(new Error(message), {
    code,
    ...(data === undefined ? {} : { data }),
  });
}

function isProtocolValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isProtocolValue(item, seen))
    : Object.values(value).every((item) => isProtocolValue(item, seen));
  seen.delete(value);
  return valid;
}

function nestedRuntimeParamError(method: string, params: Record<string, unknown>, name: string) {
  if (
    (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") &&
    name === "serializationOptions"
  ) {
    if (
      typeof params.serializationOptions !== "object" ||
      params.serializationOptions === null ||
      Array.isArray(params.serializationOptions)
    ) {
      return invalidNestedCdpParam(params, ["serializationOptions"], "object");
    }
    const options = params.serializationOptions as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(options, "serialization")) {
      return invalidNestedCdpParam(params, ["serializationOptions", "serialization"], "string", {
        missing: true,
      });
    }
    if (typeof options.serialization !== "string") {
      return invalidNestedCdpParam(params, ["serializationOptions", "serialization"], "string");
    }
    if (
      Object.prototype.hasOwnProperty.call(options, "maxDepth") &&
      (!Number.isInteger(options.maxDepth) ||
        Number(options.maxDepth) < -2_147_483_648 ||
        Number(options.maxDepth) > 2_147_483_647)
    ) {
      return invalidNestedCdpParam(params, ["serializationOptions", "maxDepth"], "integer");
    }
  }

  if (method !== "Runtime.callFunctionOn" || name !== "arguments") return;
  if (!Array.isArray(params.arguments)) {
    return invalidNestedCdpParam(params, ["arguments"], "array");
  }
  const arguments_ = params.arguments as unknown[];
  for (const [index, argument] of arguments_.entries()) {
    if (typeof argument !== "object" || argument === null || Array.isArray(argument)) {
      return invalidNestedCdpParam(params, ["arguments", index], "object", {
        expectation: "CBOR: map start expected",
      });
    }
    const record = argument as Record<string, unknown>;
    if (record.objectId !== undefined && typeof record.objectId !== "string") {
      return invalidNestedCdpParam(params, ["arguments", index, "objectId"], "string");
    }
    if (
      record.unserializableValue !== undefined &&
      typeof record.unserializableValue !== "string"
    ) {
      return invalidNestedCdpParam(params, ["arguments", index, "unserializableValue"], "string");
    }
    if (Object.prototype.hasOwnProperty.call(record, "value") && !isProtocolValue(record.value)) {
      return invalidNestedCdpParam(params, ["arguments", index, "value"], "object");
    }
  }
}

class FrameSession {
  readonly nodes: SessionNodeRegistry;
  readonly enabledDomains = new Set<string>();
  private pressedElement: Element | undefined;
  private hoveredElement: Element | undefined;
  private suppressCompatibilityMouse = false;
  private readonly detachedNodes = new WeakSet<Node>();
  private readonly objects: RemoteObjectStore;
  private nextExceptionId = 1;
  private includeWhitespace = false;
  private readonly networkRequestIds = new Set<string>();

  constructor(
    readonly id: string,
    private readonly backend: FrameBackend,
  ) {
    this.nodes = new SessionNodeRegistry(backend.backendNodes);
    this.objects = new RemoteObjectStore(backend.remoteObjectScope());
  }

  restore(
    enabledDomains: Iterable<string>,
    domainParams: Record<string, Record<string, unknown>> = {},
  ): void {
    const domains = Array.from(enabledDomains);
    const restoresPage = domains.includes("Page");
    if (restoresPage) this.enabledDomains.add("Page");
    if (domains.includes("Runtime")) {
      this.emit("Runtime.executionContextsCleared", {});
    }
    // Blink reports an ordinary frame commit before V8 announces the new
    // context. A BFCache restore keeps its context and is reported afterward.
    if (restoresPage) this.backend.pageDomainRestoringBeforeContext(this);
    if (domains.includes("Runtime")) {
      this.enableRuntime();
    }
    for (const domain of domains) {
      if (domain === "Page" || domain === "Runtime") continue;
      if (domain === "Network") this.enableNetwork();
      else if (domain === "DOM") {
        this.includeWhitespace = domainParams.DOM?.includeWhitespace === "all";
        this.enabledDomains.add("DOM");
        this.nodes.reset();
        this.backend.reconcileDomObserver();
        this.emit("DOM.documentUpdated", {});
      } else this.enabledDomains.add(domain);
    }
    // A replacement document already has its execution context by the time
    // Blink can deliver DOM-content/load callbacks. Replay Page last so a
    // late handshake preserves that ordering.
    if (restoresPage) this.backend.pageDomainRestoringAfterContext(this);
  }

  domainEnabled(domain: string): boolean {
    return this.enabledDomains.has(domain);
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const paramError = validateCdpParams(params, FRAME_PARAM_SCHEMAS[method], (name) =>
      nestedRuntimeParamError(method, params, name),
    );
    if (paramError) throw protocolError(paramError.code, paramError.message, paramError.data);
    if (method === "Accessibility.enable") {
      this.enabledDomains.add("Accessibility");
      return {};
    }
    if (method === "Accessibility.disable") {
      this.enabledDomains.delete("Accessibility");
      return {};
    }
    if (method.startsWith("Accessibility.")) {
      if (
        [
          "Accessibility.getAXNodeAndAncestors",
          "Accessibility.getChildAXNodes",
          "Accessibility.getRootAXNode",
        ].includes(method) &&
        !this.enabledDomains.has("Accessibility")
      ) {
        throw new Error("Accessibility has not been enabled.");
      }
      if (
        [
          "Accessibility.getFullAXTree",
          "Accessibility.getRootAXNode",
          "Accessibility.getChildAXNodes",
        ].includes(method)
      ) {
        this.validateFrameId(params.frameId);
      }
      const options = {
        document: this.backend.document,
        frameId: "icdp-frame",
        registry: this.backend.backendNodes,
      };
      if (method === "Accessibility.getFullAXTree") {
        return getFullAXTree(options, params.depth as number | undefined);
      }
      if (method === "Accessibility.getPartialAXTree") {
        return getPartialAXTree(
          options,
          this.targetBackendId(params),
          (params.fetchRelatives as boolean | undefined) ?? true,
        );
      }
      if (method === "Accessibility.getRootAXNode") return getRootAXNode(options);
      if (method === "Accessibility.getChildAXNodes") {
        try {
          return getChildAXNodes(options, String(params.id));
        } catch (error) {
          if (error instanceof Error && error.message === "Invalid ID") {
            throw protocolError(CDP_INVALID_PARAMS, error.message);
          }
          throw error;
        }
      }
      if (method === "Accessibility.getAXNodeAndAncestors") {
        const target = this.targetBackendId(params);
        if (target === undefined) {
          throw new Error("Either nodeId, backendNodeId or objectId must be specified");
        }
        return getAXNodeAndAncestors(options, target);
      }
      if (method === "Accessibility.queryAXTree") {
        const target = this.targetBackendId(params);
        if (target === undefined) {
          throw new Error("Either nodeId, backendNodeId or objectId must be specified");
        }
        return queryAXTree(options, {
          target,
          accessibleName: params.accessibleName as string | undefined,
          role: params.role as string | undefined,
        });
      }
    }
    if (method === "DOM.enable") {
      if (
        params.includeWhitespace !== undefined &&
        params.includeWhitespace !== "none" &&
        params.includeWhitespace !== "all"
      ) {
        throw protocolError(CDP_INVALID_PARAMS, "Invalid parameters");
      }
      if (!this.enabledDomains.has("DOM")) {
        this.includeWhitespace = params.includeWhitespace === "all";
      }
      this.enabledDomains.add("DOM");
      this.backend.reconcileDomObserver();
      return {};
    }
    if (method === "DOM.disable") {
      if (!this.enabledDomains.has("DOM")) {
        throw new Error("DOM agent hasn't been enabled");
      }
      this.enabledDomains.delete("DOM");
      this.includeWhitespace = false;
      this.nodes.reset();
      this.backend.reconcileDomObserver();
      return {};
    }
    if (method === "DOM.getDocument") {
      this.enabledDomains.add("DOM");
      this.nodes.reset();
      this.backend.reconcileDomObserver();
      return {
        root: this.serializeNode(
          this.backend.document,
          Number(params.depth ?? 2),
          Boolean(params.pierce),
        ),
      } satisfies Protocol.DOM.GetDocumentResponse;
    }
    if (method === "DOM.querySelectorAll") {
      const root = this.nodes.nodeForNodeId(Number(params.nodeId));
      if (!root) {
        throw new Error("Could not find node with given id");
      }
      if (
        !(root instanceof Document) &&
        !(root instanceof DocumentFragment) &&
        !(root instanceof Element)
      ) {
        throw new Error("Not a container node");
      }
      let matches: NodeListOf<Element>;
      try {
        matches = root.querySelectorAll(String(params.selector));
      } catch {
        throw new Error("DOM Error while querying");
      }
      return {
        nodeIds: Array.from(matches).map((node) => this.pushNodePathToFrontend(node)),
      } satisfies Protocol.DOM.QuerySelectorAllResponse;
    }
    if (method === "DOM.requestChildNodes") {
      const root = this.nodes.nodeForNodeId(Number(params.nodeId));
      const depth = Number(params.depth ?? 1);
      if (depth === 0 || depth < -1) {
        throw new Error("Please provide a positive integer as a depth or -1 for entire subtree");
      }
      if (!root || !this.isContainerNode(root)) return {};
      const nextDepth = depth < 0 ? -1 : depth - 1;
      const parentId = Number(params.nodeId);
      const pierce = Boolean(params.pierce);
      if (!this.nodes.childrenWereRequested(root)) {
        const nodes = this.visibleChildren(root).map((child) => {
          const serialized = this.serializeNode(child, nextDepth, pierce);
          serialized.parentId = parentId;
          return serialized;
        });
        this.nodes.markChildrenRequested(root);
        this.emit("DOM.setChildNodes", { parentId, nodes });
      } else if (nextDepth !== 0) {
        for (const child of this.visibleChildren(root)) {
          this.materializeUnrequestedChildren(child, nextDepth, pierce);
        }
      }
      return {};
    }
    if (method === "DOM.describeNode") {
      const node = this.resolveNode(params);
      return {
        node: this.serializeNode(node, Number(params.depth ?? 0), Boolean(params.pierce), false),
      } satisfies Protocol.DOM.DescribeNodeResponse;
    }
    if (method === "DOM.getBoxModel") {
      const node = this.resolveNode(params);
      return { model: boxModelForNode(node) } satisfies Protocol.DOM.GetBoxModelResponse;
    }
    if (method === "DOM.resolveNode") {
      const targetFields = ["nodeId", "backendNodeId"].filter(
        (field) => params[field] !== undefined,
      );
      if (targetFields.length !== 1) {
        throw protocolError(CDP_SERVER_ERROR, "Either nodeId or backendNodeId must be specified.");
      }
      this.validateExecutionContext({ contextId: params.executionContextId });
      const node = this.resolveNode(params);
      return {
        object: this.objects.wrap(node, {
          objectGroup: params.objectGroup as string | undefined,
        }),
      } satisfies Protocol.DOM.ResolveNodeResponse;
    }
    if (method === "DOM.requestNode") {
      const value = this.objects.resolve(String(params.objectId));
      const view = this.backend.document.defaultView;
      if (!view || !(value instanceof view.Node)) {
        throw new Error("Object id doesn't reference a Node");
      }
      return {
        nodeId: this.pushNodePathToFrontend(value),
      } satisfies Protocol.DOM.RequestNodeResponse;
    }
    if (method === "DOM.scrollIntoViewIfNeeded") {
      this.rejectPresentOptions(params, ["rect"]);
      const node = this.resolveNode(params);
      const element = node instanceof Element ? node : node.parentElement;
      if (!element) throw new Error("Node does not have a layout object");
      revealWithinFrame(element);
      return {};
    }
    if (method === "Network.enable") {
      this.rejectPresentOptions(params, [
        "maxTotalBufferSize",
        "maxResourceBufferSize",
        "maxPostDataSize",
      ]);
      this.rejectTruthyOptions(params, ["reportDirectSocketTraffic", "enableDurableMessages"]);
      this.enableNetwork();
      return {};
    }
    if (method === "Network.disable") {
      this.enabledDomains.delete("Network");
      this.networkRequestIds.clear();
      this.backend.reconcileNetworkObserver();
      return {};
    }
    if (method === "Network.getResponseBody") {
      if (!this.enabledDomains.has("Network")) {
        throw new Error("Network has not been enabled");
      }
      const requestId = String(params.requestId);
      if (!this.networkRequestIds.has(requestId)) {
        throw new Error("No resource with given identifier found");
      }
      return this.backend.getResponseBody(requestId);
    }
    if (method === "Page.enable") {
      this.rejectTruthyOptions(params, ["enableFileChooserOpenedEvent"]);
      this.enablePage();
      return {};
    }
    if (method === "Page.disable") {
      this.enabledDomains.delete("Page");
      return {};
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: this.backend.pageFrame() } };
    }
    if (method === "Page.navigate") {
      this.rejectPresentOptions(params, ["referrer", "transitionType", "referrerPolicy"]);
      if (params.frameId !== undefined && params.frameId !== "icdp-frame") {
        throw new Error("No frame with given id found");
      }
      let next: URL;
      try {
        next = new URL(String(params.url));
      } catch {
        throw new Error("Cannot navigate to invalid URL");
      }
      const currentOrigin = this.backend.document.defaultView?.location.origin;
      if (next.origin !== currentOrigin) {
        throw new Error("Navigation outside the embedded app's origin is not allowed");
      }
      const loaderId = this.backend.navigate(next.href);
      return {
        frameId: "icdp-frame",
        ...(loaderId === undefined ? {} : { loaderId }),
      } satisfies Protocol.Page.NavigateResponse;
    }
    if (method === "Page.reload") {
      if (params.loaderId !== undefined && params.loaderId !== this.backend.currentLoaderId()) {
        throw protocolError(
          CDP_INVALID_PARAMS,
          "Reload was discarded because the page already navigated",
        );
      }
      this.rejectTruthyOptions(params, ["ignoreCache"]);
      this.rejectPresentOptions(params, ["scriptToEvaluateOnLoad"]);
      this.backend.reload();
      return {};
    }
    if (method === "Input.dispatchKeyEvent") {
      this.rejectPresentOptions(params, ["timestamp", "unmodifiedText", "keyIdentifier"]);
      this.rejectTruthyOptions(params, ["isSystemKey"]);
      if (Array.isArray(params.commands) && params.commands.length > 0) {
        throw new Error("commands is not supported");
      }
      if (typeof params.text === "string" && params.text.length >= 4) {
        throw protocolError(CDP_INVALID_PARAMS, "Invalid 'text' parameter");
      }
      this.dispatchKeyEvent(params);
      return {};
    }
    if (method === "Input.dispatchMouseEvent") {
      this.rejectPresentOptions(params, ["timestamp"]);
      this.dispatchMouseEvent(params);
      return {};
    }
    if (method === "Input.insertText") {
      insertText(this.backend.document, String(params.text));
      return {};
    }
    if (method === "Runtime.enable") {
      this.enableRuntime();
      return {};
    }
    if (method === "Runtime.disable") {
      this.enabledDomains.delete("Runtime");
      return {};
    }
    if (method === "Runtime.runIfWaitingForDebugger") return {};
    if (method === "Runtime.evaluate") {
      this.validateExecutionContext({
        contextId: params.contextId,
        uniqueContextId: params.uniqueContextId,
      });
      this.rejectPresentOptions(params, ["timeout", "serializationOptions"]);
      this.rejectTruthyOptions(params, [
        "includeCommandLineAPI",
        "silent",
        "generatePreview",
        "userGesture",
        "disableBreaks",
        "replMode",
        "allowUnsafeEvalBlockedByCSP",
      ]);
      return await this.evaluate(params);
    }
    if (method === "Runtime.callFunctionOn") {
      return await this.callFunctionOn(params);
    }
    if (method === "Runtime.getProperties") {
      this.rejectTruthyOptions(params, ["generatePreview"]);
      return this.objects.getProperties(params as unknown as Protocol.Runtime.GetPropertiesRequest);
    }
    if (method === "Runtime.releaseObject") {
      this.objects.releaseObject(String(params.objectId));
      return {};
    }
    if (method === "Runtime.releaseObjectGroup") {
      this.objects.releaseObjectGroup(String(params.objectGroup));
      return {};
    }
    if (method === "Storage.getUsageAndQuota") {
      const requestedOrigin = new URL(String(params.origin)).origin;
      const currentOrigin = this.backend.document.defaultView?.location.origin;
      if (requestedOrigin !== currentOrigin) {
        throw new Error("Storage inspection is restricted to the current origin");
      }
      const estimate = await this.backend.document.defaultView?.navigator.storage?.estimate();
      if (!estimate) throw new Error("Storage estimate is unavailable");
      return {
        usage: estimate.usage ?? 0,
        quota: estimate.quota ?? 0,
        overrideActive: false,
        usageBreakdown: [],
      } satisfies Protocol.Storage.GetUsageAndQuotaResponse;
    }
    throw protocolError(CDP_METHOD_NOT_FOUND, `'${method}' wasn't found`);
  }

  private emit(method: string, params: Record<string, unknown>): void {
    this.backend.emit(this.id, method, params);
  }

  private enablePage(): void {
    if (this.enabledDomains.has("Page")) return;
    this.enabledDomains.add("Page");
    this.backend.pageDomainEnabled(this);
  }

  pageFrameNavigated(type: PageNavigationType): void {
    this.emit("Page.frameNavigated", {
      frame: this.backend.pageFrame(),
      type,
    });
  }

  pageLifecycleEvent(method: PageLifecycleMethod, timestamp: number): void {
    if (!this.enabledDomains.has("Page")) return;
    this.emit(method, { timestamp });
  }

  pageNavigatedWithinDocument(navigationType: SameDocumentNavigationType, url: string): void {
    if (!this.enabledDomains.has("Page")) return;
    this.emit("Page.navigatedWithinDocument", {
      frameId: "icdp-frame",
      navigationType,
      url,
    } satisfies Protocol.Page.NavigatedWithinDocumentEvent);
  }

  private enableNetwork(): void {
    if (this.enabledDomains.has("Network")) return;
    this.networkRequestIds.clear();
    this.enabledDomains.add("Network");
    this.backend.reconcileNetworkObserver();
  }

  private enableRuntime(): void {
    if (this.enabledDomains.has("Runtime")) return;
    this.enabledDomains.add("Runtime");
    this.emit("Runtime.executionContextCreated", {
      context: this.backend.executionContext(),
    });
    this.backend.replayConsole(this);
  }

  consoleAPICalled(record: ConsoleRecord): void {
    if (!this.enabledDomains.has("Runtime")) return;
    this.emit("Runtime.consoleAPICalled", {
      type: record.type,
      args: record.args.map((argument) => this.objects.wrap(argument)),
      executionContextId: this.backend.executionContext().id,
      timestamp: record.timestamp,
      stackTrace: { callFrames: [] },
    });
  }

  networkEvent(method: string, params: Record<string, unknown>): void {
    if (!this.enabledDomains.has("Network")) return;
    if (typeof params.requestId === "string") {
      this.networkRequestIds.add(params.requestId);
    }
    this.emit(method, params);
  }

  domMutations(records: MutationRecord[]): void {
    if (!this.enabledDomains.has("DOM")) return;
    for (const [index, record] of records.entries()) {
      const nodeId = this.nodes.idForNode(record.target);
      if (record.type === "attributes") {
        if (nodeId === 0 || !record.attributeName) continue;
        const element = record.target as Element;
        const nextRecord = records
          .slice(index + 1)
          .find(
            (candidate) =>
              candidate.type === "attributes" &&
              candidate.target === record.target &&
              candidate.attributeName === record.attributeName &&
              candidate.attributeNamespace === record.attributeNamespace,
          );
        const value = nextRecord
          ? nextRecord.oldValue
          : element.getAttributeNS(record.attributeNamespace, record.attributeName);
        const name = mutationAttributeName(record, element);
        if (value === null) {
          this.emit("DOM.attributeRemoved", {
            nodeId,
            name,
          });
        } else {
          this.emit("DOM.attributeModified", {
            nodeId,
            name,
            value,
          });
        }
        continue;
      }
      if (record.type === "characterData") {
        const nextRecord = records
          .slice(index + 1)
          .find(
            (candidate) => candidate.type === "characterData" && candidate.target === record.target,
          );
        const characterData = nextRecord
          ? (nextRecord.oldValue ?? "")
          : (record.target.nodeValue ?? "");
        const wasVisible = this.includeWhitespace || textNodeIsVisible(record.oldValue ?? "");
        const isVisible = this.includeWhitespace || textNodeIsVisible(characterData);
        const parent = this.frontendParent(record.target);
        const parentId = parent ? this.nodes.idForNode(parent) : 0;
        const visibleChildrenAtRecord = parent
          ? this.visibleChildrenAtRecord(parent, index, records)
          : [];
        if (wasVisible && !isVisible) {
          if (
            nodeId !== 0 &&
            parent &&
            parentId !== 0 &&
            this.nodes.childrenWereRequested(parent)
          ) {
            this.emit("DOM.childNodeRemoved", { parentNodeId: parentId, nodeId });
          } else if (parentId !== 0) {
            this.emit("DOM.childNodeCountUpdated", {
              nodeId: parentId,
              childNodeCount: visibleChildrenAtRecord.length,
            });
          }
          this.nodes.unbindSubtree(record.target);
        } else if (!wasVisible && isVisible) {
          if (parent && parentId !== 0 && this.nodes.childrenWereRequested(parent)) {
            const previous = this.previousVisibleNode(
              record.target,
              visibleChildrenAtRecord,
              index,
              records,
            );
            const node = this.serializeNode(record.target, 0, false);
            node.nodeValue = protocolNodeValue(characterData);
            this.emit("DOM.childNodeInserted", {
              parentNodeId: parentId,
              previousNodeId: previous ? this.nodes.idForNode(previous) : 0,
              node,
            });
          } else if (parentId !== 0) {
            this.emit("DOM.childNodeCountUpdated", {
              nodeId: parentId,
              childNodeCount: visibleChildrenAtRecord.length,
            });
          }
        } else if (isVisible && nodeId !== 0) {
          this.emit("DOM.characterDataModified", {
            nodeId,
            characterData,
          });
        }
        continue;
      }
      if (nodeId === 0) continue;
      const childrenAtRecord = this.childrenAtRecord(record.target, index, records);
      const visibleChildrenAtRecord = childrenAtRecord.filter((child) =>
        this.nodeIsVisibleAtRecord(child, index, records),
      );
      if (!this.nodes.childrenWereRequested(record.target)) {
        const visibleRemoved = Array.from(record.removedNodes).filter((node) =>
          this.nodeIsVisibleAtRecord(node, index, records),
        );
        const visibleAdded = Array.from(record.addedNodes).filter((node) =>
          this.nodeIsVisibleAtRecord(node, index, records),
        );
        let childNodeCount =
          visibleChildrenAtRecord.length - visibleAdded.length + visibleRemoved.length;
        for (const removed of Array.from(record.removedNodes)) {
          this.unbindMutationSubtree(removed, index, records);
          if (!visibleRemoved.includes(removed)) continue;
          childNodeCount--;
          this.emit("DOM.childNodeCountUpdated", {
            nodeId,
            childNodeCount,
          });
        }
        for (const _added of visibleAdded) {
          childNodeCount++;
          this.emit("DOM.childNodeCountUpdated", {
            nodeId,
            childNodeCount,
          });
        }
        continue;
      }
      for (const removed of Array.from(record.removedNodes)) {
        if (!this.nodeIsVisibleAtRecord(removed, index, records)) {
          this.unbindMutationSubtree(removed, index, records);
          continue;
        }
        const removedNodeId = this.nodes.idForNode(removed);
        if (removedNodeId !== 0) {
          this.emit("DOM.childNodeRemoved", {
            parentNodeId: nodeId,
            nodeId: removedNodeId,
          });
        }
        this.unbindMutationSubtree(removed, index, records);
      }
      for (const added of Array.from(record.addedNodes)) {
        if (!this.nodeIsVisibleAtRecord(added, index, records)) continue;
        if (this.detachedNodes.has(added)) {
          this.nodes.unbindSubtree(added);
          this.detachedNodes.delete(added);
        }
        const previous = this.previousVisibleNode(added, childrenAtRecord, index, records);
        this.emit("DOM.childNodeInserted", {
          parentNodeId: nodeId,
          previousNodeId: previous ? this.nodes.idForNode(previous) : 0,
          node: this.serializeMutationNode(added, index, records),
        });
      }
    }
  }

  domShadowRootPushed(host: Element, root: ShadowRoot): void {
    if (!this.enabledDomains.has("DOM")) return;
    const hostId = this.nodes.idForNode(host);
    if (hostId === 0) return;
    if (!this.nodes.childrenWereRequested(host)) {
      const nodes = this.visibleChildren(host).map((child) => {
        const serialized = this.serializeNode(child, 0, false);
        serialized.parentId = hostId;
        return serialized;
      });
      this.nodes.markChildrenRequested(host);
      this.emit("DOM.setChildNodes", { parentId: hostId, nodes });
    }
    this.emit("DOM.shadowRootPushed", {
      hostId,
      root: this.serializeNode(root, 0, false),
    });
  }

  private resolveNode(params: Record<string, unknown>): Node {
    if (params.nodeId !== undefined) {
      const node = this.nodes.nodeForNodeId(Number(params.nodeId));
      if (node) return node;
      throw new Error("Could not find node with given id");
    }
    if (params.backendNodeId !== undefined) {
      const node = this.nodes.nodeForBackendId(Number(params.backendNodeId));
      if (node) return node;
      throw new Error("No node found for given backend id");
    }
    if (params.objectId !== undefined) {
      const value = this.objects.resolve(String(params.objectId));
      const view = this.backend.document.defaultView;
      if (view && value instanceof view.Node) return value;
      throw new Error("Object id doesn't reference a Node");
    }
    throw new Error("Either nodeId, backendNodeId or objectId must be specified");
  }

  private targetBackendId(params: Record<string, unknown>): Protocol.DOM.BackendNodeId {
    if (params.nodeId !== undefined) {
      const node = this.nodes.nodeForNodeId(Number(params.nodeId));
      if (!node) throw new Error("Could not find node with given id");
      return this.nodes.backendIdFor(node);
    }
    if (params.backendNodeId !== undefined) {
      const id = Number(params.backendNodeId);
      if (!this.nodes.nodeForBackendId(id)) {
        throw new Error("No node found for given backend id");
      }
      return id;
    }
    if (params.objectId !== undefined) {
      const value = this.objects.resolve(String(params.objectId));
      const view = this.backend.document.defaultView;
      if (!view || !(value instanceof view.Node)) {
        throw new Error("Object id doesn't reference a Node");
      }
      return this.nodes.backendIdFor(value);
    }
    throw new Error("Either nodeId, backendNodeId or objectId must be specified");
  }

  private dispatchKeyEvent(params: Record<string, unknown>): void {
    const type = String(params.type);
    if (!["keyDown", "rawKeyDown", "keyUp", "char"].includes(type)) {
      throw protocolError(CDP_INVALID_PARAMS, `Unexpected event type '${type}'`);
    }
    const document = this.backend.document;
    const view = document.defaultView;
    if (!view) return;
    const target = document.activeElement ?? document.body;
    const modifiers = Number(params.modifiers ?? 0);
    const init: KeyboardEventInit = {
      bubbles: true,
      cancelable: true,
      key: String(params.key ?? ""),
      code: String(params.code ?? ""),
      location: params.isKeypad ? 3 : Number(params.location ?? 0),
      repeat: Boolean(params.autoRepeat),
      altKey: (modifiers & 1) !== 0,
      ctrlKey: (modifiers & 2) !== 0,
      metaKey: (modifiers & 4) !== 0,
      shiftKey: (modifiers & 8) !== 0,
    };
    const keyboardEvent = (eventType: string): KeyboardEvent => {
      const event = new view.KeyboardEvent(eventType, init);
      const text = typeof params.text === "string" ? params.text : "";
      const charCode = eventType === "keypress" ? Array.from(text)[0]?.codePointAt(0) : undefined;
      const virtualKeyCode = params.windowsVirtualKeyCode;
      const keyCode =
        charCode ?? (virtualKeyCode === undefined ? undefined : Number(virtualKeyCode));
      if (keyCode !== undefined) {
        Object.defineProperties(event, {
          ...(charCode === undefined ? {} : { charCode: { configurable: true, value: charCode } }),
          keyCode: { configurable: true, value: keyCode },
          which: { configurable: true, value: keyCode },
        });
      }
      return event;
    };
    if (type === "keyDown" || type === "rawKeyDown") {
      const shouldEdit = target?.dispatchEvent(keyboardEvent("keydown")) ?? true;
      if (!shouldEdit) return;
      if (init.key === "Backspace") deleteBackward(document);
      if (type === "keyDown" && typeof params.text === "string" && params.text) {
        const shouldInsert = target?.dispatchEvent(keyboardEvent("keypress")) ?? true;
        if (shouldInsert) insertText(document, params.text);
      }
    } else if (type === "keyUp") {
      target?.dispatchEvent(keyboardEvent("keyup"));
    } else {
      const shouldEdit = target?.dispatchEvent(keyboardEvent("keypress")) ?? true;
      if (shouldEdit && typeof params.text === "string" && params.text) {
        insertText(document, params.text);
      }
    }
  }

  private dispatchMouseEvent(params: Record<string, unknown>): void {
    const type = String(params.type);
    if (!["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"].includes(type)) {
      throw protocolError(CDP_INVALID_PARAMS, `Unexpected event type '${type}'`);
    }
    const buttons = ["none", "left", "middle", "right", "back", "forward"];
    const buttonName = params.button === undefined ? "none" : String(params.button);
    if (!buttons.includes(buttonName)) {
      throw protocolError(CDP_INVALID_PARAMS, "Invalid mouse button");
    }
    const pointerType = params.pointerType === undefined ? "mouse" : String(params.pointerType);
    if (pointerType !== "mouse" && pointerType !== "pen") {
      throw protocolError(CDP_INVALID_PARAMS, "Invalid parameters");
    }
    if (type === "mouseWheel" && (params.deltaX === undefined || params.deltaY === undefined)) {
      throw protocolError(
        CDP_INVALID_PARAMS,
        "'deltaX' and 'deltaY' are expected for mouseWheel event",
      );
    }
    if (type !== "mouseWheel") {
      const ranges: Array<[string, number, number, string]> = [
        ["force", 0, 1, "'force' should be in the range of [0,1]"],
        ["tangentialPressure", -1, 1, "'tangential_pressure' should be in the range of [-1,1]"],
        ["tiltX", -90, 90, "'tilt_x' should be in the range of [-90,90]"],
        ["tiltY", -90, 90, "'tilt_y' should be in the range of [-90,90]"],
        ["twist", 0, 359, "'twist' should be in the range of [0,359]"],
      ];
      for (const [name, minimum, maximum, message] of ranges) {
        if (
          params[name] !== undefined &&
          (Number(params[name]) < minimum || Number(params[name]) > maximum)
        ) {
          throw protocolError(CDP_INVALID_PARAMS, message);
        }
      }
    }

    const document = this.backend.document;
    const view = document.defaultView;
    if (!view) return;
    const x = Number(params.x);
    const y = Number(params.y);
    let target = document.elementFromPoint(x, y) ?? document.documentElement;
    while (target.shadowRoot?.mode === "open") {
      const shadowTarget = target.shadowRoot.elementFromPoint(x, y);
      if (!shadowTarget || shadowTarget === target) break;
      target = shadowTarget;
    }
    if (!(target instanceof Element)) return;
    const modifiers = Number(params.modifiers ?? 0);
    const button = buttonName === "none" ? 0 : buttons.indexOf(buttonName) - 1;
    const buttonMask =
      {
        none: 0,
        left: 1,
        right: 2,
        middle: 4,
        back: 8,
        forward: 16,
      }[buttonName] ?? 0;
    const suppliedButtons = Number(params.buttons ?? 0);
    const activeButtons =
      type === "mousePressed"
        ? suppliedButtons | buttonMask
        : type === "mouseReleased"
          ? suppliedButtons & ~buttonMask
          : suppliedButtons;
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button,
      buttons: activeButtons,
      clientX: Number(params.x),
      clientY: Number(params.y),
      detail: Number(params.clickCount ?? 0),
      altKey: (modifiers & 1) !== 0,
      ctrlKey: (modifiers & 2) !== 0,
      metaKey: (modifiers & 4) !== 0,
      shiftKey: (modifiers & 8) !== 0,
    };
    const pointerInit: PointerEventInit = {
      ...init,
      button: type === "mouseMoved" ? -1 : button,
      detail: 0,
      pointerId: 1,
      pointerType,
      pressure: Number(params.force ?? 0),
      tangentialPressure: Number(params.tangentialPressure ?? 0),
      tiltX: Number(params.tiltX ?? 0),
      tiltY: Number(params.tiltY ?? 0),
      twist: Number(params.twist ?? 0),
      isPrimary: true,
    };
    const dispatchPointer = (
      element: Element,
      eventType: string,
      bubbles = true,
      relatedTarget: Element | null = null,
    ): boolean => {
      return element.dispatchEvent(
        new view.PointerEvent(eventType, { ...pointerInit, bubbles, relatedTarget }),
      );
    };
    if (type === "mouseMoved") {
      if (this.hoveredElement !== target) {
        if (this.hoveredElement) {
          dispatchPointer(this.hoveredElement, "pointerout", true, target);
          dispatchPointer(this.hoveredElement, "pointerleave", false, target);
        }
        dispatchPointer(target, "pointerover", true, this.hoveredElement ?? null);
        dispatchPointer(target, "pointerenter", false, this.hoveredElement ?? null);
        if (!this.suppressCompatibilityMouse) {
          this.hoveredElement?.dispatchEvent(
            new view.MouseEvent("mouseout", { ...init, relatedTarget: target }),
          );
          this.hoveredElement?.dispatchEvent(
            new view.MouseEvent("mouseleave", {
              ...init,
              bubbles: false,
              relatedTarget: target,
            }),
          );
          target.dispatchEvent(
            new view.MouseEvent("mouseover", {
              ...init,
              relatedTarget: this.hoveredElement ?? null,
            }),
          );
          target.dispatchEvent(
            new view.MouseEvent("mouseenter", {
              ...init,
              bubbles: false,
              relatedTarget: this.hoveredElement ?? null,
            }),
          );
        }
        this.hoveredElement = target;
      }
      dispatchPointer(target, "pointermove");
      if (!this.suppressCompatibilityMouse) {
        target.dispatchEvent(new view.MouseEvent("mousemove", init));
      }
      return;
    }
    if (type === "mousePressed") {
      this.pressedElement = target;
      const pointerAllowed = dispatchPointer(target, "pointerdown");
      const disabledControl = target.closest(":disabled");
      this.suppressCompatibilityMouse = !pointerAllowed || disabledControl !== null;
      const shouldFocus =
        !this.suppressCompatibilityMouse &&
        target.dispatchEvent(new view.MouseEvent("mousedown", init));
      const focusTarget = target.closest<HTMLElement>(
        "button,input,select,textarea,a[href],summary,[tabindex],[contenteditable]",
      );
      if (
        buttonName === "left" &&
        shouldFocus &&
        focusTarget &&
        !focusTarget.matches(":disabled")
      ) {
        focusTarget.focus({ preventScroll: true });
      }
      if (buttonName === "right" && disabledControl === null) {
        target.dispatchEvent(new view.PointerEvent("contextmenu", pointerInit));
      }
      return;
    }
    if (type === "mouseReleased") {
      dispatchPointer(target, "pointerup");
      if (!this.suppressCompatibilityMouse) {
        target.dispatchEvent(new view.MouseEvent("mouseup", init));
      }
      const clickTarget = this.pressedElement
        ? nearestCommonAncestor(this.pressedElement, target)
        : undefined;
      const disabledControl = clickTarget?.closest(":disabled");
      if (clickTarget) {
        if (buttonName === "left" && !disabledControl) {
          clickTarget.dispatchEvent(
            new view.PointerEvent("click", {
              ...pointerInit,
              button,
              buttons: activeButtons,
              detail: Number(params.clickCount ?? 0),
            }),
          );
        } else if (buttonName !== "none" && !disabledControl) {
          clickTarget.dispatchEvent(
            new view.PointerEvent("auxclick", {
              ...pointerInit,
              button,
              buttons: activeButtons,
              detail: Number(params.clickCount ?? 0),
            }),
          );
        }
        if (buttonName === "left" && Number(params.clickCount ?? 1) === 2 && !disabledControl) {
          clickTarget.dispatchEvent(new view.MouseEvent("dblclick", init));
        }
      }
      this.pressedElement = undefined;
      this.suppressCompatibilityMouse = false;
      return;
    }
    if (type === "mouseWheel") {
      const wheelAllowed = target.dispatchEvent(
        new view.WheelEvent("wheel", {
          ...init,
          deltaX: Number(params.deltaX ?? 0),
          deltaY: Number(params.deltaY ?? 0),
        }),
      );
      if (wheelAllowed) {
        const scroller = scrollableAncestor(target);
        scroller?.scrollBy?.(Number(params.deltaX ?? 0), Number(params.deltaY ?? 0));
      }
      return;
    }
    throw protocolError(CDP_INVALID_PARAMS, "Invalid parameters");
  }

  private validateExecutionContext(params: Record<string, unknown>): void {
    if (params.contextId !== undefined && params.uniqueContextId !== undefined) {
      throw protocolError(
        CDP_INVALID_PARAMS,
        "contextId and uniqueContextId are mutually exclusive",
      );
    }
    if (
      params.contextId !== undefined &&
      Number(params.contextId) !== this.backend.executionContext().id
    ) {
      throw new Error("Cannot find context with specified id");
    }
    if (
      params.uniqueContextId !== undefined &&
      params.uniqueContextId !== this.backend.executionContext().uniqueId
    ) {
      throw protocolError(
        CDP_INVALID_PARAMS,
        isInt64Pair(String(params.uniqueContextId))
          ? "uniqueContextId not found"
          : "invalid uniqueContextId",
      );
    }
  }

  private validateFrameId(frameId: unknown): void {
    if (frameId !== undefined && frameId !== "icdp-frame") {
      throw protocolError(CDP_INVALID_PARAMS, "Frame with the given frameId is not found.");
    }
  }

  private rejectPresentOptions(params: Record<string, unknown>, names: string[]): void {
    for (const name of names) {
      if (params[name] !== undefined) {
        throw new Error(`${name} is not supported`);
      }
    }
  }

  private rejectTruthyOptions(params: Record<string, unknown>, names: string[]): void {
    for (const name of names) {
      if (params[name]) {
        throw new Error(`${name} is not supported`);
      }
    }
  }

  private async evaluate(
    params: Record<string, unknown>,
  ): Promise<Protocol.Runtime.EvaluateResponse> {
    if (params.throwOnSideEffect) {
      return this.exceptionResult(new EvalError("Possible side-effect in debug-evaluate"), params);
    }
    let value: unknown;
    try {
      const view = this.backend.document.defaultView;
      if (!view) throw new Error("Execution context is unavailable");
      value = view.eval(String(params.expression));
    } catch (error) {
      return this.exceptionResult(error, params);
    }
    let settled = value;
    if (params.awaitPromise) {
      try {
        settled = await value;
      } catch (error) {
        return this.exceptionResult(error, params, true);
      }
    }
    return {
      result: this.objects.wrap(settled, {
        objectGroup: params.objectGroup as string | undefined,
        returnByValue: Boolean(params.returnByValue),
      }),
    };
  }

  private async callFunctionOn(
    params: Record<string, unknown>,
  ): Promise<Protocol.Runtime.CallFunctionOnResponse> {
    const targetCount = [params.objectId, params.executionContextId, params.uniqueContextId].filter(
      (value) => value !== undefined,
    ).length;
    if (targetCount > 1) {
      throw protocolError(
        CDP_INVALID_PARAMS,
        "ObjectId, executionContextId and uniqueContextId must mutually exclude each other",
      );
    }
    if (targetCount < 1) {
      throw protocolError(
        CDP_INVALID_PARAMS,
        "Either objectId or executionContextId or uniqueContextId must be specified",
      );
    }
    this.validateExecutionContext({
      contextId: params.executionContextId,
      uniqueContextId: params.uniqueContextId,
    });

    const view = this.backend.document.defaultView;
    if (!view) throw new Error("Execution context is unavailable");
    const target =
      params.objectId !== undefined ? this.objects.resolve(String(params.objectId)) : view;
    const args = ((params.arguments as Protocol.Runtime.CallArgument[] | undefined) ?? []).map(
      (argument) => this.objects.decodeArgument(argument),
    );
    const inheritedGroup =
      params.objectGroup ??
      (params.objectId !== undefined
        ? this.objects.objectGroupName(String(params.objectId))
        : undefined);
    const exceptionParams =
      inheritedGroup === undefined ? params : { ...params, objectGroup: inheritedGroup };

    this.rejectPresentOptions(params, ["serializationOptions"]);
    this.rejectTruthyOptions(params, ["silent", "generatePreview", "userGesture"]);

    if (params.throwOnSideEffect) {
      return this.exceptionResult(
        new EvalError("Possible side-effect in debug-evaluate"),
        exceptionParams,
      );
    }
    let candidate: unknown;
    try {
      candidate = view.eval(`(${String(params.functionDeclaration)})`);
    } catch (error) {
      return this.exceptionResult(error, exceptionParams);
    }
    if (typeof candidate !== "function") {
      throw new Error("Given expression does not evaluate to a function");
    }
    let value: unknown;
    try {
      const fn = candidate as (this: unknown, ...args: unknown[]) => unknown;
      value = fn.apply(target, args);
    } catch (error) {
      return this.exceptionResult(error, exceptionParams);
    }
    let settled = value;
    if (params.awaitPromise) {
      try {
        settled = await value;
      } catch (error) {
        return this.exceptionResult(error, exceptionParams, true);
      }
    }
    return {
      result: this.objects.wrap(settled, {
        objectGroup: inheritedGroup as string | undefined,
        returnByValue: Boolean(params.returnByValue),
      }),
    };
  }

  private exceptionResult(
    error: unknown,
    params: Record<string, unknown>,
    inPromise = false,
  ): Protocol.Runtime.EvaluateResponse {
    const result = this.objects.wrap(error, {
      objectGroup: params.objectGroup as string | undefined,
      returnByValue: inPromise && Boolean(params.returnByValue),
    });
    const exception = this.objects.wrap(error, {
      objectGroup: params.objectGroup as string | undefined,
    });
    let text = inPromise ? "Uncaught (in promise)" : "Uncaught";
    const view = this.backend.document.defaultView;
    try {
      if (inPromise && view && error instanceof view.Error) {
        const name = String((error as Error).name || "Error");
        const message = String((error as Error).message || "");
        text += ` ${name}${message ? `: ${message}` : ""}`;
      }
    } catch {
      // Exotic rejected values keep Chromium's generic promise exception text.
    }
    return {
      result,
      exceptionDetails: {
        exceptionId: this.nextExceptionId++,
        text,
        lineNumber: 0,
        columnNumber: 0,
        executionContextId: this.backend.executionContext().id,
        exception,
      },
    };
  }

  private pushNodePathToFrontend(node: Node): Protocol.DOM.NodeId {
    if (this.nodes.idForNode(this.backend.document) === 0) return 0;
    const ancestry: Node[] = [];
    for (let current: Node | null = node; current; current = this.frontendParent(current)) {
      ancestry.push(current);
      if (current === this.backend.document) break;
    }
    if (ancestry.at(-1) !== this.backend.document) {
      const detachedRoot = ancestry.at(-1)!;
      this.nodes.unbindSubtree(detachedRoot);
      for (const detached of ancestry) this.detachedNodes.add(detached);
      this.emit("DOM.setChildNodes", {
        parentId: 0,
        nodes: [this.serializeNode(detachedRoot, 0, true)],
      });
    }

    ancestry.reverse();
    for (let index = 0; index < ancestry.length - 1; index++) {
      const parent = ancestry[index]!;
      if (this.nodes.childrenWereRequested(parent)) continue;
      const parentId = this.nodes.idForNode(parent);
      if (parentId === 0) return 0;
      const nodes = this.visibleChildren(parent).map((child) => {
        const serialized = this.serializeNode(child, 0, true);
        serialized.parentId = parentId;
        return serialized;
      });
      this.nodes.markChildrenRequested(parent);
      this.emit("DOM.setChildNodes", { parentId, nodes });
    }
    return this.nodes.idForNode(node);
  }

  private isContainerNode(node: Node): node is Document | DocumentFragment | Element {
    return node instanceof Document || node instanceof DocumentFragment || node instanceof Element;
  }

  private materializeUnrequestedChildren(node: Node, depth: number, pierce: boolean): void {
    if (depth === 0 || !this.isContainerNode(node)) return;
    const nodeId = this.nodes.idForNode(node);
    if (nodeId === 0) return;
    const nextDepth = depth < 0 ? -1 : depth - 1;
    if (!this.nodes.childrenWereRequested(node)) {
      const nodes = this.visibleChildren(node).map((child) => {
        const serialized = this.serializeNode(child, nextDepth, pierce);
        serialized.parentId = nodeId;
        return serialized;
      });
      this.nodes.markChildrenRequested(node);
      this.emit("DOM.setChildNodes", { parentId: nodeId, nodes });
      return;
    }
    for (const child of this.visibleChildren(node)) {
      this.materializeUnrequestedChildren(child, nextDepth, pierce);
    }
  }

  private serializeNode(
    node: Node,
    depth: number,
    pierce: boolean,
    bind = true,
    childrenOverride?: Node[],
  ): Protocol.DOM.Node {
    const nodeId = bind ? this.nodes.bind(node) : this.nodes.idForNode(node);
    const result: Protocol.DOM.Node = {
      nodeId,
      backendNodeId: this.nodes.backendIdFor(node),
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      localName: node instanceof Element ? node.localName : "",
      nodeValue: protocolNodeValue(node.nodeValue ?? ""),
    };

    if (node instanceof Document) {
      result.documentURL = node.URL;
      result.baseURL = node.baseURI;
      result.xmlVersion = "";
      result.compatibilityMode = node.compatMode === "BackCompat" ? "QuirksMode" : "NoQuirksMode";
    } else if (node instanceof DocumentType) {
      result.publicId = node.publicId;
      result.systemId = node.systemId;
    } else if (node instanceof ShadowRoot) {
      result.shadowRootType = node.mode;
    } else if (node instanceof Element) {
      if (node === this.backend.document.documentElement) {
        result.frameId = "icdp-frame";
      }
      result.nodeName =
        node.namespaceURI === "http://www.w3.org/1999/xhtml"
          ? node.nodeName.toUpperCase()
          : node.nodeName;
      if (node.namespaceURI === "http://www.w3.org/2000/svg") {
        result.isSVG = true;
      }
      result.attributes = Array.from(node.attributes).flatMap((attribute) => [
        attribute.name,
        attribute.value,
      ]);
      if (node.shadowRoot) {
        result.shadowRoots = [
          this.serializeNode(node.shadowRoot, pierce ? depth : 0, pierce, bind),
        ];
      }
      if (node instanceof HTMLTemplateElement) {
        result.templateContent = this.serializeNode(
          this.backend.templateContent(node),
          0,
          pierce,
          bind,
        );
      }
    }

    const children = childrenOverride ?? this.visibleChildren(node);
    if (node instanceof Document || node instanceof DocumentFragment || node instanceof Element) {
      result.childNodeCount = children.length;
      const forceChildren =
        bind &&
        depth === 0 &&
        ((node instanceof Element &&
          (node.shadowRoot !== null || node instanceof HTMLTemplateElement)) ||
          (children.length === 1 && children[0]?.nodeType === Node.TEXT_NODE));
      const childDepth = forceChildren ? 1 : depth;
      if (childDepth !== 0) {
        if (bind) this.nodes.markChildrenRequested(node);
        const nextDepth = childDepth < 0 ? -1 : childDepth - 1;
        result.children = children.map((child) => {
          const serialized = this.serializeNode(child, nextDepth, pierce, bind);
          serialized.parentId = nodeId;
          return serialized;
        });
      }
    }
    return result;
  }

  private nodeIsVisible(node: Node): boolean {
    return (
      this.includeWhitespace ||
      node.nodeType !== node.TEXT_NODE ||
      textNodeIsVisible(node.nodeValue ?? "")
    );
  }

  private nodeIsVisibleAtRecord(node: Node, index: number, records: MutationRecord[]): boolean {
    return (
      this.includeWhitespace ||
      node.nodeType !== node.TEXT_NODE ||
      textNodeIsVisible(this.characterDataAtRecord(node, index, records))
    );
  }

  private characterDataAtRecord(node: Node, index: number, records: MutationRecord[]): string {
    const nextRecord = records
      .slice(index + 1)
      .find((candidate) => candidate.type === "characterData" && candidate.target === node);
    return nextRecord ? (nextRecord.oldValue ?? "") : (node.nodeValue ?? "");
  }

  private serializeMutationNode(
    node: Node,
    index: number,
    records: MutationRecord[],
  ): Protocol.DOM.Node {
    const children = this.visibleChildrenAtRecord(node, index, records);
    const serialized = this.serializeNode(node, 0, false, true, children);
    if (node.nodeType === node.TEXT_NODE) {
      serialized.nodeValue = protocolNodeValue(this.characterDataAtRecord(node, index, records));
    } else if (node instanceof Element) {
      for (const [childIndex, child] of children.entries()) {
        if (child.nodeType === child.TEXT_NODE && serialized.children?.[childIndex]) {
          serialized.children[childIndex]!.nodeValue = protocolNodeValue(
            this.characterDataAtRecord(child, index, records),
          );
        }
      }
      const attributes = new Map<string, { name: string; value: string }>();
      for (const attribute of Array.from(node.attributes)) {
        attributes.set(`${attribute.namespaceURI ?? ""}\0${attribute.localName}`, {
          name: attribute.name,
          value: attribute.value,
        });
      }
      for (let recordIndex = records.length - 1; recordIndex > index; recordIndex--) {
        const record = records[recordIndex]!;
        if (record.type !== "attributes" || record.target !== node || !record.attributeName) {
          continue;
        }
        const key = `${record.attributeNamespace ?? ""}\0${record.attributeName}`;
        if (record.oldValue === null) {
          attributes.delete(key);
        } else {
          attributes.set(key, {
            name: mutationAttributeName(record, node),
            value: record.oldValue,
          });
        }
      }
      serialized.attributes = Array.from(attributes.values()).flatMap(({ name, value }) => [
        name,
        value,
      ]);
    }
    return serialized;
  }

  private childrenAtRecord(node: Node, index: number, records: MutationRecord[]): Node[] {
    const children: Node[] = Array.from(node.childNodes);
    for (let recordIndex = records.length - 1; recordIndex > index; recordIndex--) {
      const record = records[recordIndex]!;
      if (record.type !== "childList" || record.target !== node) continue;

      for (const added of Array.from(record.addedNodes)) {
        const addedIndex = children.indexOf(added);
        if (addedIndex !== -1) children.splice(addedIndex, 1);
      }

      const removed = Array.from(record.removedNodes);
      if (removed.length === 0) continue;
      const nextIndex = record.nextSibling ? children.indexOf(record.nextSibling) : -1;
      const previousIndex = record.previousSibling ? children.indexOf(record.previousSibling) : -1;
      const insertionIndex =
        nextIndex !== -1 ? nextIndex : previousIndex !== -1 ? previousIndex + 1 : 0;
      children.splice(insertionIndex, 0, ...removed);
    }
    return children;
  }

  private visibleChildrenAtRecord(node: Node, index: number, records: MutationRecord[]): Node[] {
    return this.childrenAtRecord(node, index, records).filter((child) =>
      this.nodeIsVisibleAtRecord(child, index, records),
    );
  }

  private unbindMutationSubtree(node: Node, index: number, records: MutationRecord[]): void {
    for (const child of this.childrenAtRecord(node, index, records)) {
      this.unbindMutationSubtree(child, index, records);
    }
    const shadowRoot = node.nodeType === node.ELEMENT_NODE ? (node as Element).shadowRoot : null;
    if (shadowRoot) {
      this.unbindMutationSubtree(shadowRoot, index, records);
    }
    if (node.nodeType === node.ELEMENT_NODE && (node as Element).localName === "template") {
      this.unbindMutationSubtree(
        this.backend.templateContent(node as HTMLTemplateElement),
        index,
        records,
      );
    }
    this.nodes.unbindNode(node);
  }

  private previousVisibleNode(
    node: Node,
    siblings: Node[],
    index: number,
    records: MutationRecord[],
  ): Node | null {
    for (let siblingIndex = siblings.indexOf(node) - 1; siblingIndex >= 0; siblingIndex--) {
      const sibling = siblings[siblingIndex]!;
      if (this.nodeIsVisibleAtRecord(sibling, index, records)) return sibling;
    }
    return null;
  }

  private visibleChildren(node: Node): Node[] {
    return Array.from(node.childNodes).filter((child) => this.nodeIsVisible(child));
  }

  private previousVisibleSibling(node: Node): Node | null {
    let sibling = node.previousSibling;
    while (sibling && !this.nodeIsVisible(sibling)) {
      sibling = sibling.previousSibling;
    }
    return sibling;
  }

  private frontendParent(node: Node): Node | null {
    if (node.parentNode) return node.parentNode;
    const view = this.backend.document.defaultView;
    return view && node instanceof view.ShadowRoot ? node.host : null;
  }
}

function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  const view = element.ownerDocument.defaultView;
  return view && root instanceof view.ShadowRoot ? root.host : null;
}

function nearestCommonAncestor(first: Element, second: Element): Element | undefined {
  const secondAncestors = new Set<Element>();
  for (let current: Element | null = second; current; current = composedParent(current)) {
    secondAncestors.add(current);
  }
  for (let current: Element | null = first; current; current = composedParent(current)) {
    if (secondAncestors.has(current)) return current;
  }
  return undefined;
}

function textControl(document: Document): HTMLInputElement | HTMLTextAreaElement | undefined {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return active;
  if (
    active instanceof HTMLInputElement &&
    ["", "text", "search", "tel", "url", "password", "email", "number"].includes(active.type)
  ) {
    return active;
  }
  return undefined;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
}

function dispatchInputEvent(
  target: HTMLElement,
  type: "beforeinput" | "input",
  inputType: string,
  data: string | null = null,
): boolean {
  const InputEventConstructor = target.ownerDocument.defaultView?.InputEvent ?? InputEvent;
  return target.dispatchEvent(
    new InputEventConstructor(type, {
      bubbles: true,
      cancelable: type === "beforeinput",
      composed: true,
      data,
      inputType,
    }),
  );
}

function insertText(document: Document, text: string): void {
  const control = textControl(document);
  if (control) {
    if (!dispatchInputEvent(control, "beforeinput", "insertText", text)) return;
    if (typeof document.execCommand === "function") {
      document.execCommand("insertText", false, text);
      return;
    }
    if (control.readOnly || control.disabled) return;
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? control.value.length;
    const capacity =
      control.maxLength < 0
        ? text.length
        : Math.max(0, control.maxLength - (control.value.length - (end - start)));
    const inserted = text.slice(0, capacity);
    if (!inserted) return;
    setNativeValue(
      control,
      `${control.value.slice(0, start)}${inserted}${control.value.slice(end)}`,
    );
    try {
      control.setSelectionRange(start + inserted.length, start + inserted.length);
    } catch {
      // Email and some other text-like input types do not expose a selection
      // range even though Chromium can insert text into them.
    }
    dispatchInputEvent(control, "input", "insertText", inserted);
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isContentEditable) {
    if (!dispatchInputEvent(active, "beforeinput", "insertText", text)) return;
    document.execCommand("insertText", false, text);
  }
}

function previousGraphemeBoundary(value: string, position: number): number {
  let previous = 0;
  for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    value.slice(0, position),
  )) {
    previous = segment.index;
  }
  return previous;
}

function deleteBackward(document: Document): void {
  const control = textControl(document);
  if (control) {
    if (control.readOnly || control.disabled) return;
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? control.value.length;
    if (start === 0 && end === 0) return;
    if (!dispatchInputEvent(control, "beforeinput", "deleteContentBackward")) return;
    const nextStart = start === end ? previousGraphemeBoundary(control.value, start) : start;
    setNativeValue(control, `${control.value.slice(0, nextStart)}${control.value.slice(end)}`);
    try {
      control.setSelectionRange(nextStart, nextStart);
    } catch {
      // See insertText: some text-like input types have no selection API.
    }
    dispatchInputEvent(control, "input", "deleteContentBackward");
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isContentEditable) {
    if (!dispatchInputEvent(active, "beforeinput", "deleteContentBackward")) return;
    document.execCommand("delete", false);
  }
}

function scrollableAncestor(element: Element): Element | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`)) {
      return current;
    }
  }
  return element.ownerDocument.scrollingElement;
}

function revealWithinFrame(element: Element): void {
  const document = element.ownerDocument;
  const view = document.defaultView;
  if (!view) return;
  const container = scrollableAncestor(element);
  if (container && container !== document.scrollingElement) {
    const containerRect = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (rect.top < containerRect.top) container.scrollTop += rect.top - containerRect.top;
    else if (rect.bottom > containerRect.bottom) {
      container.scrollTop += rect.bottom - containerRect.bottom;
    }
    if (rect.left < containerRect.left) container.scrollLeft += rect.left - containerRect.left;
    else if (rect.right > containerRect.right) {
      container.scrollLeft += rect.right - containerRect.right;
    }
  }
  const rect = element.getBoundingClientRect();
  const deltaY =
    rect.top < 0 ? rect.top : rect.bottom > view.innerHeight ? rect.bottom - view.innerHeight : 0;
  const deltaX =
    rect.left < 0 ? rect.left : rect.right > view.innerWidth ? rect.right - view.innerWidth : 0;
  if (deltaX || deltaY) view.scrollBy(deltaX, deltaY);
}

function insetQuad(
  rect: DOMRect,
  top: number,
  right: number,
  bottom: number,
  left: number,
): Protocol.DOM.Quad {
  return [
    rect.left + left,
    rect.top + top,
    rect.right - right,
    rect.top + top,
    rect.right - right,
    rect.bottom - bottom,
    rect.left + left,
    rect.bottom - bottom,
  ];
}

function cssNumber(value: string): number {
  return Number.parseFloat(value) || 0;
}

function boxModel(element: Element): Protocol.DOM.BoxModel {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const border = {
    top: cssNumber(style.borderTopWidth),
    right: cssNumber(style.borderRightWidth),
    bottom: cssNumber(style.borderBottomWidth),
    left: cssNumber(style.borderLeftWidth),
  };
  const padding = {
    top: cssNumber(style.paddingTop),
    right: cssNumber(style.paddingRight),
    bottom: cssNumber(style.paddingBottom),
    left: cssNumber(style.paddingLeft),
  };
  const margin = {
    top: cssNumber(style.marginTop),
    right: cssNumber(style.marginRight),
    bottom: cssNumber(style.marginBottom),
    left: cssNumber(style.marginLeft),
  };
  return {
    content: insetQuad(
      rect,
      border.top + padding.top,
      border.right + padding.right,
      border.bottom + padding.bottom,
      border.left + padding.left,
    ),
    padding: insetQuad(rect, border.top, border.right, border.bottom, border.left),
    border: insetQuad(rect, 0, 0, 0, 0),
    margin: insetQuad(rect, -margin.top, -margin.right, -margin.bottom, -margin.left),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function boxModelForNode(node: Node): Protocol.DOM.BoxModel {
  if (!node.isConnected) throw new Error("Could not compute box model.");
  if (node instanceof Text) {
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      throw new Error("Could not compute box model.");
    }
    const quad = insetQuad(rect, 0, 0, 0, 0);
    return {
      content: quad,
      padding: [...quad],
      border: [...quad],
      margin: [...quad],
      width: Math.ceil(rect.right) - Math.floor(rect.left),
      height: Math.ceil(rect.bottom) - Math.floor(rect.top),
    };
  }
  if (!(node instanceof Element) || getComputedStyle(node).display === "none") {
    throw new Error("Could not compute box model.");
  }
  return boxModel(node);
}

export class FrameBackend {
  readonly backendNodes: DomRegistry;
  private readonly sessions = new Map<string, FrameSession>();
  private readonly consoleBacklog: ConsoleRecord[] = [];
  private readonly send: FrameBackendOptions["send"];
  private readonly navigatePage: (url: string) => void;
  private readonly reloadPage: () => void;
  private readonly persistNavigationLoaderId: boolean;
  private readonly onDomContentLoaded = (): void => {
    this.recordPageLifecycle("Page.domContentEventFired");
  };
  private readonly onLoad = (): void => {
    this.recordPageLifecycle("Page.loadEventFired");
  };
  private readonly onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) this.recordPageNavigation("BackForwardCacheRestore");
  };
  private historyApiNavigationUrl: string | undefined;
  private pageNavigateFragmentUrl: string | undefined;
  private pendingPageNavigationLoaderId: string | undefined;
  private sameDocumentNavigation: { type: SameDocumentNavigationType; url: string } | undefined;
  private readonly pageLifecycleJournal = new Map<PageLifecycleMethod, number>();
  private readonly pageDelivery = new Map<string, PageDeliveryState>();
  private pageNavigation: { sequence: number; type: PageNavigationType } = {
    sequence: 1,
    type: "Navigation",
  };
  private domObserver: MutationObserver | undefined;
  private domObservedRoots = new WeakSet<Node>();
  private restoreAttachShadow: (() => void) | undefined;
  private readonly restoreDomMutationBoundaries: Array<() => void> = [];
  private templateContentGetter: ((template: HTMLTemplateElement) => DocumentFragment) | undefined;
  private networkObserver: NetworkObserver | undefined;
  readonly document: Document;
  private loaderId: string;
  private readonly contextId = allocateExecutionContextId();
  private readonly contextUniqueId = allocateUniqueExecutionContextId(this.contextId);
  private readonly objectScope = allocateUniqueExecutionContextId(this.contextId);

  constructor(options: FrameBackendOptions) {
    this.document = options.document;
    this.loaderId = this.takePendingLoaderId();
    this.send = options.send;
    this.persistNavigationLoaderId = options.navigate === undefined;
    this.navigatePage =
      options.navigate ??
      ((url) => {
        if (this.document.defaultView) this.document.defaultView.location.href = url;
      });
    this.reloadPage =
      options.reload ??
      (() => {
        this.document.defaultView?.location.reload();
      });
    this.backendNodes = createDomRegistry();
    this.seedPageLifecycleJournal();
    this.document.addEventListener("DOMContentLoaded", this.onDomContentLoaded);
    this.document.defaultView?.addEventListener("load", this.onLoad);
    this.document.defaultView?.addEventListener("pageshow", this.onPageShow);
    this.observeSameDocumentNavigation();
  }

  attach(
    sessionId: string,
    enabledDomains: Iterable<string>,
    domainParams: Record<string, Record<string, unknown>> = {},
  ): void {
    const session = new FrameSession(sessionId, this);
    this.sessions.set(sessionId, session);
    session.restore(enabledDomains, domainParams);
  }

  detach(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.pageDelivery.delete(sessionId);
    this.reconcileDomObserver();
    this.reconcileNetworkObserver();
  }

  clearSessions(): void {
    this.sessions.clear();
    this.reconcileDomObserver();
    this.reconcileNetworkObserver();
  }

  consoleAPICalled(type: string, args: unknown[]): void {
    const record = { type, args, timestamp: Date.now() };
    this.consoleBacklog.push(record);
    if (this.consoleBacklog.length > 200) this.consoleBacklog.shift();
    for (const session of this.sessions.values()) session.consoleAPICalled(record);
  }

  replayConsole(session: FrameSession): void {
    for (const record of this.consoleBacklog) session.consoleAPICalled(record);
  }

  emit(sessionId: string, method: string, params: Record<string, unknown>): void {
    this.send({ kind: "event", sessionId, method, params });
  }

  pageDomainEnabled(session: FrameSession): void {
    const delivery = this.pageDeliveryFor(session.id);
    delivery.navigationSequence = this.pageNavigation.sequence;
    for (const method of this.pageLifecycleJournal.keys()) {
      delivery.lifecycle.add(method);
    }
  }

  pageDomainRestoringBeforeContext(session: FrameSession): void {
    const delivery = this.pageDeliveryFor(session.id);
    if (
      delivery.navigationSequence < this.pageNavigation.sequence &&
      this.pageNavigation.type === "Navigation"
    ) {
      session.pageFrameNavigated(this.pageNavigation.type);
      delivery.navigationSequence = this.pageNavigation.sequence;
    }
  }

  pageDomainRestoringAfterContext(session: FrameSession): void {
    const delivery = this.pageDeliveryFor(session.id);
    if (delivery.navigationSequence < this.pageNavigation.sequence) {
      session.pageFrameNavigated(this.pageNavigation.type);
      delivery.navigationSequence = this.pageNavigation.sequence;
    }
    for (const method of PAGE_LIFECYCLE_ORDER) {
      const timestamp = this.pageLifecycleJournal.get(method);
      if (timestamp === undefined || delivery.lifecycle.has(method)) continue;
      session.pageLifecycleEvent(method, timestamp);
      delivery.lifecycle.add(method);
    }
  }

  private recordPageLifecycle(method: PageLifecycleMethod, timestamp = this.monotonicTime()): void {
    if (this.pageLifecycleJournal.has(method)) return;
    this.pageLifecycleJournal.set(method, timestamp);
    for (const session of this.sessions.values()) {
      if (!session.domainEnabled("Page")) continue;
      const delivery = this.pageDeliveryFor(session.id);
      if (delivery.lifecycle.has(method)) continue;
      session.pageLifecycleEvent(method, timestamp);
      delivery.lifecycle.add(method);
    }
  }

  private recordPageNavigation(type: PageNavigationType): void {
    this.pageNavigation = {
      sequence: this.pageNavigation.sequence + 1,
      type,
    };
    // A persisted pageshow immediately starts the Frame-Agent/Host handshake.
    // Journal the navigation for the restored channel instead of racing an
    // event over the port that the Host is about to replace.
  }

  private observeSameDocumentNavigation(): void {
    const navigation = (
      this.document.defaultView as
        | (Window & {
            navigation?: EventTarget & {
              currentEntry?: { sameDocument?: boolean; url?: string | null };
            };
          })
        | null
    )?.navigation;
    if (!navigation) return;
    const history = this.document.defaultView!.history;
    const markHistoryApiNavigation = (url: string | URL | null | undefined): string => {
      const href = url == null ? this.document.URL : new URL(String(url), this.document.URL).href;
      this.historyApiNavigationUrl = href;
      return href;
    };
    const clearHistoryApiNavigation = (href: string): void => {
      if (this.historyApiNavigationUrl === href) {
        this.historyApiNavigationUrl = undefined;
      }
    };
    const emitSameDocumentNavigation = (
      navigationType: SameDocumentNavigationType,
      url: string,
    ): void => {
      for (const session of this.sessions.values()) {
        session.pageNavigatedWithinDocument(navigationType, url);
      }
    };
    const wrapHistoryMethod = <T extends "pushState" | "replaceState">(method: T): void => {
      const original = history[method];
      history[method] = function (
        this: History,
        data: unknown,
        unused: string,
        url?: string | URL | null,
      ): void {
        const href = markHistoryApiNavigation(url);
        try {
          Reflect.apply(original, this, [data, unused, url]);
        } catch (error) {
          clearHistoryApiNavigation(href);
          throw error;
        }
        emitSameDocumentNavigation("historyApi", href);
        queueMicrotask(() => clearHistoryApiNavigation(href));
      } as History[T];
    };
    wrapHistoryMethod("pushState");
    wrapHistoryMethod("replaceState");
    navigation.addEventListener("navigate", (rawEvent) => {
      const event = rawEvent as Event & {
        destination?: { sameDocument?: boolean; url?: string };
        hashChange?: boolean;
        navigationType?: string;
      };
      if (!event.destination?.url) return;
      const pageNavigateFragment = this.pageNavigateFragmentUrl === event.destination.url;
      this.pageNavigateFragmentUrl = undefined;
      const historyApiNavigation = this.historyApiNavigationUrl === event.destination.url;
      this.historyApiNavigationUrl = undefined;
      if (historyApiNavigation) return;
      const type =
        pageNavigateFragment || event.hashChange || event.navigationType === "traverse"
          ? "fragment"
          : event.destination.sameDocument
            ? "fragment"
            : "other";
      this.sameDocumentNavigation = { type, url: event.destination.url };
    });
    navigation.addEventListener("navigatesuccess", () => {
      if (!this.sameDocumentNavigation) return;
      const { type, url } = this.sameDocumentNavigation;
      this.sameDocumentNavigation = undefined;
      if (navigation.currentEntry?.url !== url) return;
      this.clearPendingLoaderId();
      emitSameDocumentNavigation(type, url);
    });
    navigation.addEventListener("navigateerror", () => {
      this.pageNavigateFragmentUrl = undefined;
      this.sameDocumentNavigation = undefined;
      this.clearPendingLoaderId();
    });
  }

  private takePendingLoaderId(): string {
    try {
      const storage = this.document.defaultView?.sessionStorage;
      const loaderId = storage?.getItem(PENDING_LOADER_ID_KEY);
      storage?.removeItem(PENDING_LOADER_ID_KEY);
      if (loaderId?.startsWith("icdp-loader-")) return loaderId;
    } catch {}
    return allocateLoaderId();
  }

  private rememberPendingLoaderId(loaderId: string): void {
    this.pendingPageNavigationLoaderId = loaderId;
    try {
      this.document.defaultView?.sessionStorage.setItem(PENDING_LOADER_ID_KEY, loaderId);
    } catch {}
  }

  private clearPendingLoaderId(): void {
    const loaderId = this.pendingPageNavigationLoaderId;
    this.pendingPageNavigationLoaderId = undefined;
    if (!loaderId) return;
    try {
      const storage = this.document.defaultView?.sessionStorage;
      if (storage?.getItem(PENDING_LOADER_ID_KEY) === loaderId) {
        storage.removeItem(PENDING_LOADER_ID_KEY);
      }
    } catch {}
  }

  private pageDeliveryFor(sessionId: string): PageDeliveryState {
    let delivery = this.pageDelivery.get(sessionId);
    if (!delivery) {
      delivery = { lifecycle: new Set(), navigationSequence: 0 };
      this.pageDelivery.set(sessionId, delivery);
    }
    return delivery;
  }

  private seedPageLifecycleJournal(): void {
    const performance = this.document.defaultView?.performance as
      | (Performance & {
          getEntriesByType?: (type: string) => PerformanceEntry[];
        })
      | undefined;
    const navigation = performance?.getEntriesByType?.("navigation")[0] as
      | Partial<PerformanceNavigationTiming>
      | undefined;
    if (performance && navigation && Number(navigation.domContentLoadedEventStart) > 0) {
      this.pageLifecycleJournal.set(
        "Page.domContentEventFired",
        cdpMonotonicTime(performance, Number(navigation.domContentLoadedEventStart)),
      );
    }
    if (performance && navigation && Number(navigation.loadEventStart) > 0) {
      this.pageLifecycleJournal.set(
        "Page.loadEventFired",
        cdpMonotonicTime(performance, Number(navigation.loadEventStart)),
      );
    }
  }

  reconcileDomObserver(): void {
    const enabled = Array.from(this.sessions.values()).some((session) =>
      session.domainEnabled("DOM"),
    );
    if (!enabled) {
      this.domObserver?.disconnect();
      this.domObserver = undefined;
      this.domObservedRoots = new WeakSet();
      this.restoreAttachShadow?.();
      this.restoreAttachShadow = undefined;
      for (const restore of this.restoreDomMutationBoundaries.splice(0).toReversed()) restore();
      this.templateContentGetter = undefined;
      return;
    }
    if (this.domObserver) {
      this.observeOpenShadowRoots(this.document);
      return;
    }
    const view = this.document.defaultView;
    if (!view) throw new Error("DOM observation is unavailable");
    this.domObserver = new view.MutationObserver((records) => this.deliverDomMutations(records));
    this.installDomMutationBoundaries(view);
    this.observeOpenShadowRoots(this.document);
    const prototype = view.Element.prototype;
    const original = prototype.attachShadow;
    const flushDomMutations = (): void => this.flushDomMutations();
    const observeOpenRoot = (root: ShadowRoot): void => {
      for (const session of this.sessions.values()) {
        session.domShadowRootPushed(root.host, root);
      }
      this.observeOpenShadowRoots(root);
    };
    const wrapped = function (this: Element, init: ShadowRootInit): ShadowRoot {
      flushDomMutations();
      const root = original.call(this, init);
      if (root.mode === "open") observeOpenRoot(root);
      return root;
    };
    try {
      prototype.attachShadow = wrapped;
      this.restoreAttachShadow = () => {
        if (prototype.attachShadow === wrapped) prototype.attachShadow = original;
      };
    } catch {
      // Existing open roots are still observed; a frozen prototype only means
      // roots attached later cannot be discovered until they are serialized.
    }
  }

  private deliverDomMutations(records: MutationRecord[]): void {
    if (records.length === 0) return;
    const view = this.document.defaultView;
    if (!view) return;
    for (const record of records) {
      for (const added of Array.from(record.addedNodes)) {
        if (added instanceof view.Element) this.observeOpenShadowRoots(added);
      }
    }
    for (const session of this.sessions.values()) {
      session.domMutations(records);
    }
  }

  private flushDomMutations(): void {
    const records = this.domObserver?.takeRecords();
    if (records?.length) this.deliverDomMutations(records);
  }

  private installDomMutationBoundaries(view: Window & typeof globalThis): void {
    const templatePrototype = view.HTMLTemplateElement.prototype;
    const contentDescriptor = Object.getOwnPropertyDescriptor(templatePrototype, "content");
    const rawContentGetter = contentDescriptor?.get;
    if (rawContentGetter) {
      this.templateContentGetter = (template) =>
        Reflect.apply(rawContentGetter, template, []) as DocumentFragment;
    }

    let innerHtmlPrototype: object | null = templatePrototype;
    let innerHtmlDescriptor: PropertyDescriptor | undefined;
    while (innerHtmlPrototype && !innerHtmlDescriptor) {
      innerHtmlDescriptor = Object.getOwnPropertyDescriptor(innerHtmlPrototype, "innerHTML");
      innerHtmlPrototype = Object.getPrototypeOf(innerHtmlPrototype) as object | null;
    }
    const previousOwnInnerHtml = Object.getOwnPropertyDescriptor(templatePrototype, "innerHTML");
    const rawInnerHtmlGetter = innerHtmlDescriptor?.get;
    const rawInnerHtmlSetter = innerHtmlDescriptor?.set;
    const flushDomMutations = (): void => this.flushDomMutations();
    const observeRoot = (root: DocumentFragment): void => this.observeOpenShadowRoots(root);
    const templateContent = (template: HTMLTemplateElement): DocumentFragment =>
      this.templateContent(template);

    if (rawContentGetter && contentDescriptor) {
      const wrappedContentGetter = function (this: HTMLTemplateElement): DocumentFragment {
        const content = Reflect.apply(rawContentGetter, this, []) as DocumentFragment;
        flushDomMutations();
        observeRoot(content);
        return content;
      };
      try {
        Object.defineProperty(templatePrototype, "content", {
          ...contentDescriptor,
          get: wrappedContentGetter,
        });
        this.restoreDomMutationBoundaries.push(() => {
          const current = Object.getOwnPropertyDescriptor(templatePrototype, "content");
          if (current?.get === wrappedContentGetter) {
            Object.defineProperty(templatePrototype, "content", contentDescriptor);
          }
        });
      } catch {}
    }

    if (rawInnerHtmlGetter && rawInnerHtmlSetter) {
      const wrappedInnerHtmlSetter = function (this: HTMLTemplateElement, value: string): void {
        flushDomMutations();
        const content = templateContent(this);
        observeRoot(content);
        Reflect.apply(rawInnerHtmlSetter, this, [value]);
      };
      try {
        Object.defineProperty(templatePrototype, "innerHTML", {
          configurable: innerHtmlDescriptor?.configurable ?? true,
          enumerable: innerHtmlDescriptor?.enumerable ?? true,
          get(this: HTMLTemplateElement) {
            return Reflect.apply(rawInnerHtmlGetter, this, []) as string;
          },
          set: wrappedInnerHtmlSetter,
        });
        this.restoreDomMutationBoundaries.push(() => {
          const current = Object.getOwnPropertyDescriptor(templatePrototype, "innerHTML");
          if (current?.set !== wrappedInnerHtmlSetter) return;
          if (previousOwnInnerHtml) {
            Object.defineProperty(templatePrototype, "innerHTML", previousOwnInnerHtml);
          } else {
            delete (templatePrototype as unknown as Record<string, unknown>).innerHTML;
          }
        });
      } catch {}
    }

    const patchFlushBoundary = (prototype: object, name: string): void => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      const original = descriptor?.value;
      if (typeof original !== "function" || !descriptor) return;
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        flushDomMutations();
        return Reflect.apply(original, this, args);
      };
      try {
        Object.defineProperty(prototype, name, { ...descriptor, value: wrapped });
        this.restoreDomMutationBoundaries.push(() => {
          const current = Object.getOwnPropertyDescriptor(prototype, name);
          if (current?.value === wrapped) Object.defineProperty(prototype, name, descriptor);
        });
      } catch {}
    };
    for (const name of [
      "removeAttribute",
      "removeAttributeNS",
      "removeAttributeNode",
      "toggleAttribute",
    ]) {
      patchFlushBoundary(view.Element.prototype, name);
    }
    for (const name of ["removeNamedItem", "removeNamedItemNS"]) {
      patchFlushBoundary(view.NamedNodeMap.prototype, name);
    }
  }

  templateContent(template: HTMLTemplateElement): DocumentFragment {
    return this.templateContentGetter?.(template) ?? template.content;
  }

  private observeOpenShadowRoots(root: Document | DocumentFragment | Element): void {
    if (!this.domObserver) return;
    if (
      (root instanceof Document || root instanceof DocumentFragment) &&
      !this.domObservedRoots.has(root)
    ) {
      this.domObservedRoots.add(root);
      this.domObserver.observe(root, {
        attributes: true,
        attributeOldValue: true,
        characterData: true,
        characterDataOldValue: true,
        childList: true,
        subtree: true,
      });
    }
    const elements =
      root instanceof Element
        ? [root, ...Array.from(root.querySelectorAll("*"))]
        : Array.from(root.querySelectorAll("*"));
    for (const element of elements) {
      if (element.shadowRoot?.mode === "open") {
        this.observeOpenShadowRoots(element.shadowRoot);
      }
      if (element instanceof HTMLTemplateElement) {
        this.observeOpenShadowRoots(this.templateContent(element));
      }
    }
  }

  reconcileNetworkObserver(): void {
    const enabled = Array.from(this.sessions.values()).some((session) =>
      session.domainEnabled("Network"),
    );
    if (!enabled) {
      this.networkObserver?.uninstall();
      this.networkObserver = undefined;
      return;
    }
    if (this.networkObserver) return;
    const view = this.document.defaultView;
    if (!view) throw new Error("Network inspection is unavailable");
    this.networkObserver = new NetworkObserver(
      view,
      (method, params) => {
        for (const session of this.sessions.values()) {
          session.networkEvent(method, params);
        }
      },
      { loaderId: () => this.currentLoaderId() },
    );
    this.networkObserver.install();
  }

  getResponseBody(requestId: Protocol.Network.RequestId): Protocol.Network.GetResponseBodyResponse {
    if (!this.networkObserver) throw new Error("Network has not been enabled");
    return this.networkObserver.getResponseBody(requestId);
  }

  monotonicTime(): number {
    const performance = this.document.defaultView?.performance;
    return performance ? cdpMonotonicTime(performance) : Number.EPSILON;
  }

  currentLoaderId(): string {
    return this.loaderId;
  }

  executionContext(): Protocol.Runtime.ExecutionContextDescription {
    const view = this.document.defaultView;
    return {
      id: this.contextId,
      uniqueId: this.contextUniqueId,
      origin: view?.location.origin ?? "",
      name: "",
      auxData: {
        isDefault: true,
        type: "default",
        frameId: "icdp-frame",
      },
    };
  }

  remoteObjectScope(): string {
    return this.objectScope;
  }

  navigate(url: string): string | undefined {
    const current = new URL(this.document.URL);
    const next = new URL(url);
    current.hash = "";
    next.hash = "";
    const sameDocument = url.includes("#") && current.href === next.href;
    const loaderId = sameDocument ? undefined : allocateLoaderId();
    this.pageNavigateFragmentUrl = sameDocument ? url : undefined;
    if (loaderId && this.persistNavigationLoaderId) this.rememberPendingLoaderId(loaderId);
    try {
      this.navigatePage(url);
    } catch (error) {
      this.pageNavigateFragmentUrl = undefined;
      this.clearPendingLoaderId();
      throw error;
    }
    return loaderId;
  }

  reload(): void {
    this.reloadPage();
  }

  pageFrame(): Protocol.Page.Frame {
    const view = this.document.defaultView;
    const documentUrl = this.document.URL;
    const url = new URL(documentUrl);
    const fragmentStart = documentUrl.indexOf("#");
    const urlFragment = fragmentStart < 0 ? undefined : documentUrl.slice(fragmentStart);
    url.hash = "";
    const trustworthyOrigin =
      url.protocol === "https:" ||
      url.protocol === "wss:" ||
      (view !== null && isLocalhost(view.location.hostname));
    const localhost = view !== null && isLocalhost(view.location.hostname);
    return {
      id: "icdp-frame",
      loaderId: this.loaderId,
      url: url.href,
      ...(urlFragment === undefined ? {} : { urlFragment }),
      domainAndRegistry: "",
      securityOrigin: url.protocol === "data:" ? "://" : (view?.location.origin ?? ""),
      securityOriginDetails: { isLocalhost: localhost },
      mimeType: this.document.contentType || "text/html",
      secureContextType: view?.isSecureContext
        ? isLocalhost(view.location.hostname)
          ? "SecureLocalhost"
          : "Secure"
        : trustworthyOrigin
          ? "InsecureAncestor"
          : "InsecureScheme",
      crossOriginIsolatedContextType: view?.crossOriginIsolated ? "Isolated" : "NotIsolated",
      gatedAPIFeatures: [],
    };
  }

  async command(command: FrameCommand): Promise<void> {
    const session = this.sessions.get(command.sessionId);
    if (!session) {
      this.send({
        kind: "response",
        sessionId: command.sessionId,
        id: command.id,
        error: { code: CDP_SERVER_ERROR, message: "Session not found" },
      });
      return;
    }

    try {
      const result = await session.dispatch(command.method, command.params);
      this.send({
        kind: "response",
        sessionId: command.sessionId,
        id: command.id,
        result: result ?? {},
      });
    } catch (error) {
      const data =
        typeof error === "object" && error !== null && "data" in error ? error.data : undefined;
      this.send({
        kind: "response",
        sessionId: command.sessionId,
        id: command.id,
        error: {
          code:
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "number"
              ? error.code
              : CDP_SERVER_ERROR,
          message: error instanceof Error ? error.message : String(error),
          ...(data === undefined ? {} : { data }),
        },
      });
    }
  }
}
