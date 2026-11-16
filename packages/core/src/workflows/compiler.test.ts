import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAvailableModels } from "@moldesk/registry";
import { getMoldeskPaths, modelInstallDir, type MoldeskPaths } from "@moldesk/runtime";
import { digest } from "../hash.js";
import { writeInstallState, type InstalledModel } from "../install-state.js";
import { planWorkflow, validateWorkflow, type WorkflowCompileResult } from "./compiler.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EXAMPLES = path.join(REPO_ROOT, "examples/workflows");
const FIXTURE = path.join(REPO_ROOT, "packages/visualizer/test/fixtures/1CRN.pdb");
const SEQUENCE = "TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN";

// Pass-through spies: compiling and planning must never launch a runner or any other process.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    exec: vi.fn(actual.exec),
    execSync: vi.fn(actual.execSync),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
    fork: vi.fn(actual.fork),
  };
});

const PROCESS_LAUNCHERS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

function launchCount(): number {
  return PROCESS_LAUNCHERS.reduce(
    (total, name) => total + vi.mocked(childProcess[name] as (...args: unknown[]) => unknown).mock.calls.length,
    0,
  );
}

beforeEach(() => {
  for (const name of PROCESS_LAUNCHERS) vi.mocked(childProcess[name] as (...args: unknown[]) => unknown).mockClear();
});

const temporaries: string[] = [];

