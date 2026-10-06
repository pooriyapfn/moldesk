import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMoldeskPaths } from "../filesystem/index.js";
import {
  cacheAsset,
  materializeAsset,
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
  it.skipIf(process.platform === "win32").each(["tar", "tar.gz"] as const)("extracts %s assets with local ownership rather than archive uid/gid", async (archive) => {
    const paths = tempPaths();
    const source = path.join(paths.home, "fixture");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "weights.bin"), "verified checkpoint fixture");
    const object = path.join(paths.home, `fixture.${archive}`);
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const ownerArgs = process.platform === "darwin"
      ? ["--uid", String(uid + 10000), "--gid", String(gid + 10000)]
      : [`--owner=${uid + 10000}`, `--group=${gid + 10000}`];
    execFileSync("tar", [archive === "tar.gz" ? "-czf" : "-cf", object, ...ownerArgs, "-C", source, "weights.bin"]);
    const target = await materializeAsset({ id: "fixture", url: "https://example.test/fixture", sha256: createHash("sha256").update(fs.readFileSync(object)).digest("hex"), target: "weights", archive }, object, path.join(paths.home, "assets"));
    const extracted = path.join(target, "weights.bin");
    expect(fs.readFileSync(extracted, "utf8")).toBe("verified checkpoint fixture");
    expect(fs.statSync(extracted).uid).toBe(uid);
    expect(fs.statSync(extracted).gid).toBe(gid);
  });

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
    // --relocatable: installs land in a `.partial-*` staging dir that gets
    // renamed to its final target on success — without this, console-script
    // shebangs bake in the staging path and break after the rename (confirmed
    // by a real install+run: `exec: .../.partial-.../.venv/bin/python: No such
    // file or directory`).
    expect(calls).toContainEqual(expect.objectContaining({ command: "uv", args: ["venv", "--relocatable", "--python", "3.11", path.join(targetDir, ".venv")] }));

    // Every uv invocation must force provisioning/using a managed interpreter, never a host one —
    // this is what lets the Python provider work with host Python absent from PATH.
    const uvCalls = calls.filter((call) => call.command === "uv");
    expect(uvCalls.length).toBeGreaterThan(0);
    for (const call of uvCalls) {
      expect(call.env?.["UV_PYTHON_PREFERENCE"]).toBe("only-managed");
      expect(call.env?.["UV_PYTHON_INSTALL_DIR"]).toContain(paths.home);
    }
  });

  it("wires extraIndexUrls into UV_EXTRA_INDEX_URL and findLinks into UV_FIND_LINKS, never replacing the default PyPI index, never as a raw CLI arg", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-index");
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const revision = "d".repeat(40);
    await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/cuda-model",
      revision,
      runtime: {
        kind: "python",
        python: "3.11",
        installer: "uv",
        extraIndexUrls: ["https://download.pytorch.org/whl/cu117"],
        findLinks: ["https://data.pyg.org/whl/torch-1.13.1+cu117.html"],
        requirements: [{ name: "torch", version: "1.13.1+cu117" }],
      },
      uvExecutable: "uv",
      paths,
      runner: async (command, args, options) => {
        calls.push({ command, args, env: options?.env });
        if (args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "torch==1.13.1+cu117\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const uvCalls = calls.filter((call) => call.command === "uv");
    expect(uvCalls.length).toBeGreaterThan(0);
    for (const call of uvCalls) {
      // Default PyPI is never overridden — only an extra index is added.
      expect(call.env?.["UV_INDEX_URL"]).toBeUndefined();
      expect(call.env?.["UV_EXTRA_INDEX_URL"]).toBe("https://download.pytorch.org/whl/cu117");
      expect(call.env?.["UV_FIND_LINKS"]).toBe("https://data.pyg.org/whl/torch-1.13.1+cu117.html");
      // Never passed as a bare positional/CLI arg — only via env, so it can never be
      // mistaken for (or smuggled in as) an arbitrary pip command fragment.
      expect(call.args.join(" ")).not.toContain("download.pytorch.org");
    }
  });

  it("omits UV_EXTRA_INDEX_URL/UV_FIND_LINKS when a runtime entry declares neither", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-no-index");
    const calls: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
    const revision = "e".repeat(40);
    await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/plain-model",
      revision,
      runtime: { kind: "python", python: "3.11", installer: "uv", requirements: [{ name: "numpy", version: "1.26.4" }] },
      uvExecutable: "uv",
      paths,
      runner: async (command, args, options) => {
        calls.push({ command, env: options?.env });
        if (args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "numpy==1.26.4\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    for (const call of calls.filter((c) => c.command === "uv")) {
      expect(call.env?.["UV_INDEX_URL"]).toBeUndefined();
      expect(call.env?.["UV_EXTRA_INDEX_URL"]).toBeUndefined();
      expect(call.env?.["UV_FIND_LINKS"]).toBeUndefined();
      expect(call.env?.["UV_TORCH_BACKEND"]).toBeUndefined();
    }
  });

  it("wires torchBackend into UV_TORCH_BACKEND on every uv call, never as a raw CLI arg", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-torch-backend");
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const revision = "f".repeat(40);
    await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/torch-model",
      revision,
      runtime: {
        kind: "python",
        python: "3.11",
        installer: "uv",
        torchBackend: "cu126",
        requirements: [{ name: "torch", version: "2.7.1+cu126" }],
      },
      uvExecutable: "uv",
      paths,
      runner: async (command, args, options) => {
        calls.push({ command, args, env: options?.env });
        if (args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "torch==2.7.1+cu126\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const uvCalls = calls.filter((call) => call.command === "uv");
    expect(uvCalls.length).toBeGreaterThan(0);
    for (const call of uvCalls) {
      expect(call.env?.["UV_TORCH_BACKEND"]).toBe("cu126");
      expect(call.env?.["UV_INDEX_URL"]).toBeUndefined();
      expect(call.args).not.toContain("--torch-backend");
    }
  });

  it("passes --only-binary for every binaryOnly-named package, on both the hashed and main install passes", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-binary-only");
    const installCalls: string[][] = [];
    const torchHash = createHash("sha256").update("torch").digest("hex");
    await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/binary-only-model",
      revision: "f".repeat(40),
      runtime: {
        kind: "python",
        python: "3.10",
        installer: "uv",
        binaryOnly: ["torch", "torch-scatter"],
        requirements: [
          { name: "torch", version: "1.13.1+cu117", hashes: [torchHash] },
          { name: "torch-scatter", version: "2.1.0+pt113cu117" },
          { name: "torch-geometric", version: "2.2.0" },
        ],
      },
      uvExecutable: "uv",
      paths,
      runner: async (command, args) => {
        if (args[0] === "pip" && args[1] === "install") installCalls.push(args);
        if (args.includes("rev-parse")) return { code: 0, stdout: `${"f".repeat(40)}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "torch==1.13.1+cu117\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.10.13\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(installCalls.length).toBeGreaterThan(0);
    for (const args of installCalls) {
      expect(args).toContain("--only-binary");
      const binaryOnlyValues = args.flatMap((a, i) => (args[i - 1] === "--only-binary" ? [a] : []));
      expect(binaryOnlyValues.sort()).toEqual(["torch", "torch-scatter"]);
      // torch-geometric has no --only-binary flag of its own (no wheel exists for it at all).
      expect(binaryOnlyValues).not.toContain("torch-geometric");
    }
  });

  it("installs preInstall requirements first, each in its own call, before any other dependency install", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-pre-install");
    const calls: Array<{ command: string; args: string[] }> = [];
    const revision = "1".repeat(40);
    await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/pre-install-model",
      revision,
      runtime: {
        kind: "python",
        python: "3.10",
        installer: "uv",
        preInstall: [{ name: "setuptools", version: "69.5.1" }],
        requirements: [{ name: "torch", version: "1.13.1+cu117" }],
      },
      uvExecutable: "uv",
      paths,
      runner: async (command, args) => {
        calls.push({ command, args });
        if (args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "torch==1.13.1+cu117\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.10.13\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const installCalls = calls.filter((c) => c.command === "uv" && c.args[0] === "pip" && c.args[1] === "install");
    expect(installCalls[0]?.args).toEqual(expect.arrayContaining(["setuptools==69.5.1"]));
    expect(installCalls[0]?.args).not.toContain("torch==1.13.1+cu117");
    // preInstall's own call never bundles other requirements into the same invocation.
    expect(installCalls[0]?.args.filter((a) => a === "setuptools==69.5.1")).toHaveLength(1);
  });

  it("defers buildAfter requirements to their own final install call, strictly after every other requirement", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-build-after");
    const calls: Array<{ command: string; args: string[] }> = [];
    const revision = "2".repeat(40);
    await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/build-after-model",
      revision,
      runtime: {
        kind: "python",
        python: "3.10",
        installer: "uv",
        buildAfter: ["openfold"],
        requirements: [
          { name: "torch", version: "1.13.1+cu117" },
          { name: "openfold", source: "https://github.com/aqlaboratory/openfold", revision: "a".repeat(40) },
        ],
      },
      uvExecutable: "uv",
      paths,
      runner: async (command, args) => {
        calls.push({ command, args });
        if (args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "torch==1.13.1+cu117\nopenfold==0.0.0\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.10.13\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const installCalls = calls.filter((c) => c.command === "uv" && c.args[0] === "pip" && c.args[1] === "install");
    expect(installCalls).toHaveLength(2);
    expect(installCalls[0]?.args).toContain("torch==1.13.1+cu117");
    expect(installCalls[0]?.args.join(" ")).not.toContain("openfold");
    expect(installCalls[1]?.args.join(" ")).toContain("openfold @ git+https://github.com/aqlaboratory/openfold");
    expect(installCalls[1]?.args).not.toContain("torch==1.13.1+cu117");
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

  it("installs via a hashed requirements file with --require-hashes when every requirement declares hashes", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-hashed");
    const calls: Array<{ command: string; args: string[] }> = [];
    const revision = "b".repeat(40);
    const result = await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/hashed-model",
      revision,
      runtime: {
        kind: "python",
        python: "3.11",
        installer: "uv",
        requirements: [
          { name: "torch", version: "2.6.0", hashes: [createHash("sha256").update("torch").digest("hex")] },
          { name: "numpy", version: "1.26.4", hashes: [createHash("sha256").update("numpy").digest("hex")] },
        ],
      },
      uvExecutable: "uv",
      paths,
      runner: async (command, args) => {
        calls.push({ command, args });
        if (args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "numpy==1.26.4\ntorch==2.6.0\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.lock).toEqual(["numpy==1.26.4", "torch==2.6.0"]);
    const installCall = calls.find((c) => c.command === "uv" && c.args[0] === "pip" && c.args[1] === "install");
    expect(installCall?.args).toContain("--require-hashes");
    const requirementsFileIndex = installCall!.args.indexOf("-r") + 1;
    const requirementsFile = installCall!.args[requirementsFileIndex]!;
    const content = fs.readFileSync(requirementsFile, "utf8");
    expect(content).toContain(`torch==2.6.0 --hash=sha256:${createHash("sha256").update("torch").digest("hex")}`);
    expect(content).toContain(`numpy==1.26.4 --hash=sha256:${createHash("sha256").update("numpy").digest("hex")}`);
  });

  it("verifies hashed requirements by artifact digest (--no-deps) then installs the full closure normally", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-partial-hash");
    const installCalls: string[][] = [];
    const torchHash = createHash("sha256").update("torch").digest("hex");
    await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/partial-hash-model",
      revision: "c".repeat(40),
      runtime: {
        kind: "python",
        python: "3.11",
        installer: "uv",
        requirements: [
          { name: "torch", version: "2.6.0", hashes: [torchHash] },
          { name: "numpy", version: "1.26.4" },
        ],
      },
      uvExecutable: "uv",
      paths,
      runner: async (command, args) => {
        if (command === "uv" && args[0] === "pip" && args[1] === "install") installCalls.push(args);
        if (args.includes("rev-parse")) return { code: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "numpy==1.26.4\ntorch==2.6.0\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(installCalls).toHaveLength(2);
    const hashedCall = installCalls.find((args) => args.includes("--require-hashes"))!;
    expect(hashedCall).toContain("--no-deps");
    const requirementsFile = hashedCall[hashedCall.indexOf("-r") + 1]!;
    expect(fs.readFileSync(requirementsFile, "utf8")).toContain(`torch==2.6.0 --hash=sha256:${torchHash}`);
    const closureCall = installCalls.find((args) => !args.includes("--require-hashes"))!;
    expect(closureCall).toContain("torch==2.6.0");
    expect(closureCall).toContain("numpy==1.26.4");
  });

  it("does not use --require-hashes when no requirement declares a hash (existing behavior unchanged)", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-no-hash");
    const calls: Array<{ command: string; args: string[] }> = [];
    const revision = "d".repeat(40);
    await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/no-hash-model",
      revision,
      runtime: { kind: "python", python: "3.11", installer: "uv", requirements: [{ name: "numpy", version: "1.26.4" }] },
      uvExecutable: "uv",
      paths,
      runner: async (command, args) => {
        calls.push({ command, args });
        if (args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "numpy==1.26.4\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const installCall = calls.find((c) => c.command === "uv" && c.args[0] === "pip" && c.args[1] === "install");
    expect(installCall?.args).toEqual(["pip", "install", "--python", path.join(targetDir, ".venv", "bin", "python"), "numpy==1.26.4"]);
    expect(installCall?.args).not.toContain("--require-hashes");
  });

  it("runs a declared postInstall hook exactly once via the venv bin dir, with no shell and no manifest-string interpolation", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-post-install");
    const calls: Array<{ command: string; args: string[] }> = [];
    const revision = "e".repeat(40);
    const result = await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/post-install-model",
      revision,
      runtime: {
        kind: "python",
        python: "3.11",
        installer: "uv",
        postInstall: ["boltz-fix-macos-libomp"],
        requirements: [{ name: "boltz-community", version: "2.10.12" }],
      },
      uvExecutable: "uv",
      paths,
      runner: async (command, args) => {
        calls.push({ command, args });
        if (args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "boltz-community==2.10.12\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
        if (command === path.join(targetDir, ".venv", "bin", "boltz-fix-macos-libomp")) {
          return { code: 0, stdout: "fixed libomp\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.postInstall).toEqual([{ hook: "boltz-fix-macos-libomp", stdout: "fixed libomp\n", stderr: "" }]);
    const hookCalls = calls.filter((c) => c.command === path.join(targetDir, ".venv", "bin", "boltz-fix-macos-libomp"));
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]?.args).toEqual([]);
  });

  it("returns an empty postInstall array when the runtime declares no hooks", async () => {
    const paths = tempPaths();
    const targetDir = path.join(paths.home, "model-no-post-install");
    const result = await preparePythonEnvironment({
      targetDir,
      repository: "https://github.com/example/plain-model",
      revision: "f".repeat(40),
      runtime: { kind: "python", python: "3.11", installer: "uv", requirements: [{ name: "numpy", version: "1.26.4" }] },
      uvExecutable: "uv",
      paths,
      runner: async (_command, args) => {
        if (args.includes("rev-parse")) return { code: 0, stdout: `${"f".repeat(40)}\n`, stderr: "" };
        if (args.includes("freeze")) return { code: 0, stdout: "numpy==1.26.4\n", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.postInstall).toEqual([]);
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
