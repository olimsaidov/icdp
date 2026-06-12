import type { ARIAProperty } from "aria-query";
import { roles as ariaRoles } from "aria-query";
import type Protocol from "devtools-protocol";
import { computeAccessibleDescription, getRole } from "dom-accessibility-api";

type AXValue = Protocol.Accessibility.AXValue;
type AXValueSource = Protocol.Accessibility.AXValueSource;
type AXProperty = Protocol.Accessibility.AXProperty;
type AXRelatedNode = Protocol.Accessibility.AXRelatedNode;
type AXPropertyName = Protocol.Accessibility.AXPropertyName;
type AXValueType = Protocol.Accessibility.AXValueType;
// `chromeRole` is in the CDP spec but may lag in the devtools-protocol package.
type AXNode = Protocol.Accessibility.AXNode & { chromeRole?: AXValue };

export type DomRegistry = {
  backendIdFor(node: Node): Protocol.DOM.BackendNodeId;
  nodeForBackendId(id: Protocol.DOM.BackendNodeId): Node | undefined;
};

type AXTreeOptions = {
  document: Document;
  frameId: Protocol.Page.FrameId;
  registry: DomRegistry;
};

// ax::mojom::Role ordinals from ui/accessibility/ax_enums.mojom (explicit, stable values).
const MOJOM_ROLE_ORDINALS: Record<string, number> = {
  None: 0,
  Abbr: 1,
  Alert: 2,
  AlertDialog: 3,
  Application: 4,
  Article: 5,
  Audio: 6,
  Banner: 7,
  Blockquote: 8,
  Button: 9,
  Canvas: 10,
  Caption: 11,
  Caret: 12,
  Cell: 13,
  CheckBox: 14,
  Client: 15,
  Code: 16,
  ColorWell: 17,
  Column: 18,
  ColumnHeader: 19,
  ComboBoxGrouping: 20,
  ComboBoxMenuButton: 21,
  Complementary: 22,
  Comment: 23,
  ContentDeletion: 24,
  ContentInsertion: 25,
  ContentInfo: 26,
  Date: 27,
  DateTime: 28,
  Definition: 29,
  DescriptionList: 30,
  DescriptionListDetailDeprecated: 31,
  DescriptionListTermDeprecated: 32,
  Desktop: 33,
  Details: 34,
  Dialog: 35,
  DirectoryDeprecated: 36,
  DisclosureTriangle: 37,
  DocAbstract: 38,
  DocAcknowledgments: 39,
  DocAfterword: 40,
  DocAppendix: 41,
  DocBackLink: 42,
  DocBiblioEntry: 43,
  DocBibliography: 44,
  DocBiblioRef: 45,
  DocChapter: 46,
  DocColophon: 47,
  DocConclusion: 48,
  DocCover: 49,
  DocCredit: 50,
  DocCredits: 51,
  DocDedication: 52,
  DocEndnote: 53,
  DocEndnotes: 54,
  DocEpigraph: 55,
  DocEpilogue: 56,
  DocErrata: 57,
  DocExample: 58,
  DocFootnote: 59,
  DocForeword: 60,
  DocGlossary: 61,
  DocGlossRef: 62,
  DocIndex: 63,
  DocIntroduction: 64,
  DocNoteRef: 65,
  DocNotice: 66,
  DocPageBreak: 67,
  DocPageFooter: 68,
  DocPageHeader: 69,
  DocPageList: 70,
  DocPart: 71,
  DocPreface: 72,
  DocPrologue: 73,
  DocPullquote: 74,
  DocQna: 75,
  DocSubtitle: 76,
  DocTip: 77,
  DocToc: 78,
  Document: 79,
  EmbeddedObject: 80,
  Emphasis: 81,
  Feed: 82,
  Figcaption: 83,
  Figure: 84,
  Footer: 85,
  SectionFooter: 86,
  Form: 87,
  GenericContainer: 88,
  GraphicsDocument: 89,
  GraphicsObject: 90,
  GraphicsSymbol: 91,
  Grid: 92,
  Group: 93,
  Header: 94,
  SectionHeader: 95,
  Heading: 96,
  Iframe: 97,
  IframePresentational: 98,
  Image: 99,
  ImeCandidate: 100,
  InlineTextBox: 101,
  InputTime: 102,
  Keyboard: 103,
  LabelText: 104,
  LayoutTable: 105,
  LayoutTableCell: 106,
  LayoutTableRow: 107,
  Legend: 108,
  LineBreak: 109,
  Link: 110,
  List: 111,
  ListBox: 112,
  ListBoxOption: 113,
  ListGrid: 114,
  ListItem: 115,
  ListMarker: 116,
  Log: 117,
  Main: 118,
  Mark: 119,
  Marquee: 120,
  Math: 121,
  Menu: 122,
  MenuBar: 123,
  MenuItem: 124,
  MenuItemCheckBox: 125,
  MenuItemRadio: 126,
  MenuListOption: 127,
  MenuListPopup: 128,
  Meter: 129,
  Navigation: 130,
  Note: 131,
  Pane: 132,
  Paragraph: 133,
  PdfActionableHighlight: 134,
  PdfRoot: 135,
  PluginObject: 136,
  PopUpButton: 137,
  PortalDeprecated: 138,
  PreDeprecated: 139,
  ProgressIndicator: 140,
  RadioButton: 141,
  RadioGroup: 142,
  Region: 143,
  RootWebArea: 144,
  Row: 145,
  RowGroup: 146,
  RowHeader: 147,
  Ruby: 148,
  RubyAnnotation: 149,
  ScrollBar: 150,
  ScrollView: 151,
  Search: 152,
  SearchBox: 153,
  Section: 154,
  Slider: 155,
  SpinButton: 156,
  Splitter: 157,
  StaticText: 158,
  Status: 159,
  Strong: 160,
  Suggestion: 161,
  SvgRoot: 162,
  Switch: 163,
  Tab: 164,
  TabList: 165,
  TabPanel: 166,
  Table: 167,
  TableHeaderContainer: 168,
  Term: 169,
  TextField: 170,
  TextFieldWithComboBox: 171,
  Time: 172,
  Timer: 173,
  TitleBar: 174,
  ToggleButton: 175,
  Toolbar: 176,
  Tooltip: 177,
  Tree: 178,
  TreeGrid: 179,
  TreeItem: 180,
  Unknown: 181,
  Video: 182,
  WebView: 183,
  Window: 184,
  Subscript: 185,
  Superscript: 186,
  MathMLMath: 187,
  MathMLFraction: 188,
  MathMLIdentifier: 189,
  MathMLMultiscripts: 190,
  MathMLNoneScript: 191,
  MathMLNumber: 192,
  MathMLOperator: 193,
  MathMLOver: 194,
  MathMLPrescriptDelimiter: 195,
  MathMLRoot: 196,
  MathMLRow: 197,
  MathMLSquareRoot: 198,
  MathMLStringLiteral: 199,
  MathMLSub: 200,
  MathMLSubSup: 201,
  MathMLSup: 202,
  MathMLTable: 203,
  MathMLTableCell: 204,
  MathMLTableRow: 205,
  MathMLText: 206,
  MathMLUnder: 207,
  MathMLUnderOver: 208,
  ComboBoxSelect: 209,
  DisclosureTriangleGrouped: 210,
  SectionWithoutName: 211,
  GridCell: 212,
  MenuItemSeparator: 213,
};

