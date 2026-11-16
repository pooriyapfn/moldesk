import Ajv from "ajv";
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Document, type ParsedNode } from "yaml";
import {
  WORKFLOW_INPUT_TYPES,
  WORKFLOW_OPERATIONS,
  WORKFLOW_OPERATION_IDS,
  type WorkflowBackend,
  type WorkflowOperation,
  type WorkflowOperationId,
  type WorkflowValueType,
} from "./operations.js";

export const WORKFLOW_API_VERSION = "moldesk.ai/v1alpha1";
export const MAX_WORKFLOW_BYTES = 256 * 1024;

const ID_SOURCE = "[a-z][a-z0-9_-]{0,63}";
const ID_PATTERN = `^${ID_SOURCE}$`;
const REFERENCE_PATTERN = `^\\$\\{inputs\\.${ID_SOURCE}\\}$|^\\$\\{steps\\.${ID_SOURCE}\\.outputs\\.${ID_SOURCE}\\}$`;
const ID_REFERENCE = new RegExp(ID_PATTERN);
const INPUT_REFERENCE = new RegExp(`^\\$\\{inputs\\.(${ID_SOURCE})\\}$`);
const STEP_REFERENCE = new RegExp(`^\\$\\{steps\\.(${ID_SOURCE})\\.outputs\\.(${ID_SOURCE})\\}$`);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CORE_TAGS = new Set(
  ["str", "int", "float", "bool", "null", "map", "seq"].map((name) => `tag:yaml.org,2002:${name}`),
);

export interface WorkflowInputDeclaration {
  type: (typeof WORKFLOW_INPUT_TYPES)[number];
  /** Optional inputs are not supported yet; every declared input must be bound. */
  required: true;
}

export interface WorkflowStep {
  id: string;
  uses: WorkflowOperationId;
  with: Record<string, string>;
  outputs: Record<string, WorkflowValueType>;
  needs: string[];
}

export interface WorkflowExecution {
  backend: WorkflowBackend;
  cache: boolean;
  max_parallel: 1;
}

export interface WorkflowDocument {
  apiVersion: typeof WORKFLOW_API_VERSION;
  kind: "Workflow";
  metadata: { name: string; version: string; description?: string };
  spec: {
    inputs: Record<string, WorkflowInputDeclaration>;
    execution: WorkflowExecution;
    steps: WorkflowStep[];
  };
}

export interface WorkflowDiagnostic {
  code: string;
  message: string;
  path: string;
  line?: number;
  column?: number;
}

export interface WorkflowSourcePosition {
  line?: number;
  column?: number;
}

export interface WorkflowParseResult {
  valid: boolean;
  diagnostics: WorkflowDiagnostic[];
  workflow?: WorkflowDocument;
  /**
   * One-based source position of a field path such as `spec.steps[1].needs[0]`.
   * Falls back to the nearest existing ancestor node; empty when none is found.
   */
  positionOf?: (fieldPath: string) => WorkflowSourcePosition;
}

export type WorkflowReference =
  | { kind: "input"; name: string }
  | { kind: "step"; stepId: string; output: string };

export function isValidWorkflowId(value: string): boolean {
  return ID_REFERENCE.test(value);
}

export function parseWorkflowReference(value: string): WorkflowReference | null {
  const input = INPUT_REFERENCE.exec(value);
  if (input) return { kind: "input", name: input[1] };
  const step = STEP_REFERENCE.exec(value);
  if (step) return { kind: "step", stepId: step[1], output: step[2] };
  return null;
}

function operationCondition(operation: WorkflowOperation): Record<string, unknown> {
  const required = operation.inputs.filter((input) => input.required).map((input) => input.name);
  return {
    if: { properties: { uses: { const: operation.uses } }, required: ["uses"] },
    then: {
      properties: {
        with: {
          type: "object",
          additionalProperties: false,
          ...(required.length > 0 ? { required } : {}),
          properties: Object.fromEntries(
            operation.inputs.map((input) => [input.name, { type: "string", pattern: REFERENCE_PATTERN }]),
          ),
        },
        outputs: {
          type: "object",
          additionalProperties: false,
          required: operation.outputs.map((output) => output.name),
          properties: Object.fromEntries(
            operation.outputs.map((output) => [output.name, { const: output.type }]),
          ),
        },
      },
    },
  };
}

function buildWorkflowJsonSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `https://moldesk.dev/schemas/workflows/${WORKFLOW_API_VERSION}`,
    title: "MoleculeDesk Workflow",
    type: "object",
    additionalProperties: false,
    required: ["apiVersion", "kind", "metadata", "spec"],
    properties: {
      apiVersion: { const: WORKFLOW_API_VERSION },
      kind: { const: "Workflow" },
      metadata: {
        type: "object",
        additionalProperties: false,
        required: ["name", "version"],
        properties: {
          name: { type: "string", pattern: ID_PATTERN, maxLength: 64 },
          version: { type: "string", minLength: 1, maxLength: 64, pattern: "^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$" },
          description: { type: "string", maxLength: 1000 },
        },
      },
      spec: {
        type: "object",
        additionalProperties: false,
        required: ["inputs", "execution", "steps"],
        properties: {
          inputs: {
            type: "object",
            propertyNames: { pattern: ID_PATTERN },
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              required: ["type"],
              properties: {
                type: { enum: WORKFLOW_INPUT_TYPES },
                required: { const: true, default: true },
              },
            },
          },
          execution: {
            type: "object",
            additionalProperties: false,
            required: ["backend"],
            properties: {
              backend: { const: "local" },
              cache: { type: "boolean", default: true },
              max_parallel: { const: 1, default: 1 },
            },
          },
          steps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "uses", "with", "outputs"],
              properties: {
                id: { type: "string", pattern: ID_PATTERN, maxLength: 64 },
                uses: { enum: WORKFLOW_OPERATION_IDS },
                with: { type: "object" },
                outputs: { type: "object" },
                needs: { type: "array", items: { type: "string", pattern: ID_PATTERN }, default: [] },
              },
              allOf: Object.values(WORKFLOW_OPERATIONS).map(operationCondition),
            },
          },
        },
      },
    },
  };
}

const WORKFLOW_JSON_SCHEMA = buildWorkflowJsonSchema();
const validateWorkflowDocument = new Ajv({ allErrors: true, jsonPointers: true }).compile(WORKFLOW_JSON_SCHEMA);

export function workflowJsonSchema(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(WORKFLOW_JSON_SCHEMA)) as Record<string, unknown>;
}

function pathText(parts: readonly string[]): string {
  if (parts.length === 0) return "(root)";
  return parts.reduce((text, part) => {
    if (/^\d+$/.test(part)) return `${text}[${part}]`;
    return text.length === 0 ? part : `${text}.${part}`;
  }, "");
}

