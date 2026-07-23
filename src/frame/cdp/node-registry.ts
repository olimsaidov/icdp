import type Protocol from "devtools-protocol";

import type { DomRegistry } from "../ax-tree.ts";

export class SessionNodeRegistry {
  private nodeToId = new WeakMap<Node, Protocol.DOM.NodeId>();
  private childrenRequested = new WeakSet<Node>();
  private readonly idToNode = new Map<Protocol.DOM.NodeId, Node>();
  private nextNodeId = 1;

  constructor(private readonly backend: DomRegistry) {}

  bind(node: Node): Protocol.DOM.NodeId {
    const existing = this.nodeToId.get(node);
    if (existing !== undefined) return existing;
    const id = this.nextNodeId++;
    this.nodeToId.set(node, id);
    this.idToNode.set(id, node);
    return id;
  }

  idForNode(node: Node): Protocol.DOM.NodeId {
    return this.nodeToId.get(node) ?? 0;
  }

  nodeForNodeId(id: Protocol.DOM.NodeId): Node | undefined {
    return this.idToNode.get(id);
  }

  markChildrenRequested(node: Node): void {
    this.childrenRequested.add(node);
  }

  childrenWereRequested(node: Node): boolean {
    return this.childrenRequested.has(node);
  }

  backendIdFor(node: Node): Protocol.DOM.BackendNodeId {
    return this.backend.backendIdFor(node);
  }

  nodeForBackendId(id: Protocol.DOM.BackendNodeId): Node | undefined {
    return this.backend.nodeForBackendId(id);
  }

  pushBackendIds(ids: Protocol.DOM.BackendNodeId[]): Protocol.DOM.NodeId[] {
    return ids.map((id) => {
      const node = this.backend.nodeForBackendId(id);
      return node ? this.bind(node) : 0;
    });
  }

  unbindSubtree(node: Node): void {
    for (const child of Array.from(node.childNodes)) {
      this.unbindSubtree(child);
    }
    const shadowRoot = node.nodeType === node.ELEMENT_NODE ? (node as Element).shadowRoot : null;
    if (shadowRoot) {
      this.unbindSubtree(shadowRoot);
    }
    if (node.nodeType === node.ELEMENT_NODE && (node as Element).localName === "template") {
      this.unbindSubtree((node as HTMLTemplateElement).content);
    }
    this.unbindNode(node);
  }

  unbindNode(node: Node): void {
    this.childrenRequested.delete(node);
    const id = this.nodeToId.get(node);
    if (id === undefined) return;
    this.nodeToId.delete(node);
    this.idToNode.delete(id);
  }

  reset(): void {
    this.nodeToId = new WeakMap();
    this.childrenRequested = new WeakSet();
    this.idToNode.clear();
  }
}
