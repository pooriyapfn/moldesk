import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listAvailableModels } from "@moldesk/registry";
import { getMoldeskPaths, isWithinRoot, type MoldeskPaths } from "@moldesk/runtime";
import { readStructureInput } from "../analysis/structure-input.js";
import { MoldeskError } from "../errors.js";
import { digest, sha256Text } from "../hash.js";
import { listInstalledModels } from "../install-state.js";
import {
  getWorkflowOperation,
  normalizeProteinSequence,
  type WorkflowOperationId,
  type WorkflowValueType,
} from "./operations.js";
import {
  parseWorkflowDocument,
  parseWorkflowReference,
  type WorkflowDiagnostic,
  type WorkflowDocument,
  type WorkflowParseResult,
  type WorkflowReference,
} from "./schema.js";

export const WORKFLOW_PLAN_SCHEMA_VERSION = 1;

export interface WorkflowPlanEdge {
  from: string;
  to: string;
}

export interface WorkflowPlanBinding {
  /** Operation input port name. */
  input: string;
  type: WorkflowValueType;
  source: WorkflowReference;
}

export interface WorkflowPlanStep {
  id: string;
  uses: WorkflowOperationId;
  operationVersion: number;
  needs: string[];
  bindings: WorkflowPlanBinding[];
  outputs: Array<{ name: string; type: WorkflowValueType }>;
}

/**
 * Workflow source. Pass the file's raw bytes when you have them: `workflowSha256` is
 * then the sha256 of exactly those bytes. A string is hashed as its UTF-8 encoding.
 */
export type WorkflowSource = string | Uint8Array;

export interface WorkflowCompileResult {
  valid: boolean;
  diagnostics: WorkflowDiagnostic[];
  workflow?: WorkflowDocument;
  /** Steps in execution order. Empty when validation fails. */
  steps: WorkflowPlanStep[];
  edges: WorkflowPlanEdge[];
  /** Source position lookup for later planning diagnostics. Not serialized. */
  positionOf?: WorkflowParseResult["positionOf"];
}

export interface WorkflowResolvedInput {
  type: WorkflowValueType;
  /** A normalized sequence, or the resolved absolute path of a structure file. */
  value: string;
  /** Structure file format (`pdb` or `mmcif`); file inputs only. */
  format?: string;
  sizeBytes: number;
  sha256: string;
}

export interface WorkflowModelAsset {
  id: string;
  sha256: string;
  sizeBytes: number;
}

export interface WorkflowModelRequirement {
  name: string;
  modelVersion: string;
  adapterVersion: string;
  manifestSha256: string;
  installationId: string;
  runtime: { kind: "python"; fingerprint: string };
  environmentFingerprint: string;
  source?: { repository: string; revision: string };
  assets: WorkflowModelAsset[];
}

export interface WorkflowStepRequirement {
  stepId: string;
  backend: "local";
  operationVersion: number;
  model?: WorkflowModelRequirement;
}

export interface WorkflowPlan {
  schemaVersion: typeof WORKFLOW_PLAN_SCHEMA_VERSION;
  workflowSha256: string;
  /**
   * sha256 of the canonical JSON of `workflowSha256`, resolved inputs, steps, edges and
   * requirements. Resolved file inputs include their canonical absolute path, which the
   * executor reads, so the same bytes at a different path (another checkout or workspace)
   * intentionally produce a different plan ID.
   */
  planId: string;
  inputs: Record<string, WorkflowResolvedInput>;
  steps: WorkflowPlanStep[];
  edges: WorkflowPlanEdge[];
  requirements: WorkflowStepRequirement[];
  /** Always empty in a valid plan; kept in the payload so every compile result carries diagnostics. */
  diagnostics: WorkflowDiagnostic[];
}

export interface PlanWorkflowOptions {
  /** External input values by declaration name. */
  inputs?: Record<string, string>;
  /** Base directory for relative file inputs. Defaults to the process cwd. */
  cwd?: string;
  /** Confinement boundary for file inputs. Relative inputs resolve against it. */
  workspaceRoot?: string;
  paths?: MoldeskPaths;
}