// ARIA role name -> Blink internal role (first internalRoles entry in aria_properties.json5).
const ARIA_TO_MOJOM: Record<string, string> = {
  alert: "Alert",
  alertdialog: "AlertDialog",
  application: "Application",
  article: "Article",
  banner: "Banner",
  blockquote: "Blockquote",
  button: "Button",
  caption: "Caption",
  cell: "Cell",
  checkbox: "CheckBox",
  code: "Code",
  columnheader: "ColumnHeader",
  combobox: "ComboBoxGrouping",
  comment: "Comment",
  complementary: "Complementary",
  contentinfo: "ContentInfo",
  definition: "Definition",
  deletion: "ContentDeletion",
  dialog: "Dialog",
  directory: "List",
  "doc-abstract": "DocAbstract",
  "doc-acknowledgments": "DocAcknowledgments",
  "doc-afterword": "DocAfterword",
  "doc-appendix": "DocAppendix",
  "doc-backlink": "DocBackLink",
  "doc-biblioentry": "DocBiblioEntry",
  "doc-bibliography": "DocBibliography",
  "doc-biblioref": "DocBiblioRef",
  "doc-chapter": "DocChapter",
  "doc-colophon": "DocColophon",
  "doc-conclusion": "DocConclusion",
  "doc-cover": "DocCover",
  "doc-credit": "DocCredit",
  "doc-credits": "DocCredits",
  "doc-dedication": "DocDedication",
  "doc-endnote": "DocEndnote",
  "doc-endnotes": "DocEndnotes",
  "doc-epigraph": "DocEpigraph",
  "doc-epilogue": "DocEpilogue",
  "doc-errata": "DocErrata",
  "doc-example": "DocExample",
  "doc-footnote": "DocFootnote",
  "doc-foreword": "DocForeword",
  "doc-glossary": "DocGlossary",
  "doc-glossref": "DocGlossRef",
  "doc-index": "DocIndex",
  "doc-introduction": "DocIntroduction",
  "doc-noteref": "DocNoteRef",
  "doc-notice": "DocNotice",
  "doc-pagebreak": "DocPageBreak",
  "doc-pagefooter": "DocPageFooter",
  "doc-pageheader": "DocPageHeader",
  "doc-pagelist": "DocPageList",
  "doc-part": "DocPart",
  "doc-preface": "DocPreface",
  "doc-prologue": "DocPrologue",
  "doc-pullquote": "DocPullquote",
  "doc-qna": "DocQna",
  "doc-subtitle": "DocSubtitle",
  "doc-tip": "DocTip",
  "doc-toc": "DocToc",
  document: "Document",
  emphasis: "Emphasis",
  feed: "Feed",
  figure: "Figure",
  form: "GenericContainer",
  "graphics-document": "GraphicsDocument",
  "graphics-object": "GraphicsObject",
  "graphics-symbol": "GraphicsSymbol",
  grid: "Grid",
  gridcell: "GridCell",
  group: "Group",
  heading: "Heading",
  image: "Image",
  img: "Image",
  insertion: "ContentInsertion",
  link: "Link",
  list: "List",
  listbox: "ListBox",
  listitem: "ListItem",
  log: "Log",
  main: "Main",
  mark: "Mark",
  marquee: "Marquee",
  math: "Math",
  menu: "Menu",
  menubar: "MenuBar",
  menuitem: "MenuItem",
  menuitemcheckbox: "MenuItemCheckBox",
  menuitemradio: "MenuItemRadio",
  meter: "Meter",
  navigation: "Navigation",
  none: "None",
  note: "Note",
  option: "ListBoxOption",
  paragraph: "Paragraph",
  presentation: "None",
  progressbar: "ProgressIndicator",
  radio: "RadioButton",
  radiogroup: "RadioGroup",
  region: "Region",
  row: "Row",
  rowgroup: "RowGroup",
  rowheader: "RowHeader",
  scrollbar: "ScrollBar",
  search: "Search",
  searchbox: "SearchBox",
  section: "Section",
  sectionfooter: "SectionFooter",
  sectionheader: "SectionHeader",
  separator: "Splitter",
  slider: "Slider",
  spinbutton: "SpinButton",
  status: "Status",
  strong: "Strong",
  subscript: "Subscript",
  suggestion: "Suggestion",
  superscript: "Superscript",
  switch: "Switch",
  tab: "Tab",
  table: "Table",
  tablist: "TabList",
  tabpanel: "TabPanel",
  term: "Term",
  textbox: "TextField",
  time: "Time",
  timer: "Timer",
  toolbar: "Toolbar",
  tooltip: "Tooltip",
  tree: "Tree",
  treegrid: "TreeGrid",
  treeitem: "TreeItem",
  window: "Window",
};

// Roles whose name is prohibited (nameFrom: ["prohibited"] in aria_properties.json5):
// only the aria-labelledby / aria-label candidates are considered, and no others.
const NAME_PROHIBITED_ROLES = new Set([
  "caption",
  "code",
  "definition",
  "deletion",
  "emphasis",
  "insertion",
  "mark",
  "none",
  "paragraph",
  "strong",
  "subscript",
  "suggestion",
  "superscript",
  "term",
  "time",
  "generic",
]);

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

function normalizeText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

// Wire roles serialized with AXValue type "internalRole" (no ARIA equivalent;
// Chromium's AXObject::RoleName is_internal flag).
const INTERNAL_WIRE_ROLES = new Set([
  "StaticText",
  "RootWebArea",
  "ListMarker",
  "DisclosureTriangle",
  "LabelText",
  "Iframe",
  "Canvas",
  "MenuListPopup",
  "MathMLMath",
  "MathMLIdentifier",
  "MathMLOperator",
  "MathMLNumber",
]);

function roleNameValue(role: string): AXValue {
  return ax(INTERNAL_WIRE_ROLES.has(role) ? "internalRole" : "role", role);
}

function chromeRoleValue(mojomName: string): AXValue {
  return ax("internalRole", MOJOM_ROLE_ORDINALS[mojomName] ?? 0);
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

type RoleInfo = {
  wire: string | null; // null → no semantic role (generic/none decision elsewhere)
  mojom: string; // Blink-internal role name for chromeRole
};

const TEXT_ENTRY_INPUTS = new Set(["", "text", "email", "url", "tel", "password", "search"]);

function inputRole(el: HTMLInputElement): RoleInfo {
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "checkbox") return { wire: "checkbox", mojom: "CheckBox" };
  if (type === "radio") return { wire: "radio", mojom: "RadioButton" };
  if (type === "range") return { wire: "slider", mojom: "Slider" };
  if (type === "number") return { wire: "spinbutton", mojom: "SpinButton" };
  if (type === "search") return { wire: "searchbox", mojom: "SearchBox" };
  if (type === "color") return { wire: "ColorWell", mojom: "ColorWell" };
  if (type === "date") return { wire: "Date", mojom: "Date" };
  if (["datetime-local", "month", "week"].includes(type))
    return { wire: "DateTime", mojom: "DateTime" };
  if (type === "time") return { wire: "InputTime", mojom: "InputTime" };
  if (["button", "submit", "reset", "image"].includes(type))
    return { wire: "button", mojom: "Button" };
  return { wire: "textbox", mojom: "TextField" };
}

/** The element's native (non-ARIA) role, Chromium-aligned. */
function nativeRole(el: Element): RoleInfo {
  const tag = el.localName;
  const none: RoleInfo = { wire: null, mojom: "GenericContainer" };
  if (tag === "html" || tag === "body") return none;
  if (tag === "math") return { wire: "MathMLMath", mojom: "MathMLMath" };
  if (tag === "mi") return { wire: "MathMLIdentifier", mojom: "MathMLMath" };
  if (tag === "mo") return { wire: "MathMLOperator", mojom: "MathMLMath" };
  if (tag === "mn") return { wire: "MathMLNumber", mojom: "MathMLMath" };
  if (tag === "summary")
    return el.parentElement?.localName === "details"
      ? { wire: "DisclosureTriangle", mojom: "DisclosureTriangle" }
      : none;
  if (tag === "label") return { wire: "LabelText", mojom: "LabelText" };
  if (tag === "iframe" || tag === "frame") return { wire: "Iframe", mojom: "Iframe" };
  if (tag === "svg") return { wire: "image", mojom: "Image" };
  if (tag === "img") {
    // alt="" is presentational unless a global attribute keeps it interesting.
    if (
      el.getAttribute("alt") === "" &&
      !el.hasAttribute("title") &&
      !el.hasAttribute("aria-label") &&
      !el.hasAttribute("aria-labelledby")
    )
      return none;
    return { wire: "image", mojom: "Image" };
  }
  if (tag === "button") return { wire: "button", mojom: "Button" };
  if (tag === "a" && el.hasAttribute("href")) return { wire: "link", mojom: "Link" };
  if (tag === "textarea") return { wire: "textbox", mojom: "TextField" };
  if (el instanceof HTMLInputElement) return inputRole(el);
  if (tag === "select")
    return el.hasAttribute("multiple")
      ? { wire: "listbox", mojom: "ListBox" }
      : { wire: "combobox", mojom: "ComboBoxSelect" };
  if (tag === "option") return { wire: "option", mojom: "MenuListOption" };
  if (tag === "optgroup") return { wire: "group", mojom: "Group" };
  if (tag === "p") return { wire: "paragraph", mojom: "Paragraph" };
  if (/^h[1-6]$/.test(tag)) return { wire: "heading", mojom: "Heading" };
  if (tag === "ul" || tag === "ol") return { wire: "list", mojom: "List" };
  if (tag === "li") return { wire: "listitem", mojom: "ListItem" };
  if (tag === "table") return { wire: "table", mojom: "Table" };
  if (tag === "thead" || tag === "tfoot") return { wire: "rowgroup", mojom: "RowGroup" };
  if (tag === "tr") return { wire: "row", mojom: "Row" };
  if (tag === "td") return { wire: "cell", mojom: "Cell" };
  if (tag === "th") return { wire: "columnheader", mojom: "ColumnHeader" };
  if (tag === "nav") return { wire: "navigation", mojom: "Navigation" };
  if (tag === "main") return { wire: "main", mojom: "Main" };
  if (tag === "dialog") return { wire: "dialog", mojom: "Dialog" };
  if (tag === "canvas") return { wire: "Canvas", mojom: "Canvas" };
  const computed = getRole(el);
  if (computed && computed !== "generic" && ariaRoles.has(computed as never))
    return { wire: computed, mojom: ARIA_TO_MOJOM[computed] ?? "Unknown" };
  return none;
}

function roleInfoOf(el: Element): RoleInfo {
  const override = (el as { __agentAX?: { role?: unknown } }).__agentAX?.role;
  if (typeof override === "string" && override)
    return { wire: override, mojom: ARIA_TO_MOJOM[override] ?? "Unknown" };
  const explicit = explicitRole(el);
  if (explicit && explicit !== "none" && explicit !== "presentation") {
    const wire = explicit === "img" ? "image" : explicit;
    return { wire, mojom: ARIA_TO_MOJOM[explicit] ?? "Unknown" };
  }
  return nativeRole(el);
}

