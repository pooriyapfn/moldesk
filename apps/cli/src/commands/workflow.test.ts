import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerWorkflowCommand } from "./workflow.js";

const state = vi.hoisted(() => ({
  validateWorkflow: vi.fn(),
  planWorkflow: vi.fn(),
  workflowJsonSchema: vi.fn(),
  storeWorkflowPlan: vi.fn(),
  submitWorkflowRun: vi.fn(),
  executeWorkflowRun: vi.fn(),
  resumeWorkflowRun: vi.fn(),
  getWorkflowStatus: vi.fn(),
}));

vi.mock("@moldesk/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moldesk/core")>();
  return {
    ...actual,
    validateWorkflow: state.validateWorkflow,
    planWorkflow: state.planWorkflow,
    workflowJsonSchema: state.workflowJsonSchema,
    storeWorkflowPlan: state.storeWorkflowPlan,
    submitWorkflowRun: state.submitWorkflowRun,
    executeWorkflowRun: state.executeWorkflowRun,
    resumeWorkflowRun: state.resumeWorkflowRun,
    getWorkflowStatus: state.getWorkflowStatus,
  };
});

let logs: string[];
let errors: string[];
let temporary: string;
let workflowFile: string;
let owned: string[] = [];

beforeEach(() => {
  logs = [];
  errors = [];
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((value: unknown) => void logs.push(String(value)));
  vi.spyOn(console, "error").mockImplementation((value: unknown) => void errors.push(String(value)));
  state.validateWorkflow.mockReset();
  state.planWorkflow.mockReset();
  state.workflowJsonSchema.mockReset();
  state.storeWorkflowPlan.mockReset();
  state.submitWorkflowRun.mockReset();
  state.executeWorkflowRun.mockReset();
  state.resumeWorkflowRun.mockReset();
  state.getWorkflowStatus.mockReset();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-workflow-cli-"));
  owned.push(temporary);
  workflowFile = path.join(temporary, "workflow.yaml");
  fs.writeFileSync(workflowFile, "apiVersion: moldesk.ai/v1alpha1\n");
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerWorkflowCommand(program);
  await program.parseAsync(["workflow", ...args], { from: "user" });
}

function singleJson(): unknown {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]!);
}

const validWorkflow = {
  valid: true,
  diagnostics: [],
  steps: [{ id: "import" }, { id: "analyze" }],
  edges: [{ from: "import", to: "analyze" }],
};

const plan = {
  schemaVersion: 1,
  workflowSha256: "a".repeat(64),
  planId: "b".repeat(64),
  inputs: {
    structure: {
      type: "structure_file",
      value: "/tmp/1CRN.pdb",
      format: "pdb",
      sizeBytes: 10,
      sha256: "c".repeat(64),
    },
  },
  steps: [{ id: "import" }, { id: "analyze" }],
  edges: [{ from: "import", to: "analyze" }],
  requirements: [],
};

