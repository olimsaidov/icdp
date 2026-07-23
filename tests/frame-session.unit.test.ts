// @vitest-environment jsdom
import { expect, test, vi } from "vitest";

import { FrameBackend } from "../src/frame/cdp/session.ts";

function walkDomNodes(node: any): any[] {
  return [
    node,
    ...(node.children ?? []).flatMap(walkDomNodes),
    ...(node.shadowRoots ?? []).flatMap(walkDomNodes),
  ];
}

function bodyNode(root: any): any {
  return root.children
    .find((node: any) => node.nodeName === "HTML")
    .children.find((node: any) => node.nodeName === "BODY");
}

function findButtonNode(node: any): any {
  return node.nodeName === "BUTTON" ? node : node.children?.map(findButtonNode).find(Boolean);
}

test("DOM.getDocument returns session node ids and stable backend node ids", async () => {
  document.body.innerHTML = "<main><button>Save</button></main>";
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.backendNodes.backendIdFor(document.body);
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 1,
    method: "DOM.getDocument",
    params: { depth: 1 },
  });

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    kind: "response",
    sessionId: "session-a",
    id: 1,
    result: {
      root: {
        nodeName: "#document",
        nodeType: 9,
      },
    },
  });
  const root = messages[0].result.root;
  expect(root.nodeId).not.toBe(root.backendNodeId);
});

test("frontend node ids cannot be used by a different session", async () => {
  document.body.innerHTML = "<button>Save</button>";
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  backend.attach("session-b", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 1,
    method: "DOM.getDocument",
    params: { depth: 0 },
  });
  const rootNodeId = messages.pop().result.root.nodeId;

  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 2,
    method: "DOM.querySelectorAll",
    params: { nodeId: rootNodeId, selector: "button" },
  });

  expect(messages).toEqual([
    {
      kind: "response",
      sessionId: "session-b",
      id: 2,
      error: { code: -32000, message: "Could not find node with given id" },
    },
  ]);
});

test("required command parameters use Chromium's invalid-params response", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 7,
    method: "DOM.querySelectorAll",
    params: { nodeId: 1 },
  });

  expect(messages).toEqual([
    {
      kind: "response",
      sessionId: "session-a",
      id: 7,
      error: { code: -32602, message: "Invalid parameters" },
    },
  ]);
});

test.each([
  ["DOM.getDocument", { depth: 1.5 }],
  ["DOM.querySelectorAll", { nodeId: "1", selector: "button" }],
  ["Input.dispatchMouseEvent", { type: "mouseMoved", x: "0", y: 0 }],
  ["Network.getResponseBody", { requestId: 42 }],
  ["Page.navigate", { url: 42 }],
  ["Runtime.callFunctionOn", { functionDeclaration: "function () {}", arguments: {} }],
  ["Runtime.evaluate", { expression: 42 }],
  ["Runtime.evaluate", { expression: "1", awaitPromise: "true" }],
  ["Storage.getUsageAndQuota", { origin: 42 }],
] as const)("%s rejects parameters with non-CDP JSON types", async (method, params) => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 71,
    method,
    params: params as Record<string, unknown>,
  });

  expect(messages).toEqual([
    {
      kind: "response",
      sessionId: "session-a",
      id: 71,
      error: { code: -32602, message: "Invalid parameters" },
    },
  ]);
});

// Adapted from Chromium dom/dom-describeNode-nodeId.js.
test("DOM.describeNode does not create a frontend node binding", async () => {
  document.body.innerHTML = '<button id="save">Save</button>';
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  const button = document.querySelector("button")!;
  backend.backendNodes.backendIdFor(document.body);
  const backendNodeId = backend.backendNodes.backendIdFor(button);
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 8,
    method: "DOM.describeNode",
    params: { backendNodeId },
  });

  expect(messages[0]).toMatchObject({
    kind: "response",
    sessionId: "session-a",
    id: 8,
    result: {
      node: {
        backendNodeId,
        nodeId: 0,
        nodeName: "BUTTON",
        localName: "button",
        attributes: ["id", "save"],
      },
    },
  });
  expect(messages[0].result.node).not.toHaveProperty("children");
});

// Adapted from Chromium's DOM.describeNode default-depth coverage.
test("DOM document and describeNode defaults use Chromium depths", async () => {
  document.body.innerHTML = "<main><button>Save</button></main>";
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 800,
    method: "DOM.getDocument",
    params: {},
  });
  const root = messages.find((message) => message.id === 800).result.root;
  const html = root.children.find((node: any) => node.nodeName === "HTML");
  expect(html.children.map((node: any) => node.nodeName)).toEqual(["HEAD", "BODY"]);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 8001,
    method: "DOM.describeNode",
    params: { backendNodeId: backend.backendNodes.backendIdFor(document.querySelector("button")!) },
  });
  const described = messages.find((message) => message.id === 8001).result.node;
  expect(described).toMatchObject({
    nodeName: "BUTTON",
    childNodeCount: 1,
  });
  expect(described).not.toHaveProperty("children");
});

// Adapted from Blink InspectorDOMAgent::BuildObjectForNode and
// BuildArrayForContainerChildren.
test("DOM.getDocument preserves Chromium shallow-tree and shadow-root rules", async () => {
  document.body.innerHTML =
    '<main><button>Save</button><div id="empty"></div><div id="host"><span>light</span></div></main>';
  const host = document.querySelector<HTMLElement>("#host")!;
  host.attachShadow({ mode: "open" }).innerHTML = "<strong>shadow</strong>";
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 801,
    method: "DOM.getDocument",
    params: { depth: -1 },
  });

  const nodes = walkDomNodes(messages[0].result.root);
  const button = nodes.find((node) => node.nodeName === "BUTTON");
  const empty = nodes.find((node) => node.nodeName === "DIV" && node.attributes?.includes("empty"));
  const hostNode = nodes.find(
    (node) => node.nodeName === "DIV" && node.attributes?.includes("host"),
  );

  expect(button.children).toEqual([
    expect.objectContaining({
      nodeType: 3,
      nodeName: "#text",
      nodeValue: "Save",
      parentId: button.nodeId,
    }),
  ]);
  expect(empty).toMatchObject({ childNodeCount: 0, children: [] });
  expect(hostNode.shadowRoots).toEqual([
    expect.objectContaining({
      nodeType: 11,
      nodeName: "#document-fragment",
      shadowRootType: "open",
      childNodeCount: 1,
    }),
  ]);

  messages.length = 0;
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 802,
    method: "DOM.getDocument",
    params: { depth: -1, pierce: true },
  });
  const piercedHost = walkDomNodes(messages[0].result.root).find(
    (node) => node.nodeName === "DIV" && node.attributes?.includes("host"),
  );
  expect(piercedHost.shadowRoots[0].children[0]).toMatchObject({
    nodeName: "STRONG",
    children: [expect.objectContaining({ nodeValue: "shadow" })],
  });
});