export interface WorkflowPlanResult {
  valid: boolean;
  diagnostics: WorkflowDiagnostic[];
  plan?: WorkflowPlan;
}

function report(
  diagnostics: WorkflowDiagnostic[],
  code: string,
  message: string,
  fieldPath: string,
): void {
  diagnostics.push({ code, message, path: fieldPath });
}

function sourceText(source: WorkflowSource): string {
  return typeof source === "string" ? source : Buffer.from(source).toString("utf8");
}

function sourceSha256(source: WorkflowSource): string {
  return typeof source === "string" ? sha256Text(source) : createHash("sha256").update(source).digest("hex");
}

/** Adds one-based line/column to diagnostics whose path names a workflow field. */
function withPositions(
  diagnostics: WorkflowDiagnostic[],
  positionOf: WorkflowParseResult["positionOf"],
): WorkflowDiagnostic[] {
  if (!positionOf) return diagnostics;
  return diagnostics.map((diagnostic) =>
    diagnostic.line === undefined && diagnostic.path.startsWith("spec.")
      ? { ...diagnostic, ...positionOf(diagnostic.path) }
      : diagnostic,
  );
}

function operationVersion(uses: string): number {
  const match = /@(\d+)$/.exec(uses);
  return match ? Number(match[1]) : 1;
}

/**
 * Resolves the DAG, typed bindings, and operation ports. This only needs the
 * workflow bytes: no file or installation access, and no runner calls.
 */
