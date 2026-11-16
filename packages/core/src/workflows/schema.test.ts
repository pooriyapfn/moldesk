import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { STRUCTURE_EXTENSIONS } from "../analysis/structure-input.js";
import {
  buildBoltzMonomerInput,
  MAX_PROTEIN_SEQUENCE_LENGTH,
  normalizeProteinSequence,
  WORKFLOW_OPERATION_IDS,
  WORKFLOW_OPERATIONS,
  workflowOperationCatalog,
} from "./operations.js";
import {
  MAX_WORKFLOW_BYTES,
  parseWorkflowDocument,
  parseWorkflowReference,
  workflowJsonSchema,
} from "./schema.js";

const EXAMPLES = path.resolve(import.meta.dirname, "../../../../examples/workflows");
const example = (name: string): string => fs.readFileSync(path.join(EXAMPLES, name), "utf8");
const structureWorkflow = (): string => example("structure-analysis.yaml");

function diagnosticsFor(source: string) {
  const result = parseWorkflowDocument(source);
  expect(result.valid).toBe(false);
  return result.diagnostics;
}

function expectDiagnostic(source: string, code: string, field?: string) {
  const diagnostics = diagnosticsFor(source);
  const match = diagnostics.find(
    (diagnostic) => diagnostic.code === code && (field === undefined || diagnostic.path === field),
  );
  expect(match, JSON.stringify(diagnostics)).toBeDefined();
  return match!;
}