// Adapted from Blink InspectorDOMAgent::PushNodePathToFrontend.
test("DOM.querySelectorAll pushes result ancestry before returning node ids", async () => {
  document.body.innerHTML = "<main><section><button>Save</button></section></main>";
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 803,
    method: "DOM.getDocument",
    params: { depth: 0 },
  });
  const rootNodeId = messages.pop().result.root.nodeId;

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 804,
    method: "DOM.querySelectorAll",
    params: { nodeId: rootNodeId, selector: "button" },
  });

  const responseIndex = messages.findIndex((message) => message.id === 804);
  const response = messages[responseIndex];
  expect(response.result.nodeIds).toEqual([expect.any(Number)]);
  expect(response.result.nodeIds[0]).toBeGreaterThan(0);
  expect(messages.slice(0, responseIndex)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "event",
        sessionId: "session-a",
        method: "DOM.setChildNodes",
      }),
    ]),
  );
  const pushed = messages.slice(0, responseIndex).flatMap((message) => message.params?.nodes ?? []);
  expect(JSON.stringify(pushed)).toContain(`"nodeId":${response.result.nodeIds[0]}`);
});

test("DOM observes mutations in exposed open shadow roots", async () => {
  document.body.innerHTML = '<div id="host"></div>';
  const shadow = document.querySelector<HTMLElement>("#host")!.attachShadow({
    mode: "open",
  });
  shadow.innerHTML = "<span>before</span>";
  const span = shadow.querySelector("span")!;
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 805,
    method: "DOM.getDocument",
    params: { depth: -1, pierce: true },
  });
  const nodeId = messages[0].result.root.children
    .flatMap((node: any) => JSON.stringify(node))
    .join("")
    .includes("SPAN");
  expect(nodeId).toBe(true);
  messages.length = 0;

  span.setAttribute("data-state", "ready");
  await Promise.resolve();

  expect(messages).toContainEqual(
    expect.objectContaining({
      kind: "event",
      sessionId: "session-a",
      method: "DOM.attributeModified",
      params: expect.objectContaining({
        name: "data-state",
        value: "ready",
      }),
    }),
  );
});

test("DOM.getBoxModel returns distinct content, padding, border, and margin quads", async () => {
  document.body.innerHTML = "<button>Save</button>";
  const button = document.querySelector("button")!;
  button.style.cssText =
    "box-sizing:border-box;width:100px;height:50px;padding:5px;border:2px solid;margin:3px";
  button.getBoundingClientRect = () =>
    ({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 110,
      bottom: 70,
      width: 100,
      height: 50,
      toJSON() {},
    }) as DOMRect;
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  const backendNodeId = backend.backendNodes.backendIdFor(button);
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 9,
    method: "DOM.getBoxModel",
    params: { backendNodeId },
  });

  expect(messages[0].result.model).toMatchObject({
    content: [17, 27, 103, 27, 103, 63, 17, 63],
    padding: [12, 22, 108, 22, 108, 68, 12, 68],
    border: [10, 20, 110, 20, 110, 70, 10, 70],
    margin: [7, 17, 113, 17, 113, 73, 7, 73],
    width: 100,
    height: 50,
  });
});

test("DOM.getBoxModel preserves fractional quad coordinates", async () => {
  document.body.innerHTML = "<button>Save</button>";
  const button = document.querySelector("button")!;
  button.getBoundingClientRect = () =>
    ({
      x: 10.25,
      y: 20.5,
      left: 10.25,
      top: 20.5,
      right: 110.75,
      bottom: 70.75,
      width: 100.5,
      height: 50.25,
      toJSON() {},
    }) as DOMRect;
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 901,
    method: "DOM.getBoxModel",
    params: { backendNodeId: backend.backendNodes.backendIdFor(button) },
  });

  expect(messages[0].result.model).toMatchObject({
    border: [10.25, 20.5, 110.75, 20.5, 110.75, 70.75, 10.25, 70.75],
    width: 101,
    height: 50,
  });
});

// Ported from Chromium's DOM mutation event tests. A session receives events
// only for frontend nodes it has requested.
test("DOM mutation events follow bound nodes and per-session enablement", async () => {
  document.body.innerHTML = "<main><p>before</p></main>";
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  backend.attach("session-b", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 91,
    method: "DOM.getDocument",
    params: { depth: -1 },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 92,
    method: "DOM.enable",
    params: {},
  });
  messages.length = 0;

  const paragraph = document.querySelector("p")!;
  paragraph.setAttribute("data-state", "ready");
  paragraph.firstChild!.nodeValue = "after";
  const child = document.createElement("span");
  child.textContent = "new";
  paragraph.append(child);
  await vi.waitFor(() => {
    expect(messages.filter((message) => message.sessionId === "session-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          method: "DOM.attributeModified",
          params: expect.objectContaining({
            name: "data-state",
            value: "ready",
          }),
        }),
        expect.objectContaining({
          kind: "event",
          method: "DOM.characterDataModified",
          params: expect.objectContaining({ characterData: "after" }),
        }),
        expect.objectContaining({
          kind: "event",
          method: "DOM.childNodeInserted",
          params: expect.objectContaining({
            node: expect.objectContaining({
              nodeName: "SPAN",
              nodeValue: "",
            }),
          }),
        }),
      ]),
    );
  });
  expect(
    messages.filter(
      (message) => message.sessionId === "session-b" && message.method?.startsWith("DOM."),
    ),
  ).toEqual([]);

  messages.length = 0;
  child.remove();
  await vi.waitFor(() => {
    expect(messages).toEqual([
      expect.objectContaining({
        kind: "event",
        sessionId: "session-a",
        method: "DOM.childNodeRemoved",
      }),
    ]);
  });
  const removedNodeId = messages[0].params.nodeId;
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 921,
    method: "DOM.describeNode",
    params: { nodeId: removedNodeId },
  });
  expect(messages.find((message) => message.id === 921)?.error).toEqual({
    code: -32000,
    message: "Could not find node with given id",
  });
  messages.length = 0;
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 93,
    method: "DOM.disable",
    params: {},
  });
  paragraph.setAttribute("data-state", "ignored");
  await Promise.resolve();
  expect(messages.filter((message) => message.kind === "event")).toEqual([]);
});

test("DOM reports child counts until a session has requested the children", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 94,
    method: "DOM.getDocument",
    params: { depth: 0 },
  });
  const rootNodeId = messages.find((message) => message.id === 94).result.root.nodeId;
  messages.length = 0;

  document.append(document.createComment("new"));
  await vi.waitFor(() => {
    expect(messages).toEqual([
      {
        kind: "event",
        sessionId: "session-a",
        method: "DOM.childNodeCountUpdated",
        params: {
          nodeId: rootNodeId,
          childNodeCount: expect.any(Number),
        },
      },
    ]);
  });
  expect(messages[0].params.childNodeCount).toBe(
    Array.from(document.childNodes).filter(
      (node) => !(node instanceof Text) || node.data.trim() !== "",
    ).length,
  );
  backend.clearSessions();
});

