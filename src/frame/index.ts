import chobitsu from "chobitsu";
import type Protocol from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";

import {
  CDP_SERVER_ERROR,
  type CdpId,
  type HandshakeMessage,
  isHandshakeMessage,
  PROTOCOL_VERSION,
} from "../protocol.ts";
import { createDomRegistry, getFullAXTree, getPartialAXTree } from "./ax-tree.ts";

type CdpMethod = keyof ProtocolMapping.Commands;
type CdpParams<Method extends CdpMethod> = NonNullable<ProtocolMapping.Commands[Method]["paramsType"][0]>;

type CdpRequest = {
  id?: CdpId;
  method: CdpMethod | string;
  params?: Record<string, any>;
};

type CdpResponse = {
  id?: CdpId;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: Record<string, unknown>;
};
type CdpHandler = (params?: Record<string, any>) => unknown | Promise<unknown>;

// chobitsu's published .d.ts omits register(), but the runtime exposes it.
const cdp = chobitsu as typeof chobitsu & {
  register(domain: string, handlers: Record<string, (params: any) => unknown>): void;
};

export type FrameAgentOptions = {
  /**
   * Origins allowed to act as Host. The agent stays dormant unless the parent
   * matches. "*" hands full DOM read/write/eval to ANY embedder — only use it
   * for pages that are themselves sandboxed or throwaway.
   */
  allowedParents: string[] | "*";
};

const frameId: Protocol.Page.FrameId = "icdp-frame";
const registry = createDomRegistry();
const noop: CdpHandler = () => ({});
let port: MessagePort | null = null;
let nextScriptIdentifier = 1;
let nextSearchId = 1;
const outboundMethods = new Map<CdpId, string>();
const searchResults = new Map<string, Protocol.DOM.BackendNodeId[]>();
let runtimeEnabled = false;
const queuedRuntimeEvents: CdpResponse[] = [];
const consoleWrapped = Symbol("icdp-console-wrapped");
type ConsoleMethod = (...args: unknown[]) => unknown;
let pressedElement: Element | null = null;
let hoveredElement: Element | null = null;
let lastClickElement: Element | null = null;
let lastClickTime = 0;

function sendToHost(message: CdpResponse): void {
  port?.postMessage(JSON.stringify(message));
}

function sendRuntimeEvent(message: CdpResponse): void {
  if (runtimeEnabled) {
    sendToHost(message);
  } else {
    queuedRuntimeEvents.push(message);
    if (queuedRuntimeEvents.length > 200) queuedRuntimeEvents.shift();
  }
}

chobitsu.setOnMessage((raw) => {
  let message: CdpResponse;
  try {
    message = JSON.parse(raw) as CdpResponse;
  } catch {
    return;
  }

  if (message.id != null) {
    const method = outboundMethods.get(message.id);
    outboundMethods.delete(message.id);
    if (method && message.error?.message === `${method} unimplemented`) {
      message.error = { code: CDP_SERVER_ERROR, message: `Method not found: ${method}` };
    } else if (message.error && message.error.code == null) {
      message.error = { ...message.error, code: CDP_SERVER_ERROR };
    }
  }

  sendToHost(message);
});

function elementForBackendId(id: Protocol.DOM.BackendNodeId): Element {
  const node = registry.nodeForBackendId(id);
  const element = node instanceof Element ? node : node?.parentElement;
  if (!element) throw new Error(`No element for backendDOMNodeId=${id}`);
  return element;
}