export function validateWorkflow(source: WorkflowSource): WorkflowCompileResult {
  const parsed = parseWorkflowDocument(sourceText(source));
  if (!parsed.valid || !parsed.workflow) {
    return { valid: false, diagnostics: parsed.diagnostics, steps: [], edges: [] };
  }

  const workflow = parsed.workflow;
  const diagnostics: WorkflowDiagnostic[] = [];
  const indexById = new Map<string, number>();
  let duplicateIds = false;

  workflow.spec.steps.forEach((step, index) => {
    const fieldPath = `spec.steps[${index}].id`;
    if (indexById.has(step.id)) {
      duplicateIds = true;
      report(diagnostics, "WORKFLOW_DUPLICATE_STEP", `Duplicate step id "${step.id}".`, fieldPath);
      return;
    }
    indexById.set(step.id, index);
  });

  const edges: WorkflowPlanEdge[] = [];
  const bindingsByIndex = new Map<number, WorkflowPlanBinding[]>();

  workflow.spec.steps.forEach((step, index) => {
    const stepPath = `spec.steps[${index}]`;

    const seenNeeds = new Set<string>();
    step.needs.forEach((need, needIndex) => {
      const needPath = `${stepPath}.needs[${needIndex}]`;
      if (need === step.id) {
        report(diagnostics, "WORKFLOW_SELF_DEPENDENCY", `Step "${step.id}" cannot depend on itself.`, needPath);
        return;
      }
      if (seenNeeds.has(need)) {
        report(
          diagnostics,
          "WORKFLOW_DUPLICATE_DEPENDENCY",
          `Step "${step.id}" lists dependency "${need}" more than once.`,
          needPath,
        );
        return;
      }
      seenNeeds.add(need);
      if (!indexById.has(need)) {
        report(diagnostics, "WORKFLOW_UNKNOWN_DEPENDENCY", `Step "${step.id}" needs unknown step "${need}".`, needPath);
        return;
      }
      edges.push({ from: need, to: step.id });
    });

    const operation = getWorkflowOperation(step.uses);
    if (!operation) return;

    const bindings: WorkflowPlanBinding[] = [];
    for (const port of operation.inputs) {
      const fieldPath = `${stepPath}.with.${port.name}`;
      const reference = parseWorkflowReference(step.with[port.name] ?? "");
      if (!reference) {
        report(diagnostics, "WORKFLOW_INVALID_REFERENCE", `Invalid binding for "with.${port.name}".`, fieldPath);
        continue;
      }

      let actualType: WorkflowValueType | undefined;
      if (reference.kind === "input") {
        const declaration = workflow.spec.inputs[reference.name];
        if (!declaration) {
          report(diagnostics, "WORKFLOW_UNKNOWN_INPUT", `Unknown workflow input "${reference.name}".`, fieldPath);
        } else {
          actualType = declaration.type;
        }
      } else {
        const target = indexById.get(reference.stepId);
        if (target === undefined) {
          report(diagnostics, "WORKFLOW_UNKNOWN_STEP", `Unknown producer step "${reference.stepId}".`, fieldPath);
        } else {
          const targetStep = workflow.spec.steps[target]!;
          if (!Object.prototype.hasOwnProperty.call(targetStep.outputs, reference.output)) {
            report(
              diagnostics,
              "WORKFLOW_UNKNOWN_OUTPUT",
              `Step "${reference.stepId}" declares no output "${reference.output}".`,
              fieldPath,
            );
          } else {
            actualType = targetStep.outputs[reference.output];
          }
          if (!step.needs.includes(reference.stepId)) {
            report(
              diagnostics,
              "WORKFLOW_UNDECLARED_DEPENDENCY",
              `Step "${step.id}" references "${reference.stepId}" but does not list it in needs.`,
              fieldPath,
            );
          }
        }
      }

      if (actualType !== undefined && actualType !== port.type) {
        report(
          diagnostics,
          "WORKFLOW_TYPE_MISMATCH",
          `Binding for "${step.id}.${port.name}" expects ${port.type}, received ${actualType}.`,
          fieldPath,
        );
        continue;
      }
      if (actualType !== undefined) bindings.push({ input: port.name, type: actualType, source: reference });
    }
    bindingsByIndex.set(index, bindings);

    for (const output of operation.outputs) {
      if (step.outputs[output.name] !== output.type) {
        report(
          diagnostics,
          "WORKFLOW_TYPE_MISMATCH",
          `Output "${step.id}.${output.name}" must be declared as ${output.type}.`,
          `${stepPath}.outputs.${output.name}`,
        );
      }
    }
  });

  let order: string[] | undefined;
  if (!duplicateIds) {
    const sorted = topologicalOrder(workflow, edges);
    order = sorted.order;
    if (!order) {
      for (const stepId of sorted.blocked) {
        report(
          diagnostics,
          "WORKFLOW_CYCLE",
          `Step "${stepId}" is blocked by a dependency cycle.`,
          `spec.steps[${indexById.get(stepId)}].needs`,
        );
      }
    }
  }

  if (diagnostics.length > 0 || !order) {
    return { valid: false, diagnostics: withPositions(diagnostics, parsed.positionOf), workflow, steps: [], edges: [] };
  }

  const steps = order.map((id) => {
    const index = indexById.get(id)!;
    const step = workflow.spec.steps[index]!;
    const operation = getWorkflowOperation(step.uses)!;
    return {
      id: step.id,
      uses: step.uses,
      operationVersion: operationVersion(step.uses),
      needs: [...step.needs],
      bindings: bindingsByIndex.get(index) ?? [],
      outputs: operation.outputs.map((output) => ({ name: output.name, type: output.type })),
    };
  });

  return { valid: true, diagnostics, workflow, steps, edges, positionOf: parsed.positionOf };
}