test("DOM.requestNode pushes the frontend ancestry and otherwise returns zero", async () => {
  document.body.innerHTML = "<main><button>Save</button></main>";
  const button = document.querySelector("button")!;
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  const backendNodeId = backend.backendNodes.backendIdFor(button);
  backend.attach("session-a", []);
  backend.attach("session-b", []);
  for (const sessionId of ["session-a", "session-b"]) {
    await backend.command({
      kind: "command",
      sessionId,
      id: sessionId === "session-a" ? 95 : 96,
      method: "DOM.resolveNode",
      params: { backendNodeId },
    });
  }
  const objectA = messages.find((message) => message.id === 95).result.object.objectId;
  const objectB = messages.find((message) => message.id === 96).result.object.objectId;
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 97,
    method: "DOM.getDocument",
    params: { depth: 0 },
  });
  messages.length = 0;

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 98,
    method: "DOM.requestNode",
    params: { objectId: objectA },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 99,
    method: "DOM.requestNode",
    params: { objectId: objectB },
  });

  const pushed = messages.filter(
    (message) => message.sessionId === "session-a" && message.method === "DOM.setChildNodes",
  );
  expect(pushed.length).toBeGreaterThanOrEqual(3);
  expect(pushed.at(-1)?.params.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        nodeName: "BUTTON",
        backendNodeId,
      }),
    ]),
  );
  const nodeId = messages.find((message) => message.id === 98).result.nodeId;
  expect(nodeId).toBeGreaterThan(0);
  expect(
    pushed.some((message) => message.params.nodes.some((node: any) => node.nodeId === nodeId)),
  ).toBe(true);
  expect(messages.find((message) => message.id === 99)?.result).toEqual({
    nodeId: 0,
  });
  expect(
    messages.filter(
      (message) => message.sessionId === "session-b" && message.method === "DOM.setChildNodes",
    ),
  ).toEqual([]);
  expect(messages.findIndex((message) => message.id === 98)).toBeGreaterThan(
    messages.findLastIndex((message) => message.method === "DOM.setChildNodes"),
  );
  backend.clearSessions();
});

test("DOM includeWhitespace is session-scoped for snapshots and insertions", async () => {
  document.body.innerHTML = " \n <span>content</span> \n ";
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  backend.attach("session-b", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 100,
    method: "DOM.getDocument",
    params: { depth: -1 },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 101,
    method: "DOM.enable",
    params: { includeWhitespace: "all" },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 102,
    method: "DOM.getDocument",
    params: { depth: -1 },
  });
  expect(bodyNode(messages.find((message) => message.id === 100).result.root).children).toEqual([
    expect.objectContaining({ nodeName: "SPAN" }),
  ]);
  expect(bodyNode(messages.find((message) => message.id === 102).result.root).children).toEqual([
    expect.objectContaining({ nodeName: "#text" }),
    expect.objectContaining({ nodeName: "SPAN" }),
    expect.objectContaining({ nodeName: "#text" }),
  ]);
  messages.length = 0;

  document.body.append(document.createTextNode(" "));
  await vi.waitFor(() => {
    expect(messages.filter((message) => message.method === "DOM.childNodeInserted")).toEqual([
      expect.objectContaining({ sessionId: "session-b" }),
    ]);
  });
  backend.clearSessions();
});

test("DOM includeWhitespace is restored with the flattened session", async () => {
  document.body.innerHTML = " \n <span>content</span> \n ";
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", ["DOM"], { DOM: { includeWhitespace: "all" } });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 103,
    method: "DOM.getDocument",
    params: { depth: -1 },
  });

  const root = messages.find((message) => message.id === 103).result.root;
  const body = root.children
    .find((node: any) => node.nodeName === "HTML")
    .children.find((node: any) => node.nodeName === "BODY");
  expect(body.children.map((node: any) => node.nodeName)).toEqual(["#text", "SPAN", "#text"]);
  backend.clearSessions();
});

test("Page.enable reports only lifecycle events that actually occur afterward", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  backend.attach("session-b", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 10,
    method: "Page.enable",
    params: {},
  });

  expect(messages.filter((message) => message.kind === "event")).toEqual([]);

  document.dispatchEvent(new Event("DOMContentLoaded"));
  window.dispatchEvent(new Event("load"));

  const events = messages.filter((message) => message.kind === "event");
  expect(events.map((event) => [event.sessionId, event.method])).toEqual([
    ["session-a", "Page.domContentEventFired"],
    ["session-a", "Page.loadEventFired"],
  ]);
  expect(
    events.every(
      (event) =>
        typeof event.params.timestamp === "number" &&
        event.params.timestamp >= window.performance.timeOrigin / 1000,
    ),
  ).toBe(true);
});

test("same-document transport restoration does not turn Page.enable into navigation", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 11,
    method: "Page.enable",
    params: {},
  });

  backend.clearSessions();
  backend.attach("session-a", ["Page"]);

  expect(messages.filter((message) => message.kind === "event")).toEqual([]);
});

test("a restored Page domain reports the replacement frame navigation", () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });

  backend.attach("session-a", ["Page"]);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    kind: "event",
    sessionId: "session-a",
    method: "Page.frameNavigated",
    params: {
      type: "Navigation",
      frame: {
        id: "icdp-frame",
        loaderId: expect.any(String),
        url: expect.any(String),
        domainAndRegistry: "",
        securityOrigin: expect.any(String),
        mimeType: "text/html",
        secureContextType: expect.any(String),
        crossOriginIsolatedContextType: "NotIsolated",
        gatedAPIFeatures: [],
      },
    },
  });

  document.dispatchEvent(new Event("DOMContentLoaded"));
  window.dispatchEvent(new Event("load"));
  expect(messages.map((message) => message.method)).toEqual([
    "Page.frameNavigated",
    "Page.domContentEventFired",
    "Page.loadEventFired",
  ]);
});

test("restored Page replays actual lifecycle stages missed before attach", () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });

  document.dispatchEvent(new Event("DOMContentLoaded"));
  window.dispatchEvent(new Event("load"));
  backend.attach("session-a", ["Page"]);

  expect(messages.map((message) => message.method)).toEqual([
    "Page.frameNavigated",
    "Page.domContentEventFired",
    "Page.loadEventFired",
  ]);
});

test("restores Runtime before replaying a replacement document's Page lifecycle", () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  document.dispatchEvent(new Event("DOMContentLoaded"));
  window.dispatchEvent(new Event("load"));

  backend.attach("session-a", ["Page", "Runtime"]);

  expect(messages.map((message) => message.method)).toEqual([
    "Runtime.executionContextsCleared",
    "Page.frameNavigated",
    "Runtime.executionContextCreated",
    "Page.domContentEventFired",
    "Page.loadEventFired",
  ]);
});

test("reports persisted pageshow as BackForwardCacheRestore", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 12,
    method: "Page.enable",
    params: {},
  });
  backend.clearSessions();

  const pageShow = new Event("pageshow");
  Object.defineProperty(pageShow, "persisted", { value: true });
  window.dispatchEvent(pageShow);
  backend.attach("session-a", ["Page"]);

  expect(messages.filter((message) => message.kind === "event")).toMatchObject([
    {
      sessionId: "session-a",
      method: "Page.frameNavigated",
      params: { type: "BackForwardCacheRestore" },
    },
  ]);
});

