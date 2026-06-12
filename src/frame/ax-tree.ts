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
type AXValueSource = Protocol.Accessibility.AXValueSource;
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
  /** When set, ignored nodes keep their real role + name (Chromium's
   *  force_name_and_role, used by queryAXTree) instead of role:none + no name. */
  forceNameAndRole?: boolean;
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

// Internal (non-ARIA) role tokens are serialized with AXValue type "internalRole"
// rather than "role" (Chromium's AXObject::RoleName is_internal flag). ARIA-mapped
// tokens like "generic"/"button" keep type "role".
const INTERNAL_ROLES = new Set([
  "StaticText",
  "RootWebArea",
  "ListMarker",
  "DisclosureTriangle",
  "MathMLMath",
  "MathMLIdentifier",
  "MathMLOperator",
  "MathMLNumber",
]);

function roleNameValue(role: string): AXValue {
  return ax(INTERNAL_ROLES.has(role) ? "internalRole" : "role", role);
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
  for (const token of attr.trim().split(/\s+/)) {
    // ARIA 1.2 introduced "image" as a synonym for "img" (aria-query only has img).
    const role = token === "image" ? "img" : token;
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
  if (tag === "summary" && el.parentElement?.localName === "details") return "DisclosureTriangle";
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

// An explicit role=none/presentation makes the element presentational unless it
// is focusable or carries a global aria-* label (conditional presentation).
function isPresentational(el: Element): boolean {
  const attr = el.getAttribute("role");
  if (!attr) return false;
  let presentational = false;
  for (const token of attr.trim().split(/\s+/)) {
    if (token === "none" || token === "presentation") {
      presentational = true;
      break;
    }
    if (ariaRoles.has((token === "image" ? "img" : token) as never)) return false;
  }
  if (!presentational) return false;
  if (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")) return false;
  return !isFocusable(el);
}

// Containers whose children are required-owned and so inherit presentational.
const PRESENTATIONAL_INHERITS = new Set(["ul", "ol", "table", "thead", "tbody", "tfoot", "tr"]);

function ignoredReasonFor(el: Element, options: AXTreeOptions): AXProperty | undefined {
  const style = getComputedStyle(el);
  // The `hidden` attribute computes to display:none; Chromium reports notRendered
  // (it has no bespoke `hidden`/`hiddenRoot` ignored reason).
  if ((el as HTMLElement).hidden) return ignoredReason("notRendered");
  if (el.hasAttribute("inert")) return ignoredReason("inertElement");
  if (el.getAttribute("aria-hidden") === "true") return ignoredReason("ariaHiddenElement");
  if (style.display === "none") return ignoredReason("notRendered");
  if (style.visibility === "hidden" || style.visibility === "collapse")
    return ignoredReason("notVisible");
  if (isPresentational(el)) return ignoredReason("presentationalRole");

  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = getComputedStyle(parent);
    if ((parent as HTMLElement).hidden || parentStyle.display === "none")
      return ignoredReason("notRendered");
    if (parent.hasAttribute("inert")) return ancestorReason("inertSubtree", parent, options);
    if (parent.getAttribute("aria-hidden") === "true")
      return ancestorReason("ariaHiddenSubtree", parent, options);
  }

  return isInaccessible(el) ? ignoredReason("uninteresting") : undefined;
}

// Ancestor-derived ignored reasons carry a relatedNodes idref to the offending
// ancestor element instead of a plain boolean (Chromium's CreateRelatedNodeListValue).
function ancestorReason(
  name: AXPropertyName,
  ancestor: Element,
  options: AXTreeOptions,
): AXProperty {
  const related: Protocol.Accessibility.AXRelatedNode = {
    backendDOMNodeId: options.registry.backendIdFor(ancestor),
  };
  const id = ancestor.getAttribute("id");
  if (id) related.idref = id;
  return { name, value: { type: "idref", relatedNodes: [related] } };
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

// Ignored reasons whose subtree is still rendered (just excluded from the AX
// computation). Chromium keeps these descendants in the tree ("ignored but
// included"), so we recurse into them. The remaining reasons (notRendered,
// notVisible, hidden, hiddenRoot, uninteresting) mark genuinely unrendered
// subtrees, which Chromium also drops — so we keep pruning those.
const RENDERED_IGNORED_REASONS = new Set<AXPropertyName>([
  "ariaHiddenElement",
  "ariaHiddenSubtree",
  "inertElement",
  "inertSubtree",
  "presentationalRole",
]);

/** The subtree-variant reason inherited by an ignored element's descendants,
 *  pointing back at that element (the offending ancestor) for aria-hidden/inert. */
function subtreeReason(
  name: AXPropertyName,
  ancestor: Element,
  options: AXTreeOptions,
): AXProperty {
  if (name === "ariaHiddenElement" || name === "ariaHiddenSubtree")
    return ancestorReason("ariaHiddenSubtree", ancestor, options);
  if (name === "inertElement" || name === "inertSubtree")
    return ancestorReason("inertSubtree", ancestor, options);
  return ignoredReason(name);
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

function nativeDisabled(el: Element): boolean {
  return "disabled" in el && Boolean((el as any).disabled);
}

function isDisabled(el: Element): boolean {
  if (nativeDisabled(el) || boolAttr(el, "aria-disabled") === true) return true;
  // aria-disabled propagates to descendants (Chromium's GetRestriction).
  for (let parent = el.parentElement; parent; parent = parent.parentElement)
    if (parent.getAttribute("aria-disabled") === "true") return true;
  return false;
}

// Roles for which Chromium emits readonly/required/multiselectable (always, even
// when false). Mirrors RoleAllows{Readonly,Required,Multiselectable} in
// inspector_type_builder_helper.cc.
const READONLY_ROLES = new Set([
  "grid",
  "gridcell",
  "textbox",
  "columnheader",
  "rowheader",
  "treegrid",
]);
const REQUIRED_ROLES = new Set([
  "combobox",
  "gridcell",
  "listbox",
  "radiogroup",
  "spinbutton",
  "textbox",
  "tree",
  "columnheader",
  "rowheader",
  "treegrid",
]);
const MULTISELECTABLE_ROLES = new Set(["grid", "listbox", "tablist", "treegrid", "tree"]);

function readonlyState(el: Element): boolean {
  if ("readOnly" in el && Boolean((el as any).readOnly)) return true;
  return boolAttr(el, "aria-readonly") === true;
}

function requiredState(el: Element): boolean {
  if ("required" in el && Boolean((el as any).required)) return true;
  return boolAttr(el, "aria-required") === true;
}

function multiselectableState(el: Element): boolean {
  if (el instanceof HTMLSelectElement && el.multiple) return true;
  return boolAttr(el, "aria-multiselectable") === true;
}

function contentEditable(el: Element): boolean {
  const value = el.getAttribute("contenteditable");
  return value === "" || value === "true" || value === "plaintext-only";
}

function isFocusable(el: Element): boolean {
  if (nativeDisabled(el)) return false; // aria-disabled does not remove focusability
  const html = el as HTMLElement;
  if (html.tabIndex >= 0) return true;
  if (el.localName === "a" && el.hasAttribute("href")) return true;
  if (contentEditable(el)) return true;
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

// Roles whose value is a number on a range (slider/spinbutton/progress/etc.).
const RANGE_ROLES = new Set([
  "slider",
  "scrollbar",
  "spinbutton",
  "progressbar",
  "meter",
  "separator",
]);

/** The numeric value for a range-valued element, or undefined to omit it.
 *  aria-valuenow wins (clamped to min/max); otherwise the native value. */
function rangeValue(el: Element, role: string): number | undefined {
  const min = numberAttr(el, "aria-valuemin") ?? nativeMin(el, role);
  const max = numberAttr(el, "aria-valuemax") ?? nativeMax(el, role);
  const clamp = (n: number) => Math.min(max ?? n, Math.max(min ?? n, n));
  const ariaNow = numberAttr(el, "aria-valuenow");
  if (ariaNow != null) return clamp(ariaNow);
  if (el instanceof HTMLInputElement && (el.type === "range" || el.type === "number"))
    return Number.isFinite(el.valueAsNumber) ? el.valueAsNumber : undefined;
  // An indeterminate <progress> (no value attribute) has no value.
  if (el instanceof HTMLProgressElement) return el.hasAttribute("value") ? el.value : undefined;
  if (el instanceof HTMLMeterElement) return el.value;
  // An author range role without aria-valuenow falls back to the ARIA default:
  // the midpoint for slider/scrollbar/separator, the minimum for spinbutton.
  const lo = min ?? 0;
  const hi = max ?? 100;
  if (role === "slider" || role === "scrollbar" || role === "separator") return (lo + hi) / 2;
  if (role === "spinbutton") return lo;
  return undefined;
}

function selectValue(el: HTMLSelectElement): AXValue | undefined {
  if (el.multiple) return undefined; // multi-select has no single value
  const option = el.selectedOptions[0];
  if (!option) return undefined;
  const text = (option.getAttribute("aria-label") || option.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? ax("string", text) : undefined;
}

function valueFor(el: Element, role: string): AXValue | undefined {
  const override = (el as any).__agentAX?.value;
  if (override !== undefined)
    return ax(typeof override === "number" ? "number" : "string", override);

  if (
    RANGE_ROLES.has(role) ||
    el instanceof HTMLProgressElement ||
    el instanceof HTMLMeterElement
  ) {
    const number = rangeValue(el, role);
    return number == null ? undefined : ax("number", number);
  }

  // <select> reports the displayed text of its selected option, not el.value.
  if (el instanceof HTMLSelectElement) return selectValue(el);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Passwords are masked; empty values are omitted (Chromium's !value.empty()).
    if (el instanceof HTMLInputElement && el.type === "password")
      return el.value ? ax("string", "•".repeat(el.value.length)) : undefined;
    return el.value ? ax("string", el.value) : undefined;
  }

  // contenteditable elements report their text as the value.
  if (contentEditable(el)) {
    const text = normalizeText(el.textContent);
    return text ? ax("string", text) : undefined;
  }

  return undefined;
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
  includeText: boolean,
): Protocol.Accessibility.AXRelatedNode[] {
  return ids.flatMap((idref) => {
    const related = el.ownerDocument.getElementById(idref);
    if (!related) return [];
    const node: Protocol.Accessibility.AXRelatedNode = {
      backendDOMNodeId: options.registry.backendIdFor(related),
      idref,
    };
    // Chromium only attaches `text` on the labelledby (nodeList) relation; idref
    // and idrefList relations carry the bare related node.
    if (includeText) {
      const text =
        computeAccessibleName(related) || related.textContent?.replace(/\s+/g, " ").trim();
      if (text) node.text = text;
    }
    return [node];
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

// Roles that take their name from the element's text contents (W3C AccName).
const NAME_FROM_CONTENTS_ROLES = new Set([
  "button",
  "DisclosureTriangle",
  "cell",
  "checkbox",
  "columnheader",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "rowheader",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
]);

function normalizeText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function nameFromElements(els: Element[]): string {
  return els
    .map((el) => normalizeText(computeAccessibleName(el) || el.textContent))
    .filter(Boolean)
    .join(" ");
}

type NameCandidate = {
  base: AXValueSource;
  value: string;
  attributeValue?: AXValue;
  nativeSourceValue?: AXValue;
  invalid?: boolean;
};

/** Ordered AccName source candidates for an element, matching Chromium's
 *  NameSources: every candidate is listed; the first non-empty one wins, later
 *  ones are marked superseded. */
function nameSources(options: AXTreeOptions, el: Element, role: string): AXValueSource[] {
  const candidates: NameCandidate[] = [];

  // aria-labelledby (relatedElement)
  const labelledbyIds = idRefs(el, "aria-labelledby");
  const labelledby: NameCandidate = {
    base: { type: "relatedElement", attribute: "aria-labelledby" },
    value: nameFromElements(
      labelledbyIds
        .map((id) => el.ownerDocument.getElementById(id))
        .filter((e): e is HTMLElement => e != null),
    ),
  };
  if (labelledbyIds.length) {
    const related = relatedNodesFor(options, el, labelledbyIds, true);
    labelledby.attributeValue = {
      type: "idrefList",
      value: labelledbyIds.join(" "),
      relatedNodes: related,
    };
    if (!related.length) labelledby.invalid = true;
  }
  candidates.push(labelledby);

  // aria-label (attribute)
  candidates.push(attributeCandidate(el, "aria-label", "aria-label"));

  // native source slot (varies by element)
  if (el instanceof HTMLImageElement) {
    candidates.push(attributeCandidate(el, "alt", "alt"));
  } else if (isLabelable(el)) {
    candidates.push(nativeCandidate(options, "label", nativeLabels(el)));
  } else if (el.localName === "figure") {
    candidates.push(nativeCandidate(options, "figcaption", queryChildren(el, "figcaption")));
  } else if (el.localName === "fieldset") {
    candidates.push(nativeCandidate(options, "legend", queryChildren(el, "legend")));
  } else if (el.localName === "table") {
    candidates.push(nativeCandidate(options, "tablecaption", queryChildren(el, "caption")));
  }

  // contents (only for roles named from content)
  if (NAME_FROM_CONTENTS_ROLES.has(role))
    candidates.push({ base: { type: "contents" }, value: normalizeText(el.textContent) });

  // placeholder (text inputs)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    candidates.push(attributeCandidate(el, "placeholder", "placeholder", "placeholder"));

  // title (attribute)
  candidates.push(attributeCandidate(el, "title", "title"));

  const winner = candidates.findIndex((candidate) => candidate.value);
  return candidates.map((candidate, index) => {
    const source: AXValueSource = Object.assign({}, candidate.base);
    if (candidate.attributeValue) source.attributeValue = candidate.attributeValue;
    if (candidate.nativeSourceValue) source.nativeSourceValue = candidate.nativeSourceValue;
    if (candidate.invalid) source.invalid = true;
    if (index === winner) {
      source.value = ax("computedString", candidate.value);
    } else if (winner >= 0 && index > winner) {
      source.superseded = true;
      if (candidate.value) source.value = ax("computedString", candidate.value);
    }
    return source;
  });
}

function attributeCandidate(
  el: Element,
  attribute: string,
  label: string,
  type: AXValueSource["type"] = "attribute",
): NameCandidate {
  const raw = el.getAttribute(attribute);
  const value = normalizeText(raw);
  const candidate: NameCandidate = { base: { type, attribute: label }, value };
  if (raw != null && raw !== "") candidate.attributeValue = { type: "string", value: raw };
  return candidate;
}

function nativeCandidate(
  options: AXTreeOptions,
  nativeSource: AXValueSource["nativeSource"] & string,
  els: Element[],
): NameCandidate {
  const candidate: NameCandidate = {
    base: { type: "relatedElement", nativeSource },
    value: nameFromElements(els),
  };
  if (els.length)
    candidate.nativeSourceValue = {
      type: "nodeList",
      relatedNodes: els.map((el) => ({
        backendDOMNodeId: options.registry.backendIdFor(el),
        text: normalizeText(el.textContent) || undefined,
      })),
    };
  return candidate;
}

function isLabelable(el: Element): boolean {
  return (
    el instanceof HTMLButtonElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLOutputElement ||
    el instanceof HTMLMeterElement ||
    el instanceof HTMLProgressElement
  );
}

function nativeLabels(el: Element): Element[] {
  const labels = (el as { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
  return labels ? Array.from(labels) : [];
}

function queryChildren(el: Element, selector: string): Element[] {
  const match = el.querySelector(selector);
  return match ? [match] : [];
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
  const relatedNodes = relatedNodesFor(options, el, ids, type === "nodeList");
  if (relatedNodes.length) value.relatedNodes = relatedNodes;
  props.push({ name, value });
}

function roleSupportsAria(role: string, attr: ARIAProperty): boolean {
  // "image" is our serialized name for the ARIA "img" role; look up img's definition.
  const definition = ariaRoles.get((role === "image" ? "img" : role) as never);
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

const CHECK_DEFAULT_FALSE_ROLES = new Set([
  "checkbox",
  "radio",
  "switch",
  "menuitemcheckbox",
  "menuitemradio",
]);
const SELECTABLE_ROLES = new Set([
  "option",
  "tab",
  "row",
  "gridcell",
  "treeitem",
  "columnheader",
  "rowheader",
]);

/** The live-region status (aria-live, or an implicit-live role), or undefined. */
function liveStatus(el: Element, role: string): string | undefined {
  const aria = el.getAttribute("aria-live");
  if (aria && aria !== "off") return aria;
  if (role === "alert") return "assertive";
  if (role === "status" || role === "log") return "polite";
  return undefined;
}

/** The invalid token ("false"/"true"/"grammar"/"spelling"), or undefined. */
function invalidToken(el: Element): string | undefined {
  const aria = el.getAttribute("aria-invalid");
  if (aria === "grammar" || aria === "spelling") return aria;
  if (aria === "true" || aria === "") return "true";
  if (aria === "false") return "false";
  // Native form controls always carry an invalid state (default false).
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  )
    return "false";
  return undefined;
}

/** The editable token ("plaintext"/"richtext") for editable elements. */
function editableToken(el: Element): string | undefined {
  if (contentEditable(el))
    return el.getAttribute("contenteditable") === "plaintext-only" ? "plaintext" : "richtext";
  if (el instanceof HTMLTextAreaElement) return "plaintext";
  if (el instanceof HTMLInputElement)
    return ["", "text", "search", "email", "url", "tel", "password"].includes(el.type)
      ? "plaintext"
      : undefined;
  return undefined;
}

function isSettable(el: Element): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    contentEditable(el)
  );
}

/** The tristate checked value for a checkable element, or undefined. */
function checkedState(el: Element, role: string): boolean | "mixed" | undefined {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio"))
    return el.indeterminate ? "mixed" : el.checked;
  const aria = tristateAttr(el, "aria-checked");
  if (aria !== undefined) return aria;
  return CHECK_DEFAULT_FALSE_ROLES.has(role) ? false : undefined;
}

/** The expanded value, only when an expand/collapse state is determinable. */
function expandedState(el: Element): boolean | undefined {
  const aria = boolAttr(el, "aria-expanded");
  if (aria !== undefined) return aria;
  const details =
    el.localName === "details" ? el : el.localName === "summary" ? el.parentElement : null;
  if (details instanceof HTMLDetailsElement) return details.open;
  return undefined;
}

// propertiesFor follows Chromium's Fill* phase order:
//   live-region -> global states -> widget properties -> widget states -> relations
function propertiesFor(options: AXTreeOptions, el: Element, role: string): AXProperty[] {
  const props: AXProperty[] = [];

  // --- Live region (on the region root) ---
  const live = liveStatus(el, role);
  if (live) {
    addProp(props, "live", "token", live);
    addProp(props, "atomic", "boolean", boolAttr(el, "aria-atomic") === true, {
      includeFalse: true,
    });
    addProp(props, "relevant", "tokenList", el.getAttribute("aria-relevant") || "additions text");
  }

  // --- Global states ---
  addProp(props, "disabled", "boolean", isDisabled(el));
  addProp(props, "invalid", "token", invalidToken(el));
  addProp(props, "focusable", "booleanOrUndefined", isFocusable(el));
  addProp(props, "focused", "booleanOrUndefined", el === el.ownerDocument.activeElement);
  addProp(props, "editable", "token", editableToken(el));
  if (isSettable(el)) addProp(props, "settable", "booleanOrUndefined", true);

  // --- Widget properties ---
  addProp(props, "autocomplete", "token", ariaToken(el, "aria-autocomplete"));
  const haspopup = el.getAttribute("aria-haspopup");
  if (haspopup && haspopup !== "false") addProp(props, "hasPopup", "token", haspopup);
  addProp(props, "level", "integer", headingLevel(el));
  if (MULTISELECTABLE_ROLES.has(role))
    addProp(props, "multiselectable", "boolean", multiselectableState(el), { includeFalse: true });
  addProp(props, "orientation", "token", ariaToken(el, "aria-orientation"));
  if (role === "textbox")
    addProp(
      props,
      "multiline",
      "boolean",
      el.localName === "textarea" || boolAttr(el, "aria-multiline") === true,
      { includeFalse: true },
    );
  if (READONLY_ROLES.has(role))
    addProp(props, "readonly", "boolean", readonlyState(el), { includeFalse: true });
  if (REQUIRED_ROLES.has(role))
    addProp(props, "required", "boolean", requiredState(el), { includeFalse: true });
  if (RANGE_ROLES.has(role)) {
    addProp(props, "valuemin", "number", numberAttr(el, "aria-valuemin") ?? nativeMin(el, role));
    addProp(props, "valuemax", "number", numberAttr(el, "aria-valuemax") ?? nativeMax(el, role));
    addProp(props, "valuetext", "string", el.getAttribute("aria-valuetext"));
  }

  // --- Widget states ---
  const pressed = tristateAttr(el, "aria-pressed");
  if (pressed !== undefined) {
    addProp(props, "pressed", "tristate", tristateValue(pressed), { includeFalse: true });
  } else {
    const checked = checkedState(el, role);
    if (checked !== undefined)
      addProp(props, "checked", "tristate", tristateValue(checked), { includeFalse: true });
  }
  const expanded = expandedState(el);
  if (expanded !== undefined)
    addProp(props, "expanded", "booleanOrUndefined", expanded, { includeFalse: true });
  if (SELECTABLE_ROLES.has(role)) {
    const selected = el instanceof HTMLOptionElement ? el.selected : boolAttr(el, "aria-selected");
    if (selected !== undefined)
      addProp(props, "selected", "booleanOrUndefined", selected, { includeFalse: true });
  }
  addAriaProp(props, el, role, "aria-modal", "modal", "boolean", ariaBool(el, "aria-modal"));

  // --- Relationships (FillRelationships then FillSparseAttributes order) ---
  addRelationProp(options, props, el, "aria-describedby", "describedby", "idrefList");
  addRelationProp(options, props, el, "aria-owns", "owns", "idrefList");
  addAriaProp(props, el, role, "aria-busy", "busy", "boolean", ariaBool(el, "aria-busy"));
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
  addRelationProp(options, props, el, "aria-activedescendant", "activedescendant", "idref", {
    omitValue: true,
  });
  addRelationProp(options, props, el, "aria-errormessage", "errormessage", "idrefList");
  addRelationProp(options, props, el, "aria-controls", "controls", "idrefList");
  addRelationProp(options, props, el, "aria-details", "details", "idrefList");
  addRelationProp(options, props, el, "aria-flowto", "flowto", "idrefList");
  addRelationProp(options, props, el, "aria-labelledby", "labelledby", "nodeList");
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
    role: roleNameValue("StaticText"),
    name: ax("computedString", marker),
    parentId: markerId,
    backendDOMNodeId: options.registry.backendIdFor(el),
    childIds: [],
  });
  out.push({
    nodeId: markerId,
    ignored: false,
    role: roleNameValue("ListMarker"),
    name: ax("computedString", marker),
    backendDOMNodeId: options.registry.backendIdFor(el),
    childIds: [textId],
  });
  return [markerId];
}

function buildAX(
  options: AXTreeOptions,
  node: Node,
  parentId: string | undefined,
  out: AXNode[],
  inheritedIgnore?: AXProperty,
  depthLeft: number = Number.POSITIVE_INFINITY,
): string[] {
  if (isText(node)) {
    const text = textValue(node);
    if (!text) return [];
    const nodeId = axIdFor(node);
    // An ignored text node is anonymized to role:none with no name on the
    // getFullAXTree path, like any other ignored node; queryAXTree's
    // forceNameAndRole keeps the real StaticText role + text.
    const anonymized = Boolean(inheritedIgnore) && !options.forceNameAndRole;
    out.push({
      nodeId,
      ignored: Boolean(inheritedIgnore),
      ...(inheritedIgnore ? { ignoredReasons: [inheritedIgnore] } : {}),
      role: anonymized ? ax("role", "none") : roleNameValue("StaticText"),
      ...(anonymized ? {} : { name: ax("computedString", text) }),
      parentId,
      backendDOMNodeId: options.registry.backendIdFor(node.parentElement || node),
      childIds: [],
    });
    return [nodeId];
  }

  if (node.nodeType === Node.DOCUMENT_NODE) {
    const nodeId = axIdFor(node);
    const root: AXNode = {
      nodeId,
      ignored: false,
      role: roleNameValue("RootWebArea"),
      // Chromium's RootWebArea name is the document title (empty when untitled);
      // its backend node is the Document, and frameId appears only here (the root).
      name: ax("computedString", options.document.title || ""),
      backendDOMNodeId: options.registry.backendIdFor(options.document),
      childIds: [],
      frameId: options.frameId,
    };
    out.push(root);
    root.childIds = buildAX(
      options,
      options.document.documentElement,
      nodeId,
      out,
      undefined,
      depthLeft,
    );
    return [nodeId];
  }

  if (!isElement(node)) return [];
  const reasonIgnored = ignoredReasonFor(node, options) ?? inheritedIgnore;
  if (reasonIgnored) {
    const nodeId = axIdFor(node);
    // Recurse into still-rendered-but-ignored subtrees (aria-hidden / inert /
    // presentational) so descendants stay discoverable, mirroring Chromium's
    // "ignored but included in tree" model. Presentational inheritance only flows
    // to required-owned children (a list's items, a table's rows/cells).
    const childReason =
      reasonIgnored.name === "presentationalRole" && !PRESENTATIONAL_INHERITS.has(node.localName)
        ? undefined
        : subtreeReason(reasonIgnored.name, node, options);
    const children =
      RENDERED_IGNORED_REASONS.has(reasonIgnored.name) && depthLeft > 0
        ? composedChildren(node).flatMap((child) =>
            buildAX(options, child, undefined, out, childReason, depthLeft - 1),
          )
        : [];
    // Chromium serializes ignored nodes with role:none and no name on the
    // getFullAXTree path; only the queryAXTree force_name_and_role path keeps the
    // element's real role + name.
    const forced = options.forceNameAndRole ? roleOf(node) : null;
    out.push({
      nodeId,
      ignored: true,
      ignoredReasons: [reasonIgnored],
      role: options.forceNameAndRole
        ? forced
          ? ax("role", forced)
          : undefined
        : ax("role", "none"),
      ...(options.forceNameAndRole
        ? {
            name: ax(
              "computedString",
              forced ? accessibleNameFor(node, forced) : computeAccessibleName(node),
            ),
          }
        : {}),
      parentId,
      backendDOMNodeId: options.registry.backendIdFor(node),
      childIds: children,
    });
    for (const childId of children) {
      const child = out.find((item) => item.nodeId === childId);
      if (child) child.parentId = nodeId;
    }
    return [nodeId];
  }

  const role = roleOf(node);
  const children =
    depthLeft <= 0
      ? []
      : [
          ...buildListMarkerAX(options, node, out),
          ...composedChildren(node).flatMap((child) =>
            buildAX(options, child, undefined, out, undefined, depthLeft - 1),
          ),
        ];
  if (!role && !computeAccessibleName(node).trim()) return children;

  const nodeId = axIdFor(node);
  const name = role ? accessibleNameFor(node, role) : computeAccessibleName(node);
  const nameValue = ax("computedString", name);
  nameValue.sources = nameSources(options, node, role || "generic");
  const description = computeAccessibleDescription(node);
  const axNode: AXNode = {
    nodeId,
    ignored: false,
    role: roleNameValue(role || "generic"),
    name: nameValue,
    description: description ? ax("computedString", description) : undefined,
    value: role ? valueFor(node, role) : undefined,
    properties: role ? propertiesFor(options, node, role) : undefined,
    parentId,
    backendDOMNodeId: options.registry.backendIdFor(node),
    childIds: children,
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
  depth?: number,
): Protocol.Accessibility.GetFullAXTreeResponse {
  const nodes: AXNode[] = [];
  buildAX(
    options,
    options.document,
    undefined,
    nodes,
    undefined,
    depth && depth > 0 ? depth : undefined,
  );
  return { nodes };
}

/** Resolve a DOM backend-node id to its emitted AX node, if one exists. */
function axNodeForBackendId(
  options: AXTreeOptions,
  nodes: AXNode[],
  backendId: Protocol.DOM.BackendNodeId,
): AXNode | undefined {
  const dom = options.registry.nodeForBackendId(backendId);
  if (!dom) return undefined;
  const axId = nodeToAXId.get(dom);
  return axId ? nodes.find((node) => node.nodeId === axId) : undefined;
}

function ancestorChain(byId: Map<string, AXNode>, start: AXNode | undefined): AXNode[] {
  const chain: AXNode[] = [];
  for (let cur = start; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined)
    chain.push(cur);
  return chain;
}

/**
 * Fetch the AX node for a DOM node plus its ancestors and (by default) its
 * immediate relatives. With no target, returns the whole tree (back-compat).
 */
export function getPartialAXTree(
  options: AXTreeOptions,
  target?: Protocol.DOM.BackendNodeId,
  fetchRelatives = true,
): Protocol.Accessibility.GetPartialAXTreeResponse {
  const { nodes } = getFullAXTree(options);
  if (target == null) return { nodes };
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const start = axNodeForBackendId(options, nodes, target);
  if (!start) return { nodes: [] };
  const picked = new Map<string, AXNode>(
    ancestorChain(byId, start).map((node) => [node.nodeId, node]),
  );
  if (fetchRelatives) {
    const parent = start.parentId ? byId.get(start.parentId) : undefined;
    for (const id of [...(parent?.childIds ?? []), ...(start.childIds ?? [])]) {
      const relative = byId.get(id);
      if (relative) picked.set(relative.nodeId, relative);
    }
  }
  return { nodes: [...picked.values()] };
}

/** The root (RootWebArea) AX node of the document. */
export function getRootAXNode(
  options: AXTreeOptions,
): Protocol.Accessibility.GetRootAXNodeResponse {
  const { nodes } = getFullAXTree(options);
  const root = nodes.find((node) => !node.parentId);
  if (!root) throw new Error("no root AX node");
  return { node: root };
}

/** The direct children of the AX node with the given AX id. */
export function getChildAXNodes(
  options: AXTreeOptions,
  id: string,
): Protocol.Accessibility.GetChildAXNodesResponse {
  const { nodes } = getFullAXTree(options);
  const parent = nodes.find((node) => node.nodeId === id);
  if (!parent) return { nodes: [] };
  const childIds = new Set(parent.childIds ?? []);
  return { nodes: nodes.filter((node) => childIds.has(node.nodeId)) };
}

/** The AX node for a DOM node together with every ancestor up to the root. */
export function getAXNodeAndAncestors(
  options: AXTreeOptions,
  target: Protocol.DOM.BackendNodeId,
): Protocol.Accessibility.GetAXNodeAndAncestorsResponse {
  const { nodes } = getFullAXTree(options);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  return { nodes: ancestorChain(byId, axNodeForBackendId(options, nodes, target)) };
}

/** All AX nodes in a subtree matching the given accessible name and/or role. */
export function queryAXTree(
  options: AXTreeOptions,
  query: { target?: Protocol.DOM.BackendNodeId; accessibleName?: string; role?: string },
): Protocol.Accessibility.QueryAXTreeResponse {
  // Chromium's queryAXTree forces real role + name even on ignored nodes, so
  // hidden elements remain findable by role/name.
  const { nodes } = getFullAXTree({ ...options, forceNameAndRole: true });
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root =
    query.target == null
      ? nodes.find((node) => !node.parentId)
      : axNodeForBackendId(options, nodes, query.target);
  if (!root) return { nodes: [] };
  const subtree: AXNode[] = [];
  const stack: AXNode[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    subtree.push(node);
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) stack.push(child);
    }
  }
  return {
    nodes: subtree.filter((node) => {
      if (query.role != null && node.role?.value !== query.role) return false;
      if (query.accessibleName != null && node.name?.value !== query.accessibleName) return false;
      return true;
    }),
  };
}
