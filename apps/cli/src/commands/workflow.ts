import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import {
  MAX_WORKFLOW_BYTES,
  MoldeskError,
  cancelWorkflowRun,
  createWorkflowApproval,
  executeWorkflowRun,
  getWorkflowArtifacts,
  getWorkflowPlan,
  getWorkflowStatus,
  planWorkflow,
  resumeWorkflowRun,
  storeWorkflowPlan,
  submitWorkflowRun,
  validateWorkflow,
  workflowJsonSchema,
  workflowOperationCatalog,
  type WorkflowDiagnostic,
  type WorkflowPlan,
  type WorkflowRunSummary,
} from "@moldesk/core";
import { confirm } from "../utils/confirm.js";
import { exitCodeForWorkflowRun, reportFailure } from "../utils/report-errors.js";

interface WorkflowJsonOptions {
  json?: boolean;
}

interface WorkflowPlanOptions extends WorkflowJsonOptions {
  input: string[];
}

/** Reads the workflow's raw bytes so the plan's `workflowSha256` matches the file exactly. */
function readWorkflowSource(file: string): Buffer {
  const resolved = path.resolve(file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new MoldeskError({
      code: "INPUT_NOT_FOUND",
      message: `Workflow file not found: ${resolved}.`,
      remediation: "Check the path and try again.",
    });
  }
  if (!stat.isFile()) {
    throw new MoldeskError({
      code: "INPUT_NOT_FOUND",
      message: `Not a regular file: ${resolved}.`,
      remediation: "Pass a workflow YAML file, not a directory.",
    });
  }
  if (stat.size > MAX_WORKFLOW_BYTES) {
    throw new MoldeskError({
      code: "INPUT_TOO_LARGE",
      message: `Workflow file is too large (${stat.size} bytes; limit ${MAX_WORKFLOW_BYTES}).`,
      remediation: "Reduce the workflow file size.",
    });
  }
  return fs.readFileSync(resolved);
}

function parseInputValues(values: string[]): Record<string, string> {
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const value of values) {
    const equals = value.indexOf("=");
    if (equals <= 0) {
      throw new MoldeskError({
        code: "INVALID_WORKFLOW_INPUT",
        message: `Invalid --input "${value}". Expected name=value.`,
        remediation: "Repeat --input name=value for each workflow input.",
      });
    }
    const name = value.slice(0, equals);
    if (seen.has(name)) {
      throw new MoldeskError({
        code: "INVALID_WORKFLOW_INPUT",
        message: `Duplicate --input binding for "${name}".`,
        remediation: "Pass each workflow input at most once.",
      });
    }
    seen.add(name);
    entries.push([name, value.slice(equals + 1)]);
  }
  return Object.fromEntries(entries);
}

function diagnosticText(diagnostic: WorkflowDiagnostic): string {
  const position = diagnostic.line === undefined ? "" : `:${diagnostic.line}:${diagnostic.column ?? 1}`;
  return `${diagnostic.path}${position}: ${diagnostic.code}: ${diagnostic.message}`;
}

/**
 * Reports compile/plan diagnostics. JSON mode uses the CLI's error envelope with the
 * diagnostics under `details`; text mode lists one diagnostic per line. Both exit 2.
 */
function reportDiagnostics(
  code: "WORKFLOW_INVALID" | "WORKFLOW_PLAN_FAILED",
  diagnostics: WorkflowDiagnostic[],
  json: boolean | undefined,
): void {
  if (!json) {
    for (const diagnostic of diagnostics) console.error(diagnosticText(diagnostic));
    process.exitCode = 2;
    return;
  }
  const first = diagnostics[0];
  const message =
    diagnostics.length === 1 && first
      ? diagnosticText(first)
      : `Workflow ${code === "WORKFLOW_INVALID" ? "validation" : "planning"} failed with ${diagnostics.length} diagnostics.`;
  reportFailure(
    new MoldeskError({
      code,
      message,
      remediation: "Fix the listed diagnostics and try again.",
      details: { diagnostics },
    }),
    true,
  );
}

function workflowResult(summary: WorkflowRunSummary, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok",
    runId: summary.runId,
    planId: summary.planId,
    runStatus: summary.status,
    steps: summary.steps,
    artifacts: summary.artifacts,
    events: summary.events,
    runDir: summary.runDir,
    ...(summary.error ? { error: summary.error } : {}),
    ...extra,
  };
}

