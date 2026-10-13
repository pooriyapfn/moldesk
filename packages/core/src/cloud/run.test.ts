import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelAdapterDefinition } from "@moldesk/adapters";
import { parseManifest, type ModelManifestV1 } from "@moldesk/registry";
import {
  getMoldeskPaths,
  type ArtifactInventory,
  type BackendContext,
  type CloudCatalog,
  type CloudPod,
  type CloudProvider,
  type ExecutionBackend,
  type JobHandle,
  type JobSnapshot,
} from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import type { DeadlineGuard } from "./guard.js";
import { buildQuote } from "./quote.js";
import { planCloudRun, runCloudModel, type CloudRunDeps, type CloudRunModelOptions } from "./run.js";
import { CloudJournal } from "./state.js";
import { recoverCloudRun } from "./manage.js";

const DIGEST = "a".repeat(64);
const homes: string[] = [];

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
      runtimes: [{ kind: "python", python: "3.11", installer: "uv", platforms: ["linux-x64"], requirements: [{ name: "torch" }] }],
      hardware: { platforms: ["linux-x64"] },
      input: { formats: [".txt"], required: true },
      outputs: [{ id: "result", glob: "*.out", required: true }],
      cloud: {
        schemaVersion: 1,
        platform: "linux-x64",
        images: { gpu: `registry.example/w/gpu@sha256:${DIGEST}`, cpu: `registry.example/w/cpu@sha256:${DIGEST}` },
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

function adapter(): ModelAdapterDefinition {
  return {
    modelName: "fake-model",
    params: [],
    async validateInput() {},
    async installPlan() {
      return { steps: [] };
    },
    async command() {
      throw new Error("the client must never build a command for a remote run");
    },
    async collectOutputs(context) {
      const files = fs.existsSync(context.outputDir) ? fs.readdirSync(context.outputDir).filter((name) => name.endsWith(".out")) : [];
      if (files.length === 0) throw new MoldeskError({ code: "MISSING_REQUIRED_OUTPUT", message: "No .out file was produced.", remediation: "x" });
      return files.map((name) => ({ id: "result", path: path.join(context.outputDir, name) }));
    },
    async verifyInstallation() {
      return { passed: true };
    },
  };
}

const catalog = (): CloudCatalog => ({
  retrievedAt: "2026-10-13T12:00:00.000Z",
  gpus: [{ id: "a40", name: "A40", memoryGb: 48, priceUsdPerHour: 0.6, availability: "LOW", dataCenters: [{ id: "DC-1", availability: "LOW" }], cudaVersions: [] }],
  cpus: [{ id: "cpu3c", name: "c", priceUsdPerVcpuHour: 0.03, ramGbPerVcpu: 2, minVcpu: 2, maxVcpu: 32 }],
  dataCenters: [{ id: "DC-1", region: "EU", networkVolumeTypes: ["STANDARD"] }],
});

class FakeProvider implements CloudProvider {
  readonly name = "runpod";
  pods = new Map<string, CloudPod>();
  nextId = 1;
  failTerminate = false;
  terminated: string[] = [];
  async validateCredentials() {
    return { ok: true as const, checkedAt: "t" };
  }
  async getCatalog() {
    return catalog();
  }
  async createPod(request: { name: string }): Promise<CloudPod> {
    const pod: CloudPod = { id: `pod${this.nextId++}`, name: request.name, status: "RUNNING", dataCenterId: "DC-1", costUsdPerHour: 0.6, createdAt: null };
    this.pods.set(pod.id, pod);
    return pod;
  }
  async getPod(id: string) {
    return this.pods.get(id) ?? null;
  }
  async listPods() {
    return [...this.pods.values()];
  }
  async terminatePod(id: string) {
    if (this.failTerminate) throw new Error("provider down");
    this.terminated.push(id);
    const existed = this.pods.delete(id);
    return { id, alreadyAbsent: !existed };
  }
  async createVolume(): Promise<never> {
    throw new Error("unused");
  }
  async getVolume() {
    return null;
  }
  async listVolumes() {
    return [];
  }
  async deleteVolume(): Promise<never> {
    throw new Error("unused");
  }
}

type Script = JobSnapshot[];

class FakeBackend implements ExecutionBackend {
  starts = 0;
  observes = 0;
  collects = 0;
  cancelled = false;
  startError?: Error;
  /** Pods are created BEFORE start() can fail, to test cleanup after a half-finished provision. */
  createThenFail = false;
  collectFailures = 0;
  files: Record<string, string> = { "answer.out": "result-bytes" };
  constructor(private readonly provider: FakeProvider, readonly script: Script, private readonly events: string[]) {}
  async start(job: { runId: string }, context: BackendContext): Promise<JobHandle> {
    this.starts += 1;
    this.events.push("backend.start");
    const intent = context.ledger.beginCreate("gpu");
    const pod = await this.provider.createPod({ name: intent.name });
    context.ledger.created(intent.intentId, pod.id);
    if (this.startError) throw this.startError;
    return { version: 1, runId: job.runId, podId: pod.id, endpoint: "https://worker.example" };
  }
  reconnect(runId: string, podId: string): JobHandle {
    return { version: 1, runId, podId, endpoint: "https://worker.example" };
  }
  async observe(_handle: JobHandle, _after?: number): Promise<JobSnapshot> {
    const snapshot = this.script[Math.min(this.observes, this.script.length - 1)]!;
    this.observes += 1;
    return snapshot;
  }
  async cancel() {
    this.cancelled = true;
  }
  async collect(_handle: JobHandle, dir: string): Promise<ArtifactInventory> {
    this.collects += 1;
    if (this.collectFailures > 0) {
      this.collectFailures -= 1;
      throw new Error("connection reset");
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(this.files)) fs.writeFileSync(path.join(dir, name), text);
    return { version: 1, files: Object.keys(this.files).map((name) => ({ path: name, sizeBytes: 1, sha256: "x" })) };
  }
  async release(handle: JobHandle | { runId: string }, context: { ledger: BackendContext["ledger"] }) {
    this.events.push("backend.release");
    void handle;
    void context;
  }
}

const runningSnap = (extra: Partial<JobSnapshot> = {}): JobSnapshot => ({ stage: "running", state: "running", logs: { cursor: 1, stdout: "", stderr: "" }, ...extra });
const doneSnap: JobSnapshot = {
  stage: "running",
  state: "succeeded",
  exitCode: 0,
  logs: { cursor: 2, stdout: "predicting\n", stderr: "" },
  runtime: { pythonVersion: "3.11.9", dependencyFreeze: ["torch==2.2.1"], gpu: { name: "A40", memoryMb: 49152 }, command: { executable: "/job/x/runtime/.venv/bin/fake", args: ["--in", "/job/x/input/in.txt"], cwd: "/job/x" }, installationFingerprint: "python-" + "f".repeat(16) },
};

function sandbox(script: Script = [runningSnap(), doneSnap], overrides: Partial<CloudRunDeps> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk cloud run "));
  homes.push(home);
  const paths = getMoldeskPaths({ MOLDESK_HOME: home });
  const inputPath = path.join(home, "in.txt");
  fs.writeFileSync(inputPath, "job");
  const provider = new FakeProvider();
  const events: string[] = [];
  const backend = new FakeBackend(provider, script, events);
  const guardState = { registered: [] as string[], disarmed: [] as string[], refuse: false };
  const guard: DeadlineGuard = {
    async register(registration) {
      events.push("guard.register");
      if (guardState.refuse) throw new MoldeskError({ code: "CLOUD_GUARD_UNAVAILABLE", message: "no guard", remediation: "x" });
      guardState.registered.push(registration.deadlineAt);
      return { id: "g1" };
    },
    async disarm(id) {
      events.push("guard.disarm");
      guardState.disarmed.push(id);
    },
  };
  const clock = { ms: Date.parse("2026-10-13T12:00:00.000Z") };
  const deps: CloudRunDeps = {
    provider,
    paths,
    backend,
    guard,
    accountScope: "acct",
    resolveModel: () => ({ manifest: manifest(), adapter: adapter() }),
    now: () => new Date(clock.ms),
    sleep: async (ms) => {
      clock.ms += ms;
    },
    pollIntervalMs: 1000,
    recoveryWindowSeconds: 30,
    ...overrides,
  };
  const quoteOptions = { cachePolicy: "ephemeral" as const, maxBudgetUsd: 5, maxLifetimeSeconds: 3600 };
  const optionsFor = async (extra: Partial<CloudRunModelOptions> = {}): Promise<CloudRunModelOptions> => {
    const plan = await planCloudRun("fake-model", inputPath, { cloud: quoteOptions }, deps);
    return { cloud: { ...quoteOptions, quote: plan.quote, approval: { quoteId: plan.quote.id, approvedAt: new Date(clock.ms).toISOString() } }, ...extra };
  };
  return { paths, inputPath, provider, backend, events, guardState, clock, deps, optionsFor };
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("runCloudModel", () => {
  it("runs end to end: guard first, verified outputs, pod gone before the report, journal closed out", async () => {
    const box = sandbox();
    const logs: string[] = [];
    const options = await box.optionsFor({ onLog: (_stream, chunk) => logs.push(chunk) });
    const result = await runCloudModel("fake-model", box.inputPath, options, box.deps);

    expect(result.status).toBe("succeeded");
    expect(result.cleanupPending).toBeUndefined();
    expect(box.events).toEqual(["guard.register", "backend.start", "backend.release", "guard.disarm"]);
    expect(box.provider.pods.size).toBe(0);
    expect(logs.join("")).toContain("predicting");
    expect(result.record.outputs).toHaveLength(1);
    expect(result.record.outputs[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.record.runtime).toBe("python");
    expect(result.record.installationFingerprint).toBe("python-" + "f".repeat(16));
    expect(result.record.compute).toMatchObject({
      provider: "runpod",
      cachePolicy: "ephemeral",
      gpuId: "a40",
      datacenterId: "DC-1",
      cleanup: "confirmed",
      hardware: { name: "A40" },
      pythonVersion: "3.11.9",
      dependencyFreeze: ["torch==2.2.1"],
    });
    expect(result.record.compute!.resources).toEqual([{ role: "gpu", providerId: "pod1" }]);
    expect(result.record.compute!.remoteCommand!.cwd).toBe("/job/x"); // POSIX worker path
    expect(result.record.command.cwd).toContain("runs"); // local run directory is unchanged
    const onDisk = JSON.parse(fs.readFileSync(path.join(result.record.command.cwd, "run.json"), "utf8"));
    expect(onDisk.status).toBe("succeeded");

    const journal = CloudJournal.open(box.paths);
    expect(journal.getJob(result.record.id)).toMatchObject({ stage: "done", status: "succeeded", transferState: "verified" });
    expect(journal.listResources({ states: ["create_pending", "active", "delete_pending"] })).toHaveLength(0);
    journal.close();
  });

  it("rejects mismatched or expired approvals before any run directory, job or resource exists", async () => {
    const box = sandbox();
    const options = await box.optionsFor();
    await expect(runCloudModel("fake-model", box.inputPath, { ...options, cloud: { ...options.cloud, approval: { quoteId: "other", approvedAt: new Date(box.clock.ms).toISOString() } } }, box.deps)).rejects.toMatchObject({ code: "CLOUD_APPROVAL_MISMATCH" });
    box.clock.ms += 16 * 60 * 1000;
    await expect(runCloudModel("fake-model", box.inputPath, options, box.deps)).rejects.toMatchObject({ code: "CLOUD_APPROVAL_EXPIRED" });
    expect(fs.existsSync(box.paths.runs)).toBe(false);
    expect(box.backend.starts).toBe(0);
    expect(box.events).toEqual([]);
  });

  it("requires a new quote when the input file changed since it was quoted", async () => {
    const box = sandbox();
    const options = await box.optionsFor();
    fs.writeFileSync(box.inputPath, "different job");
    await expect(runCloudModel("fake-model", box.inputPath, options, box.deps)).rejects.toMatchObject({ code: "CLOUD_REQUOTE_REQUIRED" });
    expect(box.events).toEqual([]);
  });

  it("finalizes a failed run and provisions nothing when the deadline guard refuses", async () => {
    const box = sandbox();
    box.guardState.refuse = true;
    const result = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), box.deps);
    expect(result.status).toBe("failed");
    expect(result.record.error?.code).toBe("CLOUD_GUARD_UNAVAILABLE");
    expect(box.backend.starts).toBe(0);
    expect(box.provider.nextId).toBe(1);
    expect(fs.existsSync(path.join(result.record.command.cwd, "run.json"))).toBe(true);
  });

  it("fails on a nonzero worker exit and still terminates the machine", async () => {
    const box = sandbox([runningSnap(), { stage: "running", state: "failed", exitCode: 1, logs: { cursor: 2, stdout: "", stderr: "boom\n" } }]);
    const result = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), box.deps);
    expect(result.status).toBe("failed");
    expect(result.record.error).toEqual({ code: "RUN_EXECUTION_FAILED", message: "fake-model exited with code 1." });
    expect(box.provider.pods.size).toBe(0);
    expect(result.record.outputs).toHaveLength(0);
  });

  it("treats a missing required output as failure even when the worker reported success", async () => {
    const box = sandbox();
    box.backend.files = {};
    const result = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), box.deps);
    expect(result.status).toBe("failed");
    expect(result.record.error?.code).toBe("MISSING_REQUIRED_OUTPUT");
    expect(box.provider.pods.size).toBe(0);
  });

  it("retries a failed download inside a bounded window without rerunning inference", async () => {
    const box = sandbox();
    box.backend.collectFailures = 2;
    const result = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), box.deps);
    expect(result.status).toBe("succeeded");
    expect(box.backend.collects).toBe(3);
    expect(box.backend.starts).toBe(1);
    expect(box.backend.observes).toBe(2);
  });

  it("reports a transfer failure after the window, preserves the failure and still cleans up", async () => {
    const box = sandbox();
    box.backend.collectFailures = 1000;
    const result = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), box.deps);
    expect(result.status).toBe("failed");
    expect(result.record.error?.code).toBe("CLOUD_TRANSFER_FAILED");
    expect(box.backend.collects).toBeLessThan(20);
    expect(box.backend.starts).toBe(1);
    expect(box.provider.pods.size).toBe(0);
    const journal = CloudJournal.open(box.paths);
    expect(journal.getJob(result.record.id)!.transferState).toBe("failed");
    journal.close();
  });

  it("cancels on abort, marks the run cancelled and terminates the machine", async () => {
    const controller = new AbortController();
    const box = sandbox([runningSnap({ logs: { cursor: 1, stdout: "working\n", stderr: "" } })]);
    const options = await box.optionsFor({ signal: controller.signal, onLog: () => controller.abort() });
    const result = await runCloudModel("fake-model", box.inputPath, options, box.deps);
    expect(result.status).toBe("cancelled");
    expect(result.record.error?.code).toBe("RUN_CANCELLED");
    expect(box.backend.cancelled).toBe(true);
    expect(box.provider.pods.size).toBe(0);
  });

  it("stops at the approved lifetime and reports CLOUD_DEADLINE_EXCEEDED", async () => {
    const box = sandbox([runningSnap()], { pollIntervalMs: 600_000 });
    const result = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), box.deps);
    expect(result.status).toBe("failed");
    expect(result.record.error?.code).toBe("CLOUD_DEADLINE_EXCEEDED");
    expect(box.backend.cancelled).toBe(true);
    expect(box.provider.pods.size).toBe(0);
  });

  it("fails fast when the worker becomes unreachable and still cleans up", async () => {
    const box = sandbox();
    box.backend.observe = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), box.deps);
    expect(result.record.error?.code).toBe("CLOUD_WORKER_UNREACHABLE");
    expect(box.provider.pods.size).toBe(0);
  });

  it("cleans up a machine created before start() failed", async () => {
    const box = sandbox();
    box.backend.startError = new Error("bootstrap failed");
    const result = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), box.deps);
    expect(result.status).toBe("failed");
    expect(result.record.error?.message).toBe("bootstrap failed");
    expect(box.provider.pods.size).toBe(0);
    expect(box.provider.terminated).toEqual(["pod1"]);
  });

  it("surfaces CLOUD_CLEANUP_PENDING without discarding a valid result, and keeps the guard armed", async () => {
    const box = sandbox();
    box.provider.failTerminate = true;
    const result = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), { ...box.deps, cleanupAttempts: 2 });
    expect(result.status).toBe("succeeded");
    expect(result.record.outputs).toHaveLength(1);
    expect(result.cleanupPending).toEqual({ code: "CLOUD_CLEANUP_PENDING", resources: [{ role: "gpu", providerId: "pod1" }] });
    expect(result.record.compute!.cleanup).toBe("pending");
    expect(box.guardState.disarmed).toEqual([]);
    const journal = CloudJournal.open(box.paths);
    expect(journal.getJob(result.record.id)).toMatchObject({ status: "cleanup_pending", error: { code: "CLOUD_CLEANUP_PENDING" } });
    expect(journal.listOpenJobs()).toHaveLength(1);
    journal.close();
  });
});

