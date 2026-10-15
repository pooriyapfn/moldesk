import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelAdapterDefinition, RunContext } from "@moldesk/adapters";
import { parseManifest, type ModelManifestV1 } from "@moldesk/registry";
import type { JobStage, RuntimeProvider, WireJob } from "@moldesk/runtime";
import { digest } from "../../hash.js";
import { createManifestPipeline, type ManifestPipelineOptions, type PipelineSteps } from "./pipeline.js";
import { startDeadlineWatchdog } from "./watchdog.js";

const DIGEST = "a".repeat(64);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function manifest(): ModelManifestV1 {
  return parseManifest(
    {
      schemaVersion: 1,
      name: "fake-model",
      displayName: "Fake",
      modelVersion: "1.0.0",
      adapterVersion: "0.1.0",
      description: "t",
      category: "other",
      status: "planned",
      source: { repository: "https://example.com/r", revision: "b".repeat(40) },
      runtimes: [{ kind: "python", python: "3.11", installer: "uv", platforms: ["linux-x64"], requirements: [{ name: "torch" }] }],
      hardware: { platforms: ["linux-x64"] },
      assets: [{ id: "w", url: "https://example.com/w.bin", sha256: "c".repeat(64), target: "w.bin", sizeBytes: 3 }],
      input: { formats: [".txt"], required: true },
      outputs: [{ id: "o", glob: "*.out", required: true }],
      cloud: {
        schemaVersion: 1,
        platform: "linux-x64",
        images: { gpu: `r.example/g@sha256:${DIGEST}`, cpu: `r.example/c@sha256:${DIGEST}` },
        minVramGb: 24,
        minRamGb: 32,
        ephemeralDiskGb: 40,
        volumeGb: 40,
        assetLayoutRevision: "1",
        cpuAssetPreparation: true,
      },
    },
    "x/manifest.yaml",
  );
}

function setup(overrides: { verify?: boolean; exitCode?: number; probe?: ManifestPipelineOptions["probe"] } = {}) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk pipeline "));
  dirs.push(jobDir);
  const m = manifest();
  const calls: string[] = [];
  let seenContext: RunContext | undefined;
  const adapter: ModelAdapterDefinition = {
    modelName: "fake-model",
    params: [],
    async validateInput() {},
    async installPlan() {
      return { steps: [] };
    },
    async command(context) {
      calls.push("command");
      seenContext = context;
      return { executable: "/job/x/runtime/.venv/bin/fake", args: ["--in", context.inputPath, "--out", context.outputDir], env: { A: "1" } };
    },
    async collectOutputs() {
      return [];
    },
    async verifyInstallation() {
      calls.push("verify");
      return { passed: overrides.verify ?? true, output: "cuda probe failed" };
    },
  };
  const steps: Partial<PipelineSteps> = {
    async cacheAsset() {
      calls.push("cacheAsset");
      return "/obj/w";
    },
    async materializeAsset() {
      calls.push("materializeAsset");
      return "/assets/w.bin";
    },
    async preparePythonEnvironment(request) {
      calls.push("prepareEnv");
      expect(request.runtime.platforms).toEqual(["linux-x64"]);
      return { executable: path.join(request.targetDir, ".venv", "bin", "python"), lock: ["torch==2.2.1"], pythonVersion: "3.11.9", postInstall: [] };
    },
    async getSystemReport() {
      return { nvidia: { available: true, gpus: [{ name: "A40", totalVramBytes: 48 * 1024 ** 3 }], driverVersion: "550", driverCudaVersion: "12.4" } } as never;
    },
    runtime: {
      kind: "python",
      async inspect() {
        return { kind: "python", available: true };
      },
      async prepare() {
        throw new Error("unused");
      },
      async execute(request) {
        calls.push("execute");
        request.onStdout?.("model output\n");
        return { exitCode: overrides.exitCode ?? 0, stdoutPath: "", stderrPath: "" };
      },
      async remove() {},
    } satisfies RuntimeProvider,
  };
  const stages: JobStage[] = [];
  const logs: string[] = [];
  const job = (patch: Partial<WireJob> = {}): WireJob => ({
    version: 1,
    runId: "run-1",
    model: "fake-model",
    modelVersion: "1.0.0",
    manifestDigest: digest(m),
    cachePolicy: "ephemeral",
    gpuId: "g",
    datacenterId: "dc",
    images: m.cloud!.images,
    containerDiskGb: 40,
    volumeGb: 40,
    assetLayoutRevision: "1",
    cpuAssetPreparation: true,
    params: { seed: 1 },
    inputs: [{ role: "job", relativePath: "in.txt", sha256: "d".repeat(64), sizeBytes: 3 }],
    deadlineAt: "2099-01-01T00:00:00.000Z",
    cacheKey: "k".repeat(64),
    mode: "execute",
    ...patch,
  });
  const run = (patch: Partial<WireJob> = {}, signal = new AbortController().signal) =>
    createManifestPipeline({ resolveModel: (name) => (name === "fake-model" ? { manifest: m, adapter } : undefined), steps, ...(overrides.probe ? { probe: overrides.probe } : {}) })({
      job: job(patch),
      jobDir,
      inputDir: path.join(jobDir, "input"),
      outputDir: path.join(jobDir, "output"),
      signal,
      setStage: (stage) => void stages.push(stage),
      log: (_stream, text) => void logs.push(text),
    });
  return { run, calls, stages, logs, jobDir, context: () => seenContext };
}

