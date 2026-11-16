import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMoldeskPaths } from "@moldesk/runtime";
import { approveWorkflowPlan, type WorkflowApprovalSummary } from "./approval.js";
import { planWorkflow } from "./compiler.js";
import { storeWorkflowPlan, WorkflowStore } from "./store.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const FIXTURE = path.join(REPO_ROOT, "packages/visualizer/test/fixtures/1CRN.pdb");
const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function storedPlan() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-workflow-approval-"));
  temporaries.push(home);
  const paths = getMoldeskPaths({ MOLDESK_HOME: home });
  const source = fs.readFileSync(path.join(REPO_ROOT, "examples/workflows/structure-analysis.yaml"), "utf8");
  const planned = planWorkflow(source, { inputs: { structure: FIXTURE }, paths });
  expect(planned.valid).toBe(true);
  storeWorkflowPlan(source, planned.plan!, { paths });
  return { paths, plan: planned.plan! };
}

function approvalCount(paths: ReturnType<typeof getMoldeskPaths>, approvalId: string): boolean {
  const store = WorkflowStore.open(paths);
  try {
    return store.getApproval(approvalId) !== undefined;
  } finally {
    store.close();
  }
}

describe("approveWorkflowPlan", () => {
  it("refuses without an interactive confirmer and creates nothing", async () => {
    const { paths, plan } = storedPlan();
    await expect(approveWorkflowPlan(plan.planId, { paths })).rejects.toMatchObject({
      code: "WORKFLOW_APPROVAL_REQUIRES_CONFIRMATION",
    });
  });

  it("refuses when the confirmer declines", async () => {
    const { paths, plan } = storedPlan();
    const confirm = vi.fn(() => false);
    await expect(approveWorkflowPlan(plan.planId, { paths, confirm })).rejects.toMatchObject({
      code: "WORKFLOW_APPROVAL_DECLINED",
    });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("refuses an unknown plan before asking anyone", async () => {
    const { paths } = storedPlan();
    const confirm = vi.fn(() => true);
    await expect(approveWorkflowPlan("0".repeat(64), { paths, confirm })).rejects.toMatchObject({
      code: "WORKFLOW_PLAN_NOT_FOUND",
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("creates a one-use approval after the confirmer accepts and shows the summary", async () => {
    const { paths, plan } = storedPlan();
    const confirm = vi.fn(async (_summary: WorkflowApprovalSummary) => true);
    const result = await approveWorkflowPlan(plan.planId, { paths, confirm });
    expect(result.approval.planId).toBe(plan.planId);
    expect(approvalCount(paths, result.approval.approvalId)).toBe(true);
    const summary = confirm.mock.calls[0]![0];
    expect(summary.planId).toBe(plan.planId);
    expect(summary.backend).toBe("local");
    expect(summary.steps.map((step) => step.id)).toEqual(["import", "analyze"]);
    expect(summary.inputs.map((input) => input.name)).toEqual(["structure"]);
  });
});