describe("preflight reconciliation", () => {
  it("refuses new paid work while an orphaned or owed resource exists, before allocating anything", async () => {
    const box = sandbox();
    const options = await box.optionsFor();
    const journal = CloudJournal.open(box.paths);
    const prefix = journal.clientId.replace(/-/g, "").slice(0, 8);
    journal.close();
    box.provider.pods.set("podOrphan", { id: "podOrphan", name: `moldesk-${prefix}-deadbeef-gpu`, status: "RUNNING", dataCenterId: null, costUsdPerHour: 0.5, createdAt: null });
    await expect(runCloudModel("fake-model", box.inputPath, options, box.deps)).rejects.toMatchObject({ code: "CLOUD_UNRESOLVED_RESOURCES" });
    expect(fs.existsSync(box.paths.runs)).toBe(false);
    expect(box.events).toEqual([]);
  });

  it("refuses when a previous run still owes cleanup", async () => {
    const box = sandbox();
    box.provider.failTerminate = true;
    const first = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), { ...box.deps, cleanupAttempts: 1 });
    expect(first.cleanupPending).toBeDefined();
    await expect(runCloudModel("fake-model", box.inputPath, await box.optionsFor(), box.deps)).rejects.toMatchObject({ code: "CLOUD_UNRESOLVED_RESOURCES" });
    expect(box.backend.starts).toBe(1);
  });

  it("does not start blind when the provider cannot be listed", async () => {
    const box = sandbox();
    const options = await box.optionsFor();
    box.provider.listPods = async () => {
      throw new Error("offline");
    };
    await expect(runCloudModel("fake-model", box.inputPath, options, box.deps)).rejects.toMatchObject({ code: "CLOUD_UNAVAILABLE" });
    expect(fs.existsSync(box.paths.runs)).toBe(false);
  });
});