describe("moldesk workflow schema", () => {
  it("prints one JSON value with the schema and operation contracts", async () => {
    state.workflowJsonSchema.mockReturnValue({ $schema: "http://json-schema.org/draft-07/schema#" });
    await run("schema", "--json");
    const output = singleJson() as Record<string, unknown>;
    expect(Object.keys(output).sort()).toEqual(["operations", "schema"]);
    expect(output["schema"]).toEqual({ $schema: "http://json-schema.org/draft-07/schema#" });
    expect(Array.isArray(output["operations"])).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("moldesk workflow validate", () => {
  it("prints a valid result as one JSON value", async () => {
    state.validateWorkflow.mockReturnValue(validWorkflow);
    await run("validate", workflowFile, "--json");
    expect(singleJson()).toEqual({
      status: "ok",
      valid: true,
      order: ["import", "analyze"],
      edges: [{ from: "import", to: "analyze" }],
      diagnostics: [],
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("exits 2 with diagnostics for an invalid workflow", async () => {
    const diagnostics = [{ code: "WORKFLOW_CYCLE", message: "cycle", path: "spec.steps[0].needs" }];
    state.validateWorkflow.mockReturnValue({ valid: false, diagnostics, steps: [], edges: [] });
    await run("validate", workflowFile, "--json");
    expect(singleJson()).toEqual({
      status: "error",
      code: "WORKFLOW_INVALID",
      message: "spec.steps[0].needs: WORKFLOW_CYCLE: cycle",
      remediation: expect.any(String),
      details: { diagnostics },
    });
    expect(process.exitCode).toBe(2);
  });
});

describe("moldesk workflow plan", () => {
  it("passes parsed inputs and the caller cwd, then prints the plan", async () => {
    state.planWorkflow.mockReturnValue({ valid: true, diagnostics: [], plan });
    await run("plan", workflowFile, "--input", "structure=/tmp/1CRN.pdb", "--json");
    expect(singleJson()).toEqual({ status: "ok", ...plan });
    expect(state.planWorkflow).toHaveBeenCalledWith(expect.any(Buffer), {
      inputs: { structure: "/tmp/1CRN.pdb" },
      cwd: process.cwd(),
    });
    expect(state.storeWorkflowPlan).toHaveBeenCalledWith(expect.any(String), plan);
    expect(process.exitCode).toBeUndefined();
  });

  it("exits 2 with diagnostics when planning fails", async () => {
    const diagnostics = [{ code: "WORKFLOW_MODEL_NOT_INSTALLED", message: "missing", path: "spec.steps[0].uses" }];
    state.planWorkflow.mockReturnValue({ valid: false, diagnostics });
    await run("plan", workflowFile, "--input", "sequence=AAAA", "--json");
    expect(singleJson()).toMatchObject({ status: "error", code: "WORKFLOW_PLAN_FAILED", details: { diagnostics } });
    expect(process.exitCode).toBe(2);
  });

  it("lists diagnostics on stderr in text mode and exits 2", async () => {
    const diagnostics = [
      { code: "WORKFLOW_MISSING_INPUT", message: "Missing workflow input \"structure\".", path: "inputs.structure" },
      { code: "WORKFLOW_CYCLE", message: "cycle", path: "spec.steps[0].needs", line: 12, column: 7 },
    ];
    state.planWorkflow.mockReturnValue({ valid: false, diagnostics });
    await run("plan", workflowFile);
    expect(logs).toEqual([]);
    expect(errors).toEqual([
      'inputs.structure: WORKFLOW_MISSING_INPUT: Missing workflow input "structure".',
      "spec.steps[0].needs:12:7: WORKFLOW_CYCLE: cycle",
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("passes the workflow file's raw bytes to the planner", async () => {
    const bytes = Buffer.from([...Buffer.from("apiVersion: moldesk.ai/v1alpha1\n# "), 0xff, 0x0a]);
    fs.writeFileSync(workflowFile, bytes);
    state.planWorkflow.mockReturnValue({ valid: true, diagnostics: [], plan });
    await run("plan", workflowFile, "--json");
    expect(Buffer.compare(state.planWorkflow.mock.calls[0]![0] as Buffer, bytes)).toBe(0);
  });

  it("rejects duplicate --input bindings before planning", async () => {
    await run("plan", workflowFile, "--input", "structure=/a.pdb", "--input", "structure=/b.pdb", "--json");
    expect(singleJson()).toMatchObject({ status: "error", code: "INVALID_WORKFLOW_INPUT" });
    expect(process.exitCode).toBe(2);
    expect(state.planWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a malformed --input binding", async () => {
    await run("plan", workflowFile, "--input", "not-a-binding", "--json");
    expect(singleJson()).toMatchObject({ status: "error", code: "INVALID_WORKFLOW_INPUT" });
    expect(process.exitCode).toBe(2);
    expect(state.planWorkflow).not.toHaveBeenCalled();
  });

  it("reports a missing workflow file as a JSON error with exit 2", async () => {
    await run("plan", path.join(temporary, "missing.yaml"), "--json");
    expect(singleJson()).toMatchObject({ status: "error", code: "INPUT_NOT_FOUND" });
    expect(process.exitCode).toBe(2);
    expect(state.planWorkflow).not.toHaveBeenCalled();
  });
});

function summary(status: string, error?: { code: string; message: string }) {
  return {
    runId: "run-1",
    planId: "plan-1",
    status,
    steps: [{ id: "import", uses: "moldesk/import-structure@1", status: status === "succeeded" ? "succeeded" : "failed", attempt: 1 }],
    artifacts: [],
    events: [],
    runDir: "/tmp/run-1",
    ...(error ? { error } : {}),
  };
}

function statusView(status: string) {
  const { steps, artifacts, events, runDir } = summary(status);
  return { run: { runId: "run-1", planId: "plan-1", status }, steps, artifacts, events, runDir };
}

describe("moldesk workflow run", () => {
  it("reports ok and exits 0 for a succeeded run", async () => {
    state.submitWorkflowRun.mockReturnValue({ runId: "run-1", planId: "plan-1", duplicate: false, runDir: "/tmp/run-1" });
    state.executeWorkflowRun.mockResolvedValue(summary("succeeded"));
    await run("run", "approval-1", "--json");
    expect(singleJson()).toMatchObject({ status: "ok", runStatus: "succeeded", runId: "run-1", duplicate: false });
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ["failed", { code: "WORKFLOW_STEP_FAILED", message: "boom" }, 10],
    ["cancelled", undefined, 8],
    ["interrupted", { code: "WORKFLOW_EXECUTION_FAILED", message: "stopped" }, 10],
  ])("exits %s with a nonzero code and one JSON value that is not status ok", async (runStatus, error, code) => {
    state.submitWorkflowRun.mockReturnValue({ runId: "run-1", planId: "plan-1", duplicate: false, runDir: "/tmp/run-1" });
    state.executeWorkflowRun.mockResolvedValue(summary(runStatus, error));
    await run("run", "approval-1", "--json");
    expect(singleJson()).toMatchObject({ status: runStatus, runStatus, runId: "run-1" });
    expect(process.exitCode).toBe(code);
  });

  it("does not start an executor for a duplicate submission and reports the original run's status", async () => {
    state.submitWorkflowRun.mockReturnValue({ runId: "run-1", planId: "plan-1", duplicate: true, runDir: "/tmp/run-1" });
    state.getWorkflowStatus.mockReturnValue(statusView("succeeded"));
    await run("run", "approval-1", "--json");
    expect(state.executeWorkflowRun).not.toHaveBeenCalled();
    expect(state.getWorkflowStatus).toHaveBeenCalledWith("run-1");
    expect(singleJson()).toMatchObject({ status: "ok", runId: "run-1", runStatus: "succeeded", duplicate: true });
    expect(process.exitCode).toBeUndefined();
  });

  it("passes an abort signal that SIGINT triggers, and removes its handlers afterwards", async () => {
    const baseline = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    state.submitWorkflowRun.mockReturnValue({ runId: "run-1", planId: "plan-1", duplicate: false, runDir: "/tmp/run-1" });
    let seen: AbortSignal | undefined;
    state.executeWorkflowRun.mockImplementation(async (_id: string, options: { signal: AbortSignal }) => {
      seen = options.signal;
      expect(seen.aborted).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(baseline[0]! + 1);
      process.emit("SIGINT");
      expect(seen.aborted).toBe(true);
      return summary("cancelled");
    });
    await run("run", "approval-1", "--json");
    expect(process.exitCode).toBe(8);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(baseline);
  });

  it("removes the signal handlers when execution throws", async () => {
    const baseline = process.listenerCount("SIGTERM");
    state.submitWorkflowRun.mockReturnValue({ runId: "run-1", planId: "plan-1", duplicate: false, runDir: "/tmp/run-1" });
    state.executeWorkflowRun.mockRejectedValue(new Error("nope"));
    await run("run", "approval-1", "--json");
    expect(singleJson()).toMatchObject({ status: "error" });
    expect(process.listenerCount("SIGTERM")).toBe(baseline);
  });
});

describe("moldesk workflow resume", () => {
  it("exits nonzero for a failed resumed run and forwards a signal", async () => {
    state.resumeWorkflowRun.mockResolvedValue(summary("failed", { code: "WORKFLOW_STEP_FAILED", message: "boom" }));
    await run("resume", "run-1", "--json");
    expect(singleJson()).toMatchObject({ status: "failed", runStatus: "failed" });
    expect(process.exitCode).toBe(10);
    expect(state.resumeWorkflowRun).toHaveBeenCalledWith("run-1", { signal: expect.any(AbortSignal) });
  });

  it("exits 8 for a cancelled resumed run and 0 for a succeeded one", async () => {
    state.resumeWorkflowRun.mockResolvedValue(summary("cancelled"));
    await run("resume", "run-1", "--json");
    expect(process.exitCode).toBe(8);
    process.exitCode = undefined;
    logs.length = 0;
    state.resumeWorkflowRun.mockResolvedValue(summary("succeeded"));
    await run("resume", "run-1", "--json");
    expect(singleJson()).toMatchObject({ status: "ok" });
    expect(process.exitCode).toBeUndefined();
  });
});