describe("workflow examples", () => {
  it.each([
    ["structure-analysis.yaml", ["moldesk/import-structure@1", "moldesk/structure-analysis@1"]],
    ["boltz-analysis.yaml", ["moldesk/boltz@1", "moldesk/structure-analysis@1"]],
  ])("parses %s with typed operation ports", (file, uses) => {
    const result = parseWorkflowDocument(example(file));
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.workflow?.apiVersion).toBe("moldesk.ai/v1alpha1");
    expect(result.workflow?.spec.execution).toEqual({ backend: "local", cache: true, max_parallel: 1 });
    expect(result.workflow?.spec.steps.map((step) => step.uses)).toEqual(uses);

    for (const step of result.workflow?.spec.steps ?? []) {
      const operation = WORKFLOW_OPERATIONS[step.uses];
      expect(Object.keys(step.outputs)).toEqual(operation.outputs.map((output) => output.name));
      expect(step.with).toBeDefined();
      expect(operation.backend).toBe("local");
    }
  });

  it("exposes the same ports through discovery", () => {
    const catalog = workflowOperationCatalog();
    expect(catalog.map((operation) => operation.uses)).toEqual(WORKFLOW_OPERATION_IDS);
    for (const operation of catalog) {
      expect(operation.backend).toBe("local");
      expect(operation.inputs.length).toBeGreaterThan(0);
      expect(operation.outputs.length).toBeGreaterThan(0);
    }
    expect(WORKFLOW_OPERATIONS["moldesk/import-structure@1"].inputs[0].formats).toEqual(STRUCTURE_EXTENSIONS);
    const schema = workflowJsonSchema();
    expect(schema["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
    expect(JSON.stringify(schema)).toContain("moldesk/import-structure@1");
    expect(JSON.stringify(schema)).toContain("protein_sequence");
  });
});

describe("schema boundaries", () => {
  it("rejects an unknown root key", () => {
    expectDiagnostic(`${structureWorkflow()}\nextra: true\n`, "WORKFLOW_UNKNOWN_FIELD", "extra");
  });

  it("rejects an unknown nested key", () => {
    const source = structureWorkflow().replace("version: 0.1.0", "version: 0.1.0\n  extra: true");
    expectDiagnostic(source, "WORKFLOW_UNKNOWN_FIELD", "metadata.extra");
  });

  it("rejects an unknown operation port", () => {
    const source = structureWorkflow().replace("file: ${inputs.structure}", "file: ${inputs.structure}\n        nope: ${inputs.structure}");
    expectDiagnostic(source, "WORKFLOW_UNKNOWN_FIELD", "spec.steps[0].with.nope");
  });

  it.each([
    ["apiVersion: moldesk.ai/v1alpha1", "apiVersion: moldesk.ai/v2", "apiVersion"],
    ["backend: local", "backend: docker", "spec.execution.backend"],
    ["backend: local", "backend: runpod", "spec.execution.backend"],
    ["max_parallel: 1", "max_parallel: 2", "spec.execution.max_parallel"],
    ["uses: moldesk/import-structure@1", "uses: moldesk/unknown@1", "spec.steps[0].uses"],
  ])("rejects %s", (from, to, field) => {
    expectDiagnostic(structureWorkflow().replace(from, to), "WORKFLOW_INVALID_VALUE", field);
  });

  it("rejects optional inputs", () => {
    expectDiagnostic(
      structureWorkflow().replace("required: true", "required: false"),
      "WORKFLOW_INVALID_VALUE",
      "spec.inputs.structure.required",
    );
  });

  it("defaults an omitted required flag to true", () => {
    const result = parseWorkflowDocument(structureWorkflow().replace("      required: true\n", ""));
    expect(result.workflow?.spec.inputs["structure"]).toEqual({ type: "structure_file", required: true });
  });

  it("reports hyphenated keys with a plain path and position", () => {
    const source = structureWorkflow().replace("    structure:\n      type: structure_file", "    my-input:\n      type: nope");
    const diagnostic = expectDiagnostic(source, "WORKFLOW_INVALID_VALUE", "spec.inputs.my-input.type");
    expect(diagnostic.line).toBe(9);
    expect(diagnostic.column).toBe(13);
  });

  it("reports one-based positions on schema errors", () => {
    const diagnostic = expectDiagnostic(structureWorkflow().replace("moldesk.ai/v1alpha1", "moldesk.ai/v2"), "WORKFLOW_INVALID_VALUE", "apiVersion");
    expect(diagnostic.line).toBe(1);
    expect(diagnostic.column).toBeGreaterThan(0);
  });
});

describe("YAML boundaries", () => {
  it("rejects duplicate keys with a location", () => {
    const diagnostic = expectDiagnostic(
      structureWorkflow().replace("kind: Workflow", "kind: Workflow\nkind: Workflow"),
      "WORKFLOW_DUPLICATE_KEY",
    );
    expect(diagnostic.line).toBe(3);
    expect(diagnostic.column).toBe(1);
  });

  it.each([
    ["an empty", ""],
    ["a comment-only", "# nothing here\n"],
  ])("rejects %s source", (_name, source) => {
    expectDiagnostic(source, "WORKFLOW_EMPTY", "(root)");
  });

  it("keeps syntax errors when no content parses", () => {
    expectDiagnostic("]\n", "WORKFLOW_YAML_SYNTAX");
  });

  it("rejects a second document", () => {
    expectDiagnostic(`${structureWorkflow()}\n---\napiVersion: moldesk.ai/v1alpha1\n`, "WORKFLOW_MULTIPLE_DOCUMENTS");
  });

  it("rejects aliases", () => {
    const source = structureWorkflow().replace("version: 0.1.0", "version: 0.1.0\n  description: &description hello\n  aliased: *description");
    expectDiagnostic(source, "WORKFLOW_ALIAS", "metadata.aliased");
  });

  it("rejects merge keys", () => {
    const source = structureWorkflow().replace(
      "version: 0.1.0",
      "version: 0.1.0\n  description:\n    <<: { name: merged }",
    );
    expectDiagnostic(source, "WORKFLOW_MERGE_KEY", "metadata.description.<<");
  });

  it("rejects custom tags", () => {
    expectDiagnostic(structureWorkflow().replace("version: 0.1.0", "version: !semver 0.1.0"), "WORKFLOW_CUSTOM_TAG");
  });

  it.each(["!!binary AAAA", "!!timestamp 2026-01-01", "!!set {a: null}"])("rejects non-core tag %s", (value) => {
    expectDiagnostic(
      structureWorkflow().replace("version: 0.1.0", `version: ${value}`),
      "WORKFLOW_CUSTOM_TAG",
      "metadata.version",
    );
  });

  it("accepts explicit core tags", () => {
    const result = parseWorkflowDocument(structureWorkflow().replace("version: 0.1.0", "version: !!str 0.1.0"));
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects forbidden object keys", () => {
    expectDiagnostic(`${structureWorkflow()}\n__proto__: true\n`, "WORKFLOW_FORBIDDEN_KEY", "__proto__");
  });

  it("rejects oversized sources", () => {
    expectDiagnostic("a".repeat(MAX_WORKFLOW_BYTES + 1), "WORKFLOW_TOO_LARGE", "(root)");
  });
});

describe("restricted references", () => {
  it("parses both supported forms", () => {
    expect(parseWorkflowReference("${inputs.structure}")).toEqual({ kind: "input", name: "structure" });
    expect(parseWorkflowReference("${steps.import.outputs.structure}")).toEqual({
      kind: "step",
      stepId: "import",
      output: "structure",
    });
  });

  it.each([
    "prefix-${inputs.structure}",
    "${inputs.structure + 1}",
    "${steps.import.outputs.structure}/x",
    "${inputs}",
    "plain-value",
  ])("rejects %s", (value) => {
    expect(parseWorkflowReference(value)).toBeNull();
  });

  it("rejects interpolation inside a larger string", () => {
    expectDiagnostic(
      structureWorkflow().replace("file: ${inputs.structure}", "file: prefix-${inputs.structure}"),
      "WORKFLOW_INVALID_VALUE",
      "spec.steps[0].with.file",
    );
  });

  it("rejects a with key outside the operation contract", () => {
    expectDiagnostic(
      structureWorkflow().replace("file: ${inputs.structure}", "structure: ${inputs.structure}"),
      "WORKFLOW_MISSING_FIELD",
      "spec.steps[0].with.file",
    );
  });
});

describe("single-chain prediction binding", () => {
  it("normalizes a valid sequence", () => {
    expect(normalizeProteinSequence("acdefghiklmnpqrstvwy")).toBe("ACDEFGHIKLMNPQRSTVWY");
    expect(normalizeProteinSequence("  TTCCPSIVAR  ")).toBe("TTCCPSIVAR");
  });

  it("builds the one-chain, empty-MSA Boltz input", () => {
    const committed = parseYaml(fs.readFileSync(path.join(EXAMPLES, "../boltz/protein.yaml"), "utf8")) as Record<string, unknown>;
    const built = buildBoltzMonomerInput(" ttccpsivar ");
    expect(built).toEqual({ version: 1, sequences: [{ protein: { id: "A", sequence: "TTCCPSIVAR", msa: "empty" } }] });
    const shape = (value: Record<string, unknown>) => JSON.stringify(value, (key, v) => (key === "sequence" ? "" : v));
    expect(shape(built as unknown as Record<string, unknown>)).toBe(shape(committed));
    expect(() => buildBoltzMonomerInput({ sequences: [] })).toThrow(
      expect.objectContaining({ code: "INVALID_PROTEIN_SEQUENCE" }),
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["over limit", "A".repeat(MAX_PROTEIN_SEQUENCE_LENGTH + 1)],
    ["non-amino-acid", "ACD-E"],
    ["structured model job", { sequences: [] }],
  ])("rejects %s", (_name, value) => {
    expect(() => normalizeProteinSequence(value)).toThrow(
      expect.objectContaining({ code: "INVALID_PROTEIN_SEQUENCE" }),
    );
  });
});