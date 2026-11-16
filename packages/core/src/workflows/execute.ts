import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMoldeskPaths, isWithinRoot, type MoldeskPaths, type RuntimeProvider } from "@moldesk/runtime";
import { analyzeStructureFile } from "../analysis/analyze.js";
import { MOLSTAR_VERSION, parseStructure } from "../analysis/molstar-model.js";
import { readStructureInput } from "../analysis/structure-input.js";
import { MoldeskError } from "../errors.js";
import { digest, sha256File } from "../hash.js";
import { runModel, type RunModelResult } from "../run.js";
import { VERSION } from "../version.js";
import {
  resolveWorkflowModelRequirement,
  type WorkflowModelRequirement,
  type WorkflowPlan,
  type WorkflowPlanStep,
  type WorkflowResolvedInput,
} from "./compiler.js";
import { buildBoltzMonomerInput } from "./operations.js";
import {
  WorkflowStore,
  type RunOwner,
  type WorkflowArtifactRecord,
  type WorkflowAttemptOutputs,
  type WorkflowAttemptRecord,
  type WorkflowCacheFile,
  type NewWorkflowArtifact,
  type WorkflowErrorInfo,
  type WorkflowEventRecord,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowStepOutput,
  type WorkflowStepStatus,
} from "./store.js";

export interface WorkflowStageInput extends WorkflowStepOutput {
  value?: string;
}

export interface WorkflowExecutionOptions {
  paths?: MoldeskPaths;
  signal?: AbortSignal;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Injected for tests and for future non-Python runtimes. */
  runtimeProvider?: RuntimeProvider;
}

export interface SubmittedWorkflowRun {
  runId: string;
  planId: string;
  duplicate: boolean;
  runDir: string;
}

export interface WorkflowStepSummary {
  id: string;
  uses: string;
  status: WorkflowStepStatus;
  attempt: number;
  error?: WorkflowErrorInfo;
  outputs?: Record<string, WorkflowStepOutput>;
  /** The child model run behind a model step's attempt, for its logs and full outputs. */
  childRunId?: string;
}

export interface WorkflowRunSummary {
  runId: string;
  planId: string;
  status: WorkflowRunStatus;
  steps: WorkflowStepSummary[];
  artifacts: WorkflowArtifactRecord[];
  events: WorkflowEventRecord[];
  error?: WorkflowErrorInfo;
  runDir: string;
}

export interface WorkflowArtifactView extends WorkflowArtifactRecord {
  path: string;
  verified: boolean;
}

