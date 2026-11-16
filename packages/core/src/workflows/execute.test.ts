import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAvailableModels } from "@moldesk/registry";
import { getMoldeskPaths, modelInstallDir, type ExecuteRequest, type MoldeskPaths } from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import { digest } from "../hash.js";
import { writeInstallState, type InstalledModel } from "../install-state.js";
import { proteinCif } from "../testSupport/interface.js";
import { fakeProvider } from "../testSupport/run-fixture.js";
import { planWorkflow } from "./compiler.js";
import { createWorkflowApproval, storeWorkflowPlan, WorkflowStore } from "./store.js";
import {
  cancelWorkflowRun,
  executeWorkflowRun,
  getWorkflowArtifacts,
  getWorkflowStatus,
  resumeWorkflowRun,
  startWorkflowRun,
  submitWorkflowRun,
  type WorkflowExecutionOptions,
} from "./execute.js";

// Pass-through wrapper so Boltz-bridge tests can reject, or corrupt the returned child record of,
// a run that otherwise went through the real runModel and a fake runtime provider.
const modelHook = vi.hoisted(() => ({
  throwError: undefined as unknown,
  mutate: undefined as undefined | ((result: { record: { outputs: Array<Record<string, unknown>> } }) => void),
}));
vi.mock("../run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run.js")>();
  return {
    ...actual,
    runModel: async (...args: Parameters<typeof actual.runModel>) => {
      if (modelHook.throwError) throw modelHook.throwError;
      const result = await actual.runModel(...args);
      modelHook.mutate?.(result as never);
      return result;
    },
  };
});

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EXAMPLES = path.join(REPO_ROOT, "examples/workflows");
const FIXTURE = path.join(REPO_ROOT, "packages/visualizer/test/fixtures/1CRN.pdb");

const temporaries: string[] = [];

function tempPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-workflow-execute-"));
  temporaries.push(home);
  return getMoldeskPaths({ MOLDESK_HOME: home });
}