function tempDir(prefix = "moldesk-workflow-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

function testPaths(): MoldeskPaths {
  return getMoldeskPaths({ MOLDESK_HOME: path.join(tempDir(), "home") });
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function example(name: string): string {
  return fs.readFileSync(path.join(EXAMPLES, name), "utf8");
}

function workflow(steps: string, inputs = "    structure:\n      type: structure_file\n      required: true\n"): string {
  return `apiVersion: moldesk.ai/v1alpha1
kind: Workflow
metadata:
  name: test
  version: 0.1.0
spec:
  inputs:
${inputs}
  execution:
    backend: local
    cache: true
    max_parallel: 1
  steps:
${steps}`;
}

function expectDiagnostic(result: WorkflowCompileResult, code: string, fieldPath?: string) {
  expect(result.valid).toBe(false);
  const match = result.diagnostics.find(
    (diagnostic) => diagnostic.code === code && (fieldPath === undefined || diagnostic.path === fieldPath),
  );
  expect(match, JSON.stringify(result.diagnostics)).toBeDefined();
  return match!;
}

function installFakeBoltz(paths: MoldeskPaths, fingerprint: string): void {
  const manifest = listAvailableModels().find((entry) => entry.name === "boltz")!;
  const installDir = modelInstallDir(manifest.name, manifest.modelVersion, fingerprint, {
    MOLDESK_HOME: paths.home,
  });
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

describe("DAG resolution", () => {
  it("executes a later-declared prerequisite first", () => {
    const source = workflow(`    - id: analyze
      uses: moldesk/structure-analysis@1
      needs: [import]
      with:
        structure: \${steps.import.outputs.structure}
      outputs:
        report: json
    - id: import
      uses: moldesk/import-structure@1
      with:
        file: \${inputs.structure}
      outputs:
        structure: protein_structure
`);
    const result = validateWorkflow(source);
    expect(result.valid).toBe(true);
    expect(result.steps.map((step) => step.id)).toEqual(["import", "analyze"]);
    expect(result.edges).toEqual([{ from: "import", to: "analyze" }]);
  });

  it("keeps disconnected ready nodes in declaration order", () => {
    const source = workflow(`    - id: left
      uses: moldesk/import-structure@1
      with:
        file: \${inputs.structure}
      outputs:
        structure: protein_structure
    - id: right
      uses: moldesk/import-structure@1
      with:
        file: \${inputs.structure}
      outputs:
        structure: protein_structure
`);
    const result = validateWorkflow(source);
    expect(result.valid).toBe(true);
    expect(result.steps.map((step) => step.id)).toEqual(["left", "right"]);
    expect(result.edges).toEqual([]);
  });

  it("emits typed bindings and edges that match needs", () => {
    const result = validateWorkflow(example("structure-analysis.yaml"));
    expect(result.valid).toBe(true);
    expect(result.steps[0]!.bindings).toEqual([
      { input: "file", type: "structure_file", source: { kind: "input", name: "structure" } },
    ]);
    expect(result.steps[1]!.bindings).toEqual([
      {
        input: "structure",
        type: "protein_structure",
        source: { kind: "step", stepId: "import", output: "structure" },
      },
    ]);
    expect(result.edges).toEqual([{ from: "import", to: "analyze" }]);
  });
});

describe("broken DAGs", () => {
  it("rejects duplicate step ids", () => {
    const result = validateWorkflow(example("structure-analysis.yaml").replace("id: analyze", "id: import"));
    expectDiagnostic(result, "WORKFLOW_DUPLICATE_STEP", "spec.steps[1].id");
  });

  it("rejects a self edge", () => {
    const source = example("structure-analysis.yaml").replace(
      "      uses: moldesk/import-structure@1\n      with:",
      "      uses: moldesk/import-structure@1\n      needs: [import]\n      with:",
    );
    expectDiagnostic(validateWorkflow(source), "WORKFLOW_SELF_DEPENDENCY", "spec.steps[0].needs[0]");
  });

  it("rejects a cycle", () => {
    const source = workflow(`    - id: import
      uses: moldesk/import-structure@1
      needs: [analyze]
      with:
        file: \${inputs.structure}
      outputs:
        structure: protein_structure
    - id: analyze
      uses: moldesk/structure-analysis@1
      needs: [import]
      with:
        structure: \${steps.import.outputs.structure}
      outputs:
        report: json
`);
    expectDiagnostic(validateWorkflow(source), "WORKFLOW_CYCLE");
  });

  it("rejects duplicate and unknown dependencies", () => {
    const duplicate = example("structure-analysis.yaml").replace("needs: [import]", "needs: [import, import]");
    expectDiagnostic(validateWorkflow(duplicate), "WORKFLOW_DUPLICATE_DEPENDENCY", "spec.steps[1].needs[1]");
    const unknown = example("structure-analysis.yaml").replace("needs: [import]", "needs: [nope]");
    expectDiagnostic(validateWorkflow(unknown), "WORKFLOW_UNKNOWN_DEPENDENCY", "spec.steps[1].needs[0]");
  });

  it("rejects a step reference without a direct needs dependency", () => {
    const source = example("structure-analysis.yaml").replace("      needs: [import]\n", "");
    expectDiagnostic(validateWorkflow(source), "WORKFLOW_UNDECLARED_DEPENDENCY", "spec.steps[1].with.structure");
  });

  it("rejects unknown input, step, and output references", () => {
    const unknownInput = example("structure-analysis.yaml").replace("file: ${inputs.structure}", "file: ${inputs.nope}");
    expectDiagnostic(validateWorkflow(unknownInput), "WORKFLOW_UNKNOWN_INPUT", "spec.steps[0].with.file");
    const unknownStep = example("structure-analysis.yaml").replace(
      "structure: ${steps.import.outputs.structure}",
      "structure: ${steps.nope.outputs.structure}",
    );
    expectDiagnostic(validateWorkflow(unknownStep), "WORKFLOW_UNKNOWN_STEP", "spec.steps[1].with.structure");
    const unknownOutput = example("structure-analysis.yaml").replace(
      "structure: ${steps.import.outputs.structure}",
      "structure: ${steps.import.outputs.report}",
    );
    expectDiagnostic(validateWorkflow(unknownOutput), "WORKFLOW_UNKNOWN_OUTPUT", "spec.steps[1].with.structure");
  });

  it("rejects input and output type mismatches", () => {
    const source = example("structure-analysis.yaml")
      .replace("structure: ${steps.import.outputs.structure}", "structure: ${inputs.structure}")
      .replace("      needs: [import]\n", "");
    expectDiagnostic(validateWorkflow(source), "WORKFLOW_TYPE_MISMATCH", "spec.steps[1].with.structure");
  });
});

describe("diagnostic positions", () => {
  function lineOf(source: string, needle: string, occurrence = 0): number {
    const lines = source.split("\n");
    const matches = lines.flatMap((line, index) => (line.includes(needle) ? [index + 1] : []));
    return matches[occurrence]!;
  }

  it("attaches one-based line and column to compiler diagnostics", () => {
    const source = example("structure-analysis.yaml").replace("needs: [import]", "needs: [import, import]");
    const diagnostic = expectDiagnostic(
      validateWorkflow(source),
      "WORKFLOW_DUPLICATE_DEPENDENCY",
      "spec.steps[1].needs[1]",
    );
    expect(diagnostic.line).toBe(lineOf(source, "needs: [import, import]"));
    expect(diagnostic.column).toBe(source.split("\n")[diagnostic.line! - 1]!.lastIndexOf("import") + 1);
  });

  it("points a missing-needs reference at its with binding", () => {
    const source = example("structure-analysis.yaml").replace("      needs: [import]\n", "");
    const diagnostic = expectDiagnostic(
      validateWorkflow(source),
      "WORKFLOW_UNDECLARED_DEPENDENCY",
      "spec.steps[1].with.structure",
    );
    expect(diagnostic.line).toBe(lineOf(source, "${steps.import.outputs.structure}"));
  });

  it("falls back to the nearest existing node when the field is absent", () => {
    const source = workflow(`    - id: import
      uses: moldesk/import-structure@1
      needs: [analyze]
      with:
        file: \${inputs.structure}
      outputs:
        structure: protein_structure
    - id: analyze
      uses: moldesk/structure-analysis@1
      needs: [import]
      with:
        structure: \${steps.import.outputs.structure}
      outputs:
        report: json
`);
    const diagnostic = expectDiagnostic(validateWorkflow(source), "WORKFLOW_CYCLE", "spec.steps[0].needs");
    expect(diagnostic.line).toBe(lineOf(source, "needs: [analyze]"));
  });

  it("positions planning diagnostics that name a workflow field", () => {
    const source = example("boltz-analysis.yaml");
    const result = planWorkflow(source, { inputs: { sequence: SEQUENCE }, paths: testPaths() });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "WORKFLOW_MODEL_NOT_INSTALLED",
        line: lineOf(source, "uses: moldesk/boltz@1"),
      }),
    );
  });
});

