import type Protocol from "devtools-protocol";

type AXNode = Protocol.Accessibility.AXNode;
type Built = AXNode & { children: Built[]; parent?: Built };

/**
 * Verbatim port of Chromium's `printNodeAndChildren` from
 * web_tests/http/tests/inspector-protocol/accessibility/accessibility-getFullAXTree.js:
 * two-space indent per depth, `role.value` then optional ` "name.value"`, ignored
 * nodes spliced out (print nothing, promote their children), `<no role>` fallback.
 * The output is line-for-line comparable to Chromium's tree-walk golden files.
 */
export function printNodeAndChildren(node: Built, leadingSpace = ""): string {
  if (node.ignored) {
    return node.children.map((child) => printNodeAndChildren(child, leadingSpace)).join("\n");
  }
  let line = leadingSpace + (node.role ? node.role.value : "<no role>");
  if (node.name && node.name.value) line += ` "${node.name.value}"`;
  for (const child of node.children)
    line += "\n" + printNodeAndChildren(child, leadingSpace + "  ");
  return line;
}

/**
 * A non-splicing variant: ignored nodes ARE printed (as `(ignored) role`), so the
 * raw flat-list topology is visible. Mirrors Chromium's `*`-context dumps which
 * show the ignored wrappers rather than hiding them.
 */
export function printWithIgnored(node: Built, leadingSpace = ""): string {
  let label = node.ignored ? "(ignored) " : "";
  label += node.role ? node.role.value : "<no role>";
  if (node.name && node.name.value) label += ` "${node.name.value}"`;
  let line = leadingSpace + label;
  for (const child of node.children) line += "\n" + printWithIgnored(child, leadingSpace + "  ");
  return line;
}

/** Rebuild the tree client-side from the flat `nodes[]` via `childIds` — exactly
 *  what the Chromium harness does — then return the root. */
function rebuild(nodes: AXNode[]): Built {
  const map = new Map<string, Built>();
  for (const node of nodes) map.set(node.nodeId, { ...node, children: [] });
  for (const node of map.values()) {
    for (const childId of node.childIds ?? []) {
      const child = map.get(childId);
      if (!child) continue; // tolerate dangling childIds
      child.parent = node;
      node.children.push(child);
    }
  }
  const root = [...map.values()].find((node) => !node.parent);
  if (!root) throw new Error("no root AXNode (every node had a parent)");
  return root;
}

/** Tree-walk dump with ignored nodes spliced out (Chromium getFullAXTree style). */
export function dumpTree(nodes: AXNode[]): string {
  return printNodeAndChildren(rebuild(nodes));
}

/** Tree-walk dump that keeps ignored nodes visible. */
export function dumpTreeWithIgnored(nodes: AXNode[]): string {
  return printWithIgnored(rebuild(nodes));
}

/**
 * Mirrors Chromium's `testRunner.log(node, null, maskFields)`: blank out volatile
 * id fields so the asserted payload is role/name/value/properties/ignoredReasons
 * only. `nodeId` is module-global and never resets in the impl, so raw ids are
 * unusable across tests — masking is mandatory, not cosmetic.
 */
export function stabilize(node: AXNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "nodeId" || key === "parentId" || key === "frameId") out[key] = "<string>";
    else if (key === "backendDOMNodeId") out[key] = "<number>";
    else if (key === "childIds") out[key] = "<object>";
    else out[key] = value;
  }
  return out;
}

/** Find the first emitted node with the given CDP role value. */
export function byRole(nodes: AXNode[], role: string): AXNode | undefined {
  return nodes.find((node) => node.role?.value === role);
}

/** All emitted nodes with the given CDP role value. */
export function allByRole(nodes: AXNode[], role: string): AXNode[] {
  return nodes.filter((node) => node.role?.value === role);
}

/** The emitted node for a given DOM backend-node id (ignored nodes have role:none,
 *  so they can only be located by backend id, not by role). StaticText children
 *  reuse their parent element's backend id and are emitted before it (post-order),
 *  so the element's own node is the last match. */
export function byBackendId(
  nodes: AXNode[],
  backendId: Protocol.DOM.BackendNodeId,
): AXNode | undefined {
  return nodes.findLast((node) => node.backendDOMNodeId === backendId);
}

/** The ignored-reason names on a node. */
export function reasonsOf(node: AXNode | undefined): string[] {
  return (node?.ignoredReasons ?? []).map((reason) => reason.name);
}

/** Read a single property value off an emitted node (or undefined). */
export function prop(
  node: AXNode | undefined,
  name: string,
): Protocol.Accessibility.AXValue | undefined {
  return node?.properties?.find((property) => property.name === name)?.value;
}