function boxModel(id: Protocol.DOM.BackendNodeId): Protocol.DOM.GetBoxModelResponse {
  const rect = elementForBackendId(id).getBoundingClientRect();
  const quad = [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom].map(
    Math.round,
  );
  return {
    model: {
      content: quad,
      padding: quad,
      border: quad,
      margin: quad,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function contentQuads(id: Protocol.DOM.BackendNodeId): Protocol.DOM.GetContentQuadsResponse {
  return { quads: [boxModel(id).model.content] };
}

function describeNode(id: Protocol.DOM.BackendNodeId): Protocol.DOM.DescribeNodeResponse {
  const node = registry.nodeForBackendId(id);
  if (!node) throw new Error(`No element for backendDOMNodeId=${id}`);
  return { node: domNode(node, 0) };
}

function attributesFor(el: Element): string[] {
  const attributes: string[] = [];
  for (const attr of el.attributes) attributes.push(attr.name, attr.value);
  return attributes;
}

function childNodesFor(node: Node, depth: number): Protocol.DOM.Node[] {
  if (depth === 0) return [];
  const nextDepth = depth < 0 ? -1 : depth - 1;
  return Array.from(node.childNodes).map((child) => domNode(child, nextDepth));
}

function domNode(node: Node, depth: number): Protocol.DOM.Node {
  const nodeId = registry.backendIdFor(node);
  const children = childNodesFor(node, depth);
  const nodeName =
    node instanceof Element && node.namespaceURI === "http://www.w3.org/1999/xhtml"
      ? node.nodeName.toUpperCase()
      : node.nodeName;
  const result: Protocol.DOM.Node = {
    backendNodeId: nodeId,
    localName: node instanceof Element ? node.localName : "",
    nodeId,
    nodeName,
    nodeType: node.nodeType,
    nodeValue: node.nodeValue ?? "",
  };

  if (node.hasChildNodes()) {
    result.childNodeCount = node.childNodes.length;
    if (depth !== 0) result.children = children;
  }

  if (node instanceof Document) {
    result.documentURL = location.href;
    result.baseURL = document.baseURI;
    result.xmlVersion = "";
  } else if (node instanceof DocumentType) {
    result.publicId = node.publicId;
    result.systemId = node.systemId;
    result.internalSubset = (node as DocumentType & { internalSubset?: string }).internalSubset;
  } else if (node instanceof Element) {
    result.attributes = attributesFor(node);
    if (node instanceof HTMLIFrameElement && node.contentDocument) {
      result.frameId = `${frameId}:${nodeId}`;
      result.contentDocument = domNode(node.contentDocument, depth);
    }
  }

  return result;
}

function runtimeValue(value: unknown): Protocol.Runtime.RemoteObject {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "object", subtype: "null", value: null };
  if (value instanceof Node) return nodeRuntimeValue(value);
  if (typeof value === "bigint") return { type: "bigint", unserializableValue: `${value}n`, description: `${value}n` };
  if (typeof value === "symbol") return { type: "symbol", description: String(value) };
  if (typeof value === "function") return { type: "function", description: String(value) };
  if (typeof value === "number" && !Number.isFinite(value))
    return { type: "number", unserializableValue: String(value), description: String(value) };
  if (typeof value === "object")
    return {
      type: "object",
      value: JSON.parse(JSON.stringify(value)),
      description: Object.prototype.toString.call(value),
    };
  return { type: typeof value, value };
}

function nodeRuntimeValue(node: Node): Protocol.Runtime.RemoteObject {
  const element = node instanceof Element ? node : node.parentElement;
  const objectId = `backend:${registry.backendIdFor(element || node)}`;
  return {
    type: "object",
    subtype: "node",
    className: node instanceof Element ? node.constructor.name : "Node",
    description: node instanceof Element ? node.outerHTML : node.nodeName,
    objectId,
  };
}

function cloneConsoleObject(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= 4) return Object.prototype.toString.call(value);
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (value instanceof Element) {
    return {
      tagName: value.tagName.toLowerCase(),
      id: value.id || undefined,
      className: typeof value.className === "string" && value.className ? value.className : undefined,
      textContent: (value.textContent || "").trim().slice(0, 120) || undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => cloneConsoleObject(item, seen, depth + 1));
  }
  if (value instanceof Map) {
    return {
      entries: Array.from(value.entries())
        .slice(0, 100)
        .map(([key, entryValue]) => [
          cloneConsoleObject(key, seen, depth + 1),
          cloneConsoleObject(entryValue, seen, depth + 1),
        ]),
    };
  }
  if (value instanceof Set) {
    return {
      values: Array.from(value.values())
        .slice(0, 100)
        .map((item) => cloneConsoleObject(item, seen, depth + 1)),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return String(value);

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, entryValue]) => [key, cloneConsoleObject(entryValue, seen, depth + 1)]),
  );
}

