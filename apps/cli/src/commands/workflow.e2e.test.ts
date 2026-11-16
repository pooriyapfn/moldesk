import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerWorkflowCommand } from "./workflow.js";

// Runs the real @moldesk/core compiler (no mocks) through the CLI command.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EXAMPLE = path.join(REPO_ROOT, "examples/workflows/structure-analysis.yaml");
const BOLTZ_EXAMPLE = path.join(REPO_ROOT, "examples/workflows/boltz-analysis.yaml");
const FIXTURE = path.join(REPO_ROOT, "packages/visualizer/test/fixtures/1CRN.pdb");

let logs: string[];
let errors: string[];
let temporary: string;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  logs = [];
  errors = [];
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((value: unknown) => void logs.push(String(value)));
  vi.spyOn(console, "error").mockImplementation((value: unknown) => void errors.push(String(value)));
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-workflow-e2e-"));
  home = path.join(temporary, "home");
  previousHome = process.env["MOLDESK_HOME"];
  process.env["MOLDESK_HOME"] = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (previousHome === undefined) delete process.env["MOLDESK_HOME"];
  else process.env["MOLDESK_HOME"] = previousHome;
  fs.rmSync(temporary, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerWorkflowCommand(program);
  await program.parseAsync(["workflow", ...args], { from: "user" });
}

function singleJson(): Record<string, unknown> {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]!) as Record<string, unknown>;
}

/** Planning may read installation state but must never create run, model, or state records. */
function expectNoHomeWrites(): void {
  expect(fs.existsSync(home) ? fs.readdirSync(home, { recursive: true }) : []).toEqual([]);
}

describe("moldesk workflow (real compiler)", () => {
  it("validates the offline example", async () => {
    await run("validate", EXAMPLE, "--json");
    expect(singleJson()).toMatchObject({ status: "ok", valid: true, order: ["import", "analyze"] });
    expect(process.exitCode).toBeUndefined();
    expectNoHomeWrites();
  });

  it("plans the offline example in a clean home with a byte-exact source hash", async () => {
    await run("plan", EXAMPLE, "--input", `structure=${FIXTURE}`, "--json");
    const plan = singleJson();
    expect(plan).toMatchObject({
      status: "ok",
      schemaVersion: 1,
      workflowSha256: createHash("sha256").update(fs.readFileSync(EXAMPLE)).digest("hex"),
      edges: [{ from: "import", to: "analyze" }],
      inputs: { structure: { value: FIXTURE, format: "pdb", sizeBytes: fs.statSync(FIXTURE).size } },
    });
    expect((plan["steps"] as Array<{ id: string }>).map((step) => step.id)).toEqual(["import", "analyze"]);
    expect(process.exitCode).toBeUndefined();

    logs = [];
    await run("plan", EXAMPLE, "--input", `structure=${FIXTURE}`, "--json");
    expect(singleJson()["planId"]).toBe(plan["planId"]);
    expectNoHomeWrites();
  });

  it("returns one JSON error with positioned diagnostics for an invalid DAG and exits 2", async () => {
    const source = fs
      .readFileSync(EXAMPLE, "utf8")
      .replace("      uses: moldesk/import-structure@1\n", "      uses: moldesk/import-structure@1\n      needs: [analyze]\n");
    const file = path.join(temporary, "cycle.yaml");
    fs.writeFileSync(file, source);
    await run("validate", file, "--json");
    const output = singleJson();
    expect(output).toMatchObject({ status: "error", code: "WORKFLOW_INVALID" });
    const diagnostics = (output["details"] as { diagnostics: Array<Record<string, unknown>> }).diagnostics;
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "WORKFLOW_CYCLE", line: expect.any(Number), column: expect.any(Number) }),
    );
    expect(process.exitCode).toBe(2);
    expectNoHomeWrites();
  });

  it("reports an unavailable Boltz backend as a planning error with exit 2", async () => {
    await run("plan", BOLTZ_EXAMPLE, "--input", "sequence=TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN", "--json");
    const output = singleJson();
    expect(output).toMatchObject({ status: "error", code: "WORKFLOW_PLAN_FAILED" });
    expect((output["details"] as { diagnostics: unknown[] }).diagnostics).toContainEqual(
      expect.objectContaining({ code: "WORKFLOW_MODEL_NOT_INSTALLED", path: "spec.steps[0].uses", line: expect.any(Number) }),
    );
    expect(process.exitCode).toBe(2);
    expectNoHomeWrites();
  });
});