afterEach(() => {
  vi.restoreAllMocks();
  modelHook.throwError = undefined;
  modelHook.mutate = undefined;
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type TempPaths = ReturnType<typeof tempPaths>;

function submitApproved(paths: TempPaths, source: string, inputs: Record<string, string> = { structure: FIXTURE }) {
  const planned = planWorkflow(source, { inputs, paths });
  expect(planned.valid, JSON.stringify(planned.diagnostics)).toBe(true);
  storeWorkflowPlan(source, planned.plan!, { paths });
  const approval = createWorkflowApproval(planned.plan!.planId, { paths });
  const submitted = submitWorkflowRun(approval.approvalId, { paths });
  return { planned: planned.plan!, approval, submitted };
}

async function approvedRun(
  paths: TempPaths,
  source: string,
  inputs: Record<string, string> = { structure: FIXTURE },
  options: WorkflowExecutionOptions = {},
) {
  const { planned, approval, submitted } = submitApproved(paths, source, inputs);
  const summary = await executeWorkflowRun(submitted.runId, { paths, ...options });
  return { planned, approval, submitted, summary };
}

function exampleSource(name = "structure-analysis.yaml"): string {
  return fs.readFileSync(path.join(EXAMPLES, name), "utf8");
}

function attempts(paths: TempPaths, runId: string) {
  const store = WorkflowStore.open(paths);
  try {
    return store.listAttempts(runId);
  } finally {
    store.close();
  }
}

/**
 * Simulates a process death at the Nth `finishAttempt`: the call throws before its transaction,
 * so everything written to disk by that step stays unpublished. `before` runs ahead of the real
 * call for the calls that should go through.
 */
function crashAtFinish(nth: number, after?: (call: number) => void) {
  const original = WorkflowStore.prototype.finishAttempt;
  let call = 0;
  return vi.spyOn(WorkflowStore.prototype, "finishAttempt").mockImplementation(function (this: WorkflowStore, ...args) {
    call += 1;
    if (call === nth) {
      throw new MoldeskError({ code: "WORKFLOW_OWNER_LOST", message: "simulated crash", remediation: "none" });
    }
    const result = original.apply(this, args);
    after?.(call);
    return result;
  });
}

function installFakeBoltz(paths: MoldeskPaths, fingerprint = `python-${"a".repeat(64)}`): void {
  const manifest = listAvailableModels().find((entry) => entry.name === "boltz")!;
  const installDir = modelInstallDir(manifest.name, manifest.modelVersion, fingerprint, { MOLDESK_HOME: paths.home });
  fs.mkdirSync(installDir, { recursive: true });
  const record: InstalledModel = {
    schemaVersion: 1,
    installationId: `installation-${fingerprint.slice(-8)}`,
    model: manifest.name,
    displayName: manifest.displayName,
    modelVersion: manifest.modelVersion,
    adapterVersion: manifest.adapterVersion,
    runtime: {
      kind: "python",
      fingerprint,
      python: {
        version: "3.11",
        executable: "/usr/bin/python3",
        lockSha256: "a".repeat(64),
        platform: "darwin-arm64",
        platformSelected: true,
        postInstall: [],
      },
    },
    environmentFingerprint: `environment-${fingerprint.slice(-8)}`,
    installDir,
    ...(manifest.source
      ? { source: { repository: manifest.source.repository, revision: manifest.source.revision } }
      : {}),
    assets: (manifest.assets ?? []).map((asset) => ({
      id: asset.id,
      path: path.join(installDir, "assets", asset.target),
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes ?? 0,
    })),
    manifestSha256: digest(manifest),
    verification: { passed: true },
    dependencyLock: [],
    installedAt: "2026-01-01T00:00:00.000Z",
    verifiedAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
  };
  fs.writeFileSync(path.join(installDir, "installation.json"), JSON.stringify(record));
  writeInstallState({ schemaVersion: 1, installations: [record] }, paths);
}

const SEQUENCE = "TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN";

function writeBoltzOutputs(request: ExecuteRequest, records = ["rec"]): void {
  for (const record of records) {
    const dir = path.join(request.cwd, "output", "boltz_results_protein", "predictions", record);
    fs.mkdirSync(dir, { recursive: true });
    const stem = `${record}_model_0`;
    fs.writeFileSync(path.join(dir, `${stem}.cif`), proteinCif());
    fs.writeFileSync(path.join(dir, `confidence_${stem}.json`), JSON.stringify({ confidence_score: 0.9 }));
    fs.writeFileSync(path.join(dir, `pae_${stem}.npz`), "synthetic");
  }
}

function boltzProvider(behavior: (request: ExecuteRequest) => void | Promise<void> = writeBoltzOutputs) {
  return fakeProvider(async (request) => {
    await behavior(request);
    return { exitCode: 0, stdoutPath: path.join(request.cwd, "stdout.log"), stderrPath: path.join(request.cwd, "stderr.log") };
  });
}

function boltzRun(paths: TempPaths, options: WorkflowExecutionOptions = {}) {
  installFakeBoltz(paths);
  const { submitted } = submitApproved(paths, exampleSource("boltz-analysis.yaml"), { sequence: SEQUENCE });
  return { submitted, execute: () => executeWorkflowRun(submitted.runId, { paths, ...options }) };
}

describe("workflow execution", () => {
  it("runs import and analysis, records artifacts, and exposes durable status", async () => {
    const paths = tempPaths();
    const source = fs.readFileSync(path.join(EXAMPLES, "structure-analysis.yaml"), "utf8");
    const { planned, approval, submitted, summary } = await approvedRun(paths, source);

    expect(summary.status).toBe("succeeded");
    expect(summary.steps.map((step) => [step.id, step.status])).toEqual([
      ["import", "succeeded"],
      ["analyze", "succeeded"],
    ]);
    expect(summary.artifacts.map((artifact) => [artifact.producerStepId, artifact.type, artifact.format])).toEqual([
      ["import", "protein_structure", "pdb"],
      ["analyze", "json", "json"],
    ]);

    const report = summary.artifacts.find((artifact) => artifact.type === "json")!;
    const envelope = JSON.parse(fs.readFileSync(path.join(summary.runDir, report.relativePath), "utf8"));
    expect(envelope.kind).toBe("moldesk.analysis");
    expect(envelope.input.sha256).toBe(planned.inputs.structure!.sha256);

    const duplicate = submitWorkflowRun(approval.approvalId, { paths });
    expect(duplicate).toMatchObject({ runId: submitted.runId, duplicate: true });

    const views = await getWorkflowArtifacts(submitted.runId, { paths });
    expect(views.every((artifact) => artifact.verified)).toBe(true);
    expect(getWorkflowStatus(submitted.runId, { paths }).run.status).toBe("succeeded");
  });

  it("serves identical CPU steps from the cross-run cache", async () => {
    const paths = tempPaths();
    const source = fs.readFileSync(path.join(EXAMPLES, "structure-analysis.yaml"), "utf8");

    const first = await approvedRun(paths, source);
    const second = await approvedRun(paths, source);

    expect(first.summary.status).toBe("succeeded");
    expect(second.summary.status).toBe("succeeded");
    expect(second.summary.steps.map((step) => step.status)).toEqual(["cached", "cached"]);
    expect(second.summary.artifacts.map((artifact) => artifact.sha256)).toEqual(
      first.summary.artifacts.map((artifact) => artifact.sha256),
    );
  });

  it("rejects a file that changed between planning and submission", async () => {
    const paths = tempPaths();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-workflow-input-"));
    temporaries.push(work);
    const input = path.join(work, "1CRN.pdb");
    fs.copyFileSync(FIXTURE, input);
    const source = fs.readFileSync(path.join(EXAMPLES, "structure-analysis.yaml"), "utf8");
    const planned = planWorkflow(source, { inputs: { structure: input }, paths });
    expect(planned.valid, JSON.stringify(planned.diagnostics)).toBe(true);
    storeWorkflowPlan(source, planned.plan!, { paths });
    const approval = createWorkflowApproval(planned.plan!.planId, { paths });

    fs.appendFileSync(input, "\nREM tampered\n");

    expect(() => submitWorkflowRun(approval.approvalId, { paths })).toThrow(/changed after planning/);
    const store = WorkflowStore.open(paths);
    try {
      expect(store.getApproval(approval.approvalId)?.runId).toBeNull();
      expect(store.getApproval(approval.approvalId)?.consumedAt).toBeNull();
    } finally {
      store.close();
    }
  });

  it("keeps one run and unchanged attempt counts on duplicate submission, and never restarts an executor", async () => {
    const paths = tempPaths();
    const { approval, submitted } = await approvedRun(paths, exampleSource());
    const before = attempts(paths, submitted.runId);
    expect(before).toHaveLength(2);

    expect(submitWorkflowRun(approval.approvalId, { paths })).toMatchObject({ runId: submitted.runId, duplicate: true });
    expect(startWorkflowRun(approval.approvalId, { paths })).toEqual({ runId: submitted.runId, duplicate: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(attempts(paths, submitted.runId)).toEqual(before);
    expect(getWorkflowStatus(submitted.runId, { paths }).run.status).toBe("succeeded");
  });

  it("starts a run in the background and returns its run ID immediately", async () => {
    const paths = tempPaths();
    const source = exampleSource();
    const planned = planWorkflow(source, { inputs: { structure: FIXTURE }, paths });
    storeWorkflowPlan(source, planned.plan!, { paths });
    const approval = createWorkflowApproval(planned.plan!.planId, { paths });

    const started = startWorkflowRun(approval.approvalId, { paths });
    expect(started.duplicate).toBe(false);
    const deadline = Date.now() + 15000;
    while (getWorkflowStatus(started.runId, { paths }).run.status !== "succeeded") {
      if (Date.now() > deadline) throw new Error("background run did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 20000);

  describe("crash consistency", () => {
    it("publishes no artifact for an attempt that never reached its status transaction, then closes it on resume", async () => {
      const paths = tempPaths();
      const { submitted } = submitApproved(paths, exampleSource());
      const crash = crashAtFinish(1);
      await expect(executeWorkflowRun(submitted.runId, { paths })).rejects.toMatchObject({ code: "WORKFLOW_OWNER_LOST" });
      crash.mockRestore();

      // The staged file exists but is invisible: no artifact row, attempt still `running`.
      expect(fs.existsSync(path.join(submitted.runDir, "steps/import/attempt-1/structure.pdb"))).toBe(true);
      expect(await getWorkflowArtifacts(submitted.runId, { paths })).toEqual([]);
      expect(attempts(paths, submitted.runId).map((attempt) => [attempt.stepId, attempt.status])).toEqual([
        ["import", "running"],
        ["analyze", "pending"],
      ]);

      const resumed = await resumeWorkflowRun(submitted.runId, { paths });
      expect(resumed.status).toBe("succeeded");
      const all = attempts(paths, submitted.runId);
      const imports = all.filter((attempt) => attempt.stepId === "import");
      expect(imports.map((attempt) => [attempt.attemptNumber, attempt.status])).toEqual([
        [1, "failed"],
        [2, "succeeded"],
      ]);
      expect(imports[0]!.error?.code).toBe("WORKFLOW_ATTEMPT_INTERRUPTED");
      expect(all.filter((attempt) => attempt.stepId === "analyze")).toHaveLength(1);

      // Event IDs are ordered and the last event per attempt agrees with its persisted status.
      const view = getWorkflowStatus(submitted.runId, { paths });
      const ids = view.events.map((event) => event.id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(ids.length);
      for (const attempt of all) {
        const last = view.events.filter((event) => event.attemptId === attempt.attemptId).at(-1);
        expect(last?.status, attempt.attemptId).toBe(attempt.status);
      }
    });

    it("publishes cache-hit artifacts only with the attempt's status transaction", async () => {
      const paths = tempPaths();
      await approvedRun(paths, exampleSource());
      const { submitted } = submitApproved(paths, exampleSource());
      const crash = crashAtFinish(1);
      await expect(executeWorkflowRun(submitted.runId, { paths })).rejects.toMatchObject({ code: "WORKFLOW_OWNER_LOST" });
      crash.mockRestore();

      expect(fs.existsSync(path.join(submitted.runDir, "steps/import/attempt-1/structure.pdb"))).toBe(true);
      expect(await getWorkflowArtifacts(submitted.runId, { paths })).toEqual([]);
    });
  });

  describe("resume verification", () => {
    async function interruptedAfterImport(paths: TempPaths) {
      const { submitted } = submitApproved(paths, exampleSource());
      const crash = crashAtFinish(2);
      await expect(executeWorkflowRun(submitted.runId, { paths })).rejects.toMatchObject({ code: "WORKFLOW_OWNER_LOST" });
      crash.mockRestore();
      return submitted;
    }

    it("reuses a verified import and runs analysis once", async () => {
      const paths = tempPaths();
      const submitted = await interruptedAfterImport(paths);
      const resumed = await resumeWorkflowRun(submitted.runId, { paths });
      expect(resumed.status).toBe("succeeded");
      const all = attempts(paths, submitted.runId);
      expect(all.filter((attempt) => attempt.stepId === "import")).toHaveLength(1);
      expect(all.filter((attempt) => attempt.stepId === "analyze" && attempt.status === "succeeded")).toHaveLength(1);
    });

    it("rejects a tampered prior output instead of reusing or recomputing it", async () => {
      const paths = tempPaths();
      const submitted = await interruptedAfterImport(paths);
      fs.appendFileSync(path.join(submitted.runDir, "steps/import/attempt-1/structure.pdb"), "REMARK tampered\n");
      const before = attempts(paths, submitted.runId);

      await expect(resumeWorkflowRun(submitted.runId, { paths })).rejects.toMatchObject({
        code: "WORKFLOW_ARTIFACT_DAMAGED",
        remediation: expect.stringContaining("will not reuse or recompute"),
      });
      expect(attempts(paths, submitted.runId).map((attempt) => [attempt.stepId, attempt.attemptNumber, attempt.status])).toEqual(
        before.map((attempt) => [attempt.stepId, attempt.attemptNumber, attempt.status]),
      );
    });

    it("rejects a prior output replaced by a symlink with identical content", async () => {
      const paths = tempPaths();
      const submitted = await interruptedAfterImport(paths);
      const file = path.join(submitted.runDir, "steps/import/attempt-1/structure.pdb");
      const copy = path.join(paths.home, "elsewhere.pdb");
      fs.copyFileSync(file, copy);
      fs.rmSync(file);
      fs.symlinkSync(copy, file);

      await expect(resumeWorkflowRun(submitted.runId, { paths })).rejects.toMatchObject({
        code: "WORKFLOW_ARTIFACT_DAMAGED",
      });
    });

    it("rejects an output whose directory is a symlink out of the run", async () => {
      const paths = tempPaths();
      const submitted = await interruptedAfterImport(paths);
      const dir = path.join(submitted.runDir, "steps/import/attempt-1");
      const moved = path.join(paths.home, "moved-attempt");
      fs.renameSync(dir, moved);
      fs.symlinkSync(moved, dir);

      await expect(resumeWorkflowRun(submitted.runId, { paths })).rejects.toMatchObject({
        code: "WORKFLOW_ARTIFACT_OUTSIDE_RUN",
      });
    });

    it("verifies an upstream artifact before the next step consumes it", async () => {
      const paths = tempPaths();
      const { submitted } = submitApproved(paths, exampleSource());
      const imported = path.join(submitted.runDir, "steps/import/attempt-1/structure.pdb");
      const tamper = crashAtFinish(99, (call) => {
        if (call === 1) fs.appendFileSync(imported, "REMARK tampered after commit\n");
      });
      await expect(executeWorkflowRun(submitted.runId, { paths })).rejects.toMatchObject({
        code: "WORKFLOW_ARTIFACT_DAMAGED",
      });
      tamper.mockRestore();
      expect(attempts(paths, submitted.runId).map((attempt) => [attempt.stepId, attempt.status])).toEqual([
        ["import", "succeeded"],
        ["analyze", "pending"],
      ]);
      expect((await getWorkflowArtifacts(submitted.runId, { paths })).filter((a) => a.producerStepId === "analyze")).toEqual([]);
    });
  });

  describe("ownership", () => {
    it("stops without marking another owner's run when ownership is lost mid-run", async () => {
      const paths = tempPaths();
      const { submitted } = submitApproved(paths, exampleSource());
      const original = WorkflowStore.prototype.finishAttempt;
      vi.spyOn(WorkflowStore.prototype, "finishAttempt").mockImplementation(function (this: WorkflowStore, ...args) {
        const other = WorkflowStore.open(paths);
        try {
          other.markInterrupted(submitted.runId);
          expect(
            other.acquireRun(submitted.runId, { id: "other-owner", pid: process.pid, host: os.hostname() }).acquired,
          ).toBe(true);
        } finally {
          other.close();
        }
        return original.apply(this, args);
      });

      await expect(executeWorkflowRun(submitted.runId, { paths })).rejects.toMatchObject({ code: "WORKFLOW_OWNER_LOST" });
      vi.restoreAllMocks();
      const view = getWorkflowStatus(submitted.runId, { paths });
      expect(view.run).toMatchObject({ status: "running", ownerId: "other-owner" });
      expect(view.artifacts).toEqual([]);
    });

    it("treats an owner on another host as alive and explains why in the error", async () => {
      const paths = tempPaths();
      const { submitted } = submitApproved(paths, exampleSource());
      const store = WorkflowStore.open(paths);
      try {
        expect(store.acquireRun(submitted.runId, { id: "remote", pid: 4242, host: "another-host.invalid" }).acquired).toBe(true);
      } finally {
        store.close();
      }
      await expect(resumeWorkflowRun(submitted.runId, { paths })).rejects.toMatchObject({
        code: "WORKFLOW_OWNER_BUSY",
        message: expect.stringContaining("another host"),
      });
      await expect(executeWorkflowRun(submitted.runId, { paths })).rejects.toMatchObject({
        code: "WORKFLOW_OWNER_BUSY",
        message: expect.stringContaining("another-host.invalid"),
      });
      expect(getWorkflowStatus(submitted.runId, { paths }).run.ownerId).toBe("remote");
    });
  });

  describe("cache", () => {
    function cacheFiles(paths: TempPaths): string[] {
      const root = path.join(paths.cache, "workflows");
      return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, encoding: "utf8" }) : [];
    }

    it("recomputes when the input hash changes", async () => {
      const paths = tempPaths();
      const changed = path.join(paths.home, "changed.pdb");
      fs.writeFileSync(changed, `REMARK   9 variant\n${fs.readFileSync(FIXTURE, "utf8")}`);
      await approvedRun(paths, exampleSource());
      const second = await approvedRun(paths, exampleSource(), { structure: changed });
      expect(second.summary.steps.map((step) => step.status)).toEqual(["succeeded", "succeeded"]);
    });

    it("recomputes when caching is disabled", async () => {
      const paths = tempPaths();
      const source = exampleSource();
      expect(source).toContain("cache: true");
      await approvedRun(paths, source);
      const second = await approvedRun(paths, source.replace("cache: true", "cache: false"));
      expect(second.summary.steps.map((step) => step.status)).toEqual(["succeeded", "succeeded"]);
    });

    it("recomputes a corrupt cache entry, writes cache files atomically, and isolates run copies", async () => {
      const paths = tempPaths();
      const first = await approvedRun(paths, exampleSource());
      expect(cacheFiles(paths).filter((name) => name.includes(".tmp-"))).toEqual([]);

      // A run's own copy can be damaged without touching the cache or another run.
      fs.appendFileSync(path.join(first.submitted.runDir, first.summary.artifacts[0]!.relativePath), "x");
      const second = await approvedRun(paths, exampleSource());
      expect(second.summary.steps.map((step) => step.status)).toEqual(["cached", "cached"]);
      expect((await getWorkflowArtifacts(second.submitted.runId, { paths })).every((artifact) => artifact.verified)).toBe(true);

      const cacheRoot = path.join(paths.cache, "workflows");
      for (const name of fs.readdirSync(cacheRoot, { recursive: true, encoding: "utf8" })) {
        const file = path.join(cacheRoot, name);
        if (fs.statSync(file).isFile()) fs.appendFileSync(file, "corrupt");
      }
      const third = await approvedRun(paths, exampleSource());
      expect(third.summary.status).toBe("succeeded");
      expect(third.summary.steps.map((step) => step.status)).toEqual(["succeeded", "succeeded"]);
      expect(cacheFiles(paths).filter((name) => name.includes(".tmp-"))).toEqual([]);
    });
  });

  describe("Boltz bridge", () => {
    it("renders a single-chain one-sample job and links the verified CIF to analysis", async () => {
      const paths = tempPaths();
      let jobText = "";
      let args: string[] = [];
      const { execute } = boltzRun(paths, {
        runtimeProvider: boltzProvider((request) => {
          args = request.args;
          jobText = fs.readFileSync(request.args[1]!, "utf8");
          writeBoltzOutputs(request);
        }),
      });
      const summary = await execute();

      expect(summary.status, JSON.stringify(summary.error)).toBe("succeeded");
      expect(jobText).toContain(SEQUENCE);
      expect(args).toEqual(expect.arrayContaining(["--diffusion_samples", "1"]));
      expect(summary.steps.map((step) => [step.id, step.status])).toEqual([
        ["predict", "succeeded"],
        ["analyze", "succeeded"],
      ]);
      expect(summary.artifacts.map((artifact) => [artifact.producerStepId, artifact.type, artifact.format])).toEqual([
        ["predict", "protein_structure", "mmcif"],
        ["analyze", "json", "json"],
      ]);
      const store = WorkflowStore.open(paths);
      try {
        const childRunId = store.latestAttempt(summary.runId, "predict")?.outputs?.childRunId;
        expect(childRunId).toEqual(expect.any(String));
        expect(summary.steps.find((step) => step.id === "predict")?.childRunId).toBe(childRunId);
        expect(summary.steps.find((step) => step.id === "analyze")?.childRunId).toBeUndefined();
      } finally {
        store.close();
      }
    }, 20000);

    const malformed: Array<[string, (result: { record: { outputs: Array<Record<string, unknown>> } }, outside: string) => void]> = [
      ["zero structures entries", (result) => void (result.record.outputs = result.record.outputs.filter((o) => o["id"] !== "structures"))],
      [
        "multiple structures entries",
        (result) => void result.record.outputs.push({ ...result.record.outputs.find((o) => o["id"] === "structures")! }),
      ],
      ["a bad output hash", (result) => void (result.record.outputs.find((o) => o["id"] === "structures")!["sha256"] = "0".repeat(64))],
      [
        "an out-of-root path",
        (result, outside) => {
          const entry = result.record.outputs.find((o) => o["id"] === "structures")!;
          fs.writeFileSync(outside, proteinCif());
          entry["path"] = outside;
          entry["sha256"] = digestFile(outside);
        },
      ],
    ];

    it.each(malformed)("blocks downstream execution on %s", async (_name, mutate) => {
      const paths = tempPaths();
      modelHook.mutate = (result) => mutate(result, path.join(paths.home, "outside.cif"));
      const { execute } = boltzRun(paths, { runtimeProvider: boltzProvider() });
      const summary = await execute();

      expect(summary.status).toBe("failed");
      expect(summary.error?.code).toBe("WORKFLOW_MODEL_OUTPUT_INVALID");
      expect(summary.steps.map((step) => [step.id, step.status])).toEqual([
        ["predict", "failed"],
        ["analyze", "skipped"],
      ]);
      expect(summary.artifacts).toEqual([]);
    }, 20000);

    it("records a preflight rejection as a step failure and skips dependents", async () => {
      const paths = tempPaths();
      modelHook.throwError = new MoldeskError({
        code: "MODEL_PREFLIGHT_REJECTED",
        message: "Boltz preflight rejected the job.",
        remediation: "Fix the environment.",
      });
      const { execute } = boltzRun(paths, { runtimeProvider: boltzProvider() });
      const summary = await execute();

      expect(summary.status).toBe("failed");
      expect(summary.error).toMatchObject({ code: "MODEL_PREFLIGHT_REJECTED" });
      expect(summary.error?.message).toContain('Step "predict"');
      expect(summary.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
    });

    it("records a failed returned RunModelResult with its child run and skips dependents", async () => {
      const paths = tempPaths();
      const { execute } = boltzRun(paths, {
        runtimeProvider: fakeProvider((request) => ({
          exitCode: 1,
          stdoutPath: path.join(request.cwd, "stdout.log"),
          stderrPath: path.join(request.cwd, "stderr.log"),
        })),
      });
      const summary = await execute();

      expect(summary.status).toBe("failed");
      expect(summary.error?.code).toBe("WORKFLOW_MODEL_FAILED");
      expect(summary.error?.message).toMatch(/child run /);
      expect(summary.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
    });

    it("publishes nothing and starts no later step when cancelled during a model step", async () => {
      const paths = tempPaths();
      let runId = "";
      const { submitted, execute } = boltzRun(paths, {
        runtimeProvider: boltzProvider(async (request) => {
          writeBoltzOutputs(request);
          cancelWorkflowRun(runId, { paths });
          // Hold the fake model open until the executor's cancel poll aborts the signal.
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve();
            else request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }),
      });
      runId = submitted.runId;
      const summary = await execute();

      expect(summary.status).toBe("cancelled");
      expect(summary.steps.map((step) => [step.id, step.status])).toEqual([
        ["predict", "cancelled"],
        ["analyze", "skipped"],
      ]);
      expect(summary.artifacts).toEqual([]);
      expect(attempts(paths, runId).filter((attempt) => attempt.stepId === "analyze")).toHaveLength(1);
    }, 20000);

    it("does not resume an in-flight model attempt or call the runtime again", async () => {
      const paths = tempPaths();
      let calls = 0;
      const provider = boltzProvider(() => {
        calls += 1;
      });
      const { submitted } = boltzRun(paths, { runtimeProvider: provider });
      const store = WorkflowStore.open(paths);
      try {
        const owner = { id: "dead-owner", pid: 2147483646, host: os.hostname() };
        store.acquireRun(submitted.runId, owner);
        store.beginAttempt(store.latestAttempt(submitted.runId, "predict")!.attemptId, owner);
      } finally {
        store.close();
      }
      await expect(resumeWorkflowRun(submitted.runId, { paths, runtimeProvider: provider })).rejects.toMatchObject({
        code: "WORKFLOW_MODEL_ATTEMPT_UNRESOLVED",
      });
      expect(calls).toBe(0);
    });
  });
});

function digestFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