function consoleRuntimeValue(value: unknown): Protocol.Runtime.RemoteObject {
  if (value === undefined || value === null || typeof value !== "object") return runtimeValue(value);

  const description =
    value instanceof Error
      ? value.stack || `${value.name}: ${value.message}`
      : value instanceof Element
        ? value.outerHTML
        : Object.prototype.toString.call(value);

  return {
    type: "object",
    subtype:
      value instanceof Error ? "error" : Array.isArray(value) ? "array" : value instanceof Element ? "node" : undefined,
    className: value.constructor?.name,
    description,
    value: cloneConsoleObject(value),
  };
}

function flushQueuedRuntimeEvents(): void {
  while (queuedRuntimeEvents.length) {
    const event = queuedRuntimeEvents.shift();
    if (event) sendToHost(event);
  }
}

function enableRuntime(): Record<string, never> {
  runtimeEnabled = true;
  sendToHost({
    method: "Runtime.executionContextCreated",
    params: {
      context: {
        id: 1,
        name: "top",
        origin: location.origin,
      },
    },
  });
  flushQueuedRuntimeEvents();
  return {};
}

function emitConsole(type: string, args: unknown[]): void {
  sendRuntimeEvent({
    method: "Runtime.consoleAPICalled",
    params: {
      type,
      args: args.map(consoleRuntimeValue),
      executionContextId: 1,
      timestamp: Date.now(),
      stackTrace: { callFrames: [] },
    },
  });
}

function installConsoleBridge(): void {
  const methods: Record<string, string> = {
    clear: "clear",
    debug: "debug",
    dir: "dir",
    error: "error",
    group: "startGroup",
    groupCollapsed: "startGroupCollapsed",
    groupEnd: "endGroup",
    info: "info",
    log: "log",
    table: "table",
    warn: "warning",
  };

  for (const [name, type] of Object.entries(methods)) {
    const original = (console as unknown as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    let current = wrapConsoleMethod(original as ConsoleMethod, type);
    Object.defineProperty(console, name, {
      configurable: true,
      get: () => current,
      set: (next) => {
        current = typeof next === "function" ? wrapConsoleMethod(next, type) : next;
      },
    });
  }
}

function wrapConsoleMethod(fn: ConsoleMethod, type: string): ConsoleMethod {
  if ((fn as ConsoleMethod & { [consoleWrapped]?: true })[consoleWrapped]) return fn;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    fn.apply(console, args);
    emitConsole(type, args);
  } as ConsoleMethod;
  Object.defineProperty(wrapped, consoleWrapped, { value: true });
  return wrapped;
}

function highlight(el: Element): void {
  const rect = el.getBoundingClientRect();
  const marker = document.createElement("div");
  marker.style.cssText = [
    "position:fixed",
    `left:${rect.left}px`,
    `top:${rect.top}px`,
    `width:${rect.width}px`,
    `height:${rect.height}px`,
    "z-index:2147483647",
    "pointer-events:none",
    "outline:2px solid #005fb8",
    "background:rgba(0,95,184,.08)",
  ].join(";");
  document.documentElement.appendChild(marker);
  setTimeout(() => marker.remove(), 500);
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
}

function canSelectText(el: HTMLInputElement): boolean {
  return ["", "text", "search", "tel", "url", "password"].includes(el.type);
}

function insertText(text: string): void {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return;
  highlight(el);
  if (el instanceof HTMLInputElement && !canSelectText(el)) {
    setNativeValue(el, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const nextValue = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
    setNativeValue(el, nextValue);
    try {
      el.setSelectionRange(start + text.length, start + text.length);
    } catch {}
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    document.execCommand("insertText", false, text);
  }
}

function deleteBackward(): void {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    if (start === 0 && end === 0) return;
    const nextStart = start === end ? start - 1 : start;
    const nextValue = `${el.value.slice(0, nextStart)}${el.value.slice(end)}`;
    setNativeValue(el, nextValue);
    try {
      el.setSelectionRange(nextStart, nextStart);
    } catch {}
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    document.execCommand("delete", false);
  }
}