test("restores a BFCache navigation after its preserved Runtime context", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 13,
    method: "Page.enable",
    params: {},
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 14,
    method: "Runtime.enable",
    params: {},
  });
  messages.length = 0;
  backend.clearSessions();

  const pageShow = new Event("pageshow");
  Object.defineProperty(pageShow, "persisted", { value: true });
  window.dispatchEvent(pageShow);
  backend.attach("session-a", ["Page", "Runtime"]);

  expect(messages.map((message) => message.method)).toEqual([
    "Runtime.executionContextsCleared",
    "Runtime.executionContextCreated",
    "Page.frameNavigated",
  ]);
  expect(messages.at(-1)?.params.type).toBe("BackForwardCacheRestore");
});

test("same-document Page restoration does not duplicate delivered lifecycle", () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });

  backend.attach("session-a", ["Page"]);
  document.dispatchEvent(new Event("DOMContentLoaded"));
  backend.clearSessions();
  window.dispatchEvent(new Event("load"));
  backend.attach("session-a", ["Page"]);

  expect(messages.map((message) => message.method)).toEqual([
    "Page.frameNavigated",
    "Page.domContentEventFired",
    "Page.loadEventFired",
  ]);

  const replacementMessages: any[] = [];
  const replacement = new FrameBackend({
    document,
    send: (message) => replacementMessages.push(message),
  });
  replacement.attach("session-a", ["Page"]);
  expect(replacementMessages[0]?.method).toBe("Page.frameNavigated");
});

test("Accessibility state is session-scoped", async () => {
  document.body.innerHTML = "<button>Save</button>";
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  backend.attach("session-b", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 11,
    method: "Accessibility.enable",
    params: {},
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 12,
    method: "Accessibility.getFullAXTree",
    params: {},
  });
  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 13,
    method: "Accessibility.getFullAXTree",
    params: {},
  });
  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 131,
    method: "Accessibility.getRootAXNode",
    params: {},
  });

  expect(messages.find((message) => message.id === 12)?.result.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        backendDOMNodeId: expect.any(Number),
        role: expect.objectContaining({ value: "button" }),
      }),
    ]),
  );
  expect(messages.find((message) => message.id === 13)?.result.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        backendDOMNodeId: expect.any(Number),
        role: expect.objectContaining({ value: "button" }),
      }),
    ]),
  );
  expect(messages.find((message) => message.id === 131)?.error).toEqual({
    code: -32000,
    message: "Accessibility has not been enabled.",
  });
});

// Ported from Chromium's accessibility/getPartialAXTree.js target matrix.
test("Accessibility.getPartialAXTree resolves exactly one DOM or Runtime target", async () => {
  document.body.innerHTML = "<button>Save</button>";
  const button = document.querySelector("button")!;
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  const backendNodeId = backend.backendNodes.backendIdFor(button);
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 14,
    method: "Accessibility.enable",
    params: {},
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 15,
    method: "DOM.resolveNode",
    params: { backendNodeId },
  });
  const objectId = messages.find((message) => message.id === 15).result.object.objectId;

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 16,
    method: "Accessibility.getPartialAXTree",
    params: { objectId, fetchRelatives: false },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 17,
    method: "Accessibility.getPartialAXTree",
    params: {},
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 18,
    method: "Accessibility.getPartialAXTree",
    params: { backendNodeId, objectId },
  });

  expect(messages.find((message) => message.id === 16)?.result.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        backendDOMNodeId: backendNodeId,
        role: expect.objectContaining({ value: "button" }),
      }),
    ]),
  );
  expect(messages.find((message) => message.id === 17)?.error).toEqual({
    code: -32000,
    message: "Either nodeId, backendNodeId or objectId must be specified",
  });
  expect(messages.find((message) => message.id === 18)?.result.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ backendDOMNodeId: backendNodeId })]),
  );
});

test("Storage.getUsageAndQuota uses the browser estimate for the requested origin", async () => {
  const messages: any[] = [];
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { estimate: async () => ({ usage: 321, quota: 654 }) },
  });
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 14,
    method: "Storage.getUsageAndQuota",
    params: { origin: location.origin },
  });

  expect(messages[0]).toEqual({
    kind: "response",
    sessionId: "session-a",
    id: 14,
    result: {
      usage: 321,
      quota: 654,
      overrideActive: false,
      usageBreakdown: [],
    },
  });
});

test("Input.dispatchKeyEvent inserts text only for the key-down phase", async () => {
  document.body.innerHTML = "<input>";
  const input = document.querySelector("input")!;
  input.focus();
  const events: string[] = [];
  input.addEventListener("input", () => events.push("input"));
  input.addEventListener("change", () => events.push("change"));
  const backend = new FrameBackend({ document, send: () => {} });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 15,
    method: "Input.dispatchKeyEvent",
    params: { type: "keyDown", key: "a", text: "a" },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 16,
    method: "Input.dispatchKeyEvent",
    params: { type: "keyUp", key: "a", text: "a" },
  });

  expect(input.value).toBe("a");
  expect(events).toEqual(["input"]);
});

// TypeScript adaptation of Chromium's
// third_party/blink/web_tests/inspector-protocol/input/dispatchKeyEvent.js,
// plus regressions for raw text insertion and keypad-location precedence.
test("Input.dispatchKeyEvent preserves raw, char, and keypad semantics", async () => {
  document.body.innerHTML = "<input>";
  const input = document.querySelector("input")!;
  input.focus();
  const keypresses: Array<{ charCode: number; keyCode: number }> = [];
  const keydownLocations: number[] = [];
  input.addEventListener("keypress", (event) => {
    keypresses.push({
      charCode: event.charCode,
      keyCode: event.keyCode,
    });
  });
  input.addEventListener("keydown", (event) => {
    keydownLocations.push(event.location);
  });
  const backend = new FrameBackend({ document, send: () => {} });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 151,
    method: "Input.dispatchKeyEvent",
    params: { type: "rawKeyDown", key: "x", text: "x" },
  });
  expect(input.value).toBe("");

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 152,
    method: "Input.dispatchKeyEvent",
    params: { type: "char", key: "ש", text: "ש" },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 153,
    method: "Input.dispatchKeyEvent",
    params: {
      type: "keyDown",
      key: "1",
      code: "Numpad1",
      isKeypad: true,
      location: 1,
    },
  });

  expect(input.value).toBe("ש");
  expect(keypresses).toEqual([{ charCode: 1513, keyCode: 1513 }]);
  expect(keydownLocations).toEqual([0, 3]);
});