function pointerParts(pointer: string): string[] {
  if (!pointer) return [];
  if (pointer.startsWith("/")) {
    return pointer
      .split("/")
      .slice(1)
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  const parts: string[] = [];
  for (const match of pointer.matchAll(/\[(\d+)\]|\.?([^.[\]]+)/g)) {
    const part = match[1] ?? match[2];
    if (part !== undefined) parts.push(part);
  }
  return parts;
}

function position(node: ParsedNode | null | undefined, lineCounter: LineCounter) {
  if (!node?.range) return {};
  const pos = lineCounter.linePos(node.range[0]);
  return { line: pos.line, column: pos.col };
}

function locate(node: ParsedNode | null, parts: readonly string[]): ParsedNode | null {
  let current = node;
  for (const part of parts) {
    if (isMap(current)) {
      const pair = current.items.find((item) => isScalar(item.key) && String(item.key.value) === part);
      current = (pair?.value as ParsedNode | null | undefined) ?? null;
    } else if (isSeq(current)) {
      current = (current.items[Number(part)] as ParsedNode | null | undefined) ?? null;
    } else {
      return null;
    }
    if (!current) return null;
  }
  return current;
}

function report(
  diagnostics: WorkflowDiagnostic[],
  code: string,
  message: string,
  path: string,
  node?: ParsedNode | null,
  lineCounter?: LineCounter,
): void {
  diagnostics.push({
    code,
    message,
    path,
    ...(lineCounter ? position(node, lineCounter) : {}),
  });
}

function walkYaml(
  node: ParsedNode | null,
  parts: readonly string[],
  lineCounter: LineCounter,
  diagnostics: WorkflowDiagnostic[],
): void {
  if (!node) return;
  const path = pathText(parts);
  if (isAlias(node)) {
    report(diagnostics, "WORKFLOW_ALIAS", "YAML aliases are not supported; use literal values.", path, node, lineCounter);
    return;
  }
  if (node.tag && !CORE_TAGS.has(node.tag)) {
    report(diagnostics, "WORKFLOW_CUSTOM_TAG", `YAML tag "${node.tag}" is not supported.`, path, node, lineCounter);
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
      const child = key === undefined ? parts : [...parts, key];
      if (pair.key) walkYaml(pair.key, child, lineCounter, diagnostics);
      if (key === "<<") {
        report(diagnostics, "WORKFLOW_MERGE_KEY", "YAML merge keys are not supported.", pathText(child), pair.key, lineCounter);
      } else if (key !== undefined && FORBIDDEN_KEYS.has(key)) {
        report(diagnostics, "WORKFLOW_FORBIDDEN_KEY", `Forbidden object key "${key}".`, pathText(child), pair.key, lineCounter);
      }
      walkYaml(pair.value as ParsedNode | null, child, lineCounter, diagnostics);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => {
      walkYaml(item as ParsedNode | null, [...parts, String(index)], lineCounter, diagnostics);
    });
  }
}

function normalizeWorkflow(value: Record<string, unknown>): WorkflowDocument {
  const metadata = value["metadata"] as Record<string, unknown>;
  const spec = value["spec"] as Record<string, unknown>;
  const execution = spec["execution"] as Record<string, unknown>;
  const inputs = spec["inputs"] as Record<string, { type: WorkflowInputDeclaration["type"]; required?: boolean }>;
  const steps = spec["steps"] as Array<{
    id: string;
    uses: WorkflowOperationId;
    with: Record<string, string>;
    outputs: Record<string, WorkflowValueType>;
    needs?: string[];
  }>;

  return {
    apiVersion: WORKFLOW_API_VERSION,
    kind: "Workflow",
    metadata: {
      name: String(metadata["name"]),
      version: String(metadata["version"]),
      ...(metadata["description"] !== undefined ? { description: String(metadata["description"]) } : {}),
    },
    spec: {
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([name, declaration]) => [
          name,
          { type: declaration.type, required: true },
        ]),
      ),
      execution: {
        backend: "local",
        cache: execution["cache"] === undefined ? true : Boolean(execution["cache"]),
        max_parallel: 1,
      },
      steps: steps.map((step) => ({
        id: step.id,
        uses: step.uses,
        with: { ...step.with },
        outputs: { ...step.outputs },
        needs: step.needs ?? [],
      })),
    },
  };
}

