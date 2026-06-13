// Harness + fixture drivers for the Chromium accessibility conformance suite.
//
// This module is impl-facing and self-contained: each case drives our
// ax-tree.ts over a fixture and returns the dumped text, exactly mirroring
// Chromium's inspector-protocol harness (testRunner.log formatting, the
// accessibility-dumpAccessibilityNodes.js flow, the per-golden tree printers,
// ported from web_tests/http/tests/inspector-protocol/{resources,accessibility}).
//
// It does NOT read the Chromium checkout and makes no assertions. The expected
// output is vendored separately by `npm run gen:conformance` into
// conformance.expected.ts, so conformance.test.ts runs with no Chromium
// dependency. The fixtures here ARE derived from the goldens' .js files; keep
// them in sync when regenerating.
import type Protocol from "devtools-protocol";

import {
  createDomRegistry,
  type DomRegistry,
  getAXNodeAndAncestors,
  getChildAXNodes,
  getFullAXTree,
  getPartialAXTree,
  getRootAXNode,
  queryAXTree,
} from "../../src/frame/ax-tree.ts";

type AXNode = Protocol.Accessibility.AXNode & {
  children?: unknown[];
  parent?: unknown;
  domNode?: string;
  selected?: boolean;
};

type Options = { document: Document; frameId: string; registry: DomRegistry };

function setup(html: string): Options {
  document.title = "";
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-dump");
  document.body.innerHTML = html;
  return { document, frameId: "icdp-frame", registry: createDomRegistry() };
}

function roundtrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** URLs depend on the serving host (jsdom vs Chromium's test server) — mask
 *  them on both sides before comparison. */
export function maskUrls(text: string): string {
  return text.replace(/(value : )http:\/\/\S+/g, "$1<url>");
}

// ---- testRunner.log port (inspector-protocol-test.js _logObject) ----
function logObject(object: unknown, title: string | null, stabilizeNames: string[]): string {
  const lines: string[] = [];
  function dumpValue(value: unknown, prefix: string, prefixWithName: string): void {
    if (typeof value === "object" && value !== null) {
      if (Array.isArray(value)) dumpItems(value, prefix, prefixWithName);
      else dumpProperties(value as Record<string, unknown>, prefix, prefixWithName);
    } else {
      const valueStr = String(value).replace(/\n/g, " ");
      if (valueStr.length) prefixWithName += " ";
      lines.push(prefixWithName + valueStr);
    }
  }
  function dumpProperties(obj: Record<string, unknown>, prefix: string, firstLinePrefix: string) {
    prefix = prefix || "";
    firstLinePrefix = firstLinePrefix || prefix;
    if (/\S$/.test(firstLinePrefix)) firstLinePrefix += " ";
    lines.push(firstLinePrefix + "{");
    for (const name of Object.keys(obj).toSorted()) {
      let value = obj[name];
      const prefixWithName = "    " + prefix + name + " :";
      if (stabilizeNames.includes(name)) value = `<${typeof value}>`;
      dumpValue(value, "    " + prefix, prefixWithName);
    }
    lines.push(prefix + "}");
  }
  function dumpItems(arr: unknown[], prefix: string, firstLinePrefix: string) {
    prefix = prefix || "";
    firstLinePrefix = firstLinePrefix || prefix;
    if (/\S$/.test(firstLinePrefix)) firstLinePrefix += " ";
    lines.push(firstLinePrefix + "[");
    for (let i = 0; i < arr.length; ++i)
      dumpValue(arr[i], "    " + prefix, "    " + prefix + "[" + i + "] :");
    lines.push(prefix + "]");
  }
  dumpValue(object, "", title || "");
  return lines.join("\n");
}

/** Accumulates the testRunner.log lines and renders the final dump text. */
class Harness {
  private logs: string[] = [];
  private title: string;
  constructor(title: string) {
    this.title = title;
  }
  log(text: string): void {
    this.logs.push(text);
  }
  logObj(obj: unknown, masks: string[]): void {
    this.logs.push(logObject(obj, null, masks));
  }
  text(): string {
    return [this.title, ...this.logs].join("\n") + "\n\n";
  }
}

// ---- accessibility-dumpAccessibilityNodes.js port ----
function describeDomNode(node: Node): string {
  let description = node.nodeName.toLowerCase();
  if (node.nodeType === 1 && (node as Element).hasAttribute("id"))
    description += "#" + (node as Element).getAttribute("id");
  return description;
}

function rewriteRelatedNodeValue(options: Options, value: Protocol.Accessibility.AXValue): void {
  if (!value.relatedNodes) return;
  for (const related of value.relatedNodes) {
    const dom = options.registry.nodeForBackendId(related.backendDOMNodeId);
    delete (related as { backendDOMNodeId?: unknown }).backendDOMNodeId;
    (related as { nodeResult?: string }).nodeResult = dom
      ? describeDomNode(dom)
      : "[NODE NOT FOUND]";
  }
}

function rewriteRelatedNodes(options: Options, nodes: AXNode[], selectedDom: Node): void {
  for (const node of nodes) {
    const properties = node.ignored ? node.ignoredReasons : node.properties;
    for (const source of node.name?.sources ?? []) {
      let value: Protocol.Accessibility.AXValue | undefined;
      if (source.value) value = source.value;
      if (source.attributeValue) value = source.attributeValue;
      if (!value) continue;
      if (value.type === "idrefList" || value.type === "idref" || value.type === "nodeList")
        rewriteRelatedNodeValue(options, value);
    }
    for (const property of properties ?? []) {
      if (
        property.value.type === "idrefList" ||
        property.value.type === "idref" ||
        property.value.type === "nodeList"
      )
        rewriteRelatedNodeValue(options, property.value);
    }
    if ("backendDOMNodeId" in node && node.backendDOMNodeId !== undefined) {
      const dom = options.registry.nodeForBackendId(node.backendDOMNodeId);
      delete (node as { backendDOMNodeId?: unknown }).backendDOMNodeId;
      node.domNode = dom ? describeDomNode(dom) : "[NODE NOT FOUND]";
      if (dom === selectedDom) node.selected = true;
    }
  }
}

function dumpNode(h: Harness, nodes: AXNode[]): void {
  const node = nodes[0];
  if (!node) return;
  delete node.selected;
  h.logObj(node, ["id", "backendDOMNodeId", "nodeId", "parentId", "childIds"]);
}

function dumpTreeStructure(h: Harness, nodes: AXNode[]): void {
  function printNodeAndChildren(node: AXNode, leadingSpace = ""): string {
    let str = leadingSpace;
    if (node.selected) str += "*";
    str += node.role ? node.role.value : "<no role>";
    str += node.name && node.name.value !== "" ? ` "${node.name.value}"` : "";
    for (const child of (node.children as AXNode[] | undefined) ?? [])
      str += "\n" + printNodeAndChildren(child, leadingSpace + "  ");
    return str;
  }
  const nodeMap: Record<string, AXNode> = {};
  for (const node of nodes) nodeMap[node.nodeId] = node;
  for (const nodeId of Object.keys(nodeMap)) {
    const node = nodeMap[nodeId]!;
    if (node.childIds) {
      node.children = [];
      for (let i = 0; i < node.childIds.length && node.childIds.length > 0; ) {
        const childId = node.childIds[i]!;
        if (childId in nodeMap) {
          const child = nodeMap[childId]!;
          child.parentId = nodeId;
          (node.children as AXNode[]).push(child);
          node.childIds.splice(i, 1);
        } else {
          node.childIds[i] = "<string>";
          i++;
        }
      }
      if (!node.childIds.length) delete node.childIds;
      if (!(node.children as AXNode[]).length) delete node.children;
    }
  }
  const rootNode = Object.values(nodeMap).find((node) => !("parentId" in node));
  for (const node of Object.values(nodeMap)) delete node.parentId;
  h.log("\n" + (rootNode ? printNodeAndChildren(rootNode) : "<no root>"));
}

/** The `dumpAccessibilityNodesBySelectorAndCompleteTest` flow: for each matched
 *  element, optionally dump the fetch-relatives tree, then the single node. */
function dumpBySelector(
  title: string,
  html: string,
  selector: string,
  fetchRelatives: boolean,
  mutate?: (doc: Document) => void,
): string {
  const options = setup(html);
  mutate?.(document);
  // populate registry + AX ids exactly once before resolving targets
  getFullAXTree(options);
  const h = new Harness(title);
  for (const el of Array.from(document.querySelectorAll(selector))) {
    const backendId = options.registry.backendIdFor(el);
    if (fetchRelatives) {
      const resp = roundtrip(getPartialAXTree(options, backendId, true).nodes) as AXNode[];
      rewriteRelatedNodes(options, resp, el);
      dumpTreeStructure(h, resp);
    }
    const resp = roundtrip(getPartialAXTree(options, backendId, false).nodes) as AXNode[];
    rewriteRelatedNodes(options, resp, el);
    dumpNode(h, resp);
  }
  return h.text();
}

// ---- per-golden tree printer (accessibility-getFullAXTree.js local helper) ----
function printNodes(h: Harness, nodes: AXNode[]): void {
  function printNodeAndChildren(node: AXNode, leadingSpace = ""): string {
    if (node.ignored) {
      return ((node.children as AXNode[]) ?? [])
        .map((child) => printNodeAndChildren(child, leadingSpace))
        .join("\n");
    }
    let str = leadingSpace + (node.role ? node.role.value : "<no role>");
    str += node.name && node.name.value ? ` "${node.name.value}"` : "";
    for (const child of (node.children as AXNode[]) ?? [])
      str += "\n" + printNodeAndChildren(child, leadingSpace + "  ");
    return str;
  }
  const nodeMap = new Map<string, AXNode>();
  for (const node of nodes) nodeMap.set(node.nodeId, node);
  for (const node of nodeMap.values()) {
    node.children = [];
    for (const childId of node.childIds ?? []) {
      const child = nodeMap.get(childId);
      if (!child) continue;
      child.parent = node;
      (node.children as AXNode[]).push(child);
    }
  }
  const rootNode = [...nodeMap.values()].find((node) => !node.parent);
  h.log("\n" + (rootNode ? printNodeAndChildren(rootNode) : "<no root>"));
}

// =================== bespoke method drivers ===================

function runGetFullAXTree(): string {
  const options = setup(
    `<div>Some text in a div, also a <a href='https://www.example.com'>link</a></div>
    <button>Hello Button</button>
    <iframe src="../resources/iframe-accessible-name.html"></iframe>`,
  );
  const h = new Harness("Tests Accessibility.getFullAXTree");
  printNodes(h, roundtrip(getFullAXTree(options).nodes) as AXNode[]);
  return h.text();
}

function runGetFullAXTreeDepth(): string {
  const options = setup(
    `<div>Some text in a div, also a <a href='https://www.example.com'>link</a></div>
    <button>Hello Button</button>`,
  );
  const h = new Harness("Tests Accessibility.getRootAXNode");
  printNodes(h, roundtrip(getFullAXTree(options, 2).nodes) as AXNode[]);
  return h.text();
}

function runGetRootNode(): string {
  const options = setup(`<p>hi</p>`);
  // golden navigates to page-with-iframe-accessible-name.html: body holds an iframe.
  // We reproduce only the main-frame half; iframe half is cross-frame ceiling.
  document.body.innerHTML = `<iframe src="../resources/iframe-accessible-name.html"></iframe>`;
  const h = new Harness("Tests Accessibility.getRootAXNode");
  const root = roundtrip(getRootAXNode(options).node);
  h.log("\ngetRootAXNode for main frame:\n");
  h.logObj(root, ["nodeId", "backendDOMNodeId", "childIds", "frameId", "parentId", "properties"]);
  return h.text();
}

function runGetChildAXNodes(): string {
  const options = setup(
    `<main>
    <article>
      <h1>Article</h1>
      <p>First paragraph</p>
    </article>
    <iframe src="../resources/iframe-accessible-name.html"></iframe>
  </main>`,
  );
  const h = new Harness("Tests Accessibility.getChildAXNodes");
  function print(node: AXNode, leadingSpace = ""): string {
    if (node.ignored)
      return ((node.children as AXNode[]) ?? [])
        .map((child) => print(child, leadingSpace))
        .join("\n");
    let str = leadingSpace + (node.role ? node.role.value : "<no role>");
    str += node.name && node.name.value ? ` "${node.name.value}"` : "";
    for (const child of (node.children as AXNode[]) ?? [])
      str += "\n" + print(child, leadingSpace + "  ");
    return str;
  }
  const full = roundtrip(getFullAXTree(options, 2).nodes) as AXNode[];
  const nodeMap = new Map<string, AXNode>();
  for (const node of full) nodeMap.set(node.nodeId, node);
  for (const node of nodeMap.values()) {
    node.children = [];
    for (const childId of node.childIds ?? []) {
      const child = nodeMap.get(childId);
      if (!child) continue;
      child.parent = node;
      (node.children as AXNode[]).push(child);
    }
  }
  const rootNode = [...nodeMap.values()].find((node) => !node.parent)!;
  h.log("\nAfter getFullAXTree:\n" + print(rootNode));
  // Chromium path: root.children[0].children[0].children[0].children[0] === article
  const article = (
    (((rootNode.children as AXNode[])?.[0]?.children as AXNode[])?.[0]?.children as AXNode[])?.[0]
      ?.children as AXNode[]
  )?.[0];
  if (article) {
    const childResult = roundtrip(getChildAXNodes(options, article.nodeId).nodes) as AXNode[];
    for (const node of childResult) {
      nodeMap.set(node.nodeId, node);
      node.children = [];
    }
    article.children = [];
    for (const childId of article.childIds ?? []) {
      const child = nodeMap.get(childId);
      if (!child) {
        h.log("Should have gotten child with id " + childId);
        continue;
      }
      child.parent = article;
      (article.children as AXNode[]).push(child);
    }
    h.log("\nAfter getChildAXNodes:\n" + print(rootNode));
  }
  return h.text();
}

function runGetAXNodeAndAncestors(): string {
  const options = setup(
    `<main>
    <article>
      <h1>Article</h1>
      <p>First paragraph</p>
    </article>
  </main>`,
  );
  getFullAXTree(options);
  const h = new Harness("Tests Accessibility.getAXNodeAndAncestors");
  const p = document.querySelector("p")!;
  const nodes = roundtrip(
    getAXNodeAndAncestors(options, options.registry.backendIdFor(p)).nodes,
  ) as AXNode[];
  for (const node of nodes)
    h.logObj(node, ["nodeId", "backendDOMNodeId", "childIds", "frameId", "parentId"]);
  return h.text();
}

function runQueryAXTree(): string {
  const options = setup(
    `<h2 id="shown">title</h2>
      <h2 id="hidden" aria-hidden="true" lang="x">title</h2>
      <h2 id="unrendered" hidden lang="x">title</h2>

      <div id="node1" aria-labeledby="node2"></div>
      <div id="node2" aria-label="bar"></div>
      <div id="node3" aria-label="foo" aria-hidden="true"></div>
      <div id="node4" class="container">
          <div id="node5" role="button" aria-label="foo"></div>
          <div id="node6" role="button" aria-label="foo"></div>
          <div id="node7" hidden role="button" aria-label="foo"></div>
          <div id="node8" role="button" aria-label="bar"></div>
      </div>

      <button id="node10">text content</button>
      <h1 id="node11">text content</h1>
      <h1 id="node12" role="presentation">text content</h1>

      <img id="node20" src="" alt="Accessible Name">
      <input id="node21" type="submit" value="Accessible Name">
      <label id="node22" for="node23">Accessible Name</label>
      <input id="node23">
      <div id="node24" title="Accessible Name"></div>

      <div role="treeitem" id="node30">
        <div role="treeitem" id="node31">
          <div role="treeitem" id="node32">item1</div>
          <div role="treeitem" id="node33">item2</div>
        </div>
        <div role="treeitem" id="node34">item3</div>
      </div>
      <div aria-describedby="node30"></div>
      <header id="header">role=[banner] test</header>
      <div id="shadow-host"></div>`,
  );
  // script-built shadow trees from the golden
  {
    const div = document.createElement("div");
    const shadowRoot = div.attachShadow({ mode: "open" });
    const h1 = document.createElement("h1");
    h1.textContent = "text content";
    h1.id = "node13";
    shadowRoot.appendChild(h1);
    document.documentElement.appendChild(div);
    const host = document.getElementById("shadow-host")!;
    const hostRoot = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    input.id = "shadow-input";
    input.placeholder = "Shadow input";
    hostRoot.appendChild(input);
  }
  getFullAXTree(options);
  const h = new Harness("Test finding DOM nodes by accessible name");

  const container = document.querySelector(".container")!;
  const shadowRootNode = document.getElementById("shadow-host")!.shadowRoot as unknown as Node;

  function logNodes(nodes: AXNode[]): void {
    for (const axNode of nodes) {
      const dom =
        axNode.backendDOMNodeId === undefined
          ? undefined
          : options.registry.nodeForBackendId(axNode.backendDOMNodeId);
      if (!dom || dom.nodeType !== 1) continue;
      const el = dom as Element;
      // golden quirk: attributes.indexOf('id') + 1 → first attr value when no id
      const attrs: string[] = [];
      for (const attr of Array.from(el.attributes)) attrs.push(attr.name, attr.value);
      const idIndex = attrs.indexOf("id") + 1;
      h.log(String(attrs[idIndex]));
    }
  }
  const q = (target: Node | undefined, query: { accessibleName?: string; role?: string }) =>
    roundtrip(
      queryAXTree(options, {
        target: target === undefined ? undefined : options.registry.backendIdFor(target),
        ...query,
      }).nodes,
    ) as AXNode[];

  h.log("\nRunning test: dumpAXNodes");
  h.log("dump both an ignored and an unignored axnode");
  for (const axnode of q(document, { accessibleName: "title" }))
    h.logObj(axnode, ["nodeId", "backendDOMNodeId", "childIds", "parentId"]);

  h.log("\nRunning test: testGetNodesForSubtreeByAccessibleName");
  h.log(`find all elements with accessible name "foo"`);
  logNodes(q(document, { accessibleName: "foo" }));
  h.log(`find all elements with accessible name "foo" inside container`);
  logNodes(q(container, { accessibleName: "foo" }));
  h.log(`find all elements with accessible name "bar"`);
  logNodes(q(document, { accessibleName: "bar" }));
  h.log(`find all elements with accessible name "text content"`);
  logNodes(q(document, { accessibleName: "text content" }));
  h.log(`find all elements with accessible name "Accessible Name"`);
  logNodes(q(document, { accessibleName: "Accessible Name" }));
  h.log(`find all elements with accessible name "item1 item2 item3"`);
  logNodes(q(document, { accessibleName: "item1 item2 item3" }));

  h.log("\nRunning test: testGetNodesForSubtreeByRole");
  h.log(`find all elements with role "button"`);
  logNodes(q(document, { role: "button" }));
  h.log(`find all elements with role "heading"`);
  logNodes(q(document, { role: "heading" }));
  h.log(`find all elements with role "treeitem"`);
  logNodes(q(document, { role: "treeitem" }));
  h.log(`find all ignored nodes with role "presentation"`);
  logNodes(q(document, { role: "presentation" }));
  h.log(`find all nodes with role "banner" (expected: 1 node)`);
  logNodes(q(document, { role: "banner" }));

  h.log("\nRunning test: testGetNodesForSubtreeByAccessibleNameAndRole");
  h.log(`find all elements with accessible name "foo" and role "button"`);
  logNodes(q(document, { accessibleName: "foo", role: "button" }));
  h.log(`find all elements with accessible name "foo" and role "button" inside container`);
  logNodes(q(container, { accessibleName: "foo", role: "button" }));
  h.log(`find all elements with accessible name "text content" and role "heading"`);
  logNodes(q(document, { accessibleName: "text content", role: "heading" }));
  h.log(`find all elements with accessible name "text content" and role "button"`);
  logNodes(q(document, { accessibleName: "text content", role: "button" }));
  h.log(`find all elements with accessible name "Accessible Name" and role "textbox"`);
  logNodes(q(document, { accessibleName: "Accessible Name", role: "textbox" }));
  h.log(`find all elements with accessible name "Accessible Name" and role "button"`);
  logNodes(q(document, { accessibleName: "Accessible Name", role: "button" }));

  h.log("\nRunning test: testGetNodesForShadowRoot");
  h.log(`find all elements with accessible name "Shadow input" (expected: 1 node)`);
  logNodes(q(shadowRootNode, { accessibleName: "Shadow input" }));
  return h.text();
}

// =================== the case registry ===================

export type ConformanceCase = {
  /** matches the Chromium golden's `<name>-expected.txt` stem */
  name: string;
  /** ceiling cases (InlineTextBox leaves / cross-frame iframe sections) are
   *  produced but not byte-asserted — there's no vendored expected for them */
  ceiling?: boolean;
  run: () => string;
};

export const CASES: ConformanceCase[] = [
  { name: "accessibility-getFullAXTree", ceiling: true, run: runGetFullAXTree },
  { name: "getFullAXTree-depth", run: runGetFullAXTreeDepth },
  { name: "accessibility-getRootNode", ceiling: true, run: runGetRootNode },
  { name: "accessibility-getChildAXNodes", ceiling: true, run: runGetChildAXNodes },
  { name: "accessibility-getAXNodeAndAncestors", run: runGetAXNodeAndAncestors },
  {
    name: "accessibility-getNodeWithNoAXNode",
    run: () =>
      dumpBySelector(
        "Tests that node without AXNode reports accessibility values.",
        `<input type='text'>`,
        "head",
        false,
      ),
  },
  {
    name: "accessibility-getTreeWithNoAXNode",
    run: () =>
      dumpBySelector(
        "Tests that fetching the tree for a node without an AXNode functions correctly.",
        `<main>
    <article>
    <div id="hidden" style="display: none">hidden div</div>
    </article>
    </main>`,
        "#hidden",
        true,
      ),
  },
  {
    name: "accessibility-getRelationships",
    run: () =>
      dumpBySelector(
        "Tests relationship accessibility values.",
        `<h3 id='rg1_label'>Lunch Options</h3>
    <ul id='rg1' class='radiogroup' role='radiogroup' aria-labelledby='rg1_label' aria-activedescendant='rg1-r4' tabindex='0' data-dump>
      <li id='rg1-r1' tabindex='-1' role='radio' aria-checked='false'>
        Thai
      </li>
      <li id='rg1-r2' tabindex='-1' role='radio' aria-checked='false'>
        Subway
      </li>
      <li id='rg1-r3' tabindex='-1' role='radio' aria-checked='false'>
        Jimmy Johns
      </li>
      <li id='rg1-r4' tabindex='-1' role='radio' aria-checked='true'>
        Radio Maria
      </li>
      <li id='rg1-r5' tabindex='-1' role='radio' aria-checked='false'>
        Rainbow Gardens
      </li>
    </ul>
    <h3 id='rg2_label'>Drink Options</h3>
    <ul id='rg2' role='radiogroup' aria-labelledby='rg2_label' aria-activedescendant='' tabindex='0' data-dump>
      <li id='rg2-r1' tabindex='-1' role='radio' aria-checked='false'>
        Water
      </li>
      <li id='rg2-r2' tabindex='-1' role='radio' aria-checked='false'>
        Tea
      </li>
      <li id='rg2-r3' tabindex='-1' role='radio' aria-checked='false'>
        Coffee
      </li>
      <li id='rg2-r4' tabindex='-1' role='radio' aria-checked='false'>
        Cola
      </li>
      <li id='rg2-r5' tabindex='-1' role='radio' aria-checked='false'>
        Ginger Ale
      </li>
    </ul>`,
        "[data-dump]",
        false,
      ),
  },
  {
    name: "accessibility-ignoredNodes",
    run: () =>
      dumpBySelector(
        "Tests accessibility values of ignored nodes.",
        // <html data-dump> in the golden merges onto the document element; applied
        // via the mutate hook below. Inner content is otherwise verbatim.
        `<div>Non-hidden div for comparison</div>
    <div role='img'>
        <svg data-dump>
            <circle xmlns:svg='http://www.w3.org/2000/svg' cx='150px' cy='100px' r='50px' fill='#ff0000' stroke='#000000' stroke-width='5px'/>
        </svg>
    </div>
    <div data-dump aria-hidden='true'>
        <div data-dump>Descendant of aria-hidden node</div>
    </div>
    <ol role='none' data-dump>
      <li data-dump>List item also presentational</li>
      <div data-dump>Div in list isn't presentational</div>
    </ol>

    <label for='checkbox' data-dump><span data-dump>Content within label refers to label container</span></label>
    <input type='checkbox' id='checkbox'>
    <div style='display: none' data-dump>
      Non-rendered div
      <span data-dump>Span within non-rendered div</span>
      <button aria-hidden='false'>aria-hidden false button</button>
    </div>

    <canvas style='height: 1px; width: 1px;' data-dump></canvas>

    <canvas role='presentation' data-dump><div>Canvas fallback content</div></canvas>

    <select data-dump>
      <option data-dump>Options are not sent</option>
      <option>because they are inside of shadow root.</option>
    </select>

    <button inert data-dump>inert button</button>
    <div id='inert-root' inert>
      <button data-dump>button in inert subtree</button>
    </div>

    <span data-dump aria-label="span with ARIA label">should not be ignored</span>

    <div data-dump style="display: contents">div with display contents - should be ignored, but text should be included</div>

    <summary data-dump>summary element without details parent is ignored</summary>

    <div role='presentation'>
      <button data-dump>Ignored parent shouldn't cause descendant to be missing from the tree</button>
    </div>`,
        "[data-dump]",
        true,
        (doc) => doc.documentElement.setAttribute("data-dump", ""),
      ),
  },
  {
    name: "accessibility-ignoredNodesModal",
    run: () =>
      dumpBySelector(
        "Tests accessibility values of ignored nodes in model dialog.",
        `<div data-dump>Hidden by modal dialog</div>
    <dialog data-dump>
        (Dialog itself is not hidden)
        <div data-dump>Non-hidden element inside dialog</div>
    </dialog>`,
        "[data-dump]",
        false,
        (doc) => {
          const dialog = doc.querySelector("dialog") as HTMLDialogElement;
          if (typeof dialog.showModal === "function") dialog.showModal();
          else dialog.setAttribute("open", "");
        },
      ),
  },
  {
    name: "accessibility-modal",
    run: () =>
      dumpBySelector(
        "Tests accessibility values in modal dialog.",
        `<dialog data-dump id='modal'>
      <div data-dump role='button' aria-modal='true'>
      </div>
      <div data-dump role='dialog' aria-modal='false'>
      </div>
      <div data-dump role='dialog' aria-modal='true'>
      </div>
      <div data-dump role='alertdialog' aria-modal='true'>
      </div>
      <dialog data-dump>Closed Dialog</dialog>
      <dialog data-dump open>Open Dialog</dialog>
    </dialog>`,
        "[data-dump]",
        false,
        (doc) => {
          const dialog = doc.getElementById("modal") as HTMLDialogElement;
          if (typeof dialog.showModal === "function") dialog.showModal();
          else dialog.setAttribute("open", "");
        },
      ),
  },
  {
    name: "accessibility-aria-1.1",
    run: () =>
      dumpBySelector(
        "Tests ARIA 1.1 accessibility markup.",
        `<input data-dump aria-errormessage='err' aria-invalid='true'>
    <h3 id='err'>This text field has an error!</h3>

    <img data-dump aria-details='d' aria-label='Label'>
    <div id='d'>Details</div>

    <button data-dump aria-keyshortcuts='Ctrl+A'>Select All</button>

    <input data-dump type='checkbox' aria-roledescription='Lightswitch' checked>`,
        "[data-dump]",
        false,
      ),
  },
  {
    name: "accessibility-nameSources-buttons",
    run: () =>
      dumpBySelector(
        "Tests name sources in buttons.",
        `<div class='tests'>
       <button id='button1'></button>
       <button id='button2'>button2-content</button>
       <button id='button3'><img src='resources/cake.png'></button>
       <button id='button4'><img src='resources/cake.png' alt='cake'></button>
       <button id='button5'>I love <img src='resources/cake.png'>!</button>
       <button id='button6'>I love <img src='resources/cake.png' alt='cake'>!</button>
       <button id='button7' title='button7-title'></button>
       <button id='button8' title='button8-title'>button8-content</button>
       <button id='button9' title='button9-title'><img src='resources/cake.png'></button>
       <button id='button10' title='button10-title'><img src='resources/cake.png' alt='cake'></button>
       <button id='button11'>button11-content</button>
       <label for='button11'>label-for-button11</label>
     </div>`,
        "button",
        false,
      ),
  },
  {
    name: "accessibility-nameSources-img-figure",
    run: () =>
      dumpBySelector(
        "Tests name sources in images and figures.",
        `<div class='tests'>
      <figure data-dump id='figure1'>
        <img src='resources/cake.png' alt='cake'>
      </figure>
      <figure data-dump id='figure2' title='figure2-title'>
        <img src='resources/cake.png' alt='cake'>
      </figure>
      <figure data-dump id='figure3' title='figure3-title'>
        <figcaption>figcaption3</figcaption>
        <img src='resources/cake.png' alt='cake'>
      </figure>
      <figure data-dump id='figure4' title='figure4-title' aria-label='figure4-aria-label'>
        <figcaption>figcaption4</figcaption>
        <img src='resources/cake.png' alt='cake'>
      </figure>
      <figure data-dump id='figure5' title='figure5-title' aria-label='figure5-aria-label' aria-labelledby='figure-labelledby5'>
        <figcaption>figcaption5</figcaption>
        <img src='resources/cake.png' alt='cake'>
      </figure>
      <span hidden='true' id='figure-labelledby5'>figure5-aria-labelledby</span>
      <img data-dump id='img1' src='resources/cake.png'>
      <img data-dump id='img2' title='img2-title' src='resources/cake.png'>
      <img data-dump id='img3' title='img3-title' alt='img3-alt' src='resources/cake.png'>
      <img data-dump id='img4' title='img4-title' alt='img4-alt' aria-label='img4-aria-label' src='resources/cake.png'>
      <img data-dump id='img5' title='img5-title' alt='img5-alt' aria-label='img5-aria-label' aria-labelledby='img-labelledby5' src='resources/cake.png'>
      <span hidden='true' id='img-labelledby5'>img5-aria-labelledby</span>
      <div data-dump tabIndex=0 role='link' id='link1'>
        I
        <img src='hidden.jpg' alt='do not' role='presentation' />
        like ice cream.
      </div>
      <svg data-dump id='svg1'>
        <title>svg1-title</title>
      </svg>
    </div>
    <img data-dump title="title" alt="" src='resources/cake.png'>`,
        "[data-dump]",
        false,
      ),
  },
  {
    name: "accessibility-nameSources-input-buttons",
    run: () =>
      dumpBySelector(
        "Tests name sources in input[type=button].",
        `<div class='tests'>
      <input id='button1' type='button'>
      <input id='button2' type='button' value='button-value2'>
      <input id='button3' type='button' value='button-value3' title='button-title3'>
      <input id='button4' type='button' title='button-title4'>
      <input id='button5' type='button'>
      <label for='button5'>button-label-5</label>
      <label>button-label-6<input id='button6' type='button'></label>
      <input id='button7' type='button' value='button-value7'>
      <label for='button7'>button-label-7</label>
      <input id='button8' type='button' value='button-value8' aria-label='button-aria-label-8'>
      <label for='button8'>button-label-8</label>
      <input id='button9' type='button' value='button-value9' aria-label='button-aria-label-9' aria-labelledby='label-for-button9'>
      <label for='button9'>button-label-9</label>
      <span id='label-for-button9'>button9-aria-labelledby</span>
      <input id='submit1' type='submit'>
      <input id='submit2' type='submit' value='submit-value2'>
      <input id='submit3' type='submit' title='submit-title'>
      <input id='reset1' type='reset'>
      <input id='image-input1' type='image' src='resources/cake.png'>
      <input id='image-input2' type='image' src='resources/cake.png' value='image-input-value2'>
      <input id='image-input3' type='image' src='resources/cake.png' alt='image-input-alt3'>
      <input id='image-input4' type='image' src='resources/cake.png' alt='image-input-alt4' value='image-input-value4'>
      <input id='image-input5' type='image' src='resources/cake.png' title='image-input-title5'>
    </div>`,
        "input",
        false,
      ),
  },
  {
    name: "accessibility-nameSources-input",
    run: () =>
      dumpBySelector(
        "Tests name sources in inputs.",
        `<div class='tests'>
      <input data-dump id='text1' type='text'>
      <input data-dump id='text2' type='text' title='text2-title'>
      <input data-dump id='text3' type='text' title='text3-title' aria-placeholder='text3-aria-placeholder' placeholder='text3-placeholder'>
      <input data-dump id='text4' type='text' title='text4-title' aria-placeholder='text4-aria-placeholder' placeholder='text4-placeholder'>
      <label for='text4'>label-for-text4</label>
      <input data-dump id='text5' type='text' title='text5-title' aria-placeholder='text5-aria-placeholder' placeholder='text5-placeholder' aria-label='text5-aria-label'>
      <label for='text5'>label-for-text5</label>
      <input data-dump id='text6' type='text' title='text6-title' aria-placeholder='text6-aria-placeholder' placeholder='text6-placeholder' aria-label='text6-aria-label' aria-labelledby='text-labelledby6'>
      <label for='text6'>label-for-text6</label>
      <span id='text-labelledby6'>labelledby-for-text6</span>
      <label>label-wrapping-text7<input data-dump id='text7' type='text' title='text7-title'></label>
      <label for='dummy'>label-wrapping-text8<input data-dump id='text8' type='text'></label>
      <label for='text9'>label-for-text9</label>
      <label>label-wrapping-text9<input data-dump id='text9' type='text' title='text9-title' aria-placeholder='text9-aria-placeholder' placeholder='text9-placeholder'></label>
      <label>label-wrapping-text10<input data-dump id='text10' type='text' title='text10-title' aria-placeholder='text10-aria-placeholder' placeholder='text10-placeholder'></label>
      <input data-dump id='text11' type='text'>
      <label for='text11'>first-label-for-text11</label>
      <label for='text11'>second-label-for-text11</label>
      <input data-dump id='text12' type='text' title='text12-title' aria-placeholder='text12-aria-placeholder'>
    </div>`,
        "[data-dump]",
        false,
      ),
  },
  {
    name: "accessibility-nameSources-labelledby",
    run: () =>
      dumpBySelector(
        "Tests name sources when used with aria-labelledby.",
        `<div class='tests'>
      <div data-dump id='div'>Div Contents</div>
      <button data-dump id='self'>Contents of button</button>
      <button data-dump id='labelledby' aria-labelledby='label1'>Contents</button>
      <div id='label1'>Label 1</div>
      <button data-dump id='labelledbySelf' aria-labelledby='labelledbySelf'>Contents</button>
      <button data-dump id='labelledby3' aria-labelledby='labelledby3 label3'>Contents</button>
      <div id='label3'>Label 3</div>
      <button data-dump id='labelledby4' aria-labelledby='label4'>Contents</button>
      <div id='label4' aria-labelledby='label4chained'>Contents 4</div>
      <p id='label4chained'>Contents 4 chained</p>
      <button data-dump id='labelledby5' aria-labelledby='label5'>Contents</button>
      <button data-dump id='labelledby6' aria-labelledby='label6'>Contents</button>
      <div id='label6'></div>
      <button data-dump id='labelledby7' aria-labelledby='label7'>Contents</button>
      <h3 id='label7' style='visibility: hidden'>Invisible label</h3>
      <button data-dump id='labelledby8' aria-labelledby='label8'>Contents</button>
      <h3 id='label8' style='display: none'>Display-none label</h3>
      <button data-dump id='labelOnly' aria-label='Label'>Contents</button>
      <button data-dump id='emptyLabel1' aria-label=''>Contents</button>
      <button data-dump id='emptyLabel2' aria-label>Contents</button>
      <button data-dump id='labelledby9' aria-labelledby='label9' aria-label='Label'>Contents</button>
      <div id='label9'>Labelledby 9</div>
      <button data-dump id='labelledby10' aria-labelledby='label10'>Contents</button>
      <div id='label10' aria-label='Label 10 label'>Contents 10</div>
      <button data-dump id='labelledby11' aria-labelledby='label11'>Contents</button>
      <div id='label11' aria-label=''>Contents 11</div>
      <button data-dump id='labelledby12' aria-labelledby='label12'>Contents</button>
      <div id='label12' aria-label='Label 12 label' aria-labelledby='label12chained'>Contents 12</div>
      <p id='label12chained'>Contents 12 chained</p>
      <input data-dump id='input1' aria-labelledby='list1'>
      <ul id='list1' aria-owns='list1_item3'>
          <li>A
          <li>B
      </ul>
      <div role='listitem' id='list1_item3'>C</div>
    </div>`,
        "[data-dump]",
        false,
      ),
  },
  {
    name: "accessibility-nameSources-options",
    run: () =>
      dumpBySelector(
        "Tests name sources in <option>s.",
        `<div class='tests'>
     <select>
       <option id="option1" aria-label="label" value="foo">x</option>
     </select>
     <select>
       <option id="option2" value="foo">x</option>
     </select>
     <select>
       <option id="option3" aria-label="label">x</option>
     </select>
     <select>
       <option id="option4">x</option>
     </select>
     </div>`,
        "option",
        false,
      ),
  },
  {
    name: "accessibility-nameSources-summary",
    run: () =>
      dumpBySelector(
        "Tests name sources in details and summary.",
        `<div class='tests'>
      <details id='details2'>
        <summary id='summary2' title='summary2-title'></summary>
        <p>details2-content</p>
      </details>
      <details id='details3'>
        <summary id='summary3' title='summary3-title'>summary3-contents</summary>
        <p>details3-content</p>
      </details>
      <details id='details4'>
        <summary id='summary4' title='summary4-title' aria-label='summary4-aria-label'>summary4-contents</summary>
        <p>details4-content</p>
      </details>
      <details id='details5'>
        <summary id='summary5' title='summary5-title' aria-label='summary5-aria-label' aria-labelledby='labelledby5'>summary5-contents</summary>
        <p>details5-content</p>
      </details>
      <span hidden='true' id='labelledby5'>summary5-aria-labelledby</span>
    </div>`,
        "summary",
        false,
      ),
  },
  {
    name: "accessibility-nameSources-visiblity",
    run: () =>
      dumpBySelector(
        "Tests name sources in invisible nodes.",
        `<div class='tests'>
      <div data-dump id='link1' tabIndex=0 role='link'>
        <p>1</p>
        <table role="presentation">
          <tr><td>2</td></tr>
          <tr><td style='visibility: hidden'>3</td></tr>
          <tr><td style='display:none'>4</td></tr>
          <tr style='visibility: hidden'><td>5</td></tr>
          <tr style='display: none'><td>6</td></tr>
        </table>
        <p>7</p>
      </div>
      <input data-dump id='input2' aria-labelledby='label2'>
      <div id='label2'>
        <p>1</p>
        <table role="presentation">
          <tr><td>2</td></tr>
          <tr><td style='visibility: hidden'>3</td></tr>
          <tr><td style='display:none'>4</td></tr>
          <tr style='visibility: hidden'><td>5</td></tr>
          <tr style='display: none'><td>6</td></tr>
        </table>
        <p>7</p>
      </div>
      <input data-dump id='input3' aria-labelledby='3a 3b 3c 3d 3e 3f 3g'>
      <p id='3a'>1</p>
      <table role="presentation">
        <tr><td id='3b'>2</td></tr>
        <tr><td id='3c' style='visibility: hidden'>3</td></tr>
        <tr><td id='3d' style='display:none'>4</td></tr>
        <tr id='3e' style='visibility: hidden'><td>5</td></tr>
        <tr id='3f' style='display: none'><td>6</td></tr>
      </table>
      <p id='3g'>7</p>
      <input data-dump id='input4' aria-labelledby='label4'>
      <div style='display: none'>
        <div id='label4'>
          <p>1</p>
          <table>
            <tr><td>2</td></tr>
            <tr><td style='visibility: hidden'>3</td></tr>
            <tr><td style='display:none'>4</td></tr>
            <tr style='visibility: hidden'><td>5</td></tr>
            <tr style='display: none'><td>6</td></tr>
          </table>
          <p>7</p>
        </div>
      </div>
      <h3 id='heading1'>
        Before
        <p id='hidden1' aria-hidden='true'>Hidden text</p>
        After
      </h3>
      <button data-dump id='button1' aria-labelledby='hidden1'></button>
      <h3 id='heading2'>
        Before
        <p id='hidden2' aria-hidden='true'>Hidden text</p>
        After
      </h3>
      <button data-dump id='button2' aria-labelledby='heading2'></button>
      <h3 id='heading3' aria-hidden='true'>
        Before
        <p id='hidden3'>Text within hidden subtree</p>
        After
      </h3>
      <button data-dump id='button3' aria-labelledby='hidden3'></button>
      <h3 id='heading4' aria-hidden='true'>
        Before
        <p id='hidden4' aria-hidden='true'>Text within hidden subtree</p>
        After
      </h3>
      <button data-dump id='button4' aria-labelledby='heading4'></button>
      <label for='input5' aria-hidden='true'>
        Before
        <p aria-hidden='true'>Hidden text</p>
        After</label>
      <input data-dump id='input5'>
    </div>`,
        "[data-dump]",
        false,
      ),
  },
  { name: "accessibility-query-axtree", run: runQueryAXTree },
];

export function runCase(name: string): string {
  const found = CASES.find((c) => c.name === name);
  if (!found) throw new Error(`unknown conformance case: ${name}`);
  return found.run();
}