test("Input.dispatchKeyEvent keeps native and Windows virtual key codes distinct", async () => {
  document.body.innerHTML = '<input value="abc">';
  const input = document.querySelector("input")!;
  input.focus();
  input.setSelectionRange(3, 3);
  const keyCodes: number[] = [];
  input.addEventListener("keydown", (event) => keyCodes.push(event.keyCode));
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 154,
    method: "Input.dispatchKeyEvent",
    params: {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      nativeVirtualKeyCode: 8,
    },
  });

  expect(messages[0]).toEqual({
    kind: "response",
    sessionId: "session-a",
    id: 154,
    result: {},
  });
  expect(keyCodes).toEqual([0]);
  expect(input.value).toBe("ab");
});

test("Input.insertText supports controls without a selection range", async () => {
  document.body.innerHTML = '<input type="email" value="before@example.test">';
  const input = document.querySelector("input")!;
  input.focus();
  const events: string[] = [];
  input.addEventListener("input", () => events.push("input"));
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 161,
    method: "Input.insertText",
    params: { text: ".new" },
  });

  expect(messages[0]).toEqual({
    kind: "response",
    sessionId: "session-a",
    id: 161,
    result: {},
  });
  expect(input.value).toBe("before@example.test.new");
  expect(events).toEqual(["input"]);
});

test("Input.dispatchMouseEvent preserves the pressed target for click synthesis", async () => {
  document.body.innerHTML = "<button>Save</button>";
  const button = document.querySelector("button")!;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => button,
  });
  let clicks = 0;
  button.addEventListener("click", () => clicks++);
  const backend = new FrameBackend({ document, send: () => {} });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 17,
    method: "Input.dispatchMouseEvent",
    params: { type: "mousePressed", x: 10, y: 10, button: "left", buttons: 1 },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 18,
    method: "Input.dispatchMouseEvent",
    params: { type: "mouseReleased", x: 10, y: 10, button: "left", buttons: 0 },
  });

  expect(clicks).toBe(1);
});

// Direct TypeScript rewrite of Chromium's dispatchMouseEvent.js event sequence
// and expected output, with auxclick retained as an additional assertion.
test("Input.dispatchMouseEvent derives DOM button state and right-click order", async () => {
  document.body.innerHTML = "<button>Target</button>";
  const button = document.querySelector("button")!;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => button,
  });
  const events: Array<{
    type: string;
    button: number;
    buttons: number;
    shiftKey: boolean;
  }> = [];
  for (const type of ["mousedown", "mouseup", "mousemove", "wheel", "auxclick", "contextmenu"]) {
    button.addEventListener(type, (event) => {
      const mouse = event as MouseEvent;
      events.push({
        type: event.type,
        button: mouse.button,
        buttons: mouse.buttons,
        shiftKey: mouse.shiftKey,
      });
    });
  }
  const backend = new FrameBackend({ document, send: () => {} });
  backend.attach("session-a", []);
  let id = 170;
  const dispatch = async (params: Record<string, unknown>) => {
    await backend.command({
      kind: "command",
      sessionId: "session-a",
      id: id++,
      method: "Input.dispatchMouseEvent",
      params: { x: 10, y: 10, ...params },
    });
  };

  await dispatch({ type: "mousePressed", button: "left", buttons: 0 });
  await dispatch({ type: "mousePressed", button: "middle", buttons: 1 });
  await dispatch({ type: "mouseReleased", button: "middle", buttons: 5 });
  await dispatch({ type: "mouseReleased", button: "left", buttons: 1 });
  await dispatch({ type: "mouseMoved", modifiers: 8, buttons: 0 });
  await dispatch({ type: "mousePressed", button: "right", buttons: 0 });
  await dispatch({ type: "mouseReleased", button: "right", buttons: 2 });
  await dispatch({ type: "mousePressed", button: "back", buttons: 0 });
  await dispatch({ type: "mousePressed", button: "forward", buttons: 8 });
  await dispatch({ type: "mouseWheel", deltaX: 50, deltaY: 70 });

  expect(events).toEqual([
    { type: "mousedown", button: 0, buttons: 1, shiftKey: false },
    { type: "mousedown", button: 1, buttons: 5, shiftKey: false },
    { type: "mouseup", button: 1, buttons: 1, shiftKey: false },
    { type: "auxclick", button: 1, buttons: 1, shiftKey: false },
    { type: "mouseup", button: 0, buttons: 0, shiftKey: false },
    { type: "mousemove", button: 0, buttons: 0, shiftKey: true },
    { type: "mousedown", button: 2, buttons: 2, shiftKey: false },
    { type: "contextmenu", button: 2, buttons: 2, shiftKey: false },
    { type: "mouseup", button: 2, buttons: 0, shiftKey: false },
    { type: "mousedown", button: 3, buttons: 8, shiftKey: false },
    { type: "mousedown", button: 4, buttons: 24, shiftKey: false },
    { type: "wheel", button: 0, buttons: 0, shiftKey: false },
  ]);
});

test("Input.dispatchMouseEvent validates Chromium mouse parameters", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ type: "mousePressed", x: 0, y: 0, button: "invalid" }, "Invalid mouse button"],
    [
      { type: "mouseWheel", x: 0, y: 0, deltaX: 1 },
      "'deltaX' and 'deltaY' are expected for mouseWheel event",
    ],
    [{ type: "mouseMoved", x: 0, y: 0, force: 2 }, "'force' should be in the range of [0,1]"],
    [
      { type: "mouseMoved", x: 0, y: 0, tangentialPressure: -2 },
      "'tangential_pressure' should be in the range of [-1,1]",
    ],
    [{ type: "mouseMoved", x: 0, y: 0, tiltX: 91 }, "'tilt_x' should be in the range of [-90,90]"],
    [{ type: "mouseMoved", x: 0, y: 0, tiltY: -91 }, "'tilt_y' should be in the range of [-90,90]"],
    [{ type: "mouseMoved", x: 0, y: 0, twist: 360 }, "'twist' should be in the range of [0,359]"],
    [{ type: "mouseMoved", x: 0, y: 0, pointerType: "touch" }, "Invalid parameters"],
  ];

  for (const [index, [params, message]] of invalid.entries()) {
    const id = 180 + index;
    await backend.command({
      kind: "command",
      sessionId: "session-a",
      id,
      method: "Input.dispatchMouseEvent",
      params,
    });
    expect(messages.find((response) => response.id === id)?.error).toEqual({
      code: -32602,
      message,
    });
  }
});

test("Input.dispatchMouseEvent exposes supported pen properties on pointer events", async () => {
  document.body.innerHTML = "<button>Draw</button>";
  const button = document.querySelector("button")!;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => button,
  });
  const received: PointerEvent[] = [];
  button.addEventListener("pointerdown", (event) => {
    received.push(event as PointerEvent);
  });
  const backend = new FrameBackend({ document, send: () => {} });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 199,
    method: "Input.dispatchMouseEvent",
    params: {
      type: "mousePressed",
      x: 12,
      y: 34,
      button: "left",
      buttons: 1,
      force: 0.75,
      tangentialPressure: 0.25,
      tiltX: 15,
      tiltY: -20,
      twist: 120,
      pointerType: "pen",
    },
  });

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    pointerType: "pen",
    pressure: 0.75,
    tangentialPressure: 0.25,
    tiltX: 15,
    tiltY: -20,
    twist: 120,
    clientX: 12,
    clientY: 34,
  });
});