// ---------------------------------------------------------------------------
// Visibility / classification helpers
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set([
  "head",
  "style",
  "script",
  "noscript",
  "template",
  "meta",
  "link",
  "base",
  "title",
  "datalist",
  "param",
  "track",
  "source",
  "col",
  "colgroup",
  "br",
]);

function isSkipped(el: Element): boolean {
  if (SKIP_TAGS.has(el.localName)) return true;
  if (el instanceof HTMLInputElement && el.type === "hidden") return true;
  return false;
}

function isUnrendered(el: Element): boolean {
  if ((el as HTMLElement).hidden) return true;
  if (el.localName === "dialog" && !el.hasAttribute("open")) return true;
  // children of a closed <details> (other than its summary) are not rendered
  const parent = el.parentElement;
  if (parent?.localName === "details" && !parent.hasAttribute("open") && el.localName !== "summary")
    return true;
  return getComputedStyle(el).display === "none";
}

function isInvisible(el: Element): boolean {
  const visibility = getComputedStyle(el).visibility;
  return visibility === "hidden" || visibility === "collapse";
}

function isElHiddenForText(el: Element): boolean {
  return (
    (el as HTMLElement).hidden ||
    el.getAttribute("aria-hidden") === "true" ||
    getComputedStyle(el).display === "none" ||
    isInvisible(el)
  );
}

function hasHiddenAncestorOrSelf(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement)
    if (isElHiddenForText(cur)) return true;
  return false;
}

function isInlineLevel(el: Element): boolean {
  const display = getComputedStyle(el).display;
  if (display) return display.startsWith("inline") || display === "contents";
  return false;
}

function contentEditable(el: Element): boolean {
  const value = el.getAttribute("contenteditable");
  return value === "" || value === "true" || value === "plaintext-only";
}

function nativeDisabled(el: Element): boolean {
  return "disabled" in el && Boolean((el as { disabled?: boolean }).disabled);
}

