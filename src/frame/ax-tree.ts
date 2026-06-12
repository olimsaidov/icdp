import type { ARIAProperty } from "aria-query";
import { roles as ariaRoles } from "aria-query";
import type Protocol from "devtools-protocol";
import {
  computeAccessibleDescription,
  computeAccessibleName,
  getRole,
  isInaccessible,
} from "dom-accessibility-api";

type AXValue = Protocol.Accessibility.AXValue;
type AXProperty = Protocol.Accessibility.AXProperty;
type AXNode = Protocol.Accessibility.AXNode;
type AXPropertyName = Protocol.Accessibility.AXPropertyName;
type AXValueType = Protocol.Accessibility.AXValueType;

export type DomRegistry = {
  backendIdFor(node: Node): Protocol.DOM.BackendNodeId;
  nodeForBackendId(id: Protocol.DOM.BackendNodeId): Node | undefined;
};

type AXTreeOptions = {
  document: Document;
  frameId: Protocol.Page.FrameId;
  registry: DomRegistry;
};

const nodeToAXId = new WeakMap<Node, string>();
let nextAXId = 1;

export function createDomRegistry(): DomRegistry {
  const nodeToBackendId = new WeakMap<Node, Protocol.DOM.BackendNodeId>();
  const backendIdToNode = new Map<Protocol.DOM.BackendNodeId, Node>();
  let nextBackendId = 1;

  return {
    backendIdFor(node) {
      const existing = nodeToBackendId.get(node);
      if (existing) return existing;
      const id = nextBackendId++;
      nodeToBackendId.set(node, id);
      backendIdToNode.set(id, node);
      return id;
    },
    nodeForBackendId(id) {
      return backendIdToNode.get(id);
    },
  };
}

function ax(type: AXValueType, value?: unknown): AXValue {
  return value === undefined ? { type: "valueUndefined" } : { type, value };
}

function axIdFor(node: Node): string {
  const existing = nodeToAXId.get(node);
  if (existing) return existing;
  const id = String(nextAXId++);
  nodeToAXId.set(node, id);
  return id;
}

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function isText(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

function textValue(node: Text): string {
  return node.nodeValue?.replace(/\s+/g, " ").trim() || "";
}

function explicitRole(el: Element): string | null {
  const attr = el.getAttribute("role");
  if (!attr) return null;
  for (const role of attr.trim().split(/\s+/)) {
    if (ariaRoles.has(role as never)) return role;
  }
  return null;
}

function implicitRole(el: Element): string | null {
  const tag = el.localName;
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "tbody") return null;
  if (tag === "math") return "MathMLMath";
  if (tag === "mi") return "MathMLIdentifier";
  if (tag === "mo") return "MathMLOperator";
  if (tag === "mn") return "MathMLNumber";
  const role = getRole(el);
  if (role && ariaRoles.has(role as never)) return role;

  if (tag === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (["", "text", "email", "url", "tel", "password"].includes(type)) return "textbox";
  }
  if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
  if (tag === "option") return "option";
  if (tag === "p") return "paragraph";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "img") return el.getAttribute("alt") === "" ? null : "image";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "li") return "listitem";
  if (tag === "optgroup") return "group";
  if (tag === "table") return "table";
  if (tag === "thead" || tag === "tfoot") return "rowgroup";
  if (tag === "tr") return "row";
  if (tag === "td") return "cell";
  if (tag === "th") return "columnheader";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "dialog") return "dialog";
  return null;
}

function roleOf(el: Element): string | null {
  const override = (el as any).__agentAX?.role;
  if (typeof override === "string" && override) return override;
  const computed = implicitRole(el);
  if (computed === "none" || computed === "presentation") return null;
  const explicit = explicitRole(el);
  if (explicit === "none" || explicit === "presentation") return null;
  const role = explicit || computed;
  return role === "img" ? "image" : role;
}

