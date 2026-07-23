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

  beforeAll(async () => {
    harness = await createNetworkNavigationHarness({
      frameModule: fileURLToPath(new URL("../src/frame/index.ts", import.meta.url)),
      hostModule: fileURLToPath(new URL("../src/host/index.ts", import.meta.url)),
      serveRelay,
    });
    const wasm = await readFile(
      new URL(import.meta.resolve("@olimsaidov/agent-browser-wasm/agent_browser_wasm_bg.wasm")),
    );
    agent = await createAgentBrowser({
      transport: {
        send: (method, params, sessionId) => harness.browser.send(method, params, sessionId),
      },
      wasmUrl: wasm,
    });
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