/** `run` and `resume` report `status: "ok"` only for a run that did not fail, cancel or get interrupted. */
function runOutcome(summary: WorkflowRunSummary, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const finishedBadly = summary.status === "failed" || summary.status === "cancelled" || summary.status === "interrupted";
  return workflowResult(summary, { ...(finishedBadly ? { status: summary.status } : {}), ...extra });
}

function reportRun(summary: WorkflowRunSummary, json: boolean | undefined, extra: Record<string, unknown> = {}): void {
  if (json) console.log(JSON.stringify(runOutcome(summary, extra), null, 2));
  else printRun(summary);
  const code = exitCodeForWorkflowRun(summary.status, summary.error);
  if (code !== 0) process.exitCode = code;
}

/** Aborts `controller` on SIGINT/SIGTERM, as `moldesk run` does; the returned fn removes the handlers. */
function abortOnSignals(controller: AbortController): () => void {
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
}

function statusSummary(runId: string): WorkflowRunSummary {
  const status = getWorkflowStatus(runId);
  return {
    runId: status.run.runId,
    planId: status.run.planId,
    status: status.run.status,
    steps: status.steps,
    artifacts: status.artifacts,
    events: status.events,
    ...(status.run.error ? { error: status.run.error } : {}),
    runDir: status.runDir,
  };
}

function printRun(summary: WorkflowRunSummary): void {
  console.log(`${summary.status} ${summary.runId} (${summary.steps.length} steps, ${summary.artifacts.length} artifacts)`);
  for (const step of summary.steps) console.log(`  ${step.id}: ${step.status} (attempt ${step.attempt})`);
  if (summary.error) console.log(`  error: ${summary.error.code}: ${summary.error.message}`);
}

function planText(plan: WorkflowPlan): string {
  const lines = [`Plan ${plan.planId}`, `Workflow sha256 ${plan.workflowSha256}`];
  for (const [name, input] of Object.entries(plan.inputs)) {
    const detail = input.format ? ` (${input.format}, ${input.sizeBytes} bytes)` : "";
    lines.push(`  input ${name}: ${input.value}${detail}`);
  }
  lines.push(`  steps: ${plan.steps.map((step) => step.id).join(" → ")}`);
  return lines.join("\n");
}