/** Kahn's algorithm with declaration order as the ready-list tie breaker. */
function topologicalOrder(
  workflow: WorkflowDocument,
  edges: WorkflowPlanEdge[],
): { order?: string[]; blocked: string[] } {
  const indexById = new Map(workflow.spec.steps.map((step, index) => [step.id, index]));
  const inDegree = new Map(workflow.spec.steps.map((step) => [step.id, 0]));
  const dependents = new Map(workflow.spec.steps.map((step) => [step.id, [] as string[]]));

  for (const edge of edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    dependents.get(edge.from)?.push(edge.to);
  }

  const ready = workflow.spec.steps.filter((step) => inDegree.get(step.id) === 0).map((step) => step.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  const completed = new Set(order);
  return {
    ...(order.length === workflow.spec.steps.length ? { order } : {}),
    blocked: workflow.spec.steps.filter((step) => !completed.has(step.id)).map((step) => step.id),
  };
}

function inputDiagnostic(error: unknown, fieldPath: string): WorkflowDiagnostic {
  if (error instanceof MoldeskError) {
    return { code: error.code, message: error.message, path: fieldPath };
  }
  return {
    code: "WORKFLOW_INPUT_INVALID",
    message: error instanceof Error ? error.message : String(error),
    path: fieldPath,
  };
}

function resolveStructureFile(
  value: string,
  options: PlanWorkflowOptions,
  fieldPath: string,
  diagnostics: WorkflowDiagnostic[],
): WorkflowResolvedInput | undefined {
  const root = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
  const base = root ?? path.resolve(options.cwd ?? process.cwd());
  let resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);

  if (root) {
    let rootReal: string;
    try {
      if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
      rootReal = fs.realpathSync(root);
    } catch {
      report(diagnostics, "WORKFLOW_WORKSPACE_NOT_FOUND", `Workspace root not found: ${root}.`, fieldPath);
      return undefined;
    }
    if (!isWithinRoot(root, resolved) && !isWithinRoot(rootReal, resolved)) {
      report(diagnostics, "WORKFLOW_INPUT_OUTSIDE_WORKSPACE", `Input resolves outside the workspace: ${resolved}.`, fieldPath);
      return undefined;
    }
    try {
      resolved = fs.realpathSync(resolved);
    } catch {
      report(diagnostics, "INPUT_NOT_FOUND", `File not found: ${resolved}.`, fieldPath);
      return undefined;
    }
    if (!isWithinRoot(rootReal, resolved)) {
      report(
        diagnostics,
        "WORKFLOW_INPUT_OUTSIDE_WORKSPACE",
        `Input escapes the workspace through a symlink: ${resolved}.`,
        fieldPath,
      );
      return undefined;
    }
  }

  try {
    const input = readStructureInput(resolved);
    return {
      type: "structure_file",
      value: resolved,
      format: input.format,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    };
  } catch (error) {
    diagnostics.push(inputDiagnostic(error, fieldPath));
    return undefined;
  }
}

function resolveInput(
  type: WorkflowValueType,
  value: string,
  options: PlanWorkflowOptions,
  fieldPath: string,
  diagnostics: WorkflowDiagnostic[],
): WorkflowResolvedInput | undefined {
  if (type === "protein_sequence") {
    try {
      const sequence = normalizeProteinSequence(value);
      return {
        type,
        value: sequence,
        sizeBytes: Buffer.byteLength(sequence, "utf8"),
        sha256: sha256Text(sequence),
      };
    } catch (error) {
      diagnostics.push(inputDiagnostic(error, fieldPath));
      return undefined;
    }
  }
  if (type === "structure_file") {
    return resolveStructureFile(value, options, fieldPath, diagnostics);
  }
  report(diagnostics, "WORKFLOW_UNSUPPORTED_INPUT", `Unsupported workflow input type: ${type}.`, fieldPath);
  return undefined;
}