function ignoredReasonFor(el: Element): AXProperty | undefined {
  const style = getComputedStyle(el);
  if ((el as HTMLElement).hidden) return ignoredReason("hidden");
  if (el.hasAttribute("inert")) return ignoredReason("inertElement");
  if (el.getAttribute("aria-hidden") === "true") return ignoredReason("ariaHiddenElement");
  if (style.display === "none") return ignoredReason("notRendered");
  if (style.visibility === "hidden" || style.visibility === "collapse")
    return ignoredReason("notVisible");

  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = getComputedStyle(parent);
    if ((parent as HTMLElement).hidden || parentStyle.display === "none")
      return ignoredReason("hiddenRoot");
    if (parent.hasAttribute("inert")) return ignoredReason("inertSubtree");
    if (parent.getAttribute("aria-hidden") === "true") return ignoredReason("ariaHiddenSubtree");
  }

  return isInaccessible(el) ? ignoredReason("uninteresting") : undefined;
}

function boolAttr(el: Element, name: string): boolean | undefined {
  const value = el.getAttribute(name);
  if (value == null) return undefined;
  if (value === "" || value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function tristateAttr(el: Element, name: string): boolean | "mixed" | undefined {
  const value = el.getAttribute(name);
  if (value === "mixed") return "mixed";
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function tristateValue(
  value: boolean | "mixed" | undefined,
): "true" | "false" | "mixed" | undefined {
  if (value === undefined) return undefined;
  if (value === "mixed") return "mixed";
  return value ? "true" : "false";
}

function ignoredReason(name: AXPropertyName): AXProperty {
  return { name, value: ax("boolean", true) };
}

function addProp(
  props: AXProperty[],
  name: AXPropertyName,
  type: AXValueType,
  value: unknown,
  options: { includeFalse?: boolean } = {},
): void {
  if (
    value !== undefined &&
    value !== null &&
    value !== "" &&
    (options.includeFalse || value !== false)
  )
    props.push({ name, value: ax(type, value) });
}

function isDisabled(el: Element): boolean {
  return (
    boolAttr(el, "aria-disabled") === true || ("disabled" in el && Boolean((el as any).disabled))
  );
}

function isFocusable(el: Element): boolean {
  if (isDisabled(el)) return false;
  const html = el as HTMLElement;
  if (html.tabIndex >= 0) return true;
  if (el.localName === "a" && el.hasAttribute("href")) return true;
  return ["button", "input", "select", "textarea"].includes(el.localName);
}

function headingLevel(el: Element): number | undefined {
  const aria = Number(el.getAttribute("aria-level"));
  if (Number.isFinite(aria) && aria > 0) return aria;
  const match = /^h([1-6])$/.exec(el.localName);
  return match?.[1] ? Number(match[1]) : undefined;
}

function numberAttr(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name);
  if (raw == null || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nativeMin(el: Element, role: string): number | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === "range") return numberAttr(el, "min") ?? 0;
    if (el.type === "number") return numberAttr(el, "min");
  }
  if (el instanceof HTMLProgressElement) return 0;
  if (el instanceof HTMLMeterElement) return el.min;
  if (role === "scrollbar") return 0;
  return undefined;
}

function nativeMax(el: Element, role: string): number | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === "range") return numberAttr(el, "max") ?? 100;
    if (el.type === "number") return numberAttr(el, "max");
  }
  if (el instanceof HTMLProgressElement) return el.max;
  if (el instanceof HTMLMeterElement) return el.max;
  if (role === "scrollbar") return 100;
  return undefined;
}

function valueFor(el: Element): AXValue | undefined {
  const override = (el as any).__agentAX?.value;
  if (override !== undefined)
    return ax(typeof override === "number" ? "number" : "string", override);
  if (el instanceof HTMLInputElement && (el.type === "range" || el.type === "number")) {
    const number = Number(el.value);
    return Number.isFinite(number) ? ax("number", number) : ax("string", el.value);
  }
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return ax("string", el.value);
  }
  if (el instanceof HTMLProgressElement || el instanceof HTMLMeterElement)
    return ax("number", el.value);
  const now = el.getAttribute("aria-valuenow");
  if (now == null) return undefined;
  const number = Number(now);
  return Number.isFinite(number) ? ax("number", number) : ax("string", now);
}

function ariaBool(el: Element, name: string): boolean | undefined {
  return boolAttr(el, name);
}