describe("planCloudRun", () => {
  it("rejects models without a cloud block and jobs with companion inputs", async () => {
    const box = sandbox();
    const plain = parseManifest({ ...JSON.parse(JSON.stringify(manifest())), cloud: undefined }, "x/manifest.yaml");
    await expect(planCloudRun("fake-model", box.inputPath, { cloud: { cachePolicy: "ephemeral", maxBudgetUsd: 5, maxLifetimeSeconds: 3600 } }, { ...box.deps, resolveModel: () => ({ manifest: plain, adapter: adapter() }) })).rejects.toMatchObject({ code: "CLOUD_MODEL_UNSUPPORTED" });
    const withCompanions: ModelAdapterDefinition = { ...adapter(), resolveCompanionInputs: async () => [{ id: "protein", sourcePath: "p.pdb" }] };
    await expect(planCloudRun("fake-model", box.inputPath, { cloud: { cachePolicy: "ephemeral", maxBudgetUsd: 5, maxLifetimeSeconds: 3600 } }, { ...box.deps, resolveModel: () => ({ manifest: manifest(), adapter: withCompanions }) })).rejects.toMatchObject({ code: "CLOUD_COMPANION_INPUTS_UNSUPPORTED" });
  });

  it("produces the same quote that buildQuote would, without allocating anything", async () => {
    const box = sandbox();
    const plan = await planCloudRun("fake-model", box.inputPath, { cloud: { cachePolicy: "ephemeral", maxBudgetUsd: 5, maxLifetimeSeconds: 3600 } }, box.deps);
    expect(plan.quote.id).toBe(buildQuote({ provider: "runpod", manifest: plan.manifest, cloud: plan.cloud, catalog: catalog(), cachePolicy: "ephemeral", maxBudgetUsd: 5, maxLifetimeSeconds: 3600, inputs: [{ role: "job", sha256: plan.input.sha256, sizeBytes: 3 }] }).id);
    expect(fs.existsSync(box.paths.runs)).toBe(false);
  });
});

