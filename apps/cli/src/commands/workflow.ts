import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import {
  MAX_WORKFLOW_BYTES,
  MoldeskError,
  planWorkflow,
  validateWorkflow,
  workflowJsonSchema,
  type WorkflowDiagnostic,
} from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

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

export function registerWorkflowCommand(program: Command): void {
  const workflow = program
    .command("workflow")
    .description("Compile and plan local workflows without executing them");

  workflow
    .command("schema")
    .description("Print the workflow YAML JSON Schema")
    .option("--json", "print JSON")
    .action(() => {
      console.log(JSON.stringify(workflowJsonSchema(), null, 2));
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
        const result = planWorkflow(readWorkflowSource(file), {
          inputs: parseInputValues(options.input),
          cwd: process.cwd(),
        });

        if (!result.valid || !result.plan) {
          reportDiagnostics("WORKFLOW_PLAN_FAILED", result.diagnostics, options.json);
        } else if (options.json) {
          console.log(JSON.stringify({ status: "ok", ...result.plan }, null, 2));
        } else {
          const plan = result.plan;
          console.log(`Plan ${plan.planId}`);
          console.log(`Workflow sha256 ${plan.workflowSha256}`);
          for (const [name, input] of Object.entries(plan.inputs)) {
            const detail = input.format ? ` (${input.format}, ${input.sizeBytes} bytes)` : "";
            console.log(`  input ${name}: ${input.value}${detail}`);
          }
          console.log(`  steps: ${plan.steps.map((step) => step.id).join(" → ")}`);
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
}