describe("manifest pipeline", () => {
  it("runs assets, runtime, verification and execution in order and reports what ran", async () => {
    const box = setup();
    const result = await box.run();
    expect(box.calls).toEqual(["cacheAsset", "materializeAsset", "prepareEnv", "verify", "command", "execute"]);
    expect(box.stages).toEqual(["preparing_assets", "installing_runtime", "verifying_runtime", "running"]);
    expect(result.exitCode).toBe(0);
    expect(result.runtime).toMatchObject({
      pythonVersion: "3.11.9",
      dependencyFreeze: ["torch==2.2.1"],
      sourceRevision: "b".repeat(40),
      gpu: { name: "A40", memoryMb: 49152, driverVersion: "550", cudaVersion: "12.4" },
      command: { executable: "/job/x/runtime/.venv/bin/fake", cwd: box.jobDir },
    });
    expect(result.runtime!.installationFingerprint).toMatch(/^python-[0-9a-f]{32}$/);
    expect(box.logs.join("")).toContain("model output");
  });

  it("reports the peak GPU memory and disk observed during the job", async () => {
    const box = setup({ probe: { intervalMs: 1000, samplers: { disk: () => ({ usedBytes: 5, totalBytes: 50 }), vramUsedMb: async () => 1234 } } });
    const result = await box.run();
    expect(result.runtime!.usage).toMatchObject({ peakVramMb: 1234 });
    expect(result.runtime!.usage!.disk[0]).toMatchObject({ startUsedBytes: 5, peakUsedBytes: 5, totalBytes: 50 });
  });

  it("builds the adapter command from worker-local paths and the approved params only", async () => {
    const box = setup();
    await box.run();
    const context = box.context()!;
    expect(context.platform).toBe("linux-x64");
    expect(context.params).toEqual({ seed: 1 });
    expect(context.inputPath).toBe(path.join(box.jobDir, "input", "in.txt"));
    expect(context.outputDir).toBe(path.join(box.jobDir, "output"));
    expect(context.runtimeExecutable).toBe(path.join(box.jobDir, "runtime", ".venv", "bin", "python"));
  });

  it("refuses a job approved against a different manifest, an unknown model or a non-cloud model", async () => {
    await expect(setup().run({ manifestDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "WORKER_MANIFEST_MISMATCH" });
    await expect(setup().run({ model: "other" })).rejects.toMatchObject({ code: "WORKER_MODEL_UNKNOWN" });
  });

  it("stops at failed verification before any inference", async () => {
    const box = setup({ verify: false });
    await expect(box.run()).rejects.toMatchObject({ code: "INSTALL_VERIFICATION_FAILED" });
    expect(box.calls).not.toContain("execute");
    expect(box.calls).not.toContain("command");
  });

  it("returns the model's nonzero exit code unchanged", async () => {
    expect((await setup({ exitCode: 3 }).run()).exitCode).toBe(3);
  });

  it("does not start when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const box = setup();
    await expect(box.run({}, controller.signal)).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    expect(box.calls).toEqual([]);
  });
});