export interface WorkflowStatusView {
  run: WorkflowRunRecord;
  steps: WorkflowStepSummary[];
  artifacts: WorkflowArtifactRecord[];
  events: WorkflowEventRecord[];
  runDir: string;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function workflowError(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

function cancellationError(): MoldeskError {
  return workflowError(
    "WORKFLOW_RUN_CANCELLED",
    "The workflow run was cancelled before outputs were published.",
    "Resume the run when ready.",
  );
}

export function workflowRunDirectory(paths: MoldeskPaths, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw workflowError("WORKFLOW_RUN_NOT_FOUND", `Invalid workflow run ID "${runId}".`, "Check the run ID.");
  }
  return path.join(paths.runs, "workflows", runId);
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

function errorInfo(error: unknown, fallbackCode: string): WorkflowErrorInfo {
  if (error instanceof MoldeskError) return { code: error.code, message: error.message };
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

/** Rechecks the installed model binding against the plan before any paid/slow work starts. */
function verifyModelRequirement(planned: WorkflowModelRequirement, paths: MoldeskPaths): void {
  const resolution = resolveWorkflowModelRequirement(planned.name, paths);
  const current = resolution.requirement;
  if (!current || resolution.diagnostics.length > 0) {
    throw workflowError(
      "WORKFLOW_MODEL_INSTALLATION_MISMATCH",
      resolution.diagnostics[0]?.message ?? `${planned.name} is no longer available.`,
      "Reinstall the matching model, then plan and approve the workflow again.",
      { diagnostics: resolution.diagnostics },
    );
  }
  if (
    current.installationId !== planned.installationId ||
    current.manifestSha256 !== planned.manifestSha256 ||
    current.runtime.fingerprint !== planned.runtime.fingerprint ||
    current.environmentFingerprint !== planned.environmentFingerprint
  ) {
    throw workflowError(
      "WORKFLOW_MODEL_INSTALLATION_MISMATCH",
      `The installed ${planned.name} environment changed after planning.`,
      "Plan and approve the workflow again against the current installation.",
    );
  }
}

function atomicWrite(file: string, contents: string): void {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function extensionFor(format: string | undefined): string {
  if (format === "pdb") return ".pdb";
  if (format === "mmcif") return ".cif";
  if (format === "json") return ".json";
  return ".txt";
}

function stageInputRelativePath(name: string, input: WorkflowResolvedInput): string {
  return path.join("inputs", `${name}${extensionFor(input.format)}`);
}

function stagedInputsPath(runDir: string): string {
  return path.join(runDir, "inputs.json");
}

function stageRunDirectory(
  runDir: string,
  planRecord: { source: string; plan: WorkflowPlan },
): Record<string, WorkflowStageInput> {
  fs.mkdirSync(runDir, { recursive: true });
  atomicWrite(path.join(runDir, "workflow.yaml"), planRecord.source);
  atomicWrite(path.join(runDir, "plan.json"), `${JSON.stringify(planRecord.plan, null, 2)}\n`);
  const staged: Record<string, WorkflowStageInput> = {};

  for (const [name, input] of Object.entries(planRecord.plan.inputs)) {
    const relativePath = stageInputRelativePath(name, input);
    const target = path.join(runDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (input.type === "structure_file") {
      fs.copyFileSync(input.value, target);
      const sha256 = sha256FileSync(target);
      if (sha256 !== input.sha256) {
        throw workflowError(
          "WORKFLOW_INPUT_CHANGED",
          `Workflow input "${name}" changed after planning.`,
          "Plan the workflow again with the current file.",
        );
      }
      staged[name] = {
        type: input.type,
        format: input.format,
        relativePath,
        sha256,
        sizeBytes: fs.statSync(target).size,
      };
    } else {
      fs.writeFileSync(target, input.value, { mode: 0o600 });
      const sha256 = sha256FileSync(target);
      if (sha256 !== input.sha256) {
        throw workflowError(
          "WORKFLOW_INPUT_CHANGED",
          `Workflow input "${name}" changed after planning.`,
          "Plan the workflow again with the current value.",
        );
      }
      staged[name] = {
        type: input.type,
        relativePath,
        sha256,
        sizeBytes: fs.statSync(target).size,
        value: input.value,
      };
    }
  }

  atomicWrite(stagedInputsPath(runDir), `${JSON.stringify(staged, null, 2)}\n`);
  return staged;
}

function sha256FileSync(file: string): string {
  // Staging is bounded by the planner's input limits; a sync hash keeps staging atomic and simple.
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function loadStagedInputs(runDir: string): Record<string, WorkflowStageInput> {
  const file = stagedInputsPath(runDir);
  let staged: Record<string, WorkflowStageInput>;
  try {
    staged = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, WorkflowStageInput>;
  } catch {
    throw workflowError(
      "WORKFLOW_RUN_STATE_DAMAGED",
      `Workflow run state is missing or unreadable: ${file}.`,
      "Start a new run from a fresh approval.",
    );
  }
  return staged;
}

async function verifyManagedFile(
  runDir: string,
  relativePath: string,
  expected: { sha256: string; sizeBytes: number },
): Promise<string> {
  const root = path.resolve(runDir);
  const absolute = path.resolve(root, relativePath);
  const outside = (): MoldeskError =>
    workflowError(
      "WORKFLOW_ARTIFACT_OUTSIDE_RUN",
      `Artifact escapes the run directory: ${relativePath}.`,
      "Start a new run from a fresh approval; do not reuse this run directory.",
    );
  if (!isWithinRoot(root, absolute)) throw outside();
  const damaged = (what: string): MoldeskError =>
    workflowError(
      "WORKFLOW_ARTIFACT_DAMAGED",
      `Artifact ${what}: ${relativePath}.`,
      "Start a new run from a fresh approval; this run's outputs can no longer be trusted.",
    );
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    throw damaged("is missing");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw damaged("is not a regular file");
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = fs.realpathSync(root);
    realFile = fs.realpathSync(absolute);
  } catch {
    throw damaged("is missing");
  }
  if (!isWithinRoot(realRoot, realFile)) throw outside();
  if (stat.size !== expected.sizeBytes) throw damaged("size changed");
  const sha256 = await sha256File(absolute);
  if (sha256 !== expected.sha256) throw damaged("hash changed");
  return absolute;
}

function outputPath(runDir: string, output: WorkflowStepOutput): string {
  return path.resolve(runDir, output.relativePath);
}

function cacheDirectory(paths: MoldeskPaths, cacheKey: string): string {
  return path.join(paths.cache, "workflows", cacheKey);
}

function cacheKeyFor(step: WorkflowPlanStep, bindings: Record<string, WorkflowStageInput>): string {
  return digest({
    schemaVersion: 1,
    operation: step.uses,
    operationVersion: step.operationVersion,
    moldeskVersion: VERSION,
    analysisDependency: { name: "molstar", version: MOLSTAR_VERSION },
    bindings: step.bindings.map((binding) => ({
      input: binding.input,
      type: binding.type,
      sha256: bindings[binding.input]!.sha256,
      format: bindings[binding.input]!.format ?? null,
    })),
    outputs: step.outputs,
  });
}

/**
 * Copies and hashes an output into the attempt directory. It does not touch the database: the
 * artifact rows are inserted by `finishAttempt` in the attempt's terminal-status transaction.
 */
async function stageFile(
  runDir: string,
  attemptDir: string,
  outputName: string,
  type: WorkflowStepOutput["type"],
  format: string,
  sourceFile: string,
  extension = extensionFor(format),
): Promise<WorkflowStepOutput> {
  fs.mkdirSync(attemptDir, { recursive: true });
  const destination = path.join(attemptDir, `${outputName}${extension}`);
  if (path.resolve(destination) !== path.resolve(sourceFile)) fs.copyFileSync(sourceFile, destination);
  const sha256 = await sha256File(destination);
  const sizeBytes = fs.statSync(destination).size;
  const relativePath = path.relative(runDir, destination);
  return { type, format, relativePath, sha256, sizeBytes };
}

function artifactsFor(runId: string, stepId: string, outputs: Record<string, WorkflowStepOutput>): NewWorkflowArtifact[] {
  return Object.entries(outputs).map(([name, output]) => ({
    id: `${runId}:${stepId}:${name}`,
    runId,
    stepId,
    producerStepId: stepId,
    type: output.type,
    format: output.format ?? "unknown",
    relativePath: output.relativePath,
    sha256: output.sha256,
    sizeBytes: output.sizeBytes,
  }));
}

/** Verifies every step-produced input (hash, size, containment, regular file) before it is consumed. */
async function verifyUpstreamBindings(
  step: WorkflowPlanStep,
  bindings: Record<string, WorkflowStageInput>,
  runDir: string,
): Promise<void> {
  for (const binding of step.bindings) {
    if (binding.source.kind === "input") continue;
    const produced = bindings[binding.input]!;
    try {
      await verifyManagedFile(runDir, produced.relativePath, produced);
    } catch (error) {
      if (error instanceof MoldeskError) {
        throw workflowError(
          error.code,
          `Step "${step.id}" cannot consume ${binding.source.stepId}.${binding.source.output}: ${error.message}`,
          error.remediation ?? "Start a new run from a fresh approval.",
        );
      }
      throw error;
    }
  }
}

function resolveBindings(
  step: WorkflowPlanStep,
  externalInputs: Record<string, WorkflowStageInput>,
  outputsByStep: Map<string, Record<string, WorkflowStepOutput>>,
): Record<string, WorkflowStageInput> {
  const resolved: Record<string, WorkflowStageInput> = {};
  for (const binding of step.bindings) {
    if (binding.source.kind === "input") {
      const input = externalInputs[binding.source.name];
      if (!input) {
        throw workflowError(
          "WORKFLOW_RUN_STATE_DAMAGED",
          `Workflow input "${binding.source.name}" is missing from the run snapshot.`,
          "Start a new run from a fresh approval.",
        );
      }
      resolved[binding.input] = input;
    } else {
      const produced = outputsByStep.get(binding.source.stepId)?.[binding.source.output];
      if (!produced) {
        throw workflowError(
          "WORKFLOW_MISSING_OUTPUT",
          `Step "${step.id}" needs ${binding.source.stepId}.${binding.source.output}, which was not produced.`,
          "Fix the failing upstream step, then resume the run.",
        );
      }
      resolved[binding.input] = produced;
    }
  }
  return resolved;
}

function inputPath(bindings: Record<string, WorkflowStageInput>, port: string, runDir: string): string {
  const value = bindings[port];
  if (!value) {
    throw workflowError(
      "WORKFLOW_MISSING_OUTPUT",
      `Operation input "${port}" was not resolved.`,
      "Fix the workflow bindings and plan again.",
    );
  }
  return outputPath(runDir, value);
}

function hasProteinChain(parsed: Awaited<ReturnType<typeof parseStructure>>): boolean {
  return parsed.chains.some((chain) => chain.residues.some((residue) => residue.kind === "protein"));
}

async function executeImport(
  runDir: string,
  step: WorkflowPlanStep,
  attemptDir: string,
  bindings: Record<string, WorkflowStageInput>,
  signal: AbortSignal,
): Promise<WorkflowAttemptOutputs> {
  const file = inputPath(bindings, "file", runDir);
  const bound = bindings["file"]!;
  const input = readStructureInput(file);
  if (input.sha256 !== bound.sha256) {
    throw workflowError(
      "WORKFLOW_ARTIFACT_DAMAGED",
      `Structure input hash changed for step "${step.id}".`,
      "Start a new run from a fresh approval.",
    );
  }
  const parsed = await parseStructure(input);
  if (!hasProteinChain(parsed)) {
    throw workflowError(
      "WORKFLOW_STRUCTURE_NO_PROTEIN",
      `Structure for step "${step.id}" contains no protein chain.`,
      "Import a PDB/mmCIF file with at least one protein chain.",
    );
  }
  if (signal.aborted) throw cancellationError();
  const output = await stageFile(
    runDir,
    attemptDir,
    "structure",
    "protein_structure",
    input.format,
    file,
    extensionFor(input.format),
  );
  return { outputs: { structure: output } };
}

async function executeAnalysis(
  runDir: string,
  attemptDir: string,
  bindings: Record<string, WorkflowStageInput>,
  signal: AbortSignal,
): Promise<WorkflowAttemptOutputs> {
  const structure = inputPath(bindings, "structure", runDir);
  const envelope = await analyzeStructureFile(structure);
  if (signal.aborted) throw cancellationError();
  fs.mkdirSync(attemptDir, { recursive: true });
  const reportPath = path.join(attemptDir, "report.json");
  atomicWrite(reportPath, `${JSON.stringify(envelope, null, 2)}\n`);
  const output = await stageFile(
    runDir,
    attemptDir,
    "report",
    "json",
    "json",
    reportPath,
    ".json",
  );
  return { outputs: { report: output } };
}

async function executeBoltz(
  paths: MoldeskPaths,
  runDir: string,
  step: WorkflowPlanStep,
  attemptDir: string,
  bindings: Record<string, WorkflowStageInput>,
  options: WorkflowExecutionOptions,
  signal: AbortSignal,
): Promise<WorkflowAttemptOutputs> {
  const sequence = bindings["sequence"]?.value;
  if (!sequence) {
    throw workflowError(
      "WORKFLOW_MISSING_OUTPUT",
      `Step "${step.id}" has no protein sequence binding.`,
      "Bind the sequence input to the Boltz step.",
    );
  }
  const job = buildBoltzMonomerInput(sequence);
  const jobDir = path.join(attemptDir, "job");
  fs.mkdirSync(jobDir, { recursive: true });
  const jobPath = path.join(jobDir, "protein.yaml");
  atomicWrite(jobPath, `${JSON.stringify(job, null, 2)}\n`);

  const result: RunModelResult = await runModel("boltz", jobPath, {
    paths,
    runtime: "python",
    params: { diffusion_samples: "1" },
    signal,
    onLog: options.onLog,
    runtimeProvider: options.runtimeProvider,
    visualize: false,
  });

  if (result.status === "cancelled") {
    throw workflowError("WORKFLOW_RUN_CANCELLED", "Boltz prediction was cancelled.", "Resume the run when ready.");
  }
  if (result.status !== "succeeded") {
    throw workflowError(
      "WORKFLOW_MODEL_FAILED",
      `${result.record.error?.message ?? "Boltz prediction failed."} (child run ${result.record.id})`,
      `Inspect the child model run ${result.record.id} for logs and retry.`,
      { childRunId: result.record.id },
    );
  }

  const structures = result.record.outputs.filter((output) => output.id === "structures");
  if (structures.length !== 1) {
    throw workflowError(
      "WORKFLOW_MODEL_OUTPUT_INVALID",
      `Boltz run ${result.record.id} produced ${structures.length} structure outputs; exactly one is required.`,
      "Retry the model step with a single-chain job.",
    );
  }
  const structure = structures[0]!;
  if (path.extname(structure.path).toLowerCase() !== ".cif") {
    throw workflowError(
      "WORKFLOW_MODEL_OUTPUT_INVALID",
      `Boltz structure output is not mmCIF: ${structure.path}.`,
      "Retry the model step; the copied structure must be a .cif file.",
    );
  }
  const childOutputDir = path.join(result.record.command.cwd, "output");
  const childPath = path.resolve(structure.path);
  if (!isWithinRoot(path.resolve(childOutputDir), childPath)) {
    throw workflowError(
      "WORKFLOW_MODEL_OUTPUT_INVALID",
      `Boltz structure output is outside the child run's output directory: ${structure.path}.`,
      "Re-run Boltz; the output path must stay inside its managed run.",
    );
  }
  const sha256 = await sha256File(childPath);
  if (sha256 !== structure.sha256) {
    throw workflowError(
      "WORKFLOW_MODEL_OUTPUT_INVALID",
      `Boltz structure output hash does not match its run record: ${structure.path}.`,
      "Re-run Boltz; the child output is damaged.",
    );
  }

  const output = await stageFile(
    runDir,
    attemptDir,
    "structure",
    "protein_structure",
    "mmcif",
    childPath,
    ".cif",
  );
  return {
    outputs: { structure: output },
    childRunId: result.record.id,
    fingerprints: {
      installationFingerprint: result.record.installationFingerprint,
      manifestSha256: result.record.manifestSha256,
    },
  };
}

function latestStatusByStep(store: WorkflowStore, runId: string, stepIds: readonly string[]): Map<string, WorkflowAttemptRecord> {
  const latest = new Map<string, WorkflowAttemptRecord>();
  for (const stepId of stepIds) {
    const attempt = store.latestAttempt(runId, stepId);
    if (attempt) latest.set(stepId, attempt);
  }
  return latest;
}

function summaryFor(store: WorkflowStore, paths: MoldeskPaths, run: WorkflowRunRecord, plan: WorkflowPlan): WorkflowRunSummary {
  const attempts = store.listAttempts(run.runId);
  const latest = new Map<string, WorkflowAttemptRecord>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.stepId);
    if (!current || current.attemptNumber < attempt.attemptNumber) latest.set(attempt.stepId, attempt);
  }
  const steps = plan.steps.map((step) => {
    const attempt = latest.get(step.id);
    return {
      id: step.id,
      uses: step.uses,
      status: attempt?.status ?? "pending",
      attempt: attempt?.attemptNumber ?? 0,
      ...(attempt?.error ? { error: attempt.error } : {}),
      ...(attempt?.outputs ? { outputs: attempt.outputs.outputs } : {}),
      ...(attempt?.outputs?.childRunId ? { childRunId: attempt.outputs.childRunId } : {}),
    } satisfies WorkflowStepSummary;
  });
  return {
    runId: run.runId,
    planId: run.planId,
    status: run.status,
    steps,
    artifacts: store.listArtifacts(run.runId),
    events: store.listEvents(run.runId),
    ...(run.error ? { error: run.error } : {}),
    runDir: workflowRunDirectory(paths, run.runId),
  };
}

function writeManifest(store: WorkflowStore, paths: MoldeskPaths, runId: string): void {
  const run = store.getRun(runId);
  if (!run) return;
  const planRecord = store.getPlan(run.planId);
  if (!planRecord) return;
  const summary = summaryFor(store, paths, run, planRecord.plan);
  atomicWrite(
    path.join(summary.runDir, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: summary.runId,
        planId: summary.planId,
        status: summary.status,
        steps: summary.steps,
        artifacts: summary.artifacts,
      },
      null,
      2,
    )}\n`,
  );
}

function ownerBusyError(store: WorkflowStore, run: WorkflowRunRecord): MoldeskError {
  if (store.isOwnerOnForeignHost(run)) {
    return workflowError(
      "WORKFLOW_OWNER_BUSY",
      `Workflow run "${run.runId}" is owned by process ${run.ownerPid} on another host (${run.ownerHost}); its liveness cannot be checked from this machine.`,
      "Check or stop the executor on that host, then try again. Use `moldesk workflow status` to follow the run.",
    );
  }
  return workflowError(
    "WORKFLOW_OWNER_BUSY",
    `Workflow run "${run.runId}" is owned by another live process.`,
    "Use `moldesk workflow status` to follow it, or stop that process first.",
  );
}

/**
 * Stages the resolved inputs and atomically consumes the approval. A duplicate submission
 * returns the run created by the first caller and never starts a second executor.
 */
export function submitWorkflowRun(
  approvalId: string,
  options: { paths?: MoldeskPaths } = {},
): SubmittedWorkflowRun {
  const paths = options.paths ?? getMoldeskPaths();
  const store = WorkflowStore.open(paths);
  try {
    const approval = store.getApproval(approvalId);
    if (!approval) {
      throw workflowError(
        "WORKFLOW_APPROVAL_NOT_FOUND",
        `Unknown approval "${approvalId}".`,
        "Approve the plan first with `moldesk workflow approve`.",
      );
    }
    if (approval.runId) {
      return {
        runId: approval.runId,
        planId: approval.planId,
        duplicate: true,
        runDir: workflowRunDirectory(paths, approval.runId),
      };
    }
    const planRecord = store.getPlan(approval.planId);
    if (!planRecord) {
      throw workflowError(
        "WORKFLOW_PLAN_NOT_FOUND",
        `Approval "${approvalId}" references unknown plan "${approval.planId}".`,
        "Plan the workflow again.",
      );
    }
    for (const requirement of planRecord.plan.requirements) {
      if (requirement.model) verifyModelRequirement(requirement.model, paths);
    }

    const runId = createRunId();
    const runDir = workflowRunDirectory(paths, runId);
    stageRunDirectory(runDir, planRecord);
    const claimed = store.claimRun(approvalId, runId, planRecord.plan.steps.map((step) => step.id));
    if (!claimed.created) {
      fs.rmSync(runDir, { recursive: true, force: true });
      return {
        runId: claimed.runId,
        planId: planRecord.plan.planId,
        duplicate: true,
        runDir: workflowRunDirectory(paths, claimed.runId),
      };
    }
    return { runId, planId: planRecord.plan.planId, duplicate: false, runDir };
  } finally {
    store.close();
  }
}

/**
 * Executes a claimed run in planned order. The CLI waits on this promise; Studio can call it
 * in the background and poll `getWorkflowStatus`.
 */
export async function executeWorkflowRun(
  runId: string,
  options: WorkflowExecutionOptions = {},
): Promise<WorkflowRunSummary> {
  const paths = options.paths ?? getMoldeskPaths();
  const store = WorkflowStore.open(paths);
  const owner: RunOwner = { id: randomUUID(), pid: process.pid, host: os.hostname() };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const cancelPoll = setInterval(() => {
    try {
      if (store.isCancelRequested(runId)) controller.abort();
    } catch {
      // The store may be closing; the execution loop still checks the signal.
    }
  }, 250);
  cancelPoll.unref?.();

  try {
    let run = store.getRun(runId);
    if (!run) {
      throw workflowError(
        "WORKFLOW_RUN_NOT_FOUND",
        `Unknown workflow run "${runId}".`,
        "Check the run ID and try again.",
      );
    }
    const planRecord = store.getPlan(run.planId);
    if (!planRecord) {
      throw workflowError(
        "WORKFLOW_PLAN_NOT_FOUND",
        `Run "${runId}" references unknown plan "${run.planId}".`,
        "Start a new run from a fresh plan.",
      );
    }
    if (run.status === "succeeded" || run.status === "cancelled") {
      return summaryFor(store, paths, run, planRecord.plan);
    }
    if (run.status === "running" && store.isOwnerAlive(run)) throw ownerBusyError(store, run);
    if (run.status === "running") store.markInterrupted(runId);

    const acquired = store.acquireRun(runId, owner);
    if (!acquired.acquired) {
      run = store.getRun(runId)!;
      if (run.status === "succeeded" || run.status === "cancelled") {
        return summaryFor(store, paths, run, planRecord.plan);
      }
      throw run.status === "running"
        ? ownerBusyError(store, run)
        : workflowError(
            "WORKFLOW_OWNER_BUSY",
            `Workflow run "${runId}" is already owned by another executor.`,
            "Use `moldesk workflow status` to follow it.",
          );
    }

    const runDir = workflowRunDirectory(paths, runId);
    const externalInputs = loadStagedInputs(runDir);
    const outputsByStep = new Map<string, Record<string, WorkflowStepOutput>>();
    let failure: WorkflowErrorInfo | undefined;
    let cancelled = false;
    let skippedFrom: number | undefined;

    for (const [index, step] of planRecord.plan.steps.entries()) {
      if (skippedFrom !== undefined) {
        store.skipStep(runId, step.id, "An earlier step did not complete.", owner.id);
        continue;
      }
      if (controller.signal.aborted || store.isCancelRequested(runId)) {
        cancelled = true;
        store.skipStep(runId, step.id, "The run was cancelled.", owner.id);
        skippedFrom = index;
        continue;
      }

      const previous = store.latestAttempt(runId, step.id);
      if (previous && (previous.status === "succeeded" || previous.status === "cached") && previous.outputs) {
        const outputs: Record<string, WorkflowStepOutput> = {};
        try {
          for (const [name, output] of Object.entries(previous.outputs.outputs)) {
            await verifyManagedFile(runDir, output.relativePath, output);
            outputs[name] = output;
          }
        } catch (error) {
          if (error instanceof MoldeskError && error.code === "WORKFLOW_ARTIFACT_OUTSIDE_RUN") throw error;
          throw workflowError(
            "WORKFLOW_ARTIFACT_DAMAGED",
            `Step "${step.id}" completed earlier but its output is damaged: ${errorInfo(error, "WORKFLOW_ARTIFACT_DAMAGED").message}`,
            `Resume will not reuse or recompute damaged outputs. Restore the files under ${runDir} or start a new run from a fresh approval.`,
            { stepId: step.id },
          );
        }
        outputsByStep.set(step.id, outputs);
        continue;
      }
      if (previous?.status === "running") {
        if (step.uses === "moldesk/boltz@1") {
          throw workflowError(
            "WORKFLOW_MODEL_ATTEMPT_UNRESOLVED",
            `Step "${step.id}" has an unresolved in-flight Boltz attempt (child run may still be live).`,
            `Inspect \`moldesk workflow status ${runId}\` and the child run logs before retrying.`,
          );
        }
        // A CPU attempt left running by a dead owner is closed before a new attempt is created.
        store.finishAttempt(previous.attemptId, "failed", {
          error: {
            code: "WORKFLOW_ATTEMPT_INTERRUPTED",
            message: "The executor stopped before this attempt finished; it was restarted as a new attempt.",
          },
          ownerId: owner.id,
        });
      }

      const model = planRecord.plan.requirements.find((requirement) => requirement.stepId === step.id)?.model;
      if (model) verifyModelRequirement(model, paths);
      const bindings = resolveBindings(step, externalInputs, outputsByStep);
      await verifyUpstreamBindings(step, bindings, runDir);
      const reusePending = previous?.status === "pending";
      const attemptNumber = reusePending ? previous.attemptNumber : (previous?.attemptNumber ?? 0) + 1;
      const attemptDir = path.join(runDir, "steps", step.id, `attempt-${attemptNumber}`);
      fs.mkdirSync(attemptDir, { recursive: true });

      const isCacheable = planRecord.cacheEnabled && step.uses !== "moldesk/boltz@1";
      const cacheKey = isCacheable ? cacheKeyFor(step, bindings) : undefined;

      const attempt: WorkflowAttemptRecord = reusePending
        ? store.beginAttempt(previous.attemptId, owner)
        : store.createAttempt(runId, step.id, attemptNumber, owner);

      if (controller.signal.aborted || store.isCancelRequested(runId)) {
        store.finishAttempt(attempt.attemptId, "cancelled", {
          error: { code: "WORKFLOW_RUN_CANCELLED", message: "The run was cancelled before the step started." },
          ownerId: owner.id,
        });
        cancelled = true;
        skippedFrom = index;
        continue;
      }

      if (cacheKey) {
        const cached = store.getCache(cacheKey);
        if (cached) {
          let outputs: Record<string, WorkflowStepOutput> | undefined;
          try {
            const staged: Record<string, WorkflowStepOutput> = {};
            const cacheDir = cacheDirectory(paths, cacheKey);
            for (const file of cached.files) {
              const source = await verifyManagedFile(cacheDir, file.relativeName, file);
              const output = await stageFile(
                runDir,
                attemptDir,
                file.output,
                file.type,
                file.format,
                source,
                path.extname(file.relativeName),
              );
              if (output.sha256 !== file.sha256) throw new Error("cache copy hash mismatch");
              staged[file.output] = output;
            }
            outputs = staged;
          } catch {
            // Missing or corrupt cache entry: recompute below.
            outputs = undefined;
          }
          if (outputs) {
            const finished = store.finishAttempt(attempt.attemptId, "cached", {
              outputs: { outputs },
              cacheKey,
              artifacts: artifactsFor(runId, step.id, outputs),
              ownerId: owner.id,
            });
            if (finished.status === "cancelled") {
              cancelled = true;
              skippedFrom = index;
              continue;
            }
            outputsByStep.set(step.id, outputs);
            continue;
          }
        }
      }

      try {
        let result: WorkflowAttemptOutputs;
        if (step.uses === "moldesk/import-structure@1") {
          result = await executeImport(runDir, step, attemptDir, bindings, controller.signal);
        } else if (step.uses === "moldesk/structure-analysis@1") {
          result = await executeAnalysis(runDir, attemptDir, bindings, controller.signal);
        } else {
          result = await executeBoltz(paths, runDir, step, attemptDir, bindings, options, controller.signal);
        }
        if (controller.signal.aborted || store.isCancelRequested(runId)) {
          store.finishAttempt(attempt.attemptId, "cancelled", {
            error: {
              code: "WORKFLOW_RUN_CANCELLED",
              message: "The run was cancelled before outputs were published.",
            },
            ownerId: owner.id,
          });
          cancelled = true;
          skippedFrom = index;
          continue;
        }
        const finished = store.finishAttempt(attempt.attemptId, "succeeded", {
          outputs: result,
          cacheKey,
          artifacts: artifactsFor(runId, step.id, result.outputs),
          ownerId: owner.id,
        });
        if (finished.status === "cancelled") {
          cancelled = true;
          skippedFrom = index;
          continue;
        }
        outputsByStep.set(step.id, result.outputs);
        if (cacheKey) publishCache(store, paths, cacheKey, result.outputs, runDir);
      } catch (error) {
        const info = errorInfo(error, "WORKFLOW_STEP_FAILED");
        if (info.code === "WORKFLOW_OWNER_LOST") throw error;
        if (controller.signal.aborted || store.isCancelRequested(runId) || info.code === "WORKFLOW_RUN_CANCELLED") {
          cancelled = true;
          store.finishAttempt(attempt.attemptId, "cancelled", { error: info, ownerId: owner.id });
          skippedFrom = index;
        } else {
          failure = { code: info.code, message: `Step "${step.id}": ${info.message}` };
          store.finishAttempt(attempt.attemptId, "failed", { error: info, ownerId: owner.id });
          skippedFrom = index;
        }
      }
    }

    const status: WorkflowRunStatus = cancelled ? "cancelled" : failure ? "failed" : "succeeded";
    store.finishRun(runId, status, failure, owner.id);
    writeManifest(store, paths, runId);
    return summaryFor(store, paths, store.getRun(runId)!, planRecord.plan);
  } catch (error) {
    const info = errorInfo(error, "WORKFLOW_EXECUTION_FAILED");
    try {
      const current = store.getRun(runId);
      if (current?.status === "running" && current.ownerId === owner.id) {
        store.finishRun(runId, "interrupted", info, owner.id);
        writeManifest(store, paths, runId);
      }
    } catch {
      // Preserve the original error; the durable state can be inspected later.
    }
    throw error;
  } finally {
    clearInterval(cancelPoll);
    options.signal?.removeEventListener("abort", abort);
    store.close();
  }
}