test("Input.dispatchKeyEvent enforces Chromium's text capacity", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 200,
    method: "Input.dispatchKeyEvent",
    params: { type: "char", text: "abcd" },
  });

  expect(messages[0].error).toEqual({
    code: -32602,
    message: "Invalid 'text' parameter",
  });
});

test("DOM.disable invalidates the session's frontend node ids", async () => {
  document.body.innerHTML = "<button>Save</button>";
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 19,
    method: "DOM.getDocument",
    params: { depth: -1 },
  });
  const buttonNodeId = findButtonNode(messages[0].result.root).nodeId;
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 20,
    method: "DOM.disable",
    params: {},
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 21,
    method: "DOM.getBoxModel",
    params: { nodeId: buttonNodeId },
  });

  expect(messages.at(-1).error).toEqual({
    code: -32000,
    message: "Could not find node with given id",
  });
});

test("DOM.disable fails when the domain was never enabled", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 211,
    method: "DOM.disable",
    params: {},
  });

  expect(messages[0]?.error).toEqual({
    code: -32000,
    message: "DOM agent hasn't been enabled",
  });
});

test("Page.navigate validates the URL and delegates same-origin navigation", async () => {
  const messages: any[] = [];
  const navigations: string[] = [];
  const backend = new FrameBackend({
    document,
    navigate: (url) => navigations.push(url),
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  const destination = new URL("/next", location.href).href;

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 22,
    method: "Page.navigate",
    params: { url: destination },
  });

  expect(navigations).toEqual([destination]);
  expect(messages[0]).toMatchObject({
    kind: "response",
    sessionId: "session-a",
    id: 22,
    result: {
      frameId: "icdp-frame",
      loaderId: expect.any(String),
    },
  });

  const fragment = new URL("#next", document.URL).href;
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 222,
    method: "Page.navigate",
    params: { url: fragment },
  });
  expect(navigations).toEqual([destination, fragment]);
  expect(messages.find((message) => message.id === 222)?.result).toEqual({
    frameId: "icdp-frame",
  });

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 221,
    method: "Page.navigate",
    params: { url: "/relative" },
  });
  expect(messages.find((message) => message.id === 221)?.error).toEqual({
    code: -32000,
    message: "Cannot navigate to invalid URL",
  });
});

test("matches Chromium target and stale-loader validation errors", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  const commands = [
    ["DOM.resolveNode", {}],
    ["DOM.resolveNode", { nodeId: 1, backendNodeId: 1 }],
    ["Page.reload", { ignoreCache: true, loaderId: "stale-loader" }],
    ["Runtime.callFunctionOn", { functionDeclaration: "function () {}", silent: true }],
    [
      "Runtime.callFunctionOn",
      {
        objectId: "object",
        executionContextId: backend.executionContext().id,
        functionDeclaration: "function () {}",
      },
    ],
  ] as const;

  for (const [index, [method, params]] of commands.entries()) {
    await backend.command({
      kind: "command",
      sessionId: "session-a",
      id: 230 + index,
      method,
      params,
    });
  }

  expect(messages.map((message) => message.error)).toEqual([
    {
      code: -32000,
      message: "Either nodeId or backendNodeId must be specified.",
    },
    {
      code: -32000,
      message: "Either nodeId or backendNodeId must be specified.",
    },
    {
      code: -32602,
      message: "Reload was discarded because the page already navigated",
    },
    {
      code: -32602,
      message: "Either objectId or executionContextId or uniqueContextId must be specified",
    },
    {
      code: -32602,
      message: "ObjectId, executionContextId and uniqueContextId must mutually exclude each other",
    },
  ]);
});

test("commands reject meaningful options the in-page backend cannot honor", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  const unsupported: Array<[string, Record<string, unknown>, string]> = [
    ["Page.enable", { enableFileChooserOpenedEvent: true }, "enableFileChooserOpenedEvent"],
    ["Page.navigate", { url: "/", referrer: "https://referrer.test/" }, "referrer"],
    ["Page.navigate", { url: "/", transitionType: "typed" }, "transitionType"],
    ["Page.navigate", { url: "/", referrerPolicy: "origin" }, "referrerPolicy"],
    ["Page.reload", { ignoreCache: true }, "ignoreCache"],
    ["Page.reload", { scriptToEvaluateOnLoad: "window.ready = true" }, "scriptToEvaluateOnLoad"],
    ["Network.enable", { maxTotalBufferSize: 1 }, "maxTotalBufferSize"],
    ["Network.enable", { maxResourceBufferSize: 1 }, "maxResourceBufferSize"],
    ["Network.enable", { maxPostDataSize: 1 }, "maxPostDataSize"],
    ["Network.enable", { reportDirectSocketTraffic: true }, "reportDirectSocketTraffic"],
    ["Network.enable", { enableDurableMessages: true }, "enableDurableMessages"],
    ["DOM.scrollIntoViewIfNeeded", { nodeId: 1, rect: {} }, "rect"],
    ["Input.dispatchKeyEvent", { type: "keyDown", timestamp: 1 }, "timestamp"],
    ["Input.dispatchKeyEvent", { type: "keyDown", unmodifiedText: "a" }, "unmodifiedText"],
    ["Input.dispatchKeyEvent", { type: "keyDown", keyIdentifier: "U+0041" }, "keyIdentifier"],
    ["Input.dispatchKeyEvent", { type: "keyDown", isSystemKey: true }, "isSystemKey"],
    ["Input.dispatchKeyEvent", { type: "keyDown", commands: ["selectAll"] }, "commands"],
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0, timestamp: 1 }, "timestamp"],
    ["Runtime.evaluate", { expression: "1", includeCommandLineAPI: true }, "includeCommandLineAPI"],
    ["Runtime.evaluate", { expression: "1", silent: true }, "silent"],
    ["Runtime.evaluate", { expression: "1", generatePreview: true }, "generatePreview"],
    ["Runtime.evaluate", { expression: "1", userGesture: true }, "userGesture"],
    ["Runtime.evaluate", { expression: "1", timeout: 1 }, "timeout"],
    ["Runtime.evaluate", { expression: "1", disableBreaks: true }, "disableBreaks"],
    ["Runtime.evaluate", { expression: "1", replMode: true }, "replMode"],
    [
      "Runtime.evaluate",
      { expression: "1", allowUnsafeEvalBlockedByCSP: true },
      "allowUnsafeEvalBlockedByCSP",
    ],
    ["Runtime.evaluate", { expression: "1", serializationOptions: {} }, "serializationOptions"],
    [
      "Runtime.callFunctionOn",
      {
        executionContextId: backend.executionContext().id,
        functionDeclaration: "() => 1",
        silent: true,
      },
      "silent",
    ],
    [
      "Runtime.callFunctionOn",
      {
        executionContextId: backend.executionContext().id,
        functionDeclaration: "() => 1",
        generatePreview: true,
      },
      "generatePreview",
    ],
    [
      "Runtime.callFunctionOn",
      {
        executionContextId: backend.executionContext().id,
        functionDeclaration: "() => 1",
        userGesture: true,
      },
      "userGesture",
    ],
    [
      "Runtime.callFunctionOn",
      {
        executionContextId: backend.executionContext().id,
        functionDeclaration: "() => 1",
        serializationOptions: {},
      },
      "serializationOptions",
    ],
  ];

  for (const [index, [method, params, option]] of unsupported.entries()) {
    const id = 300 + index;
    await backend.command({
      kind: "command",
      sessionId: "session-a",
      id,
      method,
      params,
    });
    expect(messages.find((message) => message.id === id)?.error).toEqual({
      code: -32000,
      message: `${option} is not supported`,
    });
  }
  backend.clearSessions();
});