export function registerWorkflowCommand(program: Command): void {
  const workflow = program
    .command("workflow")
    .description("Validate, plan, approve, run and inspect local YAML workflows");

  workflow
    .command("schema")
    .description("Print the workflow YAML JSON Schema and operation contracts")
    .option("--json", "print JSON")
    .action(() => {
      console.log(JSON.stringify({ schema: workflowJsonSchema(), operations: workflowOperationCatalog() }, null, 2));
    });

  workflow
    .command("validate <file>")
    .description("Validate a workflow document without resolving inputs")
    .option("--json", "print JSON")
    .action((file: string, options: WorkflowJsonOptions) => {
      try {
        const result = validateWorkflow(readWorkflowSource(file));
        if (!result.valid) {
          reportDiagnostics("WORKFLOW_INVALID", result.diagnostics, options.json);
        } else if (options.json) {
          console.log(
            JSON.stringify(
              {
                status: "ok",
                valid: true,
                order: result.steps.map((step) => step.id),
                edges: result.edges,
                diagnostics: result.diagnostics,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(`${file}: valid workflow (${result.steps.map((step) => step.id).join(" → ")}).`);
        }
      } catch (error) {
        reportFailure(error, options.json);
      }
    });

  workflow
    .command("plan <file>")
    .description("Resolve inputs and print a deterministic execution plan")
    .option("--input <name=value>", "set a workflow input (repeatable)", (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option("--json", "print JSON")
    .action((file: string, options: WorkflowPlanOptions) => {
      try {
        const source = readWorkflowSource(file);
        const result = planWorkflow(source, {
          inputs: parseInputValues(options.input),
          cwd: process.cwd(),
        });

        if (!result.valid || !result.plan) {
          reportDiagnostics("WORKFLOW_PLAN_FAILED", result.diagnostics, options.json);
          return;
        }
        storeWorkflowPlan(source.toString("utf8"), result.plan);
        if (options.json) {
          console.log(JSON.stringify({ status: "ok", ...result.plan }, null, 2));
        } else {
          const plan = result.plan;
          console.log(planText(plan));
          for (const requirement of plan.requirements) {
            if (requirement.model) {
              console.log(
                `  runtime ${requirement.stepId}: python ${requirement.model.name} ${requirement.model.modelVersion} (${requirement.model.runtime.fingerprint})`,
              );
            }
          }
        }
      } catch (error) {
        reportFailure(error, options.json);
      }
    });

  workflow
    .command("approve <plan-id>")
    .description("Display a stored plan and create a one-use approval on a human terminal")
    .option("--json", "print JSON")
    .action(async (planId: string, options: WorkflowJsonOptions) => {
      try {
        const stored = getWorkflowPlan(planId);
        if (!stored) {
          throw new MoldeskError({
            code: "WORKFLOW_PLAN_NOT_FOUND",
            message: `Unknown workflow plan "${planId}".`,
            remediation: "Plan the workflow again and approve the new plan ID.",
          });
        }
        console.error(planText(stored.plan));
        if (!process.stdin.isTTY) {
          throw new MoldeskError({
            code: "WORKFLOW_APPROVAL_REQUIRES_TTY",
            message: "Workflow approval requires an interactive terminal.",
            remediation: "Run the approve command from a terminal so a person can review the plan.",
          });
        }
        const approved = await confirm(`Approve plan ${planId}?`);
        if (!approved) {
          throw new MoldeskError({
            code: "WORKFLOW_APPROVAL_DECLINED",
            message: "Workflow plan was not approved.",
            remediation: "Run the workflow only after reviewing and approving the plan.",
          });
        }
        const approval = createWorkflowApproval(planId);
        if (options.json) {
          console.log(
            JSON.stringify({ status: "ok", approvalId: approval.approvalId, planId, plan: stored.plan }, null, 2),
          );
        } else {
          console.log(approval.approvalId);
        }
      } catch (error) {
        reportFailure(error, options.json);
      }
    });

  workflow
    .command("run <approval-id>")
    .description("Execute an approved workflow and wait for the result")
    .option("--json", "print JSON")
    .action(async (approvalId: string, options: WorkflowJsonOptions) => {
      const controller = new AbortController();
      const removeSignalHandlers = abortOnSignals(controller);
      try {
        const submitted = submitWorkflowRun(approvalId);
        if (submitted.duplicate) {
          // A duplicate never starts a second executor: report the original run as it is now.
          reportRun(statusSummary(submitted.runId), options.json, { duplicate: true });
          return;
        }
        const summary = await executeWorkflowRun(submitted.runId, { signal: controller.signal });
        reportRun(summary, options.json, { duplicate: false });
      } catch (error) {
        reportFailure(error, options.json);
      } finally {
        removeSignalHandlers();
      }
    });

  workflow
    .command("status <run-id>")
    .description("Print the durable status of a workflow run")
    .option("--json", "print JSON")
    .action((runId: string, options: WorkflowJsonOptions) => {
      try {
        const summary = statusSummary(runId);
        if (options.json) console.log(JSON.stringify(workflowResult(summary), null, 2));
        else printRun(summary);
      } catch (error) {
        reportFailure(error, options.json);
      }
    });

  workflow
    .command("artifacts <run-id>")
    .description("List verified artifacts produced by a workflow run")
    .option("--json", "print JSON")
    .action(async (runId: string, options: WorkflowJsonOptions) => {
      try {
        const artifacts = await getWorkflowArtifacts(runId);
        if (options.json) console.log(JSON.stringify({ status: "ok", runId, artifacts }, null, 2));
        else for (const artifact of artifacts) console.log(`${artifact.id}\t${artifact.type}\t${artifact.path}`);
      } catch (error) {
        reportFailure(error, options.json);
      }
    });

  workflow
    .command("resume <run-id>")
    .description("Resume an interrupted workflow run from verified outputs")
    .option("--json", "print JSON")
    .action(async (runId: string, options: WorkflowJsonOptions) => {
      const controller = new AbortController();
      const removeSignalHandlers = abortOnSignals(controller);
      try {
        const summary = await resumeWorkflowRun(runId, { signal: controller.signal });
        reportRun(summary, options.json);
      } catch (error) {
        reportFailure(error, options.json);
      } finally {
        removeSignalHandlers();
      }
    });

  workflow
    .command("cancel <run-id>")
    .description("Request cancellation of a workflow run")
    .option("--json", "print JSON")
    .action((runId: string, options: WorkflowJsonOptions) => {
      try {
        const run = cancelWorkflowRun(runId);
        if (options.json) {
          console.log(JSON.stringify({ status: "ok", runId, runStatus: run.status, cancelRequested: run.cancelRequested }, null, 2));
        } else {
          console.log(`${run.status} ${runId} (cancellation requested)`);
        }
      } catch (error) {
        reportFailure(error, options.json);
      }
    });
}