function pageFrame(): Protocol.Page.Frame {
  return {
    id: frameId,
    loaderId: "icdp-loader",
    domainAndRegistry: "",
    mimeType: document.contentType || "text/html",
    securityOrigin: location.origin,
    secureContextType: window.isSecureContext ? "Secure" : "InsecureScheme",
    crossOriginIsolatedContextType: "NotIsolated",
    gatedAPIFeatures: [],
    url: location.href,
  };
}

function emulateNetworkConditionsByRule(
  params: CdpParams<"Network.emulateNetworkConditionsByRule"> = {} as CdpParams<"Network.emulateNetworkConditionsByRule">,
): Protocol.Network.EmulateNetworkConditionsByRuleResponse {
  return {
    ruleIds: (params.matchedNetworkConditions ?? []).map((_, index) => `icdp-rule-${index}`),
  };
}

function addScriptToEvaluateOnNewDocument(): Protocol.Page.AddScriptToEvaluateOnNewDocumentResponse {
  return { identifier: `icdp-script-${nextScriptIdentifier++}` };
}

function getFrameTree(): Protocol.Page.GetFrameTreeResponse {
  return {
    frameTree: { frame: pageFrame() },
  };
}

function getResourceTree(): Protocol.Page.GetResourceTreeResponse {
  return {
    frameTree: {
      frame: pageFrame(),
      resources: [],
    },
  };
}

function getStorageKey(): Protocol.Storage.GetStorageKeyResponse {
  return { storageKey: location.origin };
}

function getFullAccessibilityTree(): Protocol.Accessibility.GetFullAXTreeResponse {
  return getFullAXTree({ document, frameId, registry });
}

function getPartialAccessibilityTree(): Protocol.Accessibility.GetPartialAXTreeResponse {
  return getPartialAXTree({ document, frameId, registry });
}

function getDocument(
  params: CdpParams<"DOM.getDocument"> = {} as CdpParams<"DOM.getDocument">,
): Protocol.DOM.GetDocumentResponse {
  return {
    root: domNode(document, Number(params.depth ?? 1)),
  };
}

function queryRoot(nodeId: unknown): Document | Element {
  if (nodeId == null || Number(nodeId) === 0) return document;
  const node = registry.nodeForBackendId(Number(nodeId));
  if (node instanceof Document) return node;
  if (node instanceof Element) return node;
  return node?.parentElement ?? document;
}

function querySelector(params: CdpParams<"DOM.querySelector">): Protocol.DOM.QuerySelectorResponse {
  const root = queryRoot(params.nodeId);
  const element = root.querySelector(params.selector);
  return { nodeId: element ? registry.backendIdFor(element) : 0 };
}

function querySelectorAll(params: CdpParams<"DOM.querySelectorAll">): Protocol.DOM.QuerySelectorAllResponse {
  const root = queryRoot(params.nodeId);
  return {
    nodeIds: Array.from(root.querySelectorAll(params.selector)).map((element) => registry.backendIdFor(element)),
  };
}

function matchingSearchNodes(query: string): Protocol.DOM.BackendNodeId[] {
  try {
    return Array.from(document.querySelectorAll(query)).map((element) => registry.backendIdFor(element));
  } catch {}

  const text = query.toLowerCase();
  return Array.from(document.querySelectorAll("*"))
    .filter((element) => (element.textContent || "").toLowerCase().includes(text))
    .map((element) => registry.backendIdFor(element));
}

function performSearch(params: CdpParams<"DOM.performSearch">): Protocol.DOM.PerformSearchResponse {
  const searchId = `icdp-search-${nextSearchId++}`;
  const nodes = matchingSearchNodes(String(params.query || ""));
  searchResults.set(searchId, nodes);
  return { searchId, resultCount: nodes.length };
}

function getSearchResults(params: CdpParams<"DOM.getSearchResults">): Protocol.DOM.GetSearchResultsResponse {
  const nodes = searchResults.get(params.searchId) ?? [];
  return { nodeIds: nodes.slice(params.fromIndex, params.toIndex) };
}

function discardSearchResults(params: CdpParams<"DOM.discardSearchResults">): Record<string, never> {
  searchResults.delete(params.searchId);
  return {};
}

function getAttributes(params: CdpParams<"DOM.getAttributes">): Protocol.DOM.GetAttributesResponse {
  const node = registry.nodeForBackendId(Number(params.nodeId));
  return { attributes: node instanceof Element ? attributesFor(node) : [] };
}

