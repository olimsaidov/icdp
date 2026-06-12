import type Protocol from "devtools-protocol";

import {
  createDomRegistry,
  type DomRegistry,
  getFullAXTree,
  queryAXTree,
} from "../../src/frame/ax-tree.ts";

type AXNode = Protocol.Accessibility.AXNode;

export type AXOptions = {
  document: Document;
  frameId: Protocol.Page.FrameId;
  registry: DomRegistry;
};

/**
 * Build a fresh AX tree from an HTML fragment, the same way the Frame Agent does
 * (calling `getFullAXTree({document, frameId, registry})` directly — no relay or
 * chobitsu plumbing). Returns the flat `nodes[]` exactly as a CDP client receives.
 */
export function build(html: string, title = "Fixture"): AXNode[] {
  document.title = title;
  document.body.innerHTML = html;
  const registry = createDomRegistry();
  const { nodes } = getFullAXTree({ document, frameId: "icdp-frame", registry });
  // Round-trip through JSON so the nodes match exactly what a CDP client receives
  // over the wire: keys set to `undefined` (e.g. value/description on a button)
  // are dropped, just as `JSON.stringify` drops them in the real relay path.
  return JSON.parse(JSON.stringify(nodes)) as AXNode[];
}

/**
 * Build an AX tree from the CURRENT document without mutating its markup — use
 * after setting up a DOM imperatively (e.g. attaching a shadow root), which
 * `build()`'s innerHTML assignment would destroy.
 */
export function snapshot(): AXNode[] {
  const registry = createDomRegistry();
  const { nodes } = getFullAXTree({ document, frameId: "icdp-frame", registry });
  return JSON.parse(JSON.stringify(nodes)) as AXNode[];
}

/**
 * Set up a document and return the AX `options` (with a live registry) plus a
 * helper to resolve a CSS selector to its DOM backend-node id — for exercising
 * the node-addressed methods (getPartialAXTree/queryAXTree/…). The tree is built
 * once so the registry and AX-id map are populated before the method runs.
 */
export function buildContext(
  html: string,
  title = "Fixture",
): {
  options: AXOptions;
  nodes: AXNode[];
  backendIdFor: (selector: string) => Protocol.DOM.BackendNodeId;
} {
  document.title = title;
  document.body.innerHTML = html;
  const registry = createDomRegistry();
  const options: AXOptions = { document, frameId: "icdp-frame", registry };
  const nodes = JSON.parse(JSON.stringify(getFullAXTree(options).nodes)) as AXNode[];
  return {
    options,
    nodes,
    backendIdFor: (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`no element for selector ${selector}`);
      return registry.backendIdFor(element);
    },
  };
}

/** Build a fixture and return the queryAXTree matches for a given role. */
export function queryRole(html: string, role: string, title = "Fixture"): AXNode[] {
  const { options } = buildContext(html, title);
  return queryAXTree(options, { role }).nodes;
}

/** Reset the document between tests so fixtures don't leak into one another. */
export function resetDocument(): void {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
}