test("Accessibility frame-scoped commands reject foreign frames", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 330,
    method: "Accessibility.enable",
    params: {},
  });

  for (const [index, method] of [
    "Accessibility.getFullAXTree",
    "Accessibility.getRootAXNode",
    "Accessibility.getChildAXNodes",
  ].entries()) {
    const id = 331 + index;
    await backend.command({
      kind: "command",
      sessionId: "session-a",
      id,
      method,
      params:
        method === "Accessibility.getChildAXNodes"
          ? { id: "1", frameId: "foreign-frame" }
          : { frameId: "foreign-frame" },
    });
    expect(messages.find((message) => message.id === id)?.error).toEqual({
      code: -32602,
      message: "Frame with the given frameId is not found.",
    });
  }
});

test("Accessibility.getChildAXNodes rejects an invalid AX id like Chromium", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 340,
    method: "Accessibility.enable",
    params: {},
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 341,
    method: "Accessibility.getChildAXNodes",
    params: { id: "not-an-ax-id" },
  });

  expect(messages.find((message) => message.id === 341)?.error).toEqual({
    code: -32602,
    message: "Invalid ID",
  });
});

test("Accessibility.disable is idempotent like Chromium", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 350,
    method: "Accessibility.disable",
    params: {},
  });

  expect(messages[0]).toEqual({
    kind: "response",
    sessionId: "session-a",
    id: 350,
    result: {},
  });
});

// Adapted from V8's sessions/runtime-remote-object.js.
test("Runtime object handles are isolated by session", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  backend.attach("session-b", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 23,
    method: "Runtime.evaluate",
    params: { expression: "({ answer: 42 })" },
  });
  const objectId = messages.find((message) => message.id === 23).result.result.objectId;

  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 24,
    method: "Runtime.getProperties",
    params: { objectId, ownProperties: true },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 25,
    method: "Runtime.getProperties",
    params: { objectId, ownProperties: true },
  });

  expect(messages.find((message) => message.id === 24).error).toEqual({
    code: -32000,
    message: "Could not find object with given id",
  });
  expect(messages.find((message) => message.id === 25).result.result).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "answer",
        configurable: true,
        enumerable: true,
        value: { type: "number", description: "42", value: 42 },
      }),
    ]),
  );
});

test("Runtime.callFunctionOn rejects unknown receiver and argument handles as protocol errors", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 251,
    method: "Runtime.callFunctionOn",
    params: {
      objectId: "missing",
      functionDeclaration: "function () { return 1 }",
    },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 252,
    method: "Runtime.callFunctionOn",
    params: {
      executionContextId: backend.executionContext().id,
      functionDeclaration: "function (value) { return value }",
      arguments: [{ objectId: "missing" }],
    },
  });

  for (const id of [251, 252]) {
    expect(messages.find((message) => message.id === id)?.error).toEqual({
      code: -32000,
      message: "Could not find object with given id",
    });
  }
});

test("Runtime.callFunctionOn rejects declarations that do not evaluate to functions", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 253,
    method: "Runtime.callFunctionOn",
    params: {
      executionContextId: backend.executionContext().id,
      functionDeclaration: "42",
    },
  });

  expect(messages[0]).toEqual({
    kind: "response",
    sessionId: "session-a",
    id: 253,
    error: {
      code: -32000,
      message: "Given expression does not evaluate to a function",
    },
  });
});

// Adapted from V8's runtime/call-function-on-async.js.
test("Runtime.callFunctionOn returns JavaScript throws as exceptionDetails", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 26,
    method: "Runtime.callFunctionOn",
    params: {
      executionContextId: backend.executionContext().id,
      functionDeclaration: "function () { throw new TypeError('boom') }",
    },
  });

  expect(messages[0]).not.toHaveProperty("error");
  expect(messages[0].result).toMatchObject({
    result: {
      type: "object",
      subtype: "error",
      className: "TypeError",
      objectId: expect.any(String),
    },
    exceptionDetails: {
      exceptionId: 1,
      text: "Uncaught",
      lineNumber: 0,
      columnNumber: 0,
      executionContextId: backend.executionContext().id,
    },
  });
});

test("Runtime returnByValue serialization failures are protocol errors", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 263,
    method: "Runtime.evaluate",
    params: {
      expression: "(() => { const value = {}; value.self = value; return value })()",
      returnByValue: true,
    },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 264,
    method: "Runtime.callFunctionOn",
    params: {
      executionContextId: backend.executionContext().id,
      functionDeclaration: "function () { const value = {}; value.self = value; return value }",
      returnByValue: true,
    },
  });

  for (const id of [263, 264]) {
    expect(messages.find((message) => message.id === id)?.error).toEqual({
      code: -32000,
      message: "Object reference chain is too long",
    });
  }
});

test("Runtime.throwOnSideEffect never executes page code", async () => {
  (window as any).__icdpSideEffects = 0;
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 265,
    method: "Runtime.evaluate",
    params: {
      expression: "++window.__icdpSideEffects",
      throwOnSideEffect: true,
    },
  });

  expect((window as any).__icdpSideEffects).toBe(0);
  expect(messages[0]).not.toHaveProperty("error");
  expect(messages[0].result).toMatchObject({
    result: {
      type: "object",
      subtype: "error",
      className: "EvalError",
    },
    exceptionDetails: {
      text: "Uncaught",
    },
  });

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 266,
    method: "Runtime.callFunctionOn",
    params: {
      executionContextId: backend.executionContext().id,
      functionDeclaration: "function () { return ++window.__icdpSideEffects }",
      throwOnSideEffect: true,
    },
  });
  expect((window as any).__icdpSideEffects).toBe(0);
  expect(messages.find((message) => message.id === 266)?.result).toMatchObject({
    result: {
      type: "object",
      subtype: "error",
      className: "EvalError",
    },
    exceptionDetails: { text: "Uncaught" },
  });
});

// Ported from V8's runtime/await-promise and unique-context-id tests.
test("Runtime assimilates thenables and rejects ambiguous execution contexts", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 261,
    method: "Runtime.evaluate",
    params: {
      expression: "({ then(resolve) { resolve(42) } })",
      awaitPromise: true,
      returnByValue: true,
    },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 262,
    method: "Runtime.evaluate",
    params: {
      expression: "1",
      contextId: backend.executionContext().id,
      uniqueContextId: backend.executionContext().uniqueId,
    },
  });

  expect(messages.find((message) => message.id === 261)?.result.result).toEqual({
    type: "number",
    description: "42",
    value: 42,
  });
  expect(messages.find((message) => message.id === 262)?.error).toEqual({
    code: -32602,
    message: "Invalid parameters",
  });
});