function getOuterHTML(params: CdpParams<"DOM.getOuterHTML">): Protocol.DOM.GetOuterHTMLResponse {
  const node = registry.nodeForBackendId(Number(params.backendNodeId ?? params.nodeId));
  if (node instanceof Element) return { outerHTML: node.outerHTML };
  if (node instanceof Document) return { outerHTML: node.documentElement.outerHTML };
  return { outerHTML: "" };
}

function focusNode(params: CdpParams<"DOM.focus">): Record<string, never> {
  const element = elementForBackendId(Number(params.backendNodeId ?? params.nodeId));
  if (element instanceof HTMLElement) element.focus();
  return {};
}

function scrollIntoViewIfNeeded(params: CdpParams<"DOM.scrollIntoViewIfNeeded">): Record<string, never> {
  elementForBackendId(Number(params.backendNodeId ?? params.nodeId)).scrollIntoView({
    block: "center",
    inline: "center",
  });
  return {};
}

function requestChildNodes(params: CdpParams<"DOM.requestChildNodes">): Record<string, never> {
  const node = registry.nodeForBackendId(Number(params.nodeId));
  if (!node) throw new Error(`No element for backendDOMNodeId=${params.nodeId}`);
  sendToHost({
    method: "DOM.setChildNodes",
    params: {
      parentId: Number(params.nodeId),
      nodes: childNodesFor(node, Number(params.depth ?? 1)),
    },
  });
  return {};
}

function describeDomNode(
  params: CdpParams<"DOM.describeNode"> = {} as CdpParams<"DOM.describeNode">,
): Protocol.DOM.DescribeNodeResponse {
  return describeNode(Number(params.backendNodeId ?? params.nodeId ?? 1));
}

function resolveNode(
  params: CdpParams<"DOM.resolveNode"> = {} as CdpParams<"DOM.resolveNode">,
): Protocol.DOM.ResolveNodeResponse {
  return {
    object: {
      objectId: `backend:${params.backendNodeId ?? params.nodeId}`,
      type: "object",
      className: "Element",
    },
  };
}

function pushNodesByBackendIdsToFrontend(
  params: CdpParams<"DOM.pushNodesByBackendIdsToFrontend"> = {} as CdpParams<"DOM.pushNodesByBackendIdsToFrontend">,
): Protocol.DOM.PushNodesByBackendIdsToFrontendResponse {
  return { nodeIds: (params.backendNodeIds ?? []).map((id) => id) };
}

function getBoxModel(params: CdpParams<"DOM.getBoxModel">): Protocol.DOM.GetBoxModelResponse {
  return boxModel(Number(params.backendNodeId ?? params.nodeId));
}

function getContentQuads(params: CdpParams<"DOM.getContentQuads">): Protocol.DOM.GetContentQuadsResponse {
  return contentQuads(Number(params.backendNodeId ?? params.nodeId));
}

function getComputedStyleForNode(params: CdpParams<"CSS.getComputedStyleForNode">): {
  computedStyle: Protocol.CSS.CSSComputedStyleProperty[];
} {
  const style = getComputedStyle(elementForBackendId(Number(params.nodeId)));
  return {
    computedStyle: Array.from(style).map((name) => ({
      name,
      value: style.getPropertyValue(name),
    })),
  };
}

function mouseEvent(type: string, params: CdpParams<"Input.dispatchMouseEvent">): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: params.button === "right" ? 2 : params.button === "middle" ? 1 : 0,
    buttons: Number(params.buttons ?? 0),
    clientX: Number(params.x ?? 0),
    clientY: Number(params.y ?? 0),
  });
}

function wheelEvent(params: CdpParams<"Input.dispatchMouseEvent">): WheelEvent {
  return new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: Number(params.x ?? 0),
    clientY: Number(params.y ?? 0),
    deltaX: Number(params.deltaX ?? 0),
    deltaY: Number(params.deltaY ?? 0),
  });
}