export function parseWorkflowDocument(source: string): WorkflowParseResult {
  const diagnostics: WorkflowDiagnostic[] = [];
  if (typeof source !== "string") {
    return {
      valid: false,
      diagnostics: [{ code: "WORKFLOW_INVALID_SOURCE", message: "Workflow source must be text.", path: "(root)" }],
    };
  }
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) {
    return {
      valid: false,
      diagnostics: [
        {
          code: "WORKFLOW_TOO_LARGE",
          message: `Workflow source exceeds ${MAX_WORKFLOW_BYTES} bytes.`,
          path: "(root)",
        },
      ],
    };
  }

  const lineCounter = new LineCounter();
  let documents: Document.Parsed[];
  try {
    documents = parseAllDocuments(source, { lineCounter, prettyErrors: false, uniqueKeys: true, customTags: [] });
  } catch (error) {
    return {
      valid: false,
      diagnostics: [
        {
          code: "WORKFLOW_YAML_SYNTAX",
          message: `YAML parse failed: ${error instanceof Error ? error.message : String(error)}`,
          path: "(root)",
        },
      ],
    };
  }

  if (documents.length > 1) {
    const second = documents[1];
    report(
      diagnostics,
      "WORKFLOW_MULTIPLE_DOCUMENTS",
      "A workflow must contain exactly one YAML document.",
      "(root)",
      second.contents,
      lineCounter,
    );
    return { valid: false, diagnostics };
  }

  const document = documents[0];
  if (!document || (document.contents === null && document.errors.length === 0)) {
    return {
      valid: false,
      diagnostics: [{ code: "WORKFLOW_EMPTY", message: "Workflow source contains no YAML document.", path: "(root)" }],
    };
  }
  for (const error of document.errors) {
    diagnostics.push({
      code: error.code === "DUPLICATE_KEY" ? "WORKFLOW_DUPLICATE_KEY" : "WORKFLOW_YAML_SYNTAX",
      message: error.message,
      path: "(root)",
      ...positionAtOffset(error.pos[0], lineCounter),
    });
  }
  // Unresolved tags surface only as warnings; the tag walk below reports them with a field path.
  for (const warning of document.warnings) {
    if (warning.code === "TAG_RESOLVE_FAILED") continue;
    diagnostics.push({
      code: "WORKFLOW_YAML_WARNING",
      message: warning.message,
      path: "(root)",
      ...positionAtOffset(warning.pos[0], lineCounter),
    });
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics };

  walkYaml(document.contents, [], lineCounter, diagnostics);
  if (diagnostics.length > 0) return { valid: false, diagnostics };

  let value: unknown;
  try {
    value = document.toJS();
  } catch (error) {
    return {
      valid: false,
      diagnostics: [
        {
          code: "WORKFLOW_YAML_SYNTAX",
          message: `YAML conversion failed: ${error instanceof Error ? error.message : String(error)}`,
          path: "(root)",
        },
      ],
    };
  }

  if (!validateWorkflowDocument(value)) {
    for (const error of validateWorkflowDocument.errors ?? []) {
      if (error.keyword === "if") continue;
      const pointer = (error as { instancePath?: string; dataPath?: string }).instancePath ?? (error as { dataPath?: string }).dataPath ?? "";
      const base = pointerParts(pointer);
      const params = error.params as Record<string, unknown>;
      const parts =
        error.keyword === "additionalProperties"
          ? [...base, String(params["additionalProperty"])]
          : error.keyword === "required"
            ? [...base, String(params["missingProperty"])]
            : base;
      const node = locate(document.contents, parts) ?? locate(document.contents, base);
      diagnostics.push({
        code:
          error.keyword === "additionalProperties"
            ? "WORKFLOW_UNKNOWN_FIELD"
            : error.keyword === "required"
              ? "WORKFLOW_MISSING_FIELD"
              : "WORKFLOW_INVALID_VALUE",
        message: `${pathText(parts)}: ${error.message ?? "invalid value"}`,
        path: pathText(parts),
        ...position(node, lineCounter),
      });
    }
    return { valid: false, diagnostics };
  }

  const contents = document.contents;
  const positionOf = (fieldPath: string): WorkflowSourcePosition => {
    const parts = pointerParts(fieldPath);
    for (let length = parts.length; length >= 0; length--) {
      const node = locate(contents, parts.slice(0, length));
      if (node) return position(node, lineCounter);
    }
    return {};
  };
  return { valid: true, diagnostics, workflow: normalizeWorkflow(value as Record<string, unknown>), positionOf };
}

function positionAtOffset(offset: number, lineCounter: LineCounter): { line: number; column: number } {
  const pos = lineCounter.linePos(offset);
  return { line: pos.line, column: pos.col };
}