describe("persistent cache modes", () => {
  const key = "k".repeat(64);
  function volume() {
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk volume "));
    dirs.push(mount);
    return mount;
  }
  const persistent = (mount: string, mode: "execute" | "prepare-assets") => ({ cachePolicy: "persistent" as const, mode, volumeMount: mount, cacheKey: key });

  it("prepare-assets prepares and publishes the cache without installing Python or probing CUDA", async () => {
    const mount = volume();
    const box = setup();
    const result = await box.run(persistent(mount, "prepare-assets"));
    expect(box.calls).toEqual(["cacheAsset", "materializeAsset"]);
    expect(box.stages).toEqual(["preparing_assets"]);
    expect(result.runtime?.cache).toMatchObject({ reused: false, fileCount: 0 });
    expect(fs.existsSync(path.join(mount, "moldesk-cache", key, "ready.json"))).toBe(true);
    expect(fs.readdirSync(path.join(mount, "moldesk-cache")).filter((n) => n.includes("staging") || n.endsWith(".lock"))).toEqual([]);
  });

  it("a second prepare-assets on a valid cache downloads nothing", async () => {
    const mount = volume();
    const first = setup();
    await first.run(persistent(mount, "prepare-assets"));
    const second = setup();
    const result = await second.run(persistent(mount, "prepare-assets"));
    expect(second.calls).toEqual([]);
    expect(result.runtime?.cache?.reused).toBe(true);
  });

  it("an execute job on a warm volume skips asset preparation and runs on a verified local copy, never the volume", async () => {
    const mount = volume();
    // Real materialize so the cache has content to hash.
    const prepare = setup();
    await prepare.run(persistent(mount, "prepare-assets"));
    const box = setup();
    await box.run(persistent(mount, "execute"));
    expect(box.calls).toEqual(["prepareEnv", "verify", "command", "execute"]);
    const assetsDir = box.context()!.assetsDir;
    expect(assetsDir).not.toBe(path.join(mount, "moldesk-cache", key, "assets"));
    expect(assetsDir.startsWith(path.join(mount, "moldesk-cache"))).toBe(false);
    expect(fs.existsSync(assetsDir)).toBe(true);
  });

  it("an execute job fails fast, before installing anything, when the volume has no valid cache", async () => {
    const mount = volume();
    const missing = setup();
    await expect(missing.run(persistent(mount, "execute"))).rejects.toMatchObject({ code: "CLOUD_CACHE_MISSING" });
    expect(missing.calls).toEqual([]);

    const prepared = setup();
    await prepared.run(persistent(mount, "prepare-assets"));
    fs.writeFileSync(path.join(mount, "moldesk-cache", key, "assets", "injected.bin"), "x");
    const damaged = setup();
    await expect(damaged.run(persistent(mount, "execute"))).rejects.toMatchObject({ code: "CLOUD_CACHE_INVALID" });
    expect(damaged.calls).toEqual([]);
  });

  it("prepare-assets without a volume is a bad job", async () => {
    await expect(setup().run({ mode: "prepare-assets" })).rejects.toMatchObject({ code: "WORKER_BAD_JOB" });
  });
});

describe("deadline watchdog", () => {
  function fakeEnv(responses: Array<number | Error>) {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const timers: Array<{ ms: number; run: () => void }> = [];
    const logs: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      const next = responses.shift() ?? 204;
      if (next instanceof Error) throw next;
      return new Response(null, { status: next });
    }) as unknown as typeof fetch;
    return { calls, timers, logs, fetchFn };
  }

  it("terminates its own pod at the deadline with the pod-scoped key", async () => {
    const env = fakeEnv([204]);
    const dog = startDeadlineWatchdog({
      deadlineAt: "2026-10-13T13:00:00.000Z",
      podId: "pod9",
      apiKey: "pod-scoped-key",
      fetch: env.fetchFn,
      now: () => Date.parse("2026-10-13T12:00:00.000Z"),
      setTimer: (run, ms) => void env.timers.push({ ms, run }),
      log: (m) => env.logs.push(m),
    });
    expect(env.timers[0]!.ms).toBe(3_600_000);
    env.timers[0]!.run();
    await dog.done;
    expect(env.calls).toEqual([{ url: "https://api.runpod.io/v2/pods/pod9/action", auth: "Bearer pod-scoped-key", body: { action: "terminate" } }]);
    expect(env.logs.join(" ")).not.toContain("pod-scoped-key");
  });

  it("fires immediately when the deadline already passed and retries until accepted", async () => {
    const env = fakeEnv([503, new Error("network"), 404]);
    const dog = startDeadlineWatchdog({
      deadlineAt: "2026-10-13T11:00:00.000Z",
      podId: "pod9",
      apiKey: "k",
      fetch: env.fetchFn,
      now: () => Date.parse("2026-10-13T12:00:00.000Z"),
      retryMs: 30_000,
      setTimer: (run, ms) => void env.timers.push({ ms, run }),
    });
    expect(env.timers[0]!.ms).toBe(0);
    env.timers[0]!.run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(env.timers[1]!.ms).toBe(30_000);
    env.timers[1]!.run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    env.timers[2]!.run();
    await dog.done;
    expect(env.calls).toHaveLength(3);
  });

  it("does nothing once stopped", async () => {
    const env = fakeEnv([204]);
    const dog = startDeadlineWatchdog({ deadlineAt: "2000-01-01T00:00:00.000Z", podId: "p", apiKey: "k", fetch: env.fetchFn, now: () => 0, setTimer: (run, ms) => void env.timers.push({ ms, run }) });
    dog.stop();
    env.timers[0]!.run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(env.calls).toHaveLength(0);
  });
});