function scrollableAncestor(el: Element | null): Element | null {
  for (let current = el; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`)) return current;
  }
  return document.scrollingElement;
}

function dispatchMouseEvent(params: CdpParams<"Input.dispatchMouseEvent">): Record<string, never> {
  const target = document.elementFromPoint(Number(params.x ?? 0), Number(params.y ?? 0)) || document.documentElement;
  if (!(target instanceof Element)) return {};

  if (params.type === "mouseMoved") {
    if (hoveredElement !== target) {
      hoveredElement?.dispatchEvent(mouseEvent("mouseout", params));
      target.dispatchEvent(mouseEvent("mouseover", params));
      target.dispatchEvent(mouseEvent("mouseenter", params));
      hoveredElement = target;
    }
    target.dispatchEvent(mouseEvent("mousemove", params));
  } else if (params.type === "mousePressed") {
    pressedElement = target;
    target.dispatchEvent(mouseEvent("mousedown", params));
  } else if (params.type === "mouseReleased") {
    target.dispatchEvent(mouseEvent("mouseup", params));
    if (pressedElement === target) {
      (target as HTMLElement).click();
      const now = Date.now();
      if (Number(params.clickCount ?? 1) > 1 || (lastClickElement === target && now - lastClickTime < 500)) {
        target.dispatchEvent(mouseEvent("dblclick", params));
      }
      lastClickElement = target;
      lastClickTime = now;
    }
    pressedElement = null;
  } else if (params.type === "mouseWheel") {
    target.dispatchEvent(wheelEvent(params));
    const scroller = scrollableAncestor(target);
    scroller?.scrollBy(Number(params.deltaX ?? 0), Number(params.deltaY ?? 0));
  }
  return {};
}

function dispatchKeyEvent(params: CdpParams<"Input.dispatchKeyEvent">): Record<string, never> {
  const key = String(params.key || params.code || params.text || "");
  const target = document.activeElement || document.body;
  if (params.type === "keyDown" || params.type === "rawKeyDown") {
    target?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
    if (key === "Backspace") deleteBackward();
  } else if (params.type === "keyUp") {
    target?.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key }));
  }
  if (typeof params.text === "string" && params.text) insertText(params.text);
  return {};
}

function inputInsertText(params: CdpParams<"Input.insertText">): Record<string, never> {
  if (typeof params.text === "string" && params.text) insertText(params.text);
  return {};
}

function navigate(params: CdpParams<"Page.navigate">): Protocol.Page.NavigateResponse {
  const next = new URL(String(params.url || "/"), location.href);
  if (next.origin !== location.origin) throw new Error("Navigation outside the embedded app's origin is not allowed");
  location.href = next.href;
  return { frameId };
}

async function evaluate(params: CdpParams<"Runtime.evaluate">): Promise<Protocol.Runtime.EvaluateResponse> {
  // biome-ignore lint/security/noGlobalEval: CDP Runtime.evaluate intentionally executes page expressions.
  const indirectEval = globalThis.eval;
  const value = indirectEval(String(params.expression || ""));
  return { result: runtimeValue(params.awaitPromise && value instanceof Promise ? await value : value) };
}

async function callFunctionOn(
  params: CdpParams<"Runtime.callFunctionOn">,
): Promise<Protocol.Runtime.CallFunctionOnResponse> {
  const id = String(params.objectId || "").startsWith("backend:") ? Number(String(params.objectId).slice(8)) : NaN;
  const target = Number.isFinite(id) ? elementForBackendId(id) : window;
  // biome-ignore lint/security/noGlobalEval: CDP Runtime.callFunctionOn intentionally executes page functions.
  const indirectEval = globalThis.eval;
  const fn = indirectEval(`(${params.functionDeclaration})`) as (this: unknown, ...args: unknown[]) => unknown;
  const value = fn.call(
    target,
    ...((params.arguments || []) as Array<{ value?: unknown; objectId?: string }>).map((arg) => {
      if (arg.objectId?.startsWith("backend:")) return elementForBackendId(Number(arg.objectId.slice(8)));
      return arg.value;
    }),
  );
  return { result: runtimeValue(params.awaitPromise && value instanceof Promise ? await value : value) };
}

cdp.register("Accessibility", {
  disable: noop,
  enable: noop,
  getFullAXTree: getFullAccessibilityTree,
  getPartialAXTree: getPartialAccessibilityTree,
});

cdp.register("Animation", {
  enable: noop,
});

cdp.register("Autofill", {
  setAddresses: noop,
});

cdp.register("CSS", {
  disable: noop,
  enable: noop,
  getComputedStyleForNode,
});

cdp.register("DOM", {
  discardSearchResults,
  describeNode: describeDomNode,
  enable: noop,
  focus: focusNode,
  getAttributes,
  getBoxModel,
  getContentQuads,
  getDocument,
  getOuterHTML,
  getSearchResults,
  performSearch,
  pushNodesByBackendIdsToFrontend,
  querySelector,
  querySelectorAll,
  requestChildNodes,
  resolveNode,
  scrollIntoViewIfNeeded,
});

cdp.register("Input", {
  dispatchKeyEvent,
  dispatchMouseEvent,
  insertText: inputInsertText,
});

cdp.register("Network", {
  emulateNetworkConditionsByRule,
  overrideNetworkState: noop,
  setBlockedURLs: noop,
});

cdp.register("Page", {
  addScriptToEvaluateOnNewDocument,
  getFrameTree,
  getResourceTree,
  navigate,
});

cdp.register("Runtime", {
  addBinding: noop,
  callFunctionOn,
  enable: enableRuntime,
  evaluate,
  runIfWaitingForDebugger: noop,
});

cdp.register("Storage", {
  getStorageKey,
});

// ---------------------------------------------------------------------------
// Handshake: announce to the parent, adopt the MessagePort the Host transfers.
// ---------------------------------------------------------------------------

const ANNOUNCE_RETRIES = 10;
const ANNOUNCE_INTERVAL_MS = 300;

let started = false;

function parentAllowed(origin: string, allowed: string[] | "*"): boolean {
  return allowed === "*" || allowed.includes(origin);
}

async function handleCommand(raw: string): Promise<void> {
  const request = JSON.parse(raw) as CdpRequest;
  if (request.id != null) outboundMethods.set(request.id, request.method);
  try {
    await chobitsu.sendRawMessage(raw);
  } catch (error) {
    if (request.id != null) outboundMethods.delete(request.id);
    sendToHost({
      id: request.id,
      error: { code: CDP_SERVER_ERROR, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function adoptPort(next: MessagePort): void {
  port?.close();
  port = next;
  next.onmessage = (event) => {
    void handleCommand(String(event.data));
  };
  sendToHost({
    method: "Page.frameNavigated",
    params: { frame: pageFrame() },
  });
  sendToHost({
    method: "Page.domContentEventFired",
    params: { timestamp: performance.now() / 1000 },
  });
  sendToHost({
    method: "Page.loadEventFired",
    params: { timestamp: performance.now() / 1000 },
  });
}

function announce(allowed: string[] | "*"): void {
  const hello = {
    icdp: "hello",
    v: PROTOCOL_VERSION,
    title: document.title || location.href,
    url: location.href,
  } satisfies HandshakeMessage;
  const targetOrigins = allowed === "*" ? ["*"] : allowed;
  for (const origin of targetOrigins) {
    try {
      window.parent.postMessage(hello, origin);
    } catch {}
  }
}

/**
 * Boot the Frame Agent. No-op when the page is not embedded. The agent stays
 * dormant (announces, but never adopts a channel) unless a parent on the
 * allowlist answers with a welcome.
 */
export function startFrameAgent(options: FrameAgentOptions): void {
  if (started || window.parent === window) return;
  started = true;

  const allowed = options.allowedParents;

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !isHandshakeMessage(event.data)) return;
    if (!parentAllowed(event.origin, allowed)) return;
    if (event.data.icdp === "probe") {
      announce(allowed);
    } else if (event.data.icdp === "welcome" && event.ports[0]) {
      adoptPort(event.ports[0]);
    }
  });

  installConsoleBridge();
  announce(allowed);

  let attempts = 0;
  const retry = window.setInterval(() => {
    if (port || ++attempts >= ANNOUNCE_RETRIES) {
      window.clearInterval(retry);
      return;
    }
    announce(allowed);
  }, ANNOUNCE_INTERVAL_MS);
}
