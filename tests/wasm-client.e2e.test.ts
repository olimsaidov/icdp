import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createAgentBrowser, type AgentBrowser } from "@olimsaidov/agent-browser-wasm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { serveRelay } from "../src/relay/node.ts";
import {
  createNetworkNavigationHarness,
  type NetworkNavigationHarness,
} from "./fixtures/network-navigation-harness.ts";

const execFileAsync = promisify(execFile);

async function inspectPackedPackage(): Promise<{
  exports: Record<string, string[]>;
  missingExportFiles: string[];
  rootError: string;
}> {
  const workspace = fileURLToPath(new URL("../", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "icdp-packed-client-"));
  const source = join(temporary, "source");
  await mkdir(source);
  try {
    for (const path of [
      "LICENSE",
      "README.md",
      "THIRD_PARTY_LICENSES.md",
      "package.json",
      "src",
      "tsconfig.json",
      "tsdown.config.ts",
    ]) {
      await cp(join(workspace, path), join(source, path), { recursive: true });
    }
    await symlink(join(workspace, "node_modules"), join(source, "node_modules"), "dir");
    await execFileAsync("npm", ["run", "build"], {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const packed = await execFileAsync("npm", ["pack", "--ignore-scripts", "--json"], {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const pack = JSON.parse(packed.stdout)[0] as {
      filename: string;
      files: Array<{ path: string }>;
    };
    const extracted = join(temporary, "extracted");
    const consumer = join(temporary, "consumer");
    const packageScope = join(consumer, "node_modules", "@olimsaidov");
    await mkdir(extracted);
    await mkdir(packageScope, { recursive: true });
    await symlink(
      join(workspace, "node_modules", "ws"),
      join(consumer, "node_modules", "ws"),
      "dir",
    );
    await execFileAsync("tar", ["-xzf", join(source, pack.filename), "-C", extracted]);
    await cp(join(extracted, "package"), join(packageScope, "icdp"), { recursive: true });
    const probe = `
      const entries = {
        frame: "@olimsaidov/icdp/frame",
        host: "@olimsaidov/icdp/host",
        protocol: "@olimsaidov/icdp/protocol",
        relay: "@olimsaidov/icdp/relay",
        relayNode: "@olimsaidov/icdp/relay/node",
      };
      const exports = {};
      for (const [name, specifier] of Object.entries(entries)) {
        exports[name] = Object.keys(await import(specifier)).sort();
      }
      let rootError = "";
      try {
        await import("@olimsaidov/icdp");
      } catch (error) {
        rootError = error.code ?? "";
      }
      console.log(JSON.stringify({ exports, rootError }));
    `;
    const probed = await execFileAsync(process.execPath, ["--input-type=module", "--eval", probe], {
      cwd: consumer,
      encoding: "utf8",
    });
    const report = JSON.parse(probed.stdout.trim()) as {
      exports: Record<string, string[]>;
      rootError: string;
    };
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
      exports: Record<string, { default: string; types: string }>;
    };
    const packedFiles = new Set(pack.files.map((file) => file.path));
    const missingExportFiles = Object.values(manifest.exports)
      .flatMap((entry) => [entry.default, entry.types])
      .map((path) => path.replace(/^\.\//, ""))
      .filter((path) => !packedFiles.has(path));

    return { ...report, missingExportFiles };
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

describe("distributable clients", () => {
  let agent: AgentBrowser;
  let harness: NetworkNavigationHarness;
  const mouseEvents: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    harness = await createNetworkNavigationHarness({
      frameModule: fileURLToPath(new URL("../src/frame/index.ts", import.meta.url)),
      hostModule: fileURLToPath(new URL("../src/host/index.ts", import.meta.url)),
      serveRelay,
    });
    const wasm = await readFile(
      new URL(import.meta.resolve("@olimsaidov/agent-browser-wasm/agent_browser_wasm_bg.wasm")),
    );
    const options = {
      cursor: true,
      transport: {
        send: (method: string, params?: Record<string, unknown>, sessionId?: string) => {
          if (method === "Input.dispatchMouseEvent") mouseEvents.push(params ?? {});
          return harness.browser.send(method, params, sessionId);
        },
      },
      wasmUrl: wasm,
    };
    agent = await createAgentBrowser(options);
  });

  afterAll(async () => {
    await harness?.close();
  });

  test("the existing WASM client drives ICDP through a raw CDP transport", async () => {
    expect(await agent.run(["get", "title"])).toEqual({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "ICDP Network Fixture",
    });
  });

  test("the existing WASM client consumes ICDP accessibility snapshots", async () => {
    const result = await agent.run(["snapshot", "-i"]);

    expect(result).toMatchObject({
      exitCode: 0,
      ok: true,
      stderr: "",
    });
    expect(result.stdout).toMatch(/button "Network action".*ref=e\d+/);
  });

  test("the current WASM client renders a cursor and performs human mouse movements", async () => {
    // Capture the closed shadow root without weakening the production overlay.
    await harness.evaluate(`(() => {
      const attachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(options) {
        const root = attachShadow.call(this, options);
        if (this.localName === "agent-browser-recording-cursor") {
          globalThis.__wasmCursorRoot = root;
          Element.prototype.attachShadow = attachShadow;
        }
        return root;
      };
    })()`);
    mouseEvents.length = 0;
    expect(
      await agent.run(["mouse", "move", "240", "160", "--human", "--seed", "42"]),
    ).toMatchObject({ ok: true, exitCode: 0 });
    const moves = mouseEvents.filter((event) => event.type === "mouseMoved");
    expect(moves.length).toBeGreaterThan(2);
    expect(moves.at(-1)).toMatchObject({ x: 240, y: 160 });
    expect(
      moves
        .slice(0, -1)
        .some((event) => Math.abs(Number(event.y) - (Number(event.x) * 2) / 3) > 0.1),
    ).toBe(true);
    expect(
      await harness.evaluate(`(() => {
      const pointer = globalThis.__wasmCursorRoot.querySelector(".pointer");
      return { display: getComputedStyle(pointer).display, transform: pointer.style.transform };
    })()`),
    ).toEqual({ display: "block", transform: "translate3d(240px, 160px, 0px)" });
    expect(await agent.run(["click", "button", "--human"])).toMatchObject({ ok: true });
    expect(mouseEvents.at(-1)).toMatchObject({ type: "mouseReleased", button: "left", buttons: 0 });
    expect(
      await harness.evaluate(`globalThis.__wasmCursorRoot.querySelectorAll(".ripple").length`),
    ).toBeGreaterThan(0);
    expect((await agent.run(["--version"])).stdout).toBe("agent-browser 0.38.1");
  });

  test("the WASM client drags with a held button and preserves mouse state across commands", async () => {
    await harness.evaluate(`(() => {
      for (const [id, left] of [["drag-source", 40], ["drag-target", 280]]) {
        const element = document.createElement("div");
        element.id = id;
        element.style.cssText = "position:fixed;top:220px;left:" + left + "px;width:40px;height:40px";
        document.body.appendChild(element);
      }
      globalThis.__wasmPointerEvents = [];
      for (const type of ["pointermove", "pointerdown", "pointerup"]) {
        document.addEventListener(type, event => globalThis.__wasmPointerEvents.push({
          type, x: event.clientX, y: event.clientY, buttons: event.buttons,
        }));
      }
    })()`);
    mouseEvents.length = 0;
    expect(await agent.run("drag #drag-source #drag-target --human")).toMatchObject({ ok: true });
    const down = mouseEvents.findIndex((event) => event.type === "mousePressed");
    const heldMoves = mouseEvents.slice(down + 1, -1);
    expect(down).toBeGreaterThan(0);
    expect(heldMoves.length).toBeGreaterThan(2);
    expect(heldMoves.every((event) => event.type === "mouseMoved" && event.buttons === 1)).toBe(
      true,
    );
    expect(mouseEvents.at(-1)).toMatchObject({ type: "mouseReleased", x: 300, y: 240, buttons: 0 });
    expect(await harness.evaluate("globalThis.__wasmPointerEvents.at(-1)")).toEqual({
      type: "pointerup",
      x: 300,
      y: 240,
      buttons: 0,
    });

    expect(await agent.run("mouse down")).toMatchObject({ ok: true });
    expect(mouseEvents.at(-1)).toMatchObject({ type: "mousePressed", x: 300, y: 240, buttons: 1 });
    expect(await agent.run("mouse move 320 260 --steps 3")).toMatchObject({ ok: true });
    expect(mouseEvents.slice(-3).every((event) => event.buttons === 1)).toBe(true);
    expect(await agent.run("mouse up")).toMatchObject({ ok: true });
    expect(mouseEvents.at(-1)).toMatchObject({ type: "mouseReleased", x: 320, y: 260, buttons: 0 });
  });

  test("the WASM client supports a human default with an explicit instant override", async () => {
    const humanAgent = await createAgentBrowser({
      inputMode: "human",
      transport: {
        send: (method, params, sessionId) => {
          if (method === "Input.dispatchMouseEvent") mouseEvents.push(params ?? {});
          return harness.browser.send(method, params, sessionId);
        },
      },
    });
    mouseEvents.length = 0;
    expect(await humanAgent.run("mouse move 100 100")).toMatchObject({ ok: true });
    expect(mouseEvents.length).toBeGreaterThan(2);
    mouseEvents.length = 0;
    expect(
      await humanAgent.run(["mouse", "move", "120", "120", "--input-mode", "instant"]),
    ).toMatchObject({ ok: true });
    expect(mouseEvents).toEqual([{ type: "mouseMoved", x: 120, y: 120, buttons: 0 }]);
  });

  test("the packed package exposes every documented runtime entry point", async () => {
    expect(await inspectPackedPackage()).toEqual({
      exports: {
        frame: ["startFrameAgent"],
        host: ["IcdpHost"],
        protocol: [
          "CDP_INVALID_PARAMS",
          "CDP_INVALID_REQUEST",
          "CDP_METHOD_NOT_FOUND",
          "CDP_PARSE_ERROR",
          "CDP_SERVER_ERROR",
          "CDP_SESSION_NOT_FOUND",
          "PROTOCOL_VERSION",
          "isHandshakeMessage",
          "parseJson",
        ],
        relay: ["RelayCore"],
        relayNode: ["serveRelay"],
      },
      missingExportFiles: [],
      rootError: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
  }, 30_000);
});
