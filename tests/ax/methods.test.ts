// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import {
  getAXNodeAndAncestors,
  getChildAXNodes,
  getFullAXTree,
  getPartialAXTree,
  getRootAXNode,
  queryAXTree,
} from "../../src/frame/ax-tree.ts";
import { buildContext, resetDocument } from "./_fixtures.ts";

afterEach(resetDocument);

// The CDP Accessibility method surface, now mirroring Chromium's domain.
describe("method surface", () => {
  test("getRootAXNode returns the RootWebArea", () => {
    const { options } = buildContext(`<main><button>Go</button></main>`);
    const { node } = getRootAXNode(options);
    expect(node.role?.value).toBe("RootWebArea");
    expect(node.parentId).toBeUndefined();
  });

  test("getChildAXNodes returns the direct children of an AX node", () => {
    const { options } = buildContext(`<main><button>Go</button></main>`);
    const root = getRootAXNode(options).node;
    const children = getChildAXNodes(options, root.nodeId).nodes;
    expect(children.length).toBe((root.childIds ?? []).length);
    expect(children.every((child) => child.parentId === root.nodeId)).toBe(true);
  });

  test("getAXNodeAndAncestors returns the node up through the root", () => {
    const { options, backendIdFor } = buildContext(`<main><button>Go</button></main>`);
    const chain = getAXNodeAndAncestors(options, backendIdFor("button")).nodes;
    expect(chain[0]?.role?.value).toBe("button");
    expect(chain.at(-1)?.role?.value).toBe("RootWebArea");
  });

  test("getPartialAXTree(target) returns the node, ancestors, and relatives — not far subtrees", () => {
    const { options, backendIdFor } = buildContext(
      `<main><button>Go</button><nav><a href="/x">FarLink</a></nav></main>`,
    );
    const partial = getPartialAXTree(options, backendIdFor("button")).nodes;
    const roles = partial.map((node) => node.role?.value);
    expect(roles).toContain("button"); // the target
    expect(roles).toContain("RootWebArea"); // an ancestor
    // a far cousin's leaf text is NOT pulled in:
    expect(partial.some((node) => node.name?.value === "FarLink")).toBe(false);
  });

  test("getPartialAXTree() with no target returns the full tree (back-compat)", () => {
    const { options } = buildContext(`<main><button>Go</button></main>`);
    expect(getPartialAXTree(options).nodes.length).toBe(getFullAXTree(options).nodes.length);
  });

  test("queryAXTree finds nodes by role and by accessible name", () => {
    const { options, backendIdFor } = buildContext(
      `<main><button>Go</button><button>Stop</button></main>`,
    );
    const buttons = queryAXTree(options, { target: backendIdFor("main"), role: "button" }).nodes;
    expect(buttons).toHaveLength(2);
    const stop = queryAXTree(options, { role: "button", accessibleName: "Stop" }).nodes;
    expect(stop.map((node) => node.name?.value)).toEqual(["Stop"]);
  });

  test("getFullAXTree honors the depth param (shallow tree omits deep descendants)", () => {
    const { options } = buildContext(
      `<main><section><article><button>deep</button></article></section></main>`,
    );
    const full = getFullAXTree(options).nodes;
    const shallow = getFullAXTree(options, 2).nodes;
    expect(full.some((node) => node.role?.value === "button")).toBe(true);
    expect(shallow.length).toBeLessThan(full.length);
    expect(shallow.some((node) => node.role?.value === "button")).toBe(false);
  });
});
