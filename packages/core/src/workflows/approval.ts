import { getMoldeskPaths, type MoldeskPaths } from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import type { WorkflowPlan } from "./compiler.js";
import { WorkflowStore, type WorkflowApprovalRecord } from "./store.js";

/** What a person reviews before a plan can run. */
export interface WorkflowApprovalSummary {
  planId: string;
  workflowSha256: string;
  backend: string;
  inputs: Array<{ name: string; value: string; format?: string; sizeBytes?: number }>;
  steps: Array<{ id: string; uses: string; needs: string[] }>;
  plan: WorkflowPlan;
}

/**
 * Asks a human to approve the summary. It must resolve `true` only after an interactive
 * decision; a front end that cannot ask a person must not supply one.
 */
export type WorkflowApprovalConfirmer = (summary: WorkflowApprovalSummary) => boolean | Promise<boolean>;

export interface ApproveWorkflowPlanOptions {
  paths?: MoldeskPaths;
  confirm?: WorkflowApprovalConfirmer;
}

function summarize(plan: WorkflowPlan): WorkflowApprovalSummary {
  const backends = [...new Set(plan.requirements.map((requirement) => requirement.backend))];
  return {
    planId: plan.planId,
    workflowSha256: plan.workflowSha256,
    backend: backends.length > 0 ? backends.join(", ") : "local",
    inputs: Object.entries(plan.inputs).map(([name, input]) => ({
      name,
      value: input.value,
      ...(input.format ? { format: input.format } : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    })),
    steps: plan.steps.map((step) => ({ id: step.id, uses: step.uses, needs: step.needs })),
    plan,
  };
}

/**
 * The single approval policy. A one-use approval is created only when the caller supplies an
 * interactive confirmer and it returns true. Transports (CLI terminal, a future UI) decide how
 * to ask; they never create approvals themselves.
 */
export async function approveWorkflowPlan(
  planId: string,
  options: ApproveWorkflowPlanOptions = {},
): Promise<{ approval: WorkflowApprovalRecord; summary: WorkflowApprovalSummary }> {
  const store = WorkflowStore.open(options.paths ?? getMoldeskPaths());
  try {
    const stored = store.getPlan(planId);
    if (!stored) {
      throw new MoldeskError({
        code: "WORKFLOW_PLAN_NOT_FOUND",
        message: `Unknown workflow plan "${planId}".`,
        remediation: "Plan the workflow again and approve the new plan ID.",
      });
    }
    const summary = summarize(stored.plan);
    if (typeof options.confirm !== "function") {
      throw new MoldeskError({
        code: "WORKFLOW_APPROVAL_REQUIRES_CONFIRMATION",
        message: "Workflow approval requires an interactive confirmation by a person.",
        remediation: "Run `moldesk workflow approve <plan-id>` from a terminal.",
      });
    }
    if ((await options.confirm(summary)) !== true) {
      throw new MoldeskError({
        code: "WORKFLOW_APPROVAL_DECLINED",
        message: "Workflow plan was not approved.",
        remediation: "Run the workflow only after reviewing and approving the plan.",
      });
    }
    return { approval: store.createApproval(planId), summary };
  } finally {
    store.close();
  }
}