function isFocusable(el: Element): boolean {
  if (nativeDisabled(el)) return false; // aria-disabled does not remove focusability
  const html = el as HTMLElement;
  if (html.tabIndex >= 0) return true;
  if (el.localName === "a" && el.hasAttribute("href")) return true;
  if (el.localName === "dialog" && el.hasAttribute("open")) return true;
  if (contentEditable(el)) return true;
  return ["button", "input", "select", "textarea", "option"].includes(el.localName);
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

// Required-owned children inherit their parent's presentational role
// (a list's items, a table's rows/sections, a row's cells) — nothing else does.
const REQUIRED_OWNED: Record<string, string[]> = {
  ul: ["li"],
  ol: ["li"],
  menu: ["li"],
  table: ["caption", "thead", "tbody", "tfoot", "tr"],
  thead: ["tr"],
  tbody: ["tr"],
  tfoot: ["tr"],
  tr: ["td", "th"],
};

function inheritsPresentation(parent: Element, child: Element): boolean {
  return REQUIRED_OWNED[parent.localName]?.includes(child.localName) ?? false;
}

function ignoredReason(name: AXPropertyName): AXProperty {
  return { name, value: ax("boolean", true) };
}

/** An ignored reason carrying a relatedNodes idref to the offending element
 *  (Chromium's CreateRelatedNodeListValue). */
function relatedReason(name: AXPropertyName, related: Element, registry: DomRegistry): AXProperty {
  const node: AXRelatedNode = { backendDOMNodeId: registry.backendIdFor(related) };
  const id = related.getAttribute("id");
  if (id) node.idref = id;
  return { name, value: { type: "idref", relatedNodes: [node] } };
}

// Dialogs opened via showModal(): jsdom's selector engine cannot answer
// :modal, so track the calls directly (harmless in real browsers, where the
// :modal check below already works).
const modalDialogs = new WeakSet<Element>();
(() => {
  const proto = (
    globalThis as unknown as { HTMLDialogElement?: { prototype: Record<string, unknown> } }
  ).HTMLDialogElement?.prototype;
  if (!proto) return;
  const showModal = proto.showModal as ((...args: unknown[]) => unknown) | undefined;
  if (showModal && (showModal as { __axPatched?: boolean }).__axPatched) return;
  proto.showModal = function (this: Element, ...args: unknown[]) {
    modalDialogs.add(this);
    if (showModal) return showModal.apply(this, args);
    this.setAttribute("open", ""); // jsdom lacks showModal entirely
    return undefined;
  };
  (proto.showModal as { __axPatched?: boolean }).__axPatched = true;
  const close = proto.close as ((...args: unknown[]) => unknown) | undefined;
  proto.close = function (this: Element, ...args: unknown[]) {
    modalDialogs.delete(this);
    if (close) return close.apply(this, args);
    this.removeAttribute("open");
    return undefined;
  };
})();

/** The open modal dialog blocking the rest of the document, if any. */
function openModalDialog(doc: Document): Element | null {
  for (const dialog of Array.from(doc.querySelectorAll("dialog[open]"))) {
    try {
      if (dialog.matches(":modal")) return dialog;
    } catch {
      // selector engine without :modal — fall through to the tracked set
    }
    if (modalDialogs.has(dialog)) return dialog;
  }
  return null;
}

/** ids referenced by any label/description relation — hidden elements so
 *  referenced stay in the AX tree (Blink's IsUsedForLabelOrDescription). */
function labelReferencedIds(doc: Document): Set<string> {
  const ids = new Set<string>();
  const attrs = ["aria-labelledby", "aria-labeledby", "aria-describedby", "aria-owns"];
  for (const attr of attrs) {
    for (const el of Array.from(doc.querySelectorAll(`[${attr}]`))) {
      for (const id of (el.getAttribute(attr) || "").trim().split(/\s+/)) if (id) ids.add(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// AX object tree
// ---------------------------------------------------------------------------

type AXObj = {
  id: string;
  node: Node;
  /** wire role for unignored serialization / forced role on ignored nodes */
  wireRole: string | null;
  mojom: string;
  ignored: boolean;
  /** participates in parent childIds / full tree / query traversal */
  included: boolean;
  reasons?: AXProperty[];
  /** suppress the computed name (aria-hidden / unrendered / presentational) */
  nameSuppressed?: boolean;
  parent?: AXObj;
  children: AXObj[];
  text?: string; // StaticText
  isRoot?: boolean;
  isPopup?: boolean; // synthetic MenuListPopup under a <select>
  markerText?: string;
};

type AXTree = {
  root: AXObj;
  byNode: Map<Node, AXObj>;
  byId: Map<string, AXObj>;
  options: AXTreeOptions;
  labelReferenced: Set<string>;
  modal: Element | null;
};

type WalkCtx = {
  ariaHiddenBy?: Element;
  inert?: boolean;
  blockedByModal?: boolean;
  presentational?: boolean;
  presentationalParent?: Element;
};

function buildTree(options: AXTreeOptions): AXTree {
  const tree: AXTree = {
    root: undefined as unknown as AXObj,
    byNode: new Map(),
    byId: new Map(),
    options,
    labelReferenced: labelReferencedIds(options.document),
    modal: openModalDialog(options.document),
  };

  const root: AXObj = {
    id: axIdFor(options.document),
    node: options.document,
    wireRole: "RootWebArea",
    mojom: "RootWebArea",
    ignored: false,
    included: true,
    children: [],
    isRoot: true,
  };
  tree.root = root;
  register(tree, root);
  const html = options.document.documentElement;
  if (html) root.children = walkElement(tree, html, root, {});
  return tree;
}

function register(tree: AXTree, obj: AXObj): void {
  tree.byNode.set(obj.node, obj);
  tree.byId.set(obj.id, obj);
}

function makeObj(
  tree: AXTree,
  node: Node,
  partial: Omit<AXObj, "id" | "node" | "children">,
): AXObj {
  const obj: AXObj = { id: axIdFor(node), node, children: [], ...partial };
  register(tree, obj);
  return obj;
}

/** Whether a hidden (unrendered / invisible) element stays in the AX tree. */
function hiddenButIncluded(tree: AXTree, el: Element): boolean {
  const id = el.getAttribute("id");
  if (id && tree.labelReferenced.has(id)) return true;
  if (el.hasAttribute("lang")) return true;
  if (el.localName === "label") return true;
  return ["table", "tbody", "thead", "tfoot", "tr", "td", "th"].includes(el.localName);
}

/** Whether an ignored-but-rendered element stays in the AX tree. Excluded
 *  nodes hoist their children to the nearest included ancestor and remain
 *  reachable only by direct inspection (Blink's IsIgnoredButIncludedInTree). */
function renderedIgnoredIncluded(tree: AXTree, el: Element): boolean {
  if (el.localName === "html" || el.localName === "body") return true;
  const id = el.getAttribute("id");
  if (id && tree.labelReferenced.has(id)) return true;
  if (el.hasAttribute("lang")) return true;
  if (["table", "tbody", "thead", "tfoot", "tr", "td", "th"].includes(el.localName)) return true;
  if (el.localName === "label") return true;
  // children of a <label> are kept for accname calculation — except spans
  if (el.parentElement?.localName === "label" && el.localName !== "span") return true;
  return false;
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

function numberAttr(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name);
  if (raw == null || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
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

/** Boundary-preserving StaticText value: internal whitespace collapses; a
 *  leading/trailing space survives only next to rendered inline siblings
 *  (approximates Blink's layout-driven text trimming). */
function staticTextValue(node: Text): string {
  const collapsed = (node.nodeValue || "").replace(/\s+/g, " ");
  if (!collapsed) return "";
  const inlineNeighbor = (dir: "previousSibling" | "nextSibling"): boolean => {
    for (let cur = node[dir]; cur; cur = cur[dir]) {
      if (isText(cur)) {
        if (normalizeText(cur.nodeValue)) return true;
        continue;
      }
      if (!isElement(cur)) continue;
      if (isUnrendered(cur)) return false;
      return isInlineLevel(cur) || ["img", "svg", "canvas"].includes(cur.localName);
    }
    return false;
  };
  let text = collapsed;
  if (text.startsWith(" ") && !inlineNeighbor("previousSibling")) text = text.slice(1);
  if (text.endsWith(" ") && !inlineNeighbor("nextSibling")) text = text.slice(0, -1);
  return text === " " ? "" : text;
}

/** Walk one element; returns the AXObjs to splice into the parent's children. */
function walkElement(tree: AXTree, el: Element, parent: AXObj, ctx: WalkCtx): AXObj[] {
  if (isSkipped(el)) return [];

  // --- unrendered / invisible subtrees: objects exist (for direct inspection)
  // but are mostly excluded from the tree, and never recurse text ---
  if (isUnrendered(el)) return [hiddenSubtree(tree, el, parent, "notRendered")].filter(included);
  if (isInvisible(el)) return [hiddenSubtree(tree, el, parent, "notVisible")].filter(included);

  const registry = tree.options.registry;
  const roleInfo = roleInfoOf(el);

  // --- ignored states (rendered) ---
  let reasons: AXProperty[] | undefined;
  let childCtx: WalkCtx = ctx;
  let nameSuppressed = false;
  let presentationalInherited = false;

  const blockedByModal =
    ctx.blockedByModal ||
    Boolean(tree.modal && !el.contains(tree.modal) && !tree.modal.contains(el));
  if (blockedByModal && tree.modal) {
    reasons = [relatedReason("activeModalDialog", tree.modal, registry)];
    childCtx = { ...ctx, blockedByModal: true };
  } else if (el.getAttribute("aria-hidden") === "true") {
    reasons = [ignoredReason("ariaHiddenElement")];
    childCtx = { ...ctx, ariaHiddenBy: el };
    nameSuppressed = true;
  } else if (ctx.ariaHiddenBy) {
    reasons = [relatedReason("ariaHiddenSubtree", ctx.ariaHiddenBy, registry)];
    childCtx = ctx;
    nameSuppressed = true;
  } else if (el.hasAttribute("inert") || ctx.inert) {
    // inherited inertness also reports inertElement (plain boolean)
    reasons = [ignoredReason("inertElement")];
    childCtx = { ...ctx, inert: true };
  } else if (
    isPresentational(el) ||
    (ctx.presentational &&
      ctx.presentationalParent &&
      inheritsPresentation(ctx.presentationalParent, el))
  ) {
    reasons = [ignoredReason("presentationalRole")];
    // inherited-presentational required-owned children (a list's items) stay
    // included in the tree, attached to the nearest included ancestor
    presentationalInherited = !isPresentational(el);
    childCtx = { ...ctx, presentational: true, presentationalParent: el };
    nameSuppressed = true;
    // a presentational element's role IS none (Blink RoleValue() == kNone)
    roleInfo.wire = null;
    roleInfo.mojom = "None";
  } else if (el.localName === "canvas" && !roleHasExplicit(el)) {
    reasons = [ignoredReason("probablyPresentational")];
    childCtx = ctx;
  } else if (roleInfo.wire === null && !isInterestingGeneric(el)) {
    reasons = [ignoredReason("uninteresting")];
    childCtx = ctx;
  } else {
    childCtx = { ...ctx, presentational: false, presentationalParent: undefined };
  }

  const dropText = Boolean(childCtx.ariaHiddenBy || childCtx.inert || childCtx.blockedByModal);

  // svg and iframe subtrees are leaves (vector content / other documents)
  const leaf = el.localName === "svg" || el.localName === "iframe" || el.localName === "frame";

  if (reasons) {
    const obj = makeObj(tree, el, {
      wireRole: roleInfo.wire,
      mojom: roleInfo.mojom,
      ignored: true,
      included: presentationalInherited || renderedIgnoredIncluded(tree, el),
      reasons,
      nameSuppressed,
    });
    const children = leaf ? [] : walkChildren(tree, el, obj, childCtx, dropText);
    if (obj.included) {
      obj.children = children;
      for (const child of children) child.parent = obj;
      obj.parent = parent;
      return [obj];
    }
    // excluded: children hoist to the nearest included ancestor
    obj.parent = parent;
    for (const child of children) child.parent = parent;
    return children;
  }

  // --- unignored ---
  const obj = makeObj(tree, el, {
    wireRole: roleInfo.wire ?? "generic",
    mojom: roleInfo.wire ? roleInfo.mojom : "GenericContainer",
    ignored: false,
    included: true,
  });
  obj.parent = parent;
  obj.markerText = listMarkerText(el);
  if (el instanceof HTMLSelectElement && !el.multiple) {
    // a single-select exposes a synthetic MenuListPopup holding its options
    const popup: AXObj = {
      id: `${obj.id}:popup`,
      node: el,
      wireRole: "MenuListPopup",
      mojom: "MenuListPopup",
      ignored: false,
      included: true,
      children: [],
      isPopup: true,
      parent: obj,
    };
    tree.byId.set(popup.id, popup);
    popup.children = walkChildren(tree, el, popup, childCtx, true);
    for (const child of popup.children) {
      child.parent = popup;
      child.children = []; // options are leaves (their text is their name)
    }
    obj.children = [popup];
    return [obj];
  }
  obj.children = leaf ? [] : walkChildren(tree, el, obj, childCtx, dropText);
  for (const child of obj.children) child.parent = obj;
  return [obj];
}

function included(obj: AXObj): boolean {
  return obj.included;
}

function roleHasExplicit(el: Element): boolean {
  return explicitRole(el) !== null;
}

/** A role-less element is an exposed `generic` when it is block-level, named,
 *  or focusable; inline/contents wrappers are ignored as uninteresting. */
function isInterestingGeneric(el: Element): boolean {
  if (el.localName === "html" || el.localName === "body") return false;
  if (
    normalizeText(el.getAttribute("aria-label")) ||
    el.hasAttribute("aria-labelledby") ||
    el.hasAttribute("aria-labeledby")
  )
    return true;
  if (isFocusable(el)) return true;
  if (getComputedStyle(el).display === "contents") return false;
  return !isInlineLevel(el);
}

function walkChildren(
  tree: AXTree,
  el: Element,
  parent: AXObj,
  ctx: WalkCtx,
  dropText: boolean,
): AXObj[] {
  const out: AXObj[] = [];
  for (const child of composedChildren(el)) {
    if (isText(child)) {
      if (dropText) continue;
      const text = staticTextValue(child);
      if (!text) continue;
      const obj = makeObj(tree, child, {
        wireRole: "StaticText",
        mojom: "StaticText",
        ignored: false,
        included: true,
        text,
      });
      obj.parent = parent;
      out.push(obj);
      continue;
    }
    if (isElement(child)) out.push(...walkElement(tree, child, parent, ctx));
  }
  return out;
}

/** Build the (excluded by default) object for an unrendered/invisible element
 *  and side-register its element descendants for direct inspection. */
function hiddenSubtree(
  tree: AXTree,
  el: Element,
  parent: AXObj,
  reason: "notRendered" | "notVisible",
): AXObj {
  const roleInfo = roleInfoOf(el);
  const obj = makeObj(tree, el, {
    wireRole: roleInfo.wire,
    mojom: roleInfo.mojom,
    ignored: true,
    included: hiddenButIncluded(tree, el),
    reasons: [ignoredReason(reason)],
    nameSuppressed: true,
  });
  obj.parent = parent;
  const registerDescendants = (cur: Element): void => {
    for (const child of Array.from(cur.children)) {
      if (isSkipped(child) || tree.byNode.has(child)) continue;
      const info = roleInfoOf(child);
      const childObj = makeObj(tree, child, {
        wireRole: info.wire,
        mojom: info.mojom,
        ignored: true,
        included: false,
        reasons: [ignoredReason(reason)],
        nameSuppressed: true,
      });
      childObj.parent = parent;
      registerDescendants(child);
    }
  };
  registerDescendants(el);
  return obj;
}

// ---------------------------------------------------------------------------
// Text equivalents (AccName contents)
// ---------------------------------------------------------------------------

/** Space-joined text equivalent of an element's contents. Skips hidden
 *  descendants unless `unfiltered`; descendant aria-labels and img alts
 *  substitute for their subtrees (Blink joins chunks with single spaces). */
function textEquivalent(root: Element, unfiltered = false): string {
  const chunks: string[] = [];
  const visit = (node: Node): void => {
    if (isText(node)) {
      const text = normalizeText(node.nodeValue);
      if (text) chunks.push(text);
      return;
    }
    if (!isElement(node)) return;
    if (isSkipped(node) && node.localName !== "title") return;
    if (!unfiltered && isElHiddenForText(node)) return;
    const ariaLabel = normalizeText(node.getAttribute("aria-label"));
    if (ariaLabel) {
      chunks.push(ariaLabel);
      return;
    }
    if (node.localName === "img" || (node instanceof HTMLInputElement && node.type === "image")) {
      const alt = normalizeText(node.getAttribute("alt"));
      // a presentational img with an alt contributes an empty chunk (Blink
      // leaves a double space in the raw source text), a plain one its alt
      if (isPresentational(node)) {
        if (node.hasAttribute("alt")) chunks.push("");
      } else if (alt) {
        chunks.push(alt);
      }
      return;
    }
    if (node instanceof HTMLInputElement) {
      const value = normalizeText(node.value);
      if (value) chunks.push(value);
      return;
    }
    for (const child of composedChildren(node)) visit(child);
    // aria-owns pulls the referenced elements into this node's contents
    for (const id of idRefs(node, "aria-owns")) {
      const owned = node.ownerDocument.getElementById(id);
      if (owned && !visited.has(owned)) {
        visited.add(owned);
        visit(owned);
      }
    }
  };
  const visited = new Set<Element>();
  for (const child of composedChildren(root)) visit(child);
  for (const id of idRefs(root, "aria-owns")) {
    const owned = root.ownerDocument.getElementById(id);
    if (owned && !visited.has(owned)) {
      visited.add(owned);
      visit(owned);
    }
  }
  return chunks.join(" ");
}

/** Text contributed by one aria-labelledby target: its aria-label wins;
 *  hidden targets contribute their full unfiltered subtree text; labelledby
 *  chains are NOT followed (the reference is non-recursive). */
function labelledbyTargetText(target: Element): string {
  const ariaLabel = normalizeText(target.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;
  return textEquivalent(target, hasHiddenAncestorOrSelf(target));
}

function labelText(label: Element): string {
  if (hasHiddenAncestorOrSelf(label)) return "";
  return textEquivalent(label);
}

// ---------------------------------------------------------------------------
// Name sources
// ---------------------------------------------------------------------------

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

function idRefs(el: Element, ...names: string[]): string[] {
  for (const name of names) {
    const raw = el.getAttribute(name);
    if (raw != null) return raw.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

type Candidate = {
  source: AXValueSource;
  /** null = source has no text at all; "" = computed but empty */
  value: string | null;
  related?: AXRelatedNode[]; // feeds the labelledby property when this wins
  /** wins the name even when its computed text is empty (native labels) */
  terminal?: boolean;
};

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

function labelledbyCandidate(tree: AXTree, el: Element): Candidate {
  const registry = tree.options.registry;
  const ids = idRefs(el, "aria-labelledby", "aria-labeledby");
  const source: AXValueSource = { type: "relatedElement", attribute: "aria-labelledby" };
  if (!ids.length) return { source, value: null };
  const targets = ids
    .map((id) => ({ id, el: el.ownerDocument.getElementById(id) }))
    .filter((t): t is { id: string; el: HTMLElement } => t.el != null);
  const texts = targets.map((t) => labelledbyTargetText(t.el));
  const joined = texts.filter(Boolean).join(" ");
  if (!joined) {
    // an unresolved or empty labelledby is invalid: the attribute value
    // degrades to a plain string and the name falls through to later sources
    source.attributeValue = { type: "string", value: el.getAttribute("aria-labelledby") ?? "" };
    source.invalid = true;
    return { source, value: null };
  }
  const related: AXRelatedNode[] = targets.map((t, i) => {
    const node: AXRelatedNode = { backendDOMNodeId: registry.backendIdFor(t.el), idref: t.id };
    if (texts[i]) node.text = texts[i];
    return node;
  });
  source.attributeValue = {
    type: "idrefList",
    value: ids.join(" "),
    ...(related.length ? { relatedNodes: related } : {}),
  };
  const propertyRelated: AXRelatedNode[] = targets.map((t, i) => ({
    backendDOMNodeId: registry.backendIdFor(t.el),
    idref: t.id,
    text: texts[i] ?? "",
  }));
  return { source, value: texts.filter(Boolean).join(" "), related: propertyRelated };
}

function attributeCandidate(
  el: Element,
  attribute: string,
  options: {
    sourceType?: AXValueSource["type"];
    defaultValue?: string;
    omitAttributeValue?: boolean;
  } = {},
): Candidate {
  const raw = el.getAttribute(attribute);
  const source: AXValueSource = { type: options.sourceType ?? "attribute", attribute };
  if (raw != null && raw !== "" && !options.omitAttributeValue)
    source.attributeValue = { type: "string", value: raw };
  const text = normalizeText(raw);
  if (text) return { source, value: text };
  if (options.defaultValue !== undefined && raw !== null)
    return { source, value: options.defaultValue };
  return { source, value: raw == null ? null : "" };
}

function nativeLabelCandidate(tree: AXTree, el: Element): Candidate {
  const registry = tree.options.registry;
  const labels = nativeLabels(el);
  const wrapped = labels.some((label) => label.contains(el));
  const nativeSource = labels.length ? (wrapped ? "labelwrapped" : "labelfor") : "label";
  const source: AXValueSource = { type: "relatedElement", nativeSource };
  if (!labels.length) return { source, value: null };
  const texts = labels.map((label) => labelText(label));
  source.nativeSourceValue = {
    type: "nodeList",
    relatedNodes: labels.map((label, i) => ({
      backendDOMNodeId: registry.backendIdFor(label),
      text: texts[i] ?? "",
    })),
  };
  const propertyRelated: AXRelatedNode[] = labels.map((label, i) => ({
    backendDOMNodeId: registry.backendIdFor(label),
    text: texts[i] ?? "",
  }));
  // an associated label terminates the name search even when its text is empty
  return {
    source,
    value: texts.filter(Boolean).join(" "),
    related: propertyRelated,
    terminal: true,
  };
}

function relatedElementCandidate(tree: AXTree, nativeSource: string, els: Element[]): Candidate {
  const registry = tree.options.registry;
  const source: AXValueSource = {
    type: "relatedElement",
    nativeSource: nativeSource as AXValueSource["nativeSource"],
  };
  if (!els.length) return { source, value: null };
  const texts = els.map((e) => textEquivalent(e));
  source.nativeSourceValue = {
    type: "nodeList",
    relatedNodes: els.map((e, i) => {
      const node: AXRelatedNode = { backendDOMNodeId: registry.backendIdFor(e) };
      if (texts[i]) node.text = texts[i];
      return node;
    }),
  };
  const propertyRelated: AXRelatedNode[] = els.map((e, i) => ({
    backendDOMNodeId: registry.backendIdFor(e),
    text: texts[i] ?? "",
  }));
  return { source, value: texts.filter(Boolean).join(" "), related: propertyRelated };
}

function contentsCandidate(el: Element, defaultValue = ""): Candidate {
  // a self-referencing aria-labelledby already consumed this node's contents
  // (Blink's visited-set recursion guard), leaving the contents source empty
  const id = el.getAttribute("id");
  if (id && idRefs(el, "aria-labelledby", "aria-labeledby").includes(id))
    return { source: { type: "contents" }, value: null };
  const text = textEquivalent(el) || defaultValue;
  return { source: { type: "contents" }, value: text || null };
}

function svgTitleCandidate(el: Element): Candidate {
  const title = Array.from(el.children).find((child) => child.localName === "title");
  const source: AXValueSource = { type: "relatedElement", nativeSource: "title" };
  if (!title) return { source, value: null };
  return { source, value: normalizeText(title.textContent) };
}

/** Ordered AccName candidates, element-specific (Chromium's NameSources). */
function nameCandidates(tree: AXTree, el: Element, role: string): Candidate[] {
  const base = [labelledbyCandidate(tree, el), attributeCandidate(el, "aria-label")];
  if (NAME_PROHIBITED_ROLES.has(role)) return base;

  const tag = el.localName;
  const title = () => attributeCandidate(el, "title");
  if (el instanceof HTMLInputElement) {
    const type = el.type;
    if (["button", "submit", "reset"].includes(type)) {
      const defaults: Record<string, string> = { submit: "Submit", reset: "Reset" };
      // the rendered label of a button input — its value attribute or the
      // type-specific default — doubles as the contents candidate
      const label = normalizeText(el.getAttribute("value")) || (defaults[type] ?? "");
      return [
        ...base,
        nativeLabelCandidate(tree, el),
        attributeCandidate(el, "value", { omitAttributeValue: true }),
        { source: { type: "contents" }, value: label || null },
        title(),
      ];
    }
    if (type === "image") {
      const typeSource: AXValueSource = { type: "attribute", attribute: "type" };
      const rawType = el.getAttribute("type");
      if (rawType) typeSource.attributeValue = { type: "string", value: rawType };
      const label =
        normalizeText(el.getAttribute("alt")) ||
        normalizeText(el.getAttribute("value")) ||
        normalizeText(el.getAttribute("title")) ||
        "Submit";
      return [
        ...base,
        nativeLabelCandidate(tree, el),
        attributeCandidate(el, "alt"),
        attributeCandidate(el, "value", { omitAttributeValue: true }),
        title(),
        { source: typeSource, value: "Submit" },
        { source: { type: "contents" }, value: label },
        title(),
      ];
    }
    if (TEXT_ENTRY_INPUTS.has(type) || type === "number") {
      return [
        ...base,
        nativeLabelCandidate(tree, el),
        title(),
        attributeCandidate(el, "placeholder", { sourceType: "placeholder" }),
        attributeCandidate(el, "aria-placeholder", { sourceType: "placeholder" }),
        title(),
      ];
    }
    const slots = [...base, nativeLabelCandidate(tree, el)];
    if (NAME_FROM_CONTENTS_ROLES.has(role)) slots.push(contentsCandidate(el));
    return [...slots, title()];
  }
  if (tag === "textarea")
    return [
      ...base,
      nativeLabelCandidate(tree, el),
      title(),
      attributeCandidate(el, "placeholder", { sourceType: "placeholder" }),
      attributeCandidate(el, "aria-placeholder", { sourceType: "placeholder" }),
      title(),
    ];
  if (tag === "img") {
    // alt="" is an explicit "no name": the empty alt wins (terminal) with its
    // empty attributeValue serialized, and no title slot follows
    if (el.getAttribute("alt") === "") {
      const source: AXValueSource = {
        type: "attribute",
        attribute: "alt",
        attributeValue: { type: "string", value: "" },
      };
      return [...base, { source, value: "", terminal: true }];
    }
    return [...base, attributeCandidate(el, "alt"), title()];
  }
  if (tag === "svg") return [...base, svgTitleCandidate(el), title()];
  if (tag === "figure") return [...base, title()];
  if (tag === "fieldset")
    return [...base, relatedElementCandidate(tree, "legend", queryChildren(el, "legend")), title()];
  if (tag === "table")
    return [
      ...base,
      relatedElementCandidate(tree, "tablecaption", queryChildren(el, "caption")),
      title(),
    ];
  const slots = [...base];
  if (isLabelable(el)) slots.push(nativeLabelCandidate(tree, el));
  if (NAME_FROM_CONTENTS_ROLES.has(role)) slots.push(contentsCandidate(el));
  slots.push(title());
  return slots;
}

function queryChildren(el: Element, selector: string): Element[] {
  const match = el.querySelector(selector);
  return match ? [match] : [];
}

type NameInfo = {
  value: string;
  sources: AXValueSource[];
  /** related nodes of the effective labelledby-ish source (for the property) */
  labelledbyRelated?: AXRelatedNode[];
  /** the name came from author ARIA (aria-label / aria-labelledby) */
  fromAuthorAria?: boolean;
};

function computeName(tree: AXTree, el: Element, role: string): NameInfo {
  const candidates = nameCandidates(tree, el, role);
  const winner = candidates.findIndex(
    (candidate) => candidate.value || (candidate.terminal && candidate.value !== null),
  );
  const sources = candidates.map((candidate, index) => {
    const source: AXValueSource = { ...candidate.source };
    if (index === winner) {
      source.value = ax("computedString", candidate.value);
    } else if (winner >= 0 && index > winner) {
      source.superseded = true;
      if (candidate.value) source.value = ax("computedString", candidate.value);
    }
    return source;
  });
  // the labelledby property reflects the winning labelledby/native-label source
  // (Chromium: name_source.text non-null && !superseded && related_objects)
  const effective =
    winner >= 0
      ? candidates[winner]
      : candidates.find((candidate) => candidate.value !== null && candidate.related?.length);
  // the wire name is whitespace-normalized; source values keep the raw join
  const value = winner >= 0 ? normalizeText(candidates[winner]?.value ?? "") : "";
  // the first two candidates are always aria-labelledby / aria-label
  return {
    value,
    sources,
    labelledbyRelated: effective?.related,
    fromAuthorAria: winner === 0 || winner === 1,
  };
}

/** RootWebArea name sources: Chromium emits this fixed quirky list. */
function rootNameSources(title: string): AXValueSource[] {
  const sources: AXValueSource[] = [
    { type: "relatedElement", attribute: "aria-labelledby" },
    { type: "attribute", attribute: "aria-label" },
    { type: "attribute", attribute: "aria-label", superseded: true },
  ];
  const native: AXValueSource = { type: "relatedElement", nativeSource: "title" };
  if (title) native.value = ax("computedString", title);
  sources.push(native);
  return sources;
}

// ---------------------------------------------------------------------------
// Properties / value / description
// ---------------------------------------------------------------------------

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
  if (nativeDisabled(el) || boolAttr(el, "aria-disabled") === true) return true;
  // aria-disabled propagates to descendants (Chromium's GetRestriction).
  for (let parent = el.parentElement; parent; parent = parent.parentElement)
    if (parent.getAttribute("aria-disabled") === "true") return true;
  return false;
}

const READONLY_ROLES = new Set([
  "grid",
  "gridcell",
  "textbox",
  "searchbox",
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
  "searchbox",
  "tree",
  "columnheader",
  "rowheader",
  "treegrid",
]);
const MULTISELECTABLE_ROLES = new Set(["grid", "listbox", "tablist", "treegrid", "tree"]);

function readonlyState(el: Element): boolean {
  if ("readOnly" in el && Boolean((el as { readOnly?: boolean }).readOnly)) return true;
  return boolAttr(el, "aria-readonly") === true;
}

function requiredState(el: Element): boolean {
  if ("required" in el && Boolean((el as { required?: boolean }).required)) return true;
  return boolAttr(el, "aria-required") === true;
}

function multiselectableState(el: Element): boolean {
  if (el instanceof HTMLSelectElement && el.multiple) return true;
  return boolAttr(el, "aria-multiselectable") === true;
}

function headingLevel(el: Element): number | undefined {
  const aria = Number(el.getAttribute("aria-level"));
  if (Number.isFinite(aria) && aria > 0) return aria;
  const match = /^h([1-6])$/.exec(el.localName);
  return match?.[1] ? Number(match[1]) : undefined;
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

const RANGE_ROLES = new Set([
  "slider",
  "scrollbar",
  "spinbutton",
  "progressbar",
  "meter",
  "separator",
]);

/** The numeric value for a range-valued element, or undefined to omit it. */
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
  const text = normalizeText(option.getAttribute("aria-label") || option.textContent);
  return text ? ax("string", text) : undefined;
}

function isTextEntryControl(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_ENTRY_INPUTS.has(el.type);
  return false;
}

function valueFor(el: Element, role: string): AXValue | undefined {
  const override = (el as { __agentAX?: { value?: unknown } }).__agentAX?.value;
  if (override !== undefined)
    return ax(typeof override === "number" ? "number" : "string", override as never);

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

  // only text-entry controls report their value (a checkbox's "on" or a
  // button input's label is not a value)
  if (isTextEntryControl(el)) {
    if (el instanceof HTMLInputElement && el.type === "password")
      return el.value ? ax("string", "•".repeat(el.value.length)) : undefined;
    const value = (el as HTMLInputElement | HTMLTextAreaElement).value;
    return value ? ax("string", value) : undefined;
  }

  // contenteditable elements report their text as the value.
  if (contentEditable(el)) {
    const text = normalizeText(el.textContent);
    return text ? ax("string", text) : undefined;
  }

  return undefined;
}

function ariaToken(el: Element, name: string): string | boolean | undefined {
  const value = el.getAttribute(name);
  if (value == null || value === "" || value === "undefined") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function relatedNodesFor(registry: DomRegistry, el: Element, ids: string[]): AXRelatedNode[] {
  return ids.flatMap((idref) => {
    const related = el.ownerDocument.getElementById(idref);
    if (!related) return [];
    return [{ backendDOMNodeId: registry.backendIdFor(related), idref }];
  });
}

function addRelationProp(
  registry: DomRegistry,
  props: AXProperty[],
  el: Element,
  attr: string,
  name: AXPropertyName,
  type: "idref" | "idrefList",
  settings: { omitValue?: boolean } = {},
): void {
  const ids = idRefs(el, attr);
  if (!ids.length) return;
  const value: AXValue = { type };
  if (!settings.omitValue && type === "idref") value.value = ids[0];
  if (!settings.omitValue && type === "idrefList") value.value = ids.join(" ");
  const relatedNodes = relatedNodesFor(registry, el, ids);
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

function liveStatus(el: Element, role: string): string | undefined {
  const aria = el.getAttribute("aria-live");
  if (aria && aria !== "off") return aria;
  if (role === "alert") return "assertive";
  if (role === "status" || role === "log") return "polite";
  return undefined;
}

/** The invalid token; native form controls always carry one (default false). */
function invalidToken(el: Element): string | undefined {
  const aria = el.getAttribute("aria-invalid");
  if (aria === "grammar" || aria === "spelling") return aria;
  if (aria === "true" || aria === "") return "true";
  if (aria === "false") return "false";
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLButtonElement
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
    return TEXT_ENTRY_INPUTS.has(el.type) ? "plaintext" : undefined;
  return undefined;
}

/** Only text-entry-like controls are settable (not checkboxes or buttons). */
function isSettable(el: Element): boolean {
  if (isTextEntryControl(el) || contentEditable(el)) return true;
  if (el instanceof HTMLInputElement)
    return ["number", "range", "color", "date", "datetime-local", "month", "week", "time"].includes(
      el.type,
    );
  return false;
}

function checkedState(el: Element, role: string): boolean | "mixed" | undefined {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio"))
    return el.indeterminate ? "mixed" : el.checked;
  const aria = tristateAttr(el, "aria-checked");
  if (aria !== undefined) return aria;
  return CHECK_DEFAULT_FALSE_ROLES.has(role) ? false : undefined;
}

function expandedState(el: Element): boolean | undefined {
  const aria = boolAttr(el, "aria-expanded");
  if (aria !== undefined) return aria;
  const details =
    el.localName === "details" ? el : el.localName === "summary" ? el.parentElement : null;
  if (details instanceof HTMLDetailsElement) return details.open;
  // a single-select <select> is a collapsed popup
  if (el instanceof HTMLSelectElement && !el.multiple) return false;
  return undefined;
}

function isModalDialog(tree: AXTree, el: Element): boolean {
  return tree.modal === el;
}

/** Where the dialog focusing steps put focus after showModal(): the first
 *  focusable descendant, else the dialog itself. jsdom never runs these
 *  steps, so emulate them when focus is still on the body. */
function modalFocusTarget(tree: AXTree): Element | null {
  if (!tree.modal) return null;
  const active = tree.options.document.activeElement;
  if (active && active !== tree.options.document.body && active.localName !== "html") return null;
  for (const el of Array.from(tree.modal.querySelectorAll("*")))
    if (!isUnrendered(el) && isFocusable(el)) return el;
  return tree.modal;
}

// propertiesFor follows Chromium's Fill* phase order:
//   live-region -> global states -> widget properties -> widget states -> relations
function propertiesFor(tree: AXTree, el: Element, role: string, name: NameInfo): AXProperty[] {
  const registry = tree.options.registry;
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
  const focused = el === el.ownerDocument.activeElement || el === modalFocusTarget(tree);
  addProp(props, "focused", "booleanOrUndefined", focused);
  addProp(props, "editable", "token", editableToken(el));
  if (isSettable(el)) addProp(props, "settable", "booleanOrUndefined", true);

  // --- Widget properties ---
  addProp(props, "autocomplete", "token", ariaToken(el, "aria-autocomplete"));
  const haspopup = el.getAttribute("aria-haspopup");
  if (haspopup && haspopup !== "false") addProp(props, "hasPopup", "token", haspopup);
  else if (el instanceof HTMLSelectElement && !el.multiple)
    addProp(props, "hasPopup", "token", "menu");
  addProp(props, "level", "integer", headingLevel(el));
  if (MULTISELECTABLE_ROLES.has(role))
    addProp(props, "multiselectable", "boolean", multiselectableState(el), { includeFalse: true });
  addProp(props, "orientation", "token", ariaToken(el, "aria-orientation"));
  if (role === "textbox" || role === "searchbox")
    addProp(
      props,
      "multiline",
      "boolean",
      el.localName === "textarea" || boolAttr(el, "aria-multiline") === true,
      { includeFalse: true },
    );
  if (READONLY_ROLES.has(role))
    addProp(props, "readonly", "boolean", readonlyState(el), { includeFalse: true });
  // native <select> (kComboBoxSelect) does not expose required, ARIA comboboxes do
  if (REQUIRED_ROLES.has(role) && !(el instanceof HTMLSelectElement))
    addProp(props, "required", "boolean", requiredState(el), { includeFalse: true });
  if (RANGE_ROLES.has(role)) {
    addProp(props, "valuemin", "number", numberAttr(el, "aria-valuemin") ?? nativeMin(el, role));
    addProp(props, "valuemax", "number", numberAttr(el, "aria-valuemax") ?? nativeMax(el, role));
    addProp(props, "valuetext", "string", el.getAttribute("aria-valuetext"));
  }
  if (role === "link" && el instanceof HTMLAnchorElement) addProp(props, "url", "string", el.href);
  if (role === "image" && el instanceof HTMLImageElement) addProp(props, "url", "string", el.src);
  if (el instanceof HTMLInputElement && el.type === "image")
    addProp(props, "url", "string", el.src);

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
  if (el.localName === "dialog") {
    // native dialogs always expose their modal state
    addProp(props, "modal", "boolean", isModalDialog(tree, el), { includeFalse: true });
  } else {
    addAriaProp(props, el, role, "aria-modal", "modal", "boolean", boolAttr(el, "aria-modal"), {
      includeFalse: true,
    });
  }

  // --- Relationships (FillRelationships then FillSparseAttributes order) ---
  addRelationProp(registry, props, el, "aria-describedby", "describedby", "idrefList");
  addRelationProp(registry, props, el, "aria-owns", "owns", "idrefList");
  addAriaProp(props, el, role, "aria-busy", "busy", "boolean", boolAttr(el, "aria-busy"));
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
  addRelationProp(registry, props, el, "aria-activedescendant", "activedescendant", "idref", {
    omitValue: true,
  });
  addRelationProp(registry, props, el, "aria-errormessage", "errormessage", "idrefList");
  addRelationProp(registry, props, el, "aria-controls", "controls", "idrefList");
  addRelationProp(registry, props, el, "aria-details", "details", "idrefList");
  addRelationProp(registry, props, el, "aria-flowto", "flowto", "idrefList");
  // labelledby reflects the WINNING name source (aria-labelledby or a native
  // label), not the mere presence of the attribute.
  if (name.labelledbyRelated?.length)
    props.push({
      name: "labelledby",
      value: { type: "nodeList", relatedNodes: name.labelledbyRelated },
    });
  return props;
}

// ---------------------------------------------------------------------------
// Wire serialization (Chromium's BuildProtocolAXNodeFor*)
// ---------------------------------------------------------------------------

function childWireIds(tree: AXTree, obj: AXObj): string[] {
  const ids: string[] = [];
  if (obj.markerText) ids.push(`${obj.id}:marker`);
  for (const child of obj.children) ids.push(child.id);
  return ids;
}

function markerNodes(tree: AXTree, obj: AXObj): AXNode[] {
  if (!obj.markerText) return [];
  const registry = tree.options.registry;
  const markerId = `${obj.id}:marker`;
  const textId = `${markerId}:text`;
  return [
    {
      nodeId: markerId,
      ignored: false,
      role: roleNameValue("ListMarker"),
      chromeRole: chromeRoleValue("ListMarker"),
      name: ax("computedString", obj.markerText),
      parentId: obj.id,
      backendDOMNodeId: registry.backendIdFor(obj.node),
      childIds: [textId],
    },
    {
      nodeId: textId,
      ignored: false,
      role: roleNameValue("StaticText"),
      chromeRole: chromeRoleValue("StaticText"),
      name: ax("computedString", obj.markerText),
      parentId: markerId,
      backendDOMNodeId: registry.backendIdFor(obj.node),
      childIds: [],
    },
  ];
}

function forcedRoleOf(obj: AXObj): { role: AXValue; chrome: AXValue } {
  if (obj.wireRole == null) {
    // presentational / role-less ignored nodes force to none (Blink RoleValue kNone)
    const generic = obj.reasons?.some(
      (reason) =>
        reason.name === "uninteresting" ||
        reason.name === "notRendered" ||
        reason.name === "notVisible" ||
        reason.name === "ariaHiddenElement" ||
        reason.name === "ariaHiddenSubtree" ||
        reason.name === "inertElement" ||
        reason.name === "activeModalDialog",
    );
    if (generic && !obj.reasons?.some((reason) => reason.name === "presentationalRole"))
      return { role: ax("role", "generic"), chrome: chromeRoleValue("GenericContainer") };
    return { role: ax("role", "none"), chrome: chromeRoleValue("None") };
  }
  return { role: roleNameValue(obj.wireRole), chrome: chromeRoleValue(obj.mojom) };
}

function nameOf(tree: AXTree, obj: AXObj): NameInfo {
  if (obj.isRoot) {
    const title = tree.options.document.title || "";
    return { value: title, sources: rootNameSources(title) };
  }
  if (obj.text !== undefined) {
    return {
      value: obj.text,
      sources: [{ type: "contents", value: ax("computedString", obj.text) }],
    };
  }
  if (obj.isPopup) return { value: "", sources: [] };
  const el = obj.node as Element;
  return computeName(tree, el, obj.wireRole ?? "generic");
}

/** The name used for queryAXTree matching: suppressed (empty) for hidden /
 *  presentational nodes, mirroring Blink's ComputedName(). */
function matchName(tree: AXTree, obj: AXObj): string {
  if (obj.ignored && obj.nameSuppressed) return "";
  return nameOf(tree, obj).value;
}

function wireNode(tree: AXTree, obj: AXObj, force = false): AXNode {
  const registry = tree.options.registry;
  const node: AXNode = {
    nodeId: obj.id,
    ignored: obj.ignored,
  };

  if (obj.ignored && !force) {
    node.role = ax("role", "none");
    node.chromeRole = chromeRoleValue("None");
    node.ignoredReasons = obj.reasons ?? [];
  } else if (obj.ignored && force) {
    const forced = forcedRoleOf(obj);
    node.role = forced.role;
    node.chromeRole = forced.chrome;
    node.name = ax("computedString", matchName(tree, obj));
    node.ignoredReasons = obj.reasons ?? [];
  } else {
    node.role = roleNameValue(obj.wireRole ?? "generic");
    node.chromeRole = chromeRoleValue(obj.mojom);
    const name = nameOf(tree, obj);
    const nameValue = ax("computedString", name.value);
    if (name.sources.length) nameValue.sources = name.sources;
    node.name = nameValue;
    if (obj.isRoot) {
      node.properties = [
        { name: "focusable", value: ax("booleanOrUndefined", true) },
        { name: "url", value: ax("string", tree.options.document.URL) },
      ];
    } else if (obj.text !== undefined || obj.isPopup) {
      node.properties = [];
    } else {
      const el = obj.node as Element;
      const role = obj.wireRole ?? "generic";
      const description = descriptionFor(el, role, name);
      if (description) node.description = ax("computedString", description);
      const value = valueFor(el, role);
      if (value) node.value = value;
      node.properties = propertiesFor(tree, el, role, name);
    }
  }

  node.childIds = childWireIds(tree, obj);
  // the synthetic MenuListPopup has no backing DOM node
  if (!obj.isPopup) node.backendDOMNodeId = registry.backendIdFor(obj.node);
  if (obj.parent) node.parentId = obj.parent.id;
  else if (obj.isRoot) node.frameId = tree.options.frameId;
  return node;
}

function descriptionFor(el: Element, role: string, nameInfo: NameInfo): string | undefined {
  const name = nameInfo.value;
  let description = normalizeText(computeAccessibleDescription(el));
  // a <summary> named by author ARIA gets its contents as the description,
  // taking priority over title (Blink's disclosure-triangle description)
  if (nameInfo.fromAuthorAria && el.localName === "summary") {
    const contents = textEquivalent(el);
    if (contents && contents !== name) return contents;
  }
  // a <summary> outside <details> is generic; its contents become its description
  if (!description && el.localName === "summary" && el.parentElement?.localName !== "details")
    description = textEquivalent(el);
  // a button input's value attribute describes it when the name came from elsewhere
  if (
    (!description || description === name) &&
    el instanceof HTMLInputElement &&
    ["button", "submit", "reset"].includes(el.type)
  ) {
    const value = normalizeText(el.getAttribute("value"));
    if (value && value !== name) description = value;
  }
  if (!description || description === name) return undefined;
  return description;
}

/** Chromium's BuildProtocolAXNodeForDOMNodeWithNoAXNode: returned when the
 *  inspected DOM node has no AX object at all (head, script, …). */
function noAXNodeFor(registry: DomRegistry, domNode: Node): AXNode {
  return {
    nodeId: "0",
    ignored: true,
    role: ax("role", "none"),
    chromeRole: chromeRoleValue("None"),
    ignoredReasons: [ignoredReason("notRendered")],
    backendDOMNodeId: registry.backendIdFor(domNode),
  };
}

// ---------------------------------------------------------------------------
// Traversals (Chromium's AddChildren / AddAncestors / WalkAXNodesToDepth)
// ---------------------------------------------------------------------------

/** Emit all included children; ignored children contribute another layer
 *  (follow_ignored), depth-first like Chromium's AddChildren. Returns the
 *  emitted objs and the unignored ones among them (the next BFS level). */
function addChildren(obj: AXObj): { emitted: AXObj[]; unignored: AXObj[] } {
  const emitted: AXObj[] = [];
  const unignored: AXObj[] = [];
  const reachable = [...obj.children];
  while (reachable.length) {
    const descendant = reachable.shift();
    if (!descendant) continue;
    if (descendant.ignored) reachable.unshift(...descendant.children);
    else unignored.push(descendant);
    emitted.push(descendant);
  }
  return { emitted, unignored };
}

function nearestObj(tree: AXTree, domNode: Node): AXObj | undefined {
  return tree.byNode.get(domNode);
}

function includedAncestor(obj: AXObj): AXObj | undefined {
  for (let cur = obj.parent; cur; cur = cur.parent) if (cur.included) return cur;
  return undefined;
}

// ---------------------------------------------------------------------------
// CDP methods
// ---------------------------------------------------------------------------

export function getFullAXTree(
  options: AXTreeOptions,
  depth?: number,
): Protocol.Accessibility.GetFullAXTreeResponse {
  const tree = buildTree(options);
  const maxDepth = depth == null || depth < 0 ? -1 : depth;
  const nodes: AXNode[] = [wireNode(tree, tree.root)];
  const queue: Array<{ obj: AXObj; depth: number }> = [{ obj: tree.root, depth: 1 }];
  while (queue.length) {
    const item = queue.shift();
    if (!item) continue;
    const { emitted, unignored } = addChildren(item.obj);
    for (const child of emitted) {
      nodes.push(wireNode(tree, child));
      nodes.push(...markerNodes(tree, child));
    }
    for (const child of unignored) {
      if (maxDepth === -1 || item.depth < maxDepth)
        queue.push({ obj: child, depth: item.depth + 1 });
    }
  }
  return { nodes };
}

/**
 * Fetch the AX node for a DOM node, optionally with its children and ancestor
 * chain (Chromium's getPartialAXTree). With no target, returns the whole tree
 * (back-compat with earlier clients).
 */
export function getPartialAXTree(
  options: AXTreeOptions,
  target?: Protocol.DOM.BackendNodeId,
  fetchRelatives = true,
): Protocol.Accessibility.GetPartialAXTreeResponse {
  if (target == null) return getFullAXTree(options);
  const tree = buildTree(options);
  const domNode = options.registry.nodeForBackendId(target);
  if (!domNode) return { nodes: [] };
  const obj = nearestObj(tree, domNode);

  const nodes: AXNode[] = [];
  if (obj) nodes.push(wireNode(tree, obj));
  else nodes.push(noAXNodeFor(options.registry, domNode));
  if (!fetchRelatives) return { nodes };

  if (obj && !obj.ignored)
    for (const child of addChildren(obj).emitted) nodes.push(wireNode(tree, child));

  let parent: AXObj | undefined;
  if (obj) parent = obj.included ? obj.parent : (includedAncestor(obj) ?? obj.parent);
  else {
    // walk up the DOM until a node with an AX object is found
    for (let cur = domNode.parentNode; cur; cur = cur.parentNode) {
      parent = nearestObj(tree, cur);
      if (parent) break;
    }
  }
  if (!parent) return { nodes };

  // Since an ignored/no-AX inspected node may be missing from its ancestor's
  // childIds, prepend it to maintain the tree structure (Chromium AddAncestors).
  const firstAncestor = wireNode(tree, parent);
  if (!obj || obj.ignored)
    firstAncestor.childIds = [obj ? obj.id : "0", ...(firstAncestor.childIds ?? [])];
  nodes.push(firstAncestor);
  for (let cur = parent.parent; cur; cur = cur.parent)
    if (cur.included) nodes.push(wireNode(tree, cur));
  return { nodes };
}

/** The root (RootWebArea) AX node of the document. */
export function getRootAXNode(
  options: AXTreeOptions,
): Protocol.Accessibility.GetRootAXNodeResponse {
  const tree = buildTree(options);
  return { node: wireNode(tree, tree.root) };
}

/** The children of the AX node with the given AX id (follow-ignored layering). */
export function getChildAXNodes(
  options: AXTreeOptions,
  id: string,
): Protocol.Accessibility.GetChildAXNodesResponse {
  const tree = buildTree(options);
  const obj = tree.byId.get(id);
  if (!obj) throw new Error("Invalid ID");
  const nodes: AXNode[] = [];
  for (const child of addChildren(obj).emitted) {
    nodes.push(wireNode(tree, child));
    nodes.push(...markerNodes(tree, child));
  }
  return { nodes };
}

/** The AX node for a DOM node together with every ancestor up to the root. */
export function getAXNodeAndAncestors(
  options: AXTreeOptions,
  target: Protocol.DOM.BackendNodeId,
): Protocol.Accessibility.GetAXNodeAndAncestorsResponse {
  const tree = buildTree(options);
  const domNode = options.registry.nodeForBackendId(target);
  if (!domNode) return { nodes: [] };
  const obj = nearestObj(tree, domNode);
  if (!obj) return { nodes: [noAXNodeFor(options.registry, domNode)] };
  const nodes: AXNode[] = [wireNode(tree, obj)];
  for (let cur = obj.parent; cur; cur = cur.parent)
    if (cur.included) nodes.push(wireNode(tree, cur));
  return { nodes };
}

/** All AX nodes in a subtree matching the given accessible name and/or role. */
export function queryAXTree(
  options: AXTreeOptions,
  query: { target?: Protocol.DOM.BackendNodeId; accessibleName?: string; role?: string },
): Protocol.Accessibility.QueryAXTreeResponse {
  const tree = buildTree(options);
  let root: AXObj | undefined;
  if (query.target == null) {
    root = tree.root;
  } else {
    let domNode = options.registry.nodeForBackendId(query.target);
    // shadow roots are missing from the AX tree; search from the host instead
    if (domNode && domNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE)
      domNode = (domNode as ShadowRoot).host ?? domNode;
    if (domNode?.nodeType === Node.DOCUMENT_NODE) root = tree.root;
    else if (domNode) root = nearestObj(tree, domNode);
  }
  if (!root) return { nodes: [] };

  const matches: AXNode[] = [];
  const stack: AXObj[] = [root];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj) continue;
    for (let i = obj.children.length - 1; i >= 0; i--) {
      const child = obj.children[i];
      if (child) stack.push(child);
    }
    if (!obj.included) continue;
    if (query.role != null) {
      const role = obj.ignored ? forcedRoleOf(obj).role.value : obj.wireRole;
      if (role !== query.role) continue;
    }
    if (query.accessibleName != null) {
      const name = obj.ignored ? matchName(tree, obj) : nameOf(tree, obj).value;
      if (name !== query.accessibleName) continue;
    }
    matches.push(wireNode(tree, obj, true));
  }
  return { nodes: matches };
}