function ariaToken(el: Element, name: string): string | boolean | undefined {
  const value = el.getAttribute(name);
  if (value == null || value === "" || value === "undefined") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function idRefs(el: Element, name: string): string[] {
  return (el.getAttribute(name) || "").trim().split(/\s+/).filter(Boolean);
}

function relatedNodesFor(
  options: AXTreeOptions,
  el: Element,
  ids: string[],
): Protocol.Accessibility.AXRelatedNode[] {
  return ids.flatMap((idref) => {
    const related = el.ownerDocument.getElementById(idref);
    if (!related) return [];
    return [
      {
        backendDOMNodeId: options.registry.backendIdFor(related),
        idref,
        text:
          computeAccessibleName(related) ||
          related.textContent?.replace(/\s+/g, " ").trim() ||
          undefined,
      },
    ];
  });
}

const authorNamedStructuralRoles = new Set([
  "list",
  "listitem",
  "main",
  "paragraph",
  "row",
  "rowgroup",
  "table",
]);

function accessibleNameFor(el: Element, role: string): string {
  if (!authorNamedStructuralRoles.has(role)) return computeAccessibleName(el);
  if (
    el.hasAttribute("aria-label") ||
    el.hasAttribute("aria-labelledby") ||
    el.hasAttribute("title")
  )
    return computeAccessibleName(el);
  return "";
}

function addRelationProp(
  options: AXTreeOptions,
  props: AXProperty[],
  el: Element,
  attr: string,
  name: AXPropertyName,
  type: "idref" | "idrefList" | "nodeList",
  settings: { omitValue?: boolean } = {},
): void {
  const ids = idRefs(el, attr);
  if (!ids.length) return;
  const value: AXValue = { type };
  if (!settings.omitValue && type === "idref") value.value = ids[0];
  if (!settings.omitValue && type === "idrefList") value.value = ids.join(" ");
  const relatedNodes = relatedNodesFor(options, el, ids);
  if (relatedNodes.length) value.relatedNodes = relatedNodes;
  props.push({ name, value });
}

function roleSupportsAria(role: string, attr: ARIAProperty): boolean {
  const definition = ariaRoles.get(role as never);
  return !definition || attr in definition.props || attr in definition.requiredProps;
}

function addAriaProp(
  props: AXProperty[],
  el: Element,
  role: string,
  attr: ARIAProperty,
  name: AXPropertyName,
  type: AXValueType,
  value: unknown,
  options: { includeFalse?: boolean } = {},
): void {
  if (!el.hasAttribute(attr) || !roleSupportsAria(role, attr)) return;
  addProp(props, name, type, value, options);
}

function propertiesFor(options: AXTreeOptions, el: Element, role: string): AXProperty[] {
  const props: AXProperty[] = [];
  addProp(props, "disabled", "boolean", isDisabled(el));
  addProp(props, "focusable", "boolean", isFocusable(el));
  addProp(props, "focused", "boolean", el === el.ownerDocument.activeElement);
  addProp(
    props,
    "readonly",
    "boolean",
    ("readOnly" in el && Boolean((el as any).readOnly)) || boolAttr(el, "aria-readonly"),
  );
  addProp(
    props,
    "required",
    "boolean",
    ("required" in el && Boolean((el as any).required)) || boolAttr(el, "aria-required"),
  );
  addAriaProp(props, el, role, "aria-busy", "busy", "boolean", ariaBool(el, "aria-busy"));
  addAriaProp(props, el, role, "aria-invalid", "invalid", "token", ariaToken(el, "aria-invalid"), {
    includeFalse: true,
  });
  addAriaProp(
    props,
    el,
    role,
    "aria-autocomplete",
    "autocomplete",
    "token",
    ariaToken(el, "aria-autocomplete"),
  );
  addAriaProp(
    props,
    el,
    role,
    "aria-haspopup",
    "hasPopup",
    "token",
    ariaToken(el, "aria-haspopup"),
    {
      includeFalse: true,
    },
  );
  addAriaProp(props, el, role, "aria-modal", "modal", "boolean", ariaBool(el, "aria-modal"));
  addAriaProp(
    props,
    el,
    role,
    "aria-multiselectable",
    "multiselectable",
    "boolean",
    ariaBool(el, "aria-multiselectable"),
  );
  addAriaProp(
    props,
    el,
    role,
    "aria-orientation",
    "orientation",
    "token",
    ariaToken(el, "aria-orientation"),
  );
  addAriaProp(
    props,
    el,
    role,
    "aria-keyshortcuts",
    "keyshortcuts",
    "string",
    el.getAttribute("aria-keyshortcuts"),
  );
  addAriaProp(
    props,
    el,
    role,
    "aria-roledescription",
    "roledescription",
    "string",
    el.getAttribute("aria-roledescription"),
  );

  if (role === "checkbox" || role === "radio" || role === "switch") {
    const checked =
      el instanceof HTMLInputElement
        ? el.indeterminate
          ? "mixed"
          : el.checked
        : tristateAttr(el, "aria-checked");
    addProp(props, "checked", "tristate", tristateValue(checked), { includeFalse: true });
  }

  addProp(props, "expanded", "booleanOrUndefined", boolAttr(el, "aria-expanded"), {
    includeFalse: true,
  });
  addProp(props, "pressed", "tristate", tristateValue(tristateAttr(el, "aria-pressed")), {
    includeFalse: true,
  });
  addProp(
    props,
    "selected",
    "booleanOrUndefined",
    (el instanceof HTMLOptionElement ? el.selected : undefined) ?? boolAttr(el, "aria-selected"),
    { includeFalse: true },
  );
  if (role === "heading") addProp(props, "level", "integer", headingLevel(el));
  if (role === "textbox")
    addProp(
      props,
      "multiline",
      "boolean",
      el.localName === "textarea" || boolAttr(el, "aria-multiline"),
    );
  const min = numberAttr(el, "aria-valuemin") ?? nativeMin(el, role);
  const max = numberAttr(el, "aria-valuemax") ?? nativeMax(el, role);
  addProp(props, "valuemin", "number", min);
  addProp(props, "valuemax", "number", max);
  addProp(props, "valuetext", "string", el.getAttribute("aria-valuetext"));
  addRelationProp(options, props, el, "aria-activedescendant", "activedescendant", "idref", {
    omitValue: true,
  });
  addRelationProp(options, props, el, "aria-controls", "controls", "idrefList");
  addRelationProp(options, props, el, "aria-describedby", "describedby", "idrefList");
  addRelationProp(options, props, el, "aria-details", "details", "idrefList");
  addRelationProp(options, props, el, "aria-errormessage", "errormessage", "idrefList");
  addRelationProp(options, props, el, "aria-flowto", "flowto", "idrefList");
  addRelationProp(options, props, el, "aria-labelledby", "labelledby", "nodeList");
  addRelationProp(options, props, el, "aria-owns", "owns", "idrefList");
  if (role === "link" && el instanceof HTMLAnchorElement) addProp(props, "url", "string", el.href);
  return props;
}

function composedChildren(node: Node): Node[] {
  if (isElement(node)) {
    const shadow = (node as HTMLElement).shadowRoot;
    if (shadow) return Array.from(shadow.childNodes);
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    if (node.localName === "table") {
      const children = Array.from(node.childNodes);
      const sections = new Set(["thead", "tbody", "tfoot"]);
      const section = (name: string) =>
        children.filter((child) => isElement(child) && child.localName === name);
      return [
        ...children.filter((child) => !isElement(child) || !sections.has(child.localName)),
        ...section("thead"),
        ...section("tbody"),
        ...section("tfoot"),
      ];
    }
  }
  return Array.from(node.childNodes);
}

function listMarkerText(el: Element): string | undefined {
  if (el.localName !== "li" || getComputedStyle(el).display !== "list-item") return undefined;
  const list = el.parentElement;
  if (list?.localName !== "ol") return undefined;
  const siblings = Array.from(list.children).filter(
    (child) => child.localName === "li" && getComputedStyle(child).display === "list-item",
  );
  const start = numberAttr(list, "start") ?? 1;
  return `${start + Math.max(0, siblings.indexOf(el))}. `;
}

function buildListMarkerAX(options: AXTreeOptions, el: Element, out: AXNode[]): string[] {
  const marker = listMarkerText(el);
  if (!marker) return [];
  const markerId = `${axIdFor(el)}:marker`;
  const textId = `${markerId}:text`;
  out.push({
    nodeId: textId,
    ignored: false,
    role: ax("role", "StaticText"),
    name: ax("computedString", marker),
    parentId: markerId,
    backendDOMNodeId: options.registry.backendIdFor(el),
    childIds: [],
    frameId: options.frameId,
  });
  out.push({
    nodeId: markerId,
    ignored: false,
    role: ax("role", "ListMarker"),
    name: ax("computedString", marker),
    backendDOMNodeId: options.registry.backendIdFor(el),
    childIds: [textId],
    frameId: options.frameId,
  });
  return [markerId];
}

function buildAX(
  options: AXTreeOptions,
  node: Node,
  parentId: string | undefined,
  out: AXNode[],
): string[] {
  if (isText(node)) {
    const text = textValue(node);
    if (!text) return [];
    const nodeId = axIdFor(node);
    out.push({
      nodeId,
      ignored: false,
      role: ax("role", "StaticText"),
      name: ax("computedString", text),
      parentId,
      backendDOMNodeId: options.registry.backendIdFor(node.parentElement || node),
      childIds: [],
      frameId: options.frameId,
    });
    return [nodeId];
  }

  if (node.nodeType === Node.DOCUMENT_NODE) {
    const nodeId = axIdFor(node);
    const root: AXNode = {
      nodeId,
      ignored: false,
      role: ax("role", "RootWebArea"),
      name: ax("computedString", options.document.title || options.document.location.href),
      backendDOMNodeId: options.registry.backendIdFor(options.document.documentElement),
      childIds: [],
      frameId: options.frameId,
    };
    out.push(root);
    root.childIds = buildAX(options, options.document.documentElement, nodeId, out);
    return [nodeId];
  }

  if (!isElement(node)) return [];
  const ignoredReason = ignoredReasonFor(node);
  if (ignoredReason) {
    const role = roleOf(node);
    const nodeId = axIdFor(node);
    out.push({
      nodeId,
      ignored: true,
      ignoredReasons: [ignoredReason],
      role: role ? ax("role", role) : undefined,
      name: ax(
        "computedString",
        role ? accessibleNameFor(node, role) : computeAccessibleName(node),
      ),
      backendDOMNodeId: options.registry.backendIdFor(node),
      childIds: [],
      frameId: options.frameId,
    });
    return [nodeId];
  }

  const role = roleOf(node);
  const children = [
    ...buildListMarkerAX(options, node, out),
    ...composedChildren(node).flatMap((child) => buildAX(options, child, undefined, out)),
  ];
  if (!role && !computeAccessibleName(node).trim()) return children;

  const nodeId = axIdFor(node);
  const name = role ? accessibleNameFor(node, role) : computeAccessibleName(node);
  const description = computeAccessibleDescription(node);
  const axNode: AXNode = {
    nodeId,
    ignored: false,
    role: ax("role", role || "generic"),
    name: ax("computedString", name),
    description: description ? ax("computedString", description) : undefined,
    value: role ? valueFor(node) : undefined,
    properties: role ? propertiesFor(options, node, role) : undefined,
    parentId,
    backendDOMNodeId: options.registry.backendIdFor(node),
    childIds: children,
    frameId: options.frameId,
  };
  for (const childId of children) {
    const child = out.find((item) => item.nodeId === childId);
    if (child) child.parentId = nodeId;
  }
  out.push(axNode);
  return [nodeId];
}

export function getFullAXTree(
  options: AXTreeOptions,
): Protocol.Accessibility.GetFullAXTreeResponse {
  const nodes: AXNode[] = [];
  buildAX(options, options.document, undefined, nodes);
  return { nodes };
}

export function getPartialAXTree(
  options: AXTreeOptions,
): Protocol.Accessibility.GetPartialAXTreeResponse {
  return getFullAXTree(options);
}
