import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { serveRelay } from "../src/relay/node.ts";
import {
  createNetworkNavigationHarness,
  type NetworkNavigationHarness,
} from "./fixtures/network-navigation-harness.ts";

describe("Network and navigation through a real Chromium client", () => {
  let harness: NetworkNavigationHarness;

  beforeAll(async () => {
    harness = await createNetworkNavigationHarness({
      frameModule: fileURLToPath(new URL("../src/frame/index.ts", import.meta.url)),
      hostModule: fileURLToPath(new URL("../src/host/index.ts", import.meta.url)),
      serveRelay,
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  test("orders request, response, data, and completion events with one loader", async () => {
    expect(harness.chromiumProduct).toMatch(/^Chrome\/\d+\./);
    const start = harness.icdp.events.length;
    const url = `${harness.appOrigin}/api/text?case=ordered`;

    await harness.evaluate(`fetch(${JSON.stringify(url)}).then((response) => response.text())`);
    const request = await harness.icdp.waitForEvent(
      "Network.requestWillBeSent",
      (params) => params.request?.url === url,
      start,
    );
    const requestId = String(request.params.requestId);
    await harness.icdp.waitForEvent(
      "Network.loadingFinished",
      (params) => params.requestId === requestId,
      start,
    );

    const events = harness.icdp.events
      .slice(start)
      .filter((event) => event.params.requestId === requestId);
    expect(events.map((event) => event.method)).toEqual([
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Network.dataReceived",
      "Network.loadingFinished",
    ]);

    const response = events[1]!.params;
    const frameTree = await harness.icdp.send("Page.getFrameTree");
    expect(request.params).toMatchObject({
      loaderId: frameTree.frameTree.frame.loaderId,
      documentURL: `${harness.appOrigin}/`,
      initiator: { type: "script" },
      redirectHasExtraInfo: false,
      type: "Fetch",
    });
    expect(response).toMatchObject({
      requestId,
      loaderId: request.params.loaderId,
      type: "Fetch",
      response: {
        url,
        status: 200,
        mimeType: "text/plain",
        charset: "utf-8",
        connectionReused: false,
        connectionId: 0,
        securityState: "unknown",
      },
      hasExtraInfo: false,
    });
    expect(await harness.icdp.send("Network.getResponseBody", { requestId })).toEqual({
      body: "network-body",
      base64Encoded: false,
    });
  });

  test("returns binary response bodies with CDP base64 encoding", async () => {
    const start = harness.icdp.events.length;
    const url = `${harness.appOrigin}/api/binary`;

    expect(
      await harness.evaluate(
        `fetch(${JSON.stringify(url)})
          .then((response) => response.arrayBuffer())
          .then((body) => Array.from(new Uint8Array(body)))`,
      ),
    ).toEqual([0, 255, 1]);
    const request = await harness.icdp.waitForEvent(
      "Network.requestWillBeSent",
      (params) => params.request?.url === url,
      start,
    );
    const requestId = String(request.params.requestId);
    const finished = await harness.icdp.waitForEvent(
      "Network.loadingFinished",
      (params) => params.requestId === requestId,
      start,
    );

    expect(finished.params.encodedDataLength).toBe(3);
    expect(await harness.icdp.send("Network.getResponseBody", { requestId })).toEqual({
      body: "AP8B",
      base64Encoded: true,
    });
  });

  test("reports string request bodies and headers before echo responses", async () => {
    const start = harness.icdp.events.length;
    const url = `${harness.appOrigin}/api/echo`;
    const body = JSON.stringify({ value: 42 });

    expect(
      await harness.evaluate(`
        fetch(${JSON.stringify(url)}, {
          method: "POST",
          headers: { "content-type": "application/json", "x-case": "request-body" },
          body: ${JSON.stringify(body)},
        }).then((response) => response.text())
      `),
    ).toBe(body);
    const request = await harness.icdp.waitForEvent(
      "Network.requestWillBeSent",
      (params) => params.request?.url === url,
      start,
    );
    const requestId = String(request.params.requestId);
    await harness.icdp.waitForEvent(
      "Network.loadingFinished",
      (params) => params.requestId === requestId,
      start,
    );

    expect(request.params).toMatchObject({
      initiator: { type: "script" },
      request: {
        url,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-case": "request-body",
        },
        hasPostData: true,
        postData: body,
      },
    });
    expect(await harness.icdp.send("Network.getResponseBody", { requestId })).toEqual({
      body,
      base64Encoded: false,
    });
  });

  test("terminates rejected fetches with loadingFailed and no response", async () => {
    const start = harness.icdp.events.length;
    const url = `${harness.appOrigin}/api/failure`;

    expect(
      await harness.evaluate(
        `fetch(${JSON.stringify(url)})
          .then(() => "resolved", (error) => error.name + ": " + error.message)`,
      ),
    ).toMatch(/^TypeError: /);
    const request = await harness.icdp.waitForEvent(
      "Network.requestWillBeSent",
      (params) => params.request?.url === url,
      start,
    );
    const requestId = String(request.params.requestId);
    const failed = await harness.icdp.waitForEvent(
      "Network.loadingFailed",
      (params) => params.requestId === requestId,
      start,
    );
    const events = harness.icdp.events
      .slice(start)
      .filter((event) => event.params.requestId === requestId);

    expect(events.map((event) => event.method)).toEqual([
      "Network.requestWillBeSent",
      "Network.loadingFailed",
    ]);
    expect(failed.params).toMatchObject({
      requestId,
      type: "Fetch",
      errorText: expect.any(String),
    });
    expect(failed.params.errorText.length).toBeGreaterThan(0);
  });

  test("reports Chromium-shaped redirect hops on one request id", async () => {
    const start = harness.icdp.events.length;
    const redirectUrl = `${harness.appOrigin}/api/redirect`;
    const finalUrl = `${harness.appOrigin}/api/text?from=redirect`;

    expect(
      await harness.evaluate(
        `fetch(${JSON.stringify(redirectUrl)})
          .then(async (response) => ({
            body: await response.text(),
            redirected: response.redirected,
            url: response.url,
          }))`,
      ),
    ).toEqual({ body: "network-body", redirected: true, url: finalUrl });
    const response = await harness.icdp.waitForEvent(
      "Network.responseReceived",
      (params) => params.response?.url === finalUrl,
      start,
    );
    await harness.icdp.waitForEvent(
      "Network.loadingFinished",
      (params) => params.requestId === response.params.requestId,
      start,
    );
    const requests = harness.icdp.events
      .slice(start)
      .filter((event) => event.method === "Network.requestWillBeSent");

    expect(requests).toHaveLength(2);
    expect(requests.map((event) => event.params.requestId)).toEqual([
      response.params.requestId,
      response.params.requestId,
    ]);
    expect(requests.map((event) => event.params.request.url)).toEqual([redirectUrl, finalUrl]);
    expect(requests[1]!.params.redirectResponse).toMatchObject({
      url: redirectUrl,
      status: 302,
    });
  });

  test("orders execution context and document lifecycle around navigation", async () => {
    const initial = await harness.icdp.send("Page.getFrameTree");
    const initialLoaderId = String(initial.frameTree.frame.loaderId);
    const start = harness.icdp.events.length;
    const url = `${harness.appOrigin}/page-two?case=lifecycle`;

    expect(await harness.icdp.send("Page.navigate", { url })).toMatchObject({
      frameId: "icdp-frame",
    });
    const navigated = await harness.icdp.waitForEvent(
      "Page.frameNavigated",
      (params) => params.frame?.url === url,
      start,
    );
    await harness.icdp.waitForEvent("Page.loadEventFired", () => true, start);
    const methods = harness.icdp.events
      .slice(start)
      .filter(
        (event) =>
          event.method.startsWith("Page.") || event.method.startsWith("Runtime.executionContext"),
      )
      .map((event) => event.method);

    expect(methods).toEqual([
      "Runtime.executionContextsCleared",
      "Page.frameNavigated",
      "Runtime.executionContextCreated",
      "Page.domContentEventFired",
      "Page.loadEventFired",
    ]);
    expect(navigated.params).toMatchObject({
      frame: {
        id: "icdp-frame",
        url,
        loaderId: expect.any(String),
      },
      type: "Navigation",
    });
    expect(navigated.params.frame.loaderId).not.toBe(initialLoaderId);
    expect(await harness.icdp.send("Page.getFrameTree")).toMatchObject({
      frameTree: { frame: navigated.params.frame },
    });
    expect(await harness.evaluate("[document.readyState, document.URL]")).toEqual([
      "complete",
      url,
    ]);
  });

  test("returns the committed loader id for cross-document navigation", async () => {
    const start = harness.icdp.events.length;
    const url = `${harness.appOrigin}/page-three?case=loader`;

    const response = await harness.icdp.send("Page.navigate", { url });
    const navigated = await harness.icdp.waitForEvent(
      "Page.frameNavigated",
      (params) => params.frame?.url === url,
      start,
    );

    expect(response).toEqual({
      frameId: "icdp-frame",
      loaderId: navigated.params.frame.loaderId,
    });
  });

  test("preserves the document loader while traversing same-document history", async () => {
    const initial = await harness.icdp.send("Page.getFrameTree");
    const loaderId = String(initial.frameTree.frame.loaderId);
    await harness.evaluate(`
      history.pushState({ step: 1 }, "", "/history-one");
      history.pushState({ step: 2 }, "", "/history-two");
    `);
    const start = harness.icdp.events.length;

    expect(
      await harness.evaluate(`
        new Promise((resolve) => {
          addEventListener("popstate", () => resolve(location.href), { once: true });
          history.back();
        })
      `),
    ).toBe(`${harness.appOrigin}/history-one`);
    expect(await harness.icdp.send("Page.getFrameTree")).toMatchObject({
      frameTree: {
        frame: {
          loaderId,
          url: `${harness.appOrigin}/history-one`,
        },
      },
    });

    expect(
      await harness.evaluate(`
        new Promise((resolve) => {
          addEventListener("popstate", () => resolve(location.href), { once: true });
          history.forward();
        })
      `),
    ).toBe(`${harness.appOrigin}/history-two`);
    expect(
      harness.icdp.events
        .slice(start)
        .filter((event) =>
          ["Page.domContentEventFired", "Page.frameNavigated", "Page.loadEventFired"].includes(
            event.method,
          ),
        ),
    ).toEqual([]);
  });

  test("reports same-document History API changes to Page clients", async () => {
    const start = harness.icdp.events.length;
    const url = `${harness.appOrigin}/history-event`;

    await harness.evaluate(`history.pushState({}, "", ${JSON.stringify(url)})`);
    const event = harness.icdp.events
      .slice(start)
      .find((candidate) => candidate.method === "Page.navigatedWithinDocument");

    expect(event).toEqual({
      method: "Page.navigatedWithinDocument",
      params: {
        frameId: "icdp-frame",
        navigationType: "historyApi",
        url,
      },
    });
  });
});
