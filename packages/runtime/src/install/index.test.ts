import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMoldeskPaths } from "../filesystem/index.js";
import {
  cacheAsset,
  ensureManagedUv,
  MANAGED_UV_VERSION,
  prepareDockerImage,
  preparePythonEnvironment,
  UV_RELEASES,
  type AssetFetch,
} from "./index.js";

const platformId = `${process.platform}-${process.arch}`;
const release = UV_RELEASES[platformId];

const homes: string[] = [];

function tempPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-runtime-install-"));
  homes.push(home);
  return getMoldeskPaths({ MOLDESK_HOME: home });
}

function response(bytes: Uint8Array, status = 200) {
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => name.toLowerCase() === "content-length" ? String(bytes.byteLength) : null },
    body: {
      getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }),
      }),
    },
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("installation runtime", () => {
  it("resumes downloads, verifies SHA-256, and reuses the content-addressed object", async () => {
    const paths = tempPaths();
    const bytes = Buffer.from("checkpoint-content");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    fs.mkdirSync(paths.downloads, { recursive: true });
    fs.writeFileSync(path.join(paths.downloads, `${checksum}.part`), bytes.subarray(0, 5));
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const fetcher: AssetFetch = async (_url, init) => {
      calls.push(init ?? {});
      return response(bytes.subarray(5), 206);
    };
    const asset = {
      id: "weights",
      url: "https://example.test/weights.pt",
      sha256: checksum,
      target: "weights.pt",
      archive: "none" as const,
    };
    const object = await cacheAsset(asset, paths, { fetch: fetcher });
    expect(calls[0]?.headers?.["Range"]).toBe("bytes=5-");
    expect(fs.readFileSync(object)).toEqual(bytes);
    await cacheAsset(asset, paths, { fetch: async () => { throw new Error("cache miss"); } });
  });

  it("rejects a checksum mismatch and serializes concurrent downloads by digest", async () => {
    const paths = tempPaths();
    const bytes = Buffer.from("verified bytes");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const asset = { id: "asset", url: "https://example.test/asset", sha256: checksum, target: "asset" };
    await expect(cacheAsset(asset, paths, { fetch: async () => response(Buffer.from("wrong")) })).rejects.toMatchObject({ code: "ASSET_CHECKSUM_MISMATCH" });

    let fetches = 0;
    const fetcher: AssetFetch = async () => {
      fetches += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return response(bytes);
    };
    const [first, second] = await Promise.all([
      cacheAsset(asset, paths, { fetch: fetcher }),
      cacheAsset(asset, paths, { fetch: fetcher }),
    ]);
    expect(first).toBe(second);
    expect(fetches).toBe(1);
  });

  it("uses shell-free pinned git and uv commands, and forces the managed Python interpreter", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model");
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const revision = "a".repeat(40);
    const result = await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/model",
      revision,
      runtime: {
        kind: "python",
        python: "3.11",
        installer: "uv",
        requirements: [{ name: "numpy", version: "1.26.4" }],
      },
      uvExecutable: "uv",
      paths,
      runner: async (command, args, options) => {
        calls.push({ command, args, env: options?.env });
        if (args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "numpy==1.26.4\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.lock).toEqual(["numpy==1.26.4"]);
    expect(calls).toContainEqual(expect.objectContaining({ command: "git", args: ["-C", path.join(targetDir, "source"), "fetch", "--depth", "1", "origin", revision] }));
    expect(calls).toContainEqual(expect.objectContaining({ command: "uv", args: ["pip", "install", "--python", path.join(targetDir, ".venv", "bin", "python"), "numpy==1.26.4"] }));

    // Every uv invocation must force provisioning/using a managed interpreter, never a host one —
    // this is what lets the Python provider work with host Python absent from PATH.
    const uvCalls = calls.filter((call) => call.command === "uv");
    expect(uvCalls.length).toBeGreaterThan(0);
    for (const call of uvCalls) {
      expect(call.env?.["UV_PYTHON_PREFERENCE"]).toBe("only-managed");
      expect(call.env?.["UV_PYTHON_INSTALL_DIR"]).toContain(paths.home);
    }
  });

  it("reuses an already-verified managed uv install without downloading", async () => {
    if (!release) return; // unsupported platform in UV_RELEASES; nothing to assert here.
    const paths = tempPaths();
    const toolDir = path.join(paths.home, "tools", "uv", MANAGED_UV_VERSION);
    fs.mkdirSync(toolDir, { recursive: true });
    fs.writeFileSync(path.join(toolDir, "uv"), "fake-uv-binary");
    fs.writeFileSync(path.join(toolDir, "verified.json"), JSON.stringify({ version: MANAGED_UV_VERSION, sha256: release.sha256 }));
    let fetchCalled = false;
    const executable = await ensureManagedUv({
      paths,
      fetch: async () => { fetchCalled = true; throw new Error("must not fetch when the cached install already verifies"); },
      runner: async (command, args) => {
        if (command === path.join(toolDir, "uv") && args[0] === "--version") {
          return { code: 0, stdout: `uv ${MANAGED_UV_VERSION}\n`, stderr: "" };
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
    });
    expect(executable).toBe(path.join(toolDir, "uv"));
    expect(fetchCalled).toBe(false);
  });

  it("does not silently reuse a managed uv install with a corrupted receipt", async () => {
    if (!release) return; // unsupported platform in UV_RELEASES; nothing to assert here.
    const paths = tempPaths();
    const toolDir = path.join(paths.home, "tools", "uv", MANAGED_UV_VERSION);
    fs.mkdirSync(toolDir, { recursive: true });
    fs.writeFileSync(path.join(toolDir, "uv"), "fake-uv-binary");
    // Receipt sha256 does not match the pinned release — the install must be treated as unverifiable.
    fs.writeFileSync(path.join(toolDir, "verified.json"), JSON.stringify({ version: MANAGED_UV_VERSION, sha256: "0".repeat(64) }));
    let fetchCalled = false;
    await expect(ensureManagedUv({
      paths,
      fetch: async () => {
        fetchCalled = true;
        return response(Buffer.from("not the real uv archive"));
      },
      runner: async () => { throw new Error("must not run --version against an unverified receipt"); },
    })).rejects.toMatchObject({ code: "ASSET_SIZE_MISMATCH" });
    expect(fetchCalled).toBe(true);
  });

  it("fails clearly when the Docker daemon is stopped", async () => {
    await expect(prepareDockerImage({
      kind: "docker",
      image: "example/model:1",
      digest: `sha256:${"a".repeat(64)}`,
      gpu: "none",
    }, async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }))).rejects.toMatchObject({
      code: "INSTALL_COMMAND_FAILED",
    });
  });
});
