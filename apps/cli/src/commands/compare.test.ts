import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { validateEnvelope } from "@moldesk/core";
import { registerCompareCommand } from "./compare.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../../../packages/visualizer/test/fixtures");
const CAPTURE = path.resolve(import.meta.dirname, "../../../../packages/core/src/analysis/testdata/usalign");
const CRN = path.join(FIXTURES, "1CRN.pdb");

const state = vi.hoisted(() => ({ paths: undefined as unknown, runner: undefined as unknown }));

// Run the real comparison, but through a stub runner and a scratch MOLDESK_HOME.
vi.mock("@moldesk/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moldesk/core")>();
  return {
    ...actual,
    compareStructureFiles: (a: string, b: string, options: object) =>
      actual.compareStructureFiles(a, b, { ...options, paths: state.paths as never, runner: state.runner as never }),
  };
});

let dir: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-cli-compare-"));
  const { getMoldeskPaths } = await import("@moldesk/core");
  state.paths = getMoldeskPaths({ MOLDESK_HOME: path.join(dir, "home") });
  state.runner = async () => ({ code: 0, stdout: fs.readFileSync(path.join(CAPTURE, "crn-to-moved.txt"), "utf8"), stderr: "" });
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A valid installation record around a placeholder binary, so the stub runner is reached. */
async function installPlaceholder() {
  const { USALIGN_VERSION } = await import("@moldesk/core");
  const { createHash } = await import("node:crypto");
  const root = path.join((state.paths as { tools: string }).tools, "usalign", USALIGN_VERSION);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const binary = path.join(root, "bin", "USalign");
  fs.writeFileSync(binary, "placeholder");
  fs.writeFileSync(
    path.join(root, "installation.json"),
    JSON.stringify({ schemaVersion: 1, tool: "usalign", version: USALIGN_VERSION, binary: { path: "bin/USalign", sha256: createHash("sha256").update("placeholder").digest("hex") } }),
  );
}

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerCompareCommand(program);
  await program.parseAsync(["compare", ...args], { from: "user" });
}

describe("moldesk compare", () => {
  it("prints exactly one valid moldesk.compare envelope with --json", async () => {
    await installPlaceholder();
    await run(CRN, CRN, "--json");
    expect(out).toHaveLength(1);
    const envelope = validateEnvelope(JSON.parse(out[0]), "moldesk.compare");
    expect(envelope.result).toMatchObject({ mode: "monomer", alignedLength: 46, tmScore: { normalizedByA: 1 } });
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a readable summary without --json", async () => {
    await installPlaceholder();
    await run(CRN, CRN);
    expect(out.join("\n")).toContain("TM-score: 1.0000 (normalized by A, 46 residues), 1.0000 (by B, 46 residues)");
    expect(out.join("\n")).toContain("RMSD: 0.00 Å over 46 aligned residues (sequence identity 1.000)");
    expect(out.join("\n")).toMatch(/\[R \| t\]:\n {2} +0\.3600 +0\.4800 +-0\.8000 +10\.0001/);
  });

  it("exits 2 with an install remediation when US-align is missing", async () => {
    await run(CRN, CRN, "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "USALIGN_NOT_INSTALLED", remediation: expect.stringContaining("moldesk install usalign") });
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["--multimer with a chain", [CRN, CRN, "--multimer", "--chain-a", "A"], "INVALID_COMPARE_ARGS"],
    ["an unknown chain", [CRN, CRN, "--chain-a", "Z"], "CHAIN_NOT_FOUND"],
    ["a missing file", ["/does/not/exist.pdb", CRN], "INPUT_NOT_FOUND"],
  ])("exits 2 for %s", async (_name, args, code) => {
    await installPlaceholder();
    await run(...args, "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code });
    expect(process.exitCode).toBe(2);
  });
});