/** Re-resolves the installed model binding. Step 3 calls this again at submit and before execution. */
export function resolveWorkflowModelRequirement(
  modelName: string,
  paths: MoldeskPaths = getMoldeskPaths(),
  fieldPath = "spec.steps",
): { requirement?: WorkflowModelRequirement; diagnostics: WorkflowDiagnostic[] } {
  const diagnostics: WorkflowDiagnostic[] = [];
  const manifest = listAvailableModels().find((entry) => entry.name === modelName);
  if (!manifest) {
    report(
      diagnostics,
      "WORKFLOW_UNKNOWN_MODEL",
      `Workflow operation requires unknown model "${modelName}".`,
      fieldPath,
    );
    return { diagnostics };
  }

  const installed = listInstalledModels(paths).find(
    (record) => record.model === modelName && record.runtime.kind === "python" && Boolean(record.runtime.python),
  );
  if (!installed) {
    report(
      diagnostics,
      "WORKFLOW_MODEL_NOT_INSTALLED",
      `${modelName} is not installed for the python runtime. Run \`moldesk install ${modelName}\`.`,
      fieldPath,
    );
    return { diagnostics };
  }

  const manifestSha256 = digest(manifest);
  if (
    installed.modelVersion !== manifest.modelVersion ||
    installed.adapterVersion !== manifest.adapterVersion ||
    installed.manifestSha256 !== manifestSha256
  ) {
    report(
      diagnostics,
      "WORKFLOW_MODEL_INSTALLATION_MISMATCH",
      `Installed ${modelName} (${installed.modelVersion}, adapter ${installed.adapterVersion}) does not match the catalog manifest (${manifest.modelVersion}, adapter ${manifest.adapterVersion}). Reinstall with \`moldesk install ${modelName} --reinstall\`.`,
      fieldPath,
    );
    return { diagnostics };
  }

  return {
    requirement: {
      name: installed.model,
      modelVersion: installed.modelVersion,
      adapterVersion: installed.adapterVersion,
      manifestSha256,
      installationId: installed.installationId,
      runtime: { kind: "python", fingerprint: installed.runtime.fingerprint },
      environmentFingerprint: installed.environmentFingerprint,
      ...(installed.source
        ? { source: { repository: installed.source.repository, revision: installed.source.revision } }
        : {}),
      assets: installed.assets.map((asset) => ({
        id: asset.id,
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
      })),
    },
    diagnostics,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function planWorkflow(source: WorkflowSource, options: PlanWorkflowOptions = {}): WorkflowPlanResult {
  const compiled = validateWorkflow(source);
  if (!compiled.valid || !compiled.workflow) {
    return { valid: false, diagnostics: compiled.diagnostics };
  }

  const workflow = compiled.workflow;
  const diagnostics: WorkflowDiagnostic[] = [];
  const supplied = options.inputs ?? {};
  const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(supplied, name);
  const declaredNames = Object.keys(workflow.spec.inputs).sort();

  for (const name of Object.keys(supplied).sort()) {
    if (!Object.prototype.hasOwnProperty.call(workflow.spec.inputs, name)) {
      report(diagnostics, "WORKFLOW_UNKNOWN_INPUT", `Unknown workflow input "${name}".`, `inputs.${name}`);
    }
  }
  for (const name of declaredNames) {
    if (!has(name)) {
      report(diagnostics, "WORKFLOW_MISSING_INPUT", `Missing workflow input "${name}".`, `inputs.${name}`);
    }
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics };

  const inputs: Record<string, WorkflowResolvedInput> = {};
  for (const name of declaredNames) {
    const declaration = workflow.spec.inputs[name]!;
    const resolved = resolveInput(declaration.type, supplied[name]!, options, `inputs.${name}`, diagnostics);
    if (resolved) inputs[name] = resolved;
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics };

  const requirements: WorkflowStepRequirement[] = [];
  for (const step of compiled.steps) {
    const operation = getWorkflowOperation(step.uses)!;
    const declarationIndex = workflow.spec.steps.findIndex((entry) => entry.id === step.id);
    const requirement: WorkflowStepRequirement = {
      stepId: step.id,
      backend: operation.backend,
      operationVersion: step.operationVersion,
    };
    if (operation.requirements.model) {
      const resolution = resolveWorkflowModelRequirement(
        operation.requirements.model,
        options.paths,
        `spec.steps[${declarationIndex}].uses`,
      );
      if (resolution.diagnostics.length > 0) diagnostics.push(...resolution.diagnostics);
      if (resolution.requirement) requirement.model = resolution.requirement;
    }
    requirements.push(requirement);
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics: withPositions(diagnostics, compiled.positionOf) };

  const workflowSha256 = sourceSha256(source);
  const planId = digest(canonicalize({ workflowSha256, inputs, steps: compiled.steps, edges: compiled.edges, requirements }));

  return {
    valid: true,
    diagnostics,
    plan: {
      schemaVersion: WORKFLOW_PLAN_SCHEMA_VERSION,
      workflowSha256,
      planId,
      inputs,
      steps: compiled.steps,
      edges: compiled.edges,
      requirements,
      diagnostics,
    },
  };
}