describe("recoverCloudRun", () => {
  const recoverDeps = (box: ReturnType<typeof sandbox>) => ({ provider: box.provider, paths: box.paths, backend: box.backend, guard: box.deps.guard, resolveModel: box.deps.resolveModel, sleep: box.deps.sleep, cleanupAttempts: 1 });

  it("finishes owed cleanup after the provider recovers, disarms the guard and never restarts inference", async () => {
    const box = sandbox();
    box.provider.failTerminate = true;
    const first = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), { ...box.deps, cleanupAttempts: 1 });
    expect(first.cleanupPending).toBeDefined();
    expect(box.guardState.disarmed).toEqual([]);
    box.provider.failTerminate = false;

    const recovered = await recoverCloudRun(first.record.id, recoverDeps(box));
    expect(recovered.cleanup.confirmed).toBe(true);
    expect(box.provider.pods.size).toBe(0);
    expect(box.guardState.disarmed).toEqual(["g1"]);
    expect(box.backend.starts).toBe(1);
    const journal = CloudJournal.open(box.paths);
    expect(journal.getJob(first.record.id)).toMatchObject({ status: "succeeded", guardId: "g1" });
    expect(journal.listOpenJobs()).toHaveLength(0);
    journal.close();
    const onDisk = JSON.parse(fs.readFileSync(path.join(first.record.command.cwd, "run.json"), "utf8"));
    expect(onDisk.compute.cleanup).toBe("confirmed");
  });

  it("downloads results left on a still-alive pod after a transfer failure, then cleans up", async () => {
    const box = sandbox();
    box.provider.failTerminate = true;
    box.backend.collectFailures = 1000;
    const failed = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), { ...box.deps, cleanupAttempts: 1 });
    expect(failed.record.error?.code).toBe("CLOUD_TRANSFER_FAILED");
    expect(box.provider.pods.size).toBe(1);

    box.provider.failTerminate = false;
    box.backend.collectFailures = 0;
    const recovered = await recoverCloudRun(failed.record.id, recoverDeps(box));
    expect(recovered.collected).toBe(true);
    expect(recovered.status).toBe("succeeded");
    expect(recovered.result?.record.outputs).toHaveLength(1);
    expect(box.provider.pods.size).toBe(0);
    expect(box.backend.starts).toBe(1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(failed.record.command.cwd, "run.json"), "utf8"));
    expect(onDisk.status).toBe("succeeded");
    expect(onDisk.error).toBeUndefined();
  });

  it("marks an interrupted run failed and terminates its pod", async () => {
    const box = sandbox();
    box.provider.failTerminate = true;
    const first = await runCloudModel("fake-model", box.inputPath, await box.optionsFor(), { ...box.deps, cleanupAttempts: 1 });
    // Rewrite history as if the client died mid-run.
    const file = path.join(first.record.command.cwd, "run.json");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.status = "running";
    delete record.finishedAt;
    delete record.error;
    record.outputs = [];
    fs.writeFileSync(file, JSON.stringify(record));
    fs.rmSync(path.join(first.record.command.cwd, "output"), { recursive: true, force: true });
    box.backend.script.splice(0, box.backend.script.length, runningSnap());
    box.backend.observes = 0;
    box.provider.failTerminate = false;

    // The worker is still running: recovery must not silently kill an approved job.
    const waiting = await recoverCloudRun(first.record.id, recoverDeps(box));
    expect(waiting.status).toBe("running");
    expect(waiting.cleanup.confirmed).toBe(false);
    expect(box.provider.pods.size).toBe(1);

    const forced = await recoverCloudRun(first.record.id, recoverDeps(box), { terminateRunning: true });
    expect(forced.cleanup.confirmed).toBe(true);
    expect(forced.status).toBe("failed");
    expect(box.provider.pods.size).toBe(0);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.error.code).toBe("CLOUD_RUN_INTERRUPTED");
    expect(after.finishedAt).toBeDefined();
  });

  it("rejects unknown runs", async () => {
    const box = sandbox();
    await expect(recoverCloudRun("2026-01-01T00-00-00-000Z-00000000-0000-0000-0000-000000000000", recoverDeps(box))).rejects.toMatchObject({ code: "CLOUD_RUN_UNKNOWN" });
  });
});
