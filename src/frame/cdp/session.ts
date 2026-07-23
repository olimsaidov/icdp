import type Protocol from "devtools-protocol";

import { validateCdpParams, type CdpParamSchema } from "../../cdp-dispatch.ts";
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

function allocateLoaderId(): string {
  return `icdp-loader-${Math.random().toString(36).slice(2)}`;
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

function protocolError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
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

function validCallArguments(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((argument) => {
    if (typeof argument !== "object" || argument === null || Array.isArray(argument)) {
      return false;
    }
    const record = argument as Record<string, unknown>;
    if (record.objectId !== undefined && typeof record.objectId !== "string") {
      return false;
    }
    if (
      record.unserializableValue !== undefined &&
      typeof record.unserializableValue !== "string"
    ) {
      return false;
    }
    return !Object.prototype.hasOwnProperty.call(record, "value") || isProtocolValue(record.value);
  });
}

class FrameSession {
  readonly nodes: SessionNodeRegistry;
  readonly enabledDomains = new Set<string>();
  private pressedElement: Element | undefined;
  private hoveredElement: Element | undefined;
  private lastClickElement: Element | undefined;
  private lastClickTime = 0;
  private objects = new RemoteObjectStore();
  private nextExceptionId = 1;
  private includeWhitespace = false;
  private readonly networkRequestIds = new Set<string>();

  constructor(
    readonly id: string,
    private readonly backend: FrameBackend,
  ) {
    this.nodes = new SessionNodeRegistry(backend.backendNodes);
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
    const paramError = validateCdpParams(params, FRAME_PARAM_SCHEMAS[method]);
    if (paramError) throw protocolError(paramError.code, paramError.message);
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
    if (method === "DOM.describeNode") {
      const node = this.resolveNode(params);
      return {
        node: this.serializeNode(node, Number(params.depth ?? 0), Boolean(params.pierce), false),
      } satisfies Protocol.DOM.DescribeNodeResponse;
    }
    if (method === "DOM.getBoxModel") {
      const node = this.resolveNode(params);
      const element = node instanceof Element ? node : node.parentElement;
      if (!element) throw new Error("Could not compute box model.");
      return { model: boxModel(element) } satisfies Protocol.DOM.GetBoxModelResponse;
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
      this.objects = new RemoteObjectStore();
      return {};
    }
    if (method === "Runtime.runIfWaitingForDebugger") return {};
    if (method === "Runtime.evaluate") {
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
      if (!validCallArguments(params.arguments)) {
        throw protocolError(CDP_INVALID_PARAMS, "Invalid parameters");
      }
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
    for (const record of records) {
      const nodeId = this.nodes.idForNode(record.target);
      if (record.type === "attributes") {
        if (nodeId === 0 || !record.attributeName) continue;
        const element = record.target as Element;
        const value = element.getAttribute(record.attributeName);
        if (value === null) {
          this.emit("DOM.attributeRemoved", {
            nodeId,
            name: record.attributeName,
          });
        } else {
          this.emit("DOM.attributeModified", {
            nodeId,
            name: record.attributeName,
            value,
          });
        }
        continue;
      }
      if (record.type === "characterData") {
        if (nodeId !== 0) {
          this.emit("DOM.characterDataModified", {
            nodeId,
            characterData: record.target.nodeValue ?? "",
          });
        }
        continue;
      }
      if (nodeId === 0) continue;
      if (!this.nodes.childrenWereRequested(record.target)) {
        for (const removed of Array.from(record.removedNodes)) {
          this.nodes.unbindSubtree(removed);
        }
        const visibleChange =
          Array.from(record.removedNodes).some((node) => this.nodeIsVisible(node)) ||
          Array.from(record.addedNodes).some((node) => this.nodeIsVisible(node));
        if (visibleChange) {
          this.emit("DOM.childNodeCountUpdated", {
            nodeId,
            childNodeCount: this.visibleChildren(record.target).length,
          });
        }
        continue;
      }
      for (const removed of Array.from(record.removedNodes)) {
        if (!this.nodeIsVisible(removed)) {
          this.nodes.unbindSubtree(removed);
          continue;
        }
        const removedNodeId = this.nodes.idForNode(removed);
        if (removedNodeId !== 0) {
          this.emit("DOM.childNodeRemoved", {
            parentNodeId: nodeId,
            nodeId: removedNodeId,
          });
        }
        this.nodes.unbindSubtree(removed);
      }
      for (const added of Array.from(record.addedNodes)) {
        if (!this.nodeIsVisible(added)) continue;
        const previous = this.previousVisibleSibling(added);
        this.emit("DOM.childNodeInserted", {
          parentNodeId: nodeId,
          previousNodeId: previous ? this.nodes.idForNode(previous) : 0,
          node: this.serializeNode(added, 0, false),
        });
      }
    }
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
      const charCode = type === "char" ? Array.from(text)[0]?.codePointAt(0) : undefined;
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
      target?.dispatchEvent(keyboardEvent("keydown"));
      if (init.key === "Backspace") deleteBackward(document);
      if (type === "keyDown" && typeof params.text === "string" && params.text) {
        insertText(document, params.text);
      }
    } else if (type === "keyUp") {
      target?.dispatchEvent(keyboardEvent("keyup"));
    } else {
      target?.dispatchEvent(keyboardEvent("keypress"));
      if (typeof params.text === "string" && params.text) {
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
    const target =
      document.elementFromPoint(Number(params.x), Number(params.y)) ?? document.documentElement;
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
      pointerId: 1,
      pointerType,
      pressure: Number(params.force ?? 0),
      tangentialPressure: Number(params.tangentialPressure ?? 0),
      tiltX: Number(params.tiltX ?? 0),
      tiltY: Number(params.tiltY ?? 0),
      twist: Number(params.twist ?? 0),
      isPrimary: true,
    };
    const dispatchPointer = (element: Element, eventType: string, bubbles = true): void => {
      element.dispatchEvent(new view.PointerEvent(eventType, { ...pointerInit, bubbles }));
    };
    if (type === "mouseMoved") {
      if (this.hoveredElement !== target) {
        if (this.hoveredElement) {
          dispatchPointer(this.hoveredElement, "pointerout");
          dispatchPointer(this.hoveredElement, "pointerleave", false);
        }
        this.hoveredElement?.dispatchEvent(new view.MouseEvent("mouseout", init));
        this.hoveredElement?.dispatchEvent(
          new view.MouseEvent("mouseleave", { ...init, bubbles: false }),
        );
        dispatchPointer(target, "pointerover");
        dispatchPointer(target, "pointerenter", false);
        target.dispatchEvent(new view.MouseEvent("mouseover", init));
        target.dispatchEvent(new view.MouseEvent("mouseenter", { ...init, bubbles: false }));
        this.hoveredElement = target;
      }
      dispatchPointer(target, "pointermove");
      target.dispatchEvent(new view.MouseEvent("mousemove", init));
      return;
    }
    if (type === "mousePressed") {
      this.pressedElement = target;
      dispatchPointer(target, "pointerdown");
      target.dispatchEvent(new view.MouseEvent("mousedown", init));
      if (buttonName === "right") {
        target.dispatchEvent(new view.MouseEvent("contextmenu", init));
      }
      return;
    }
    if (type === "mouseReleased") {
      dispatchPointer(target, "pointerup");
      target.dispatchEvent(new view.MouseEvent("mouseup", init));
      if (this.pressedElement === target) {
        if (buttonName === "left") {
          (target as HTMLElement).click();
        } else if (buttonName !== "none" && buttonName !== "right") {
          target.dispatchEvent(new view.MouseEvent("auxclick", init));
        }
        const now = Date.now();
        if (
          (buttonName === "left" && Number(params.clickCount ?? 1) > 1) ||
          (buttonName === "left" &&
            this.lastClickElement === target &&
            now - this.lastClickTime < 500)
        ) {
          target.dispatchEvent(new view.MouseEvent("dblclick", init));
        }
        if (buttonName === "left") {
          this.lastClickElement = target;
          this.lastClickTime = now;
        }
      }
      this.pressedElement = undefined;
      return;
    }
    if (type === "mouseWheel") {
      target.dispatchEvent(
        new view.WheelEvent("wheel", {
          ...init,
          deltaX: Number(params.deltaX ?? 0),
          deltaY: Number(params.deltaY ?? 0),
        }),
      );
      const scroller = scrollableAncestor(target);
      scroller?.scrollBy?.(Number(params.deltaX ?? 0), Number(params.deltaY ?? 0));
      return;
    }
    throw protocolError(CDP_INVALID_PARAMS, "Invalid parameters");
  }

  private validateExecutionContext(params: Record<string, unknown>): void {
    if (params.contextId !== undefined && params.uniqueContextId !== undefined) {
      throw protocolError(CDP_INVALID_PARAMS, "Invalid parameters");
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
      throw new Error("Cannot find unique context with specified id");
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
    this.validateExecutionContext({
      contextId: params.contextId,
      uniqueContextId: params.uniqueContextId,
    });
    if (params.throwOnSideEffect) {
      return this.exceptionResult(new EvalError("Possible side-effect in debug-evaluate"), params);
    }
    let settled: unknown;
    try {
      const view = this.backend.document.defaultView;
      if (!view) throw new Error("Execution context is unavailable");
      const value = view.eval(String(params.expression));
      settled = params.awaitPromise ? await value : value;
    } catch (error) {
      return this.exceptionResult(error, params);
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
    this.rejectPresentOptions(params, ["serializationOptions"]);
    this.rejectTruthyOptions(params, ["silent", "generatePreview", "userGesture"]);
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

    if (params.throwOnSideEffect) {
      return this.exceptionResult(new EvalError("Possible side-effect in debug-evaluate"), params);
    }
    let candidate: unknown;
    try {
      candidate = view.eval(`(${String(params.functionDeclaration)})`);
    } catch (error) {
      return this.exceptionResult(error, params);
    }
    if (typeof candidate !== "function") {
      throw new Error("Given expression does not evaluate to a function");
    }
    let settled: unknown;
    try {
      const fn = candidate as (this: unknown, ...args: unknown[]) => unknown;
      const value = fn.apply(target, args);
      settled = params.awaitPromise ? await value : value;
    } catch (error) {
      return this.exceptionResult(error, params);
    }
    const inheritedGroup =
      params.objectGroup ??
      (params.objectId !== undefined
        ? this.objects.objectGroupName(String(params.objectId))
        : undefined);
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
  ): Protocol.Runtime.EvaluateResponse {
    const result = this.objects.wrap(error, {
      objectGroup: params.objectGroup as string | undefined,
    });
    return {
      result,
      exceptionDetails: {
        exceptionId: this.nextExceptionId++,
        text: "Uncaught",
        lineNumber: 0,
        columnNumber: 0,
        executionContextId: this.backend.executionContext().id,
        exception: result,
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
    if (ancestry.at(-1) !== this.backend.document) return 0;

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

  private serializeNode(
    node: Node,
    depth: number,
    pierce: boolean,
    bind = true,
  ): Protocol.DOM.Node {
    const nodeId = bind ? this.nodes.bind(node) : this.nodes.idForNode(node);
    const result: Protocol.DOM.Node = {
      nodeId,
      backendNodeId: this.nodes.backendIdFor(node),
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      localName: node instanceof Element ? node.localName : "",
      nodeValue: node.nodeValue ?? "",
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
        result.templateContent = this.serializeNode(node.content, 0, pierce, bind);
      }
    }

    const children = this.visibleChildren(node);
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
      (node.nodeValue ?? "").trim() !== ""
    );
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

function textControl(document: Document): HTMLInputElement | HTMLTextAreaElement | undefined {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return active;
  if (
    active instanceof HTMLInputElement &&
    ["", "text", "search", "tel", "url", "password", "email"].includes(active.type)
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

function insertText(document: Document, text: string): void {
  const control = textControl(document);
  if (control) {
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? control.value.length;
    setNativeValue(control, `${control.value.slice(0, start)}${text}${control.value.slice(end)}`);
    try {
      control.setSelectionRange(start + text.length, start + text.length);
    } catch {
      // Email and some other text-like input types do not expose a selection
      // range even though Chromium can insert text into them.
    }
    control.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: text,
        inputType: "insertText",
      }),
    );
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isContentEditable) {
    document.execCommand("insertText", false, text);
  }
}

function deleteBackward(document: Document): void {
  const control = textControl(document);
  if (control) {
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? control.value.length;
    if (start === 0 && end === 0) return;
    const nextStart = start === end ? Math.max(0, start - 1) : start;
    setNativeValue(control, `${control.value.slice(0, nextStart)}${control.value.slice(end)}`);
    try {
      control.setSelectionRange(nextStart, nextStart);
    } catch {
      // See insertText: some text-like input types have no selection API.
    }
    control.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "deleteContentBackward",
      }),
    );
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isContentEditable) {
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
  private networkObserver: NetworkObserver | undefined;
  readonly document: Document;
  private loaderId: string;
  private readonly contextId = allocateExecutionContextId();
  private readonly contextUniqueId = `icdp-context-${Math.random().toString(36).slice(2)}`;

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
      if (!navigation.currentEntry?.sameDocument || navigation.currentEntry.url !== url) return;
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
      return;
    }
    if (this.domObserver) {
      this.observeOpenShadowRoots(this.document);
      return;
    }
    const view = this.document.defaultView;
    if (!view) throw new Error("DOM observation is unavailable");
    this.domObserver = new view.MutationObserver((records) => {
      for (const record of records) {
        for (const added of Array.from(record.addedNodes)) {
          if (added instanceof view.Element) this.observeOpenShadowRoots(added);
        }
      }
      for (const session of this.sessions.values()) {
        session.domMutations(records);
      }
    });
    this.observeOpenShadowRoots(this.document);
    const prototype = view.Element.prototype;
    const original = prototype.attachShadow;
    const observeOpenRoot = (root: ShadowRoot): void => this.observeOpenShadowRoots(root);
    const wrapped = function (this: Element, init: ShadowRootInit): ShadowRoot {
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

  private observeOpenShadowRoots(root: Document | ShadowRoot | Element): void {
    if (!this.domObserver) return;
    if (
      (root instanceof Document || root instanceof ShadowRoot) &&
      !this.domObservedRoots.has(root)
    ) {
      this.domObservedRoots.add(root);
      this.domObserver.observe(root, {
        attributes: true,
        characterData: true,
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
    return {
      id: "icdp-frame",
      loaderId: this.loaderId,
      url: this.document.URL,
      domainAndRegistry: "",
      securityOrigin: view?.location.origin ?? "",
      mimeType: this.document.contentType || "text/html",
      secureContextType: view?.isSecureContext ? "Secure" : "InsecureScheme",
      crossOriginIsolatedContextType: "NotIsolated",
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
        },
      });
    }
  }
}