function publishCache(
  store: WorkflowStore,
  paths: MoldeskPaths,
  cacheKey: string,
  outputs: Record<string, WorkflowStepOutput>,
  runDir: string,
): void {
  try {
    const directory = cacheDirectory(paths, cacheKey);
    fs.mkdirSync(directory, { recursive: true });
    const files: WorkflowCacheFile[] = [];
    for (const [output, value] of Object.entries(outputs)) {
      const relativeName = path.basename(value.relativePath);
      const destination = path.join(directory, relativeName);
      const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
      try {
        fs.copyFileSync(outputPath(runDir, value), temporary);
        if (sha256FileSync(temporary) !== value.sha256) throw new Error("cache copy hash mismatch");
        fs.renameSync(temporary, destination);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
      files.push({
        output,
        relativeName,
        type: value.type,
        format: value.format ?? "unknown",
        sha256: value.sha256,
        sizeBytes: value.sizeBytes,
      });
    }
    store.putCache(cacheKey, files);
  } catch {
    // A cache write must never turn a successful scientific step into a failure.
  }
}

/** Resumes an interrupted/failed run, reusing verified completed attempts. */
/**
 * Synchronous resume preconditions. Returns the summary of an already-succeeded run, or
 * undefined when execution should (re)start. Throws for unknown, cancelled, or owner-busy runs.
 */
function checkResumable(runId: string, paths: MoldeskPaths): WorkflowRunSummary | undefined {
  const store = WorkflowStore.open(paths);
  try {
    const run = store.getRun(runId);
    if (!run) {
      throw workflowError("WORKFLOW_RUN_NOT_FOUND", `Unknown workflow run "${runId}".`, "Check the run ID.");
    }
    if (run.status === "succeeded") {
      const plan = store.getPlan(run.planId);
      if (!plan) throw workflowError("WORKFLOW_PLAN_NOT_FOUND", "Plan record is missing.", "Start a new run.");
      return summaryFor(store, paths, run, plan.plan);
    }
    if (run.status === "cancelled") {
      throw workflowError(
        "WORKFLOW_RUN_CANCELLED",
        `Workflow run "${runId}" was cancelled.`,
        "Create a new approval to run the workflow again.",
      );
    }
    if (run.status === "running" && store.isOwnerAlive(run)) throw ownerBusyError(store, run);
    if (run.status === "running") store.markInterrupted(runId);
    return undefined;
  } finally {
    store.close();
  }
}

export async function resumeWorkflowRun(
  runId: string,
  options: WorkflowExecutionOptions = {},
): Promise<WorkflowRunSummary> {
  const done = checkResumable(runId, options.paths ?? getMoldeskPaths());
  return done ?? executeWorkflowRun(runId, options);
}

export interface StartedWorkflowResume {
  runId: string;
  /** Resolves when execution settles; rejects with the executor's failure. */
  done: Promise<WorkflowRunSummary>;
}

/**
 * Like `resumeWorkflowRun`, but the preconditions are checked synchronously, so an unknown,
 * cancelled, or owner-busy run throws here instead of inside the returned promise.
 */
export function startWorkflowResume(runId: string, options: WorkflowExecutionOptions = {}): StartedWorkflowResume {
  const finished = checkResumable(runId, options.paths ?? getMoldeskPaths());
  return { runId, done: finished ? Promise.resolve(finished) : executeWorkflowRun(runId, options) };
}

export function cancelWorkflowRun(runId: string, options: { paths?: MoldeskPaths } = {}): WorkflowRunRecord {
  const paths = options.paths ?? getMoldeskPaths();
  const store = WorkflowStore.open(paths);
  try {
    const before = store.getRun(runId);
    const run = store.requestCancel(runId);
    if (run.status === "cancelled" && before?.status !== "cancelled") {
      try {
        writeManifest(store, paths, runId);
      } catch {
        // The manifest is derived from committed records and can be regenerated.
      }
    }
    return run;
  } finally {
    store.close();
  }
}

export interface StartedWorkflowRun {
  runId: string;
  duplicate: boolean;
  /** Settles (never rejects) once background execution ends; already settled for a duplicate. */
  settled: Promise<void>;
}

/**
 * Submits an approval and, unless it was a duplicate, starts execution in the background and
 * returns the run ID immediately. Failures are recorded durably by the executor; the rejection
 * is routed to `onError` (default: stderr) so it is never unhandled.
 */
export function startWorkflowRun(
  approvalId: string,
  options: WorkflowExecutionOptions & { onError?: (error: unknown, runId: string) => void } = {},
): StartedWorkflowRun {
  const { onError, ...execution } = options;
  const submitted = submitWorkflowRun(approvalId, { paths: execution.paths });
  let settled: Promise<void> = Promise.resolve();
  if (!submitted.duplicate) {
    settled = executeWorkflowRun(submitted.runId, execution).then(
      () => undefined,
      (error: unknown) => {
        if (onError) onError(error, submitted.runId);
        else console.error(`Workflow run ${submitted.runId} stopped: ${errorInfo(error, "WORKFLOW_EXECUTION_FAILED").message}`);
      },
    );
  }
  return { runId: submitted.runId, duplicate: submitted.duplicate, settled };
}

export function getWorkflowStatus(runId: string, options: { paths?: MoldeskPaths } = {}): WorkflowStatusView {
  const paths = options.paths ?? getMoldeskPaths();
  const store = WorkflowStore.open(paths);
  try {
    const run = store.getRun(runId);
    if (!run) {
      throw workflowError("WORKFLOW_RUN_NOT_FOUND", `Unknown workflow run "${runId}".`, "Check the run ID.");
    }
    const planRecord = store.getPlan(run.planId);
    if (!planRecord) {
      throw workflowError("WORKFLOW_PLAN_NOT_FOUND", "Plan record is missing.", "Start a new run.");
    }
    const summary = summaryFor(store, paths, run, planRecord.plan);
    return {
      run,
      steps: summary.steps,
      artifacts: summary.artifacts,
      events: summary.events,
      runDir: summary.runDir,
    };
  } finally {
    store.close();
  }
}

export async function getWorkflowArtifacts(
  runId: string,
  options: { paths?: MoldeskPaths } = {},
): Promise<WorkflowArtifactView[]> {
  const paths = options.paths ?? getMoldeskPaths();
  const store = WorkflowStore.open(paths);
  try {
    const run = store.getRun(runId);
    if (!run) {
      throw workflowError("WORKFLOW_RUN_NOT_FOUND", `Unknown workflow run "${runId}".`, "Check the run ID.");
    }
    const runDir = workflowRunDirectory(paths, runId);
    const artifacts = store.listArtifacts(runId);
    const views: WorkflowArtifactView[] = [];
    for (const artifact of artifacts) {
      try {
        const absolute = await verifyManagedFile(runDir, artifact.relativePath, artifact);
        views.push({ ...artifact, path: absolute, verified: true });
      } catch {
        views.push({ ...artifact, path: path.resolve(runDir, artifact.relativePath), verified: false });
      }
    }
    return views;
  } finally {
    store.close();
  }
}
