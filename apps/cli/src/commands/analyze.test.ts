import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { validateEnvelope } from "@moldesk/core";
import { registerAnalyzeCommand } from "./analyze.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../../../packages/visualizer/test/fixtures");
const CRN = path.join(FIXTURES, "1CRN.pdb");

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-cli-analyze-"));
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

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerAnalyzeCommand(program);
  await program.parseAsync(["analyze", ...args], { from: "user" });
}

describe("moldesk analyze", () => {
  it("prints exactly one valid envelope with --json", async () => {
    await run(CRN, "--json");
    expect(out).toHaveLength(1);
    const envelope = validateEnvelope(JSON.parse(out[0]), "moldesk.analysis");
    expect(envelope.input?.format).toBe("pdb");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a short summary and warnings on stderr without --json", async () => {
    await run(CRN);
    expect(out.join("\n")).toContain("A/A  protein  46 residue(s)");
    expect(err.join("\n")).toContain("No known pLDDT source");
  });

  it("writes FASTA and refuses to overwrite it", async () => {
    const fasta = path.join(dir, "crn.fa");
    await run(CRN, "--fasta", fasta, "--json");
    expect(fs.readFileSync(fasta, "utf8")).toMatch(/^>1CRN\|chain A\|label A\|protein\nTTCCPSIVAR/);
    out.length = 0;
    await run(CRN, "--fasta", fasta, "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "OUTPUT_EXISTS" });
    expect(process.exitCode).toBe(2);
  });

  it("validates a FASTA file", async () => {
    const good = path.join(dir, "good.fa");
    fs.writeFileSync(good, ">a\nACDE\n");
    await run("--validate-fasta", good, "--json");
    expect(validateEnvelope(JSON.parse(out[0])).result).toMatchObject({ fasta: { valid: true, records: [{ header: "a", length: 4 }] } });

    out.length = 0;
    const bad = path.join(dir, "bad.fa");
    fs.writeFileSync(bad, ">a\n>a\nAC1\n");
    await run("--validate-fasta", bad, "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "INVALID_FASTA" });
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["no file", [], "INVALID_ANALYZE_ARGS"],
    ["--validate-fasta with a file", [CRN, "--validate-fasta", CRN], "INVALID_ANALYZE_ARGS"],
    ["a missing file", ["/does/not/exist.pdb"], "INPUT_NOT_FOUND"],
  ])("exits 2 for %s", async (_name, args, code) => {
    await run(...args, "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code });
    expect(process.exitCode).toBe(2);
  });
});
