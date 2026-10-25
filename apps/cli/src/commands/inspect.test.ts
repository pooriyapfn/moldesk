import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { validateEnvelope } from "@moldesk/core";
import { registerInspectCommand } from "./inspect.js";

const CRN = path.resolve(import.meta.dirname, "../../../../packages/visualizer/test/fixtures/1CRN.pdb");

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerInspectCommand(program);
  await program.parseAsync(["inspect", ...args], { from: "user" });
}

describe("moldesk inspect", () => {
  it("prints one valid moldesk.inspect envelope with --json", async () => {
    await run(CRN, "A:7-9", "--radius", "4", "--json");
    expect(out).toHaveLength(1);
    const envelope = validateEnvelope(JSON.parse(out[0]), "moldesk.inspect");
    expect(envelope.result).toMatchObject({ radius: 4, residues: [{ authSeqId: 7 }, { authSeqId: 8 }, { authSeqId: 9 }] });
  });

  it("prints a readable summary without --json", async () => {
    await run(CRN, "A:7");
    expect(out[0]).toBe("A:7 ILE H (8 atoms)");
    expect(out[1]).toMatch(/^ {4}A:\d+ \w+ {2}[\d.]+ Å {2}\(\w+ - \w+\)$/);
  });

  it("puts the available chains in the --json error and in the text error", async () => {
    await run(CRN, "A:999", "--json");
    expect(JSON.parse(out[0])).toMatchObject({
      status: "error",
      code: "SELECTOR_NO_MATCH",
      message: expect.stringContaining("has protein residues 1-46, but no residue 999"),
      details: { reason: "no-residue", available: [{ chainId: "A", type: "protein", residueCount: 46, residues: "1-46" }] },
    });

    out.length = 0;
    await run(CRN, "Q");
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain('there is no chain "Q" (auth ids)');
    expect(err.join("\n")).toContain("Available chains (auth ids): A (protein, 1-46)");
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["a selector that matches nothing", [CRN, "A:999"], "SELECTOR_NO_MATCH"],
    ["an invalid selector", [CRN, "A:60-40"], "INVALID_SELECTOR"],
    ["a bad radius", [CRN, "A:1", "--radius", "abc"], "INVALID_INSPECT_ARGS"],
    ["a missing file", ["/does/not/exist.pdb", "A"], "INPUT_NOT_FOUND"],
  ])("exits 2 for %s", async (_name, args, code) => {
    await run(...args, "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code });
    expect(process.exitCode).toBe(2);
  });
});
