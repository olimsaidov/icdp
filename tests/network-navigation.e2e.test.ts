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

  test("reports the observable final response when Fetch follows a redirect", async () => {
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
    const requestId = response.params.requestId;

    expect(requests).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          requestId,
          request: expect.objectContaining({ url: redirectUrl }),
        }),
      }),
    ]);
    expect(response.params).toMatchObject({
      requestId,
      response: {
        url: finalUrl,
        status: 200,
      },
    });
    expect(requests[0]!.params).not.toHaveProperty("redirectResponse");
    expect(
      harness.icdp.events
        .slice(start)
        .filter((event) => event.params.requestId === requestId)
        .map((event) => event.method),
    ).toEqual([
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Network.dataReceived",
      "Network.loadingFinished",
    ]);
    expect(await harness.icdp.send("Network.getResponseBody", { requestId })).toEqual({
      body: "network-body",
      base64Encoded: false,
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
    expect(
      harness.icdp.events
        .slice(start)
        .filter((event) => event.method === "Page.navigatedWithinDocument")
        .map((event) => event.params),
    ).toEqual([
      {
        frameId: "icdp-frame",
        navigationType: "fragment",
        url: `${harness.appOrigin}/history-one`,
      },
      {
        frameId: "icdp-frame",
        navigationType: "fragment",
        url: `${harness.appOrigin}/history-two`,
      },
    ]);
  });

  test("reports same-document History API changes to Page clients", async () => {
    const start = harness.icdp.events.length;
    const pushedUrl = `${harness.appOrigin}/history-event`;
    const replacedUrl = `${harness.appOrigin}/history-replaced`;

    await harness.evaluate(`
      history.pushState({}, "", ${JSON.stringify(pushedUrl)});
      history.replaceState({}, "", ${JSON.stringify(replacedUrl)});
    `);

    expect(
      harness.icdp.events
        .slice(start)
        .filter((event) => event.method === "Page.navigatedWithinDocument"),
    ).toEqual([
      {
        method: "Page.navigatedWithinDocument",
        params: {
          frameId: "icdp-frame",
          navigationType: "historyApi",
          url: pushedUrl,
        },
      },
      {
        method: "Page.navigatedWithinDocument",
        params: {
          frameId: "icdp-frame",
          navigationType: "historyApi",
          url: replacedUrl,
        },
      },
    ]);
  });

  test("reports repeated Page.navigate fragments without a loader", async () => {
    const baseUrl = `${harness.appOrigin}/history-replaced`;
    const url = `${harness.appOrigin}/history-replaced#same-fragment`;
    await harness.evaluate(`history.replaceState({}, "", ${JSON.stringify(baseUrl)})`);
    const navigate = async (destination: string) => {
      const start = harness.icdp.events.length;
      const response = await harness.icdp.send("Page.navigate", { url: destination });
      const event = await harness.icdp.waitForEvent(
        "Page.navigatedWithinDocument",
        (params) => params.url === destination,
        start,
      );
      expect(response).toEqual({ frameId: "icdp-frame" });
      expect(event.params).toEqual({
        frameId: "icdp-frame",
        navigationType: "fragment",
        url: destination,
      });
    };

    await navigate(url);
    await navigate(url);
  });

  test("reports a Navigation API interception as other", async () => {
    const start = harness.icdp.events.length;
    const url = `${harness.appOrigin}/intercepted`;

    expect(
      await harness.evaluate(`
        new Promise((resolve, reject) => {
          const listener = (event) => {
            if (event.destination.url !== ${JSON.stringify(url)}) return;
            navigation.removeEventListener("navigate", listener);
            event.intercept({ handler: async () => {} });
          };
          navigation.addEventListener("navigate", listener);
          navigation.navigate(${JSON.stringify(url)}).finished.then(
            () => resolve(location.href),
            reject,
          );
        })
      `),
    ).toBe(url);
    expect(
      await harness.icdp.waitForEvent(
        "Page.navigatedWithinDocument",
        (params) => params.url === url,
        start,
      ),
    ).toEqual({
      method: "Page.navigatedWithinDocument",
      params: {
        frameId: "icdp-frame",
        navigationType: "other",
        url,
      },
    });
  });

  test("does not reuse a cancelled Page.navigate loader on reload", async () => {
    const before = await harness.icdp.send("Page.getFrameTree");
    const currentUrl = before.frameTree.frame.url;
    const cancelledUrl = `${harness.appOrigin}/cancelled`;
    await harness.evaluate(`
      navigation.addEventListener("navigate", (event) => {
        if (event.destination.url === ${JSON.stringify(cancelledUrl)}) event.preventDefault();
      }, { once: true });
    `);

    const cancelled = await harness.icdp.send("Page.navigate", { url: cancelledUrl });
    expect(cancelled).toMatchObject({
      frameId: "icdp-frame",
      loaderId: expect.any(String),
    });
    expect((await harness.icdp.send("Page.getFrameTree")).frameTree.frame.loaderId).toBe(
      before.frameTree.frame.loaderId,
    );
    await harness.evaluate("new Promise((resolve) => setTimeout(resolve, 0))");

    const start = harness.icdp.events.length;
    await harness.icdp.send("Page.reload");
    const navigated = await harness.icdp.waitForEvent(
      "Page.frameNavigated",
      (params) => params.frame?.url === currentUrl,
      start,
    );
    expect(navigated.params.frame.loaderId).not.toBe(cancelled.loaderId);
    expect(navigated.params.frame.loaderId).not.toBe(before.frameTree.frame.loaderId);
  });
});