test("Runtime.callFunctionOn validates CallArgument objects and follows V8 precedence", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 267,
    method: "Runtime.callFunctionOn",
    params: {
      executionContextId: backend.executionContext().id,
      functionDeclaration: "function (value) { return value }",
      arguments: [5],
      returnByValue: true,
    },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 268,
    method: "Runtime.callFunctionOn",
    params: {
      executionContextId: backend.executionContext().id,
      functionDeclaration: "function (value) { return value }",
      arguments: [{ objectId: 5 }],
      returnByValue: true,
    },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 269,
    method: "Runtime.callFunctionOn",
    params: {
      executionContextId: backend.executionContext().id,
      functionDeclaration: "function (value) { return value }",
      arguments: [{ value: "serializable", unserializableValue: "NaN" }],
      returnByValue: true,
    },
  });

  for (const id of [267, 268]) {
    expect(messages.find((message) => message.id === id)?.error).toEqual({
      code: -32602,
      message: "Invalid parameters",
    });
  }
  expect(messages.find((message) => message.id === 269)?.result.result).toEqual({
    type: "string",
    value: "serializable",
  });
});

// Adapted from Chromium's DOM.resolveNode and DOM.requestNode tests.
test("DOM node RemoteObjects round-trip through Runtime and requestNode", async () => {
  document.body.innerHTML = "<button>Save</button>";
  const button = document.querySelector("button")!;
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  const backendNodeId = backend.backendNodes.backendIdFor(button);
  backend.attach("session-a", []);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 27,
    method: "DOM.resolveNode",
    params: { backendNodeId, objectGroup: "dom" },
  });
  const remote = messages.find((message) => message.id === 27).result.object;
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 28,
    method: "Runtime.callFunctionOn",
    params: {
      objectId: remote.objectId,
      functionDeclaration: "function () { return this.tagName }",
      returnByValue: true,
    },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 281,
    method: "DOM.getDocument",
    params: { depth: 0 },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 29,
    method: "DOM.requestNode",
    params: { objectId: remote.objectId },
  });

  expect(remote).toMatchObject({
    type: "object",
    subtype: "node",
    className: "HTMLButtonElement",
    objectId: expect.any(String),
  });
  expect(messages.find((message) => message.id === 28).result.result).toEqual({
    type: "string",
    value: "BUTTON",
  });
  expect(messages.find((message) => message.id === 29).result.nodeId).toBeGreaterThan(0);
});

test("Runtime console history and live events are delivered only to enabled sessions", async () => {
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", []);
  backend.attach("session-b", []);
  backend.consoleAPICalled("log", ["before"]);

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 30,
    method: "Runtime.enable",
    params: {},
  });
  backend.consoleAPICalled("warning", ["after"]);

  const events = messages.filter(
    (message) => message.kind === "event" && message.method.startsWith("Runtime."),
  );
  expect(events.map((event) => [event.sessionId, event.method, event.params.type])).toEqual([
    ["session-a", "Runtime.executionContextCreated", undefined],
    ["session-a", "Runtime.consoleAPICalled", "log"],
    ["session-a", "Runtime.consoleAPICalled", "warning"],
  ]);
  expect(events[0].params.context).toMatchObject({
    id: backend.executionContext().id,
    uniqueId: expect.any(String),
    origin: expect.any(String),
  });
});

test("a restored Runtime clears the old context and creates a new document context", () => {
  const firstMessages: any[] = [];
  const first = new FrameBackend({
    document,
    send: (message) => firstMessages.push(message),
  });
  const secondMessages: any[] = [];
  const second = new FrameBackend({
    document,
    send: (message) => secondMessages.push(message),
  });

  first.attach("session-a", ["Runtime"]);
  second.attach("session-a", ["Runtime"]);

  for (const messages of [firstMessages, secondMessages]) {
    expect(messages.map((message) => message.method)).toEqual([
      "Runtime.executionContextsCleared",
      "Runtime.executionContextCreated",
    ]);
  }
  expect(first.executionContext().id).not.toBe(second.executionContext().id);
  expect(first.executionContext().uniqueId).not.toBe(second.executionContext().uniqueId);
});

// Ported from Chromium's network/get-response-body.js and target-session
// domain enablement tests.
test("Network observation, events, and response bodies follow session enablement", async () => {
  const response = {
    clone() {
      return this;
    },
    headers: new Headers({ "content-type": "text/plain", "content-length": "5" }),
    status: 200,
    statusText: "OK",
    text: async () => "hello",
    url: "https://example.test/data",
  } as unknown as Response;
  const nativeFetch = vi.fn(async () => response) as unknown as typeof fetch;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: nativeFetch,
    writable: true,
  });
  const messages: any[] = [];
  const backend = new FrameBackend({
    document,
    send: (message) => messages.push(message),
  });
  backend.attach("session-a", ["Network"]);
  backend.attach("session-b", []);

  await window.fetch("https://example.test/data");
  await vi.waitFor(() => {
    expect(
      messages.some(
        (message) =>
          message.sessionId === "session-a" && message.method === "Network.loadingFinished",
      ),
    ).toBe(true);
  });

  const networkEvents = messages.filter(
    (message) => message.kind === "event" && message.method.startsWith("Network."),
  );
  expect(new Set(networkEvents.map((message) => message.sessionId))).toEqual(
    new Set(["session-a"]),
  );
  const requestId = networkEvents.find((message) => message.method === "Network.requestWillBeSent")
    ?.params.requestId;

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 31,
    method: "Network.getResponseBody",
    params: { requestId },
  });
  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 32,
    method: "Network.getResponseBody",
    params: { requestId },
  });
  expect(messages.find((message) => message.id === 31)?.result).toEqual({
    body: "hello",
    base64Encoded: false,
  });
  expect(messages.find((message) => message.id === 32)?.error).toEqual({
    code: -32000,
    message: "Network has not been enabled",
  });

  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 321,
    method: "Network.enable",
    params: {},
  });
  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 322,
    method: "Network.getResponseBody",
    params: { requestId },
  });
  expect(messages.find((message) => message.id === 322)?.error).toEqual({
    code: -32000,
    message: "No resource with given identifier found",
  });
  await backend.command({
    kind: "command",
    sessionId: "session-b",
    id: 323,
    method: "Network.disable",
    params: {},
  });

  await backend.command({
    kind: "command",
    sessionId: "session-a",
    id: 33,
    method: "Network.disable",
    params: {},
  });
  const eventCount = messages.filter((message) => message.kind === "event").length;
  await window.fetch("https://example.test/after-disable");
  await Promise.resolve();
  expect(messages.filter((message) => message.kind === "event")).toHaveLength(eventCount);
  expect(window.fetch).toBe(nativeFetch);
});