describe("planning", () => {
  it("plans the CPU example in an empty home", () => {
    const result = planWorkflow(example("structure-analysis.yaml"), {
      inputs: { structure: FIXTURE },
      paths: testPaths(),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
    const plan = result.plan!;
    expect(plan.schemaVersion).toBe(1);
    expect(plan.workflowSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.inputs["structure"]).toMatchObject({
      type: "structure_file",
      value: FIXTURE,
      format: "pdb",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(plan.inputs["structure"]!.sizeBytes).toBe(fs.statSync(FIXTURE).size);
    expect(plan.steps.map((step) => step.id)).toEqual(["import", "analyze"]);
    expect(plan.edges).toEqual([{ from: "import", to: "analyze" }]);
    expect(plan.requirements).toEqual([
      { stepId: "import", backend: "local", operationVersion: 1 },
      { stepId: "analyze", backend: "local", operationVersion: 1 },
    ]);
  });

  it("rejects missing and extra input values", () => {
    const paths = testPaths();
    const missing = planWorkflow(example("structure-analysis.yaml"), { inputs: {}, paths });
    expect(missing.valid).toBe(false);
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: "WORKFLOW_MISSING_INPUT", path: "inputs.structure" }));

    const extra = planWorkflow(example("structure-analysis.yaml"), {
      inputs: { structure: FIXTURE, nope: "x" },
      paths,
    });
    expect(extra.valid).toBe(false);
    expect(extra.diagnostics).toContainEqual(expect.objectContaining({ code: "WORKFLOW_UNKNOWN_INPUT", path: "inputs.nope" }));
  });

  it("reports a missing Boltz installation without installing anything", () => {
    const paths = testPaths();
    const result = planWorkflow(example("boltz-analysis.yaml"), { inputs: { sequence: SEQUENCE }, paths });
    expect(result.plan).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WORKFLOW_MODEL_NOT_INSTALLED", path: "spec.steps[0].uses" }),
    );
    expect(fs.existsSync(paths.models)).toBe(false);
  });

  it("hashes raw workflow bytes exactly, including non-UTF-8 bytes", () => {
    const bytes = Buffer.concat([fs.readFileSync(path.join(EXAMPLES, "structure-analysis.yaml")), Buffer.from([0x0a, 0x23, 0x20, 0xff, 0x0a])]);
    const result = planWorkflow(bytes, { inputs: { structure: FIXTURE }, paths: testPaths() });
    expect(result.diagnostics).toEqual([]);
    expect(result.plan!.workflowSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("never launches a process or writes run records while validating and planning", () => {
    const paths = testPaths();
    installFakeBoltz(paths, `python-${"a".repeat(64)}`);
    expect(validateWorkflow(example("boltz-analysis.yaml")).valid).toBe(true);
    expect(planWorkflow(example("boltz-analysis.yaml"), { inputs: { sequence: SEQUENCE }, paths }).valid).toBe(true);
    expect(planWorkflow(example("structure-analysis.yaml"), { inputs: { structure: FIXTURE }, paths }).valid).toBe(true);
    expect(launchCount()).toBe(0);
    expect(fs.existsSync(paths.runs)).toBe(false);
  });

  it("records the installed model receipt for a Boltz plan", () => {
    const paths = testPaths();
    installFakeBoltz(paths, `python-${"a".repeat(64)}`);
    const result = planWorkflow(example("boltz-analysis.yaml"), { inputs: { sequence: SEQUENCE }, paths });
    expect(result.valid).toBe(true);
    const requirement = result.plan!.requirements.find((entry) => entry.stepId === "predict");
    expect(requirement?.model).toMatchObject({
      name: "boltz",
      runtime: { kind: "python", fingerprint: `python-${"a".repeat(64)}` },
      source: { repository: expect.stringContaining("boltz") },
      assets: expect.arrayContaining([expect.objectContaining({ id: "boltz2-conf-checkpoint" })]),
    });
  });
});

describe("file access", () => {
  it("resolves CLI-relative paths, including paths with spaces", () => {
    const cwd = tempDir();
    const directory = path.join(cwd, "dir with space");
    fs.mkdirSync(directory);
    fs.copyFileSync(FIXTURE, path.join(directory, "1CRN.pdb"));
    const result = planWorkflow(example("structure-analysis.yaml"), {
      inputs: { structure: "dir with space/1CRN.pdb" },
      cwd,
      paths: testPaths(),
    });
    expect(result.valid).toBe(true);
    expect(result.plan!.inputs["structure"]!.value).toBe(path.join(directory, "1CRN.pdb"));
  });

  it("rejects relative and absolute paths outside an enforced workspace root", () => {
    const parent = tempDir();
    const root = path.join(parent, "workspace");
    fs.mkdirSync(root);
    const outside = path.join(parent, "outside.pdb");
    fs.copyFileSync(FIXTURE, outside);

    const relative = planWorkflow(example("structure-analysis.yaml"), {
      inputs: { structure: "../outside.pdb" },
      workspaceRoot: root,
      paths: testPaths(),
    });
    expect(relative.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WORKFLOW_INPUT_OUTSIDE_WORKSPACE", path: "inputs.structure" }),
    );

    const absolute = planWorkflow(example("structure-analysis.yaml"), {
      inputs: { structure: outside },
      workspaceRoot: root,
      paths: testPaths(),
    });
    expect(absolute.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WORKFLOW_INPUT_OUTSIDE_WORKSPACE", path: "inputs.structure" }),
    );
  });

  it("rejects a symlink that escapes the workspace root", () => {
    const parent = tempDir();
    const root = path.join(parent, "workspace");
    fs.mkdirSync(root);
    const outside = path.join(parent, "outside.pdb");
    fs.copyFileSync(FIXTURE, outside);
    fs.symlinkSync(outside, path.join(root, "link.pdb"));

    const result = planWorkflow(example("structure-analysis.yaml"), {
      inputs: { structure: "link.pdb" },
      workspaceRoot: root,
      paths: testPaths(),
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WORKFLOW_INPUT_OUTSIDE_WORKSPACE", path: "inputs.structure" }),
    );
  });

  it("rejects directories, unsupported formats, and oversized inputs", () => {
    const directory = path.join(tempDir(), "structure.pdb");
    fs.mkdirSync(directory);
    const asDirectory = planWorkflow(example("structure-analysis.yaml"), {
      inputs: { structure: directory },
      paths: testPaths(),
    });
    expect(asDirectory.diagnostics).toContainEqual(
      expect.objectContaining({ code: "INPUT_NOT_FOUND", path: "inputs.structure" }),
    );

    const textFile = path.join(tempDir(), "structure.txt");
    fs.copyFileSync(FIXTURE, textFile);
    const badFormat = planWorkflow(example("structure-analysis.yaml"), {
      inputs: { structure: textFile },
      paths: testPaths(),
    });
    expect(badFormat.diagnostics).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_STRUCTURE_FORMAT", path: "inputs.structure" }),
    );

    const oversized = path.join(tempDir(), "oversized.pdb");
    fs.writeFileSync(oversized, "");
    fs.truncateSync(oversized, 65 * 1024 * 1024);
    const tooLarge = planWorkflow(example("structure-analysis.yaml"), {
      inputs: { structure: oversized },
      paths: testPaths(),
    });
    expect(tooLarge.diagnostics).toContainEqual(
      expect.objectContaining({ code: "INPUT_TOO_LARGE", path: "inputs.structure" }),
    );
  });
});

describe("determinism", () => {
  const twoInputs = workflow(
    `    - id: first
      uses: moldesk/import-structure@1
      with:
        file: \${inputs.first}
      outputs:
        structure: protein_structure
    - id: second
      uses: moldesk/import-structure@1
      with:
        file: \${inputs.second}
      outputs:
        structure: protein_structure
`,
    "    first:\n      type: structure_file\n      required: true\n    second:\n      type: structure_file\n      required: true\n",
  );

  it("replans identical YAML and input bytes with reordered input keys", () => {
    const paths = testPaths();
    const one = planWorkflow(twoInputs, { inputs: { first: FIXTURE, second: FIXTURE }, paths });
    const two = planWorkflow(twoInputs, { inputs: { second: FIXTURE, first: FIXTURE }, paths });
    expect(one.valid && two.valid).toBe(true);
    expect(one.plan!.planId).toBe(two.plan!.planId);
    expect(Object.keys(one.plan!.inputs)).toEqual(["first", "second"]);
    expect(one.plan!.steps).toEqual(two.plan!.steps);
  });

  it("changes the plan id when YAML bytes or the input file change", () => {
    const paths = testPaths();
    const base = planWorkflow(example("structure-analysis.yaml"), { inputs: { structure: FIXTURE }, paths });
    const edited = planWorkflow(
      example("structure-analysis.yaml").replace("  version: 0.1.0", "  version: 0.1.0\n  description: edited"),
      { inputs: { structure: FIXTURE }, paths },
    );
    expect(base.plan!.planId).not.toBe(edited.plan!.planId);

    const copy = path.join(tempDir(), "1CRN.pdb");
    fs.copyFileSync(FIXTURE, copy);
    const before = planWorkflow(example("structure-analysis.yaml"), { inputs: { structure: copy }, paths });
    fs.appendFileSync(copy, "\n");
    const after = planWorkflow(example("structure-analysis.yaml"), { inputs: { structure: copy }, paths });
    expect(before.plan!.planId).not.toBe(after.plan!.planId);
  });

  it("changes the plan id when the installation fingerprint changes", () => {
    const firstPaths = testPaths();
    installFakeBoltz(firstPaths, `python-${"a".repeat(64)}`);
    const first = planWorkflow(example("boltz-analysis.yaml"), { inputs: { sequence: SEQUENCE }, paths: firstPaths });

    const secondPaths = testPaths();
    installFakeBoltz(secondPaths, `python-${"b".repeat(64)}`);
    const second = planWorkflow(example("boltz-analysis.yaml"), { inputs: { sequence: SEQUENCE }, paths: secondPaths });

    expect(first.valid && second.valid).toBe(true);
    expect(first.plan!.planId).not.toBe(second.plan!.planId);
  });
});
