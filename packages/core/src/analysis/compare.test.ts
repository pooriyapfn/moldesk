import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallCommandRunner, MoldeskPaths, RunResult } from "@moldesk/runtime";
import { validateEnvelope } from "../schemas/envelope.js";
import { APPLIED, captured, usalignHome } from "../testSupport/usalign.js";
import { USALIGN_VERSION } from "../tools/usalign.js";
import { compareStructureFiles } from "./compare.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../../visualizer/test/fixtures");
const fx = (name: string) => path.join(FIXTURES, name);

let dir: string;
let paths: MoldeskPaths;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-compare-"));
  paths = usalignHome(dir, { installed: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A runner that answers with captured US-align output and records how it was called. */
function stub(stdout: string, extra: Partial<RunResult> = {}) {
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
  const runner: InstallCommandRunner = async (command, args, options) => {
    calls.push({ command, args, env: options?.env, cwd: options?.cwd });
    return { code: 0, stdout, stderr: "", ...extra };
  };
  return { runner, calls };
}

/** The captured self-alignment with different (identical) aligned sequences. */
const withAlignment = (sequence: string) =>
  captured("crn-self.txt").replace(/TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN/g, sequence).replace(/^:+$/m, ":".repeat(sequence.length));

const compare = (a: string, b: string, output: string, options = {}) => {
  const s = stub(output);
  return compareStructureFiles(a, b, { paths, runner: s.runner, ...options }).then((envelope) => ({ envelope, ...s }));
};

describe("compareStructureFiles", () => {
  it("scores a self comparison and pairs every residue with itself", async () => {
    const { envelope, calls } = await compare(fx("1CRN.pdb"), fx("1CRN.pdb"), captured("crn-self.txt"));
    validateEnvelope(envelope, "moldesk.compare");
    expect(envelope.input).toBeUndefined();
    expect(envelope.provenance.tool).toEqual({ name: "usalign", version: USALIGN_VERSION });
    const r = envelope.result;
    expect(r).toMatchObject({ mode: "monomer", chains: { a: ["A"], b: ["A"] }, lengths: { a: 46, b: 46 }, alignedLength: 46, rmsd: 0, sequenceIdentity: 1, tmScore: { normalizedByA: 1, normalizedByB: 1 } });
    expect(r.mapping).toHaveLength(46);
    expect(r.mapping.every((p) => p.a.authSeqId === p.b.authSeqId && p.a.name === p.b.name && p.a.chainAuthId === "A")).toBe(true);
    expect(r.inputs.a).toMatchObject({ path: fx("1CRN.pdb"), format: "pdb" });
    expect(r.citation.length).toBe(3);

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([fx("1CRN.pdb"), fx("1CRN.pdb"), "-outfmt", "-1", "-m", "-", "-het", "2", "-chain1", "A", "-chain2", "A"]);
    expect(calls[0].command).toBe(path.join(paths.tools, "usalign", USALIGN_VERSION, "bin", "USalign"));
    expect(Object.keys(calls[0].env ?? {})).toEqual(["PATH"]);
    expect(fs.existsSync(calls[0].cwd!)).toBe(false); // the scratch dir is removed
  });

  it("returns a 4x4 matrix equal to the transform that was applied to the second structure", async () => {
    const { envelope } = await compare(fx("1CRN.pdb"), fx("1CRN.pdb"), captured("crn-to-moved.txt"));
    const m = envelope.result.transform.matrix;
    expect(m).toHaveLength(4);
    expect(m[3]).toEqual([0, 0, 0, 1]);
    APPLIED.R.forEach((row, i) => row.forEach((v, j) => expect(Math.abs(m[i][j] - v)).toBeLessThan(1e-3)));
    APPLIED.t.forEach((v, i) => expect(Math.abs(m[i][3] - v)).toBeLessThan(1e-3));
  });

  it("returns a transform that undoes the applied one when the structures are swapped", async () => {
    const { envelope } = await compare(fx("1CRN.pdb"), fx("1CRN.pdb"), captured("moved-to-crn.txt"));
    const back = envelope.result.transform.matrix;
    const applied = [...APPLIED.R.map((row, i) => [...row, APPLIED.t[i]]), [0, 0, 0, 1]];
    // back * applied must be the identity
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const value = [0, 1, 2, 3].reduce((sum, k) => sum + back[i][k] * applied[k][j], 0);
        expect(Math.abs(value - (i === j ? 1 : 0))).toBeLessThan(1e-3);
      }
    }
  });

  it("maps a gapped alignment of different proteins back to residues", async () => {
    const { envelope } = await compare(fx("1CRN.pdb"), fx("3HZ7.pdb"), captured("crn-vs-3hz7.txt"));
    const r = envelope.result;
    expect(r).toMatchObject({ lengths: { a: 46, b: 73 }, alignedLength: 28, rmsd: 2.58, tmScore: { normalizedByA: 0.38324, normalizedByB: 0.27834 } });
    expect(r.mapping).toHaveLength(28);
    expect(r.mapping[0]).toMatchObject({ a: { authSeqId: 4, name: "CYS" }, b: { authSeqId: 6, name: "ALA" } });
    // numbers only ever increase along the alignment
    for (const side of ["a", "b"] as const) {
      expect(r.mapping.every((p, i) => i === 0 || p[side].authSeqId > r.mapping[i - 1][side].authSeqId)).toBe(true);
    }
  });

  it("aligns all chains in multimer mode and keeps the file's chain order", async () => {
    const { envelope, calls } = await compare(fx("1AAY.pdb"), fx("1AAY.pdb"), captured("aay-multimer.txt"), { multimer: true });
    expect(envelope.result).toMatchObject({ mode: "multimer", chains: { a: ["B", "C", "A"], b: ["B", "C", "A"] }, alignedLength: 107 });
    expect(envelope.result.mapping).toHaveLength(107);
    expect(envelope.result.mapping.filter((p) => p.a.chainAuthId === "A")).toHaveLength(85);
    expect(calls[0].args).toEqual([fx("1AAY.pdb"), fx("1AAY.pdb"), "-outfmt", "-1", "-m", "-", "-het", "2", "-mm", "1", "-ter", "1"]);
  });

  it("uses the chains asked for and passes them to US-align", async () => {
    const { calls } = await compare(fx("1CRN.pdb"), fx("1CRN.pdb"), captured("crn-self.txt"), { chainA: "A", chainB: "A" });
    expect(calls[0].args.slice(-4)).toEqual(["-chain1", "A", "-chain2", "A"]);
  });

  it("says which chain it picked when a file has several", async () => {
    const { envelope } = await compare(fx("1AAY.pdb"), fx("1AAY.pdb"), withAlignment("agcgtgggcgt"));
    expect(envelope.result.chains).toEqual({ a: ["B"], b: ["B"] });
    expect(envelope.warnings.map((w) => w.code)).toEqual(["CHAIN_DEFAULTED", "CHAIN_DEFAULTED"]);
    expect(envelope.warnings[0].message).toBe(
      "1AAY.pdb has 3 polymer chains (B, C, A); structure A uses chain B. Pass --chain-a to choose, or --multimer to align all chains.",
    );
    const chosen = await compare(fx("1AAY.pdb"), fx("1AAY.pdb"), withAlignment("agcgtgggcgt"), { chainA: "B", chainB: "B" });
    expect(chosen.envelope.warnings).toEqual([]);
  });

  it("says that only the first model of an ensemble is compared", async () => {
    const nmr = "MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG";
    const { envelope } = await compare(fx("1D3Z-3models.pdb"), fx("1D3Z-3models.pdb"), withAlignment(nmr));
    expect(envelope.result.mapping).toHaveLength(76);
    expect(envelope.warnings.map((w) => w.message)).toEqual([
      "1D3Z-3models.pdb has 3 models; only the first is compared.",
      "1D3Z-3models.pdb has 3 models; only the first is compared.",
    ]);
  });
});

describe("compareStructureFiles errors", () => {
  const failing = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

  it("fails with an install remediation when US-align is not installed, and never falls back", async () => {
    const empty = usalignHome(path.join(dir, "empty"));
    const s = stub(captured("crn-self.txt"));
    const error = await compareStructureFiles(fx("1CRN.pdb"), fx("1CRN.pdb"), { paths: empty, runner: s.runner }).catch((e) => e);
    expect(error).toMatchObject({ code: "USALIGN_NOT_INSTALLED" });
    expect(error.remediation).toContain("moldesk install usalign");
    expect(s.calls).toHaveLength(0);
  });

  it("refuses a binary that changed after installation", async () => {
    fs.appendFileSync(path.join(paths.tools, "usalign", USALIGN_VERSION, "bin", "USalign"), "# tampered");
    await failing(compare(fx("1CRN.pdb"), fx("1CRN.pdb"), captured("crn-self.txt")), "USALIGN_DAMAGED");
  });

  it("rejects --multimer with a chain choice before running anything", async () => {
    const s = stub("");
    await failing(compareStructureFiles(fx("1CRN.pdb"), fx("1CRN.pdb"), { paths, runner: s.runner, multimer: true, chainA: "A" }), "INVALID_COMPARE_ARGS");
    expect(s.calls).toHaveLength(0);
  });

  it("lists the available chains when a chain does not exist", async () => {
    const error = await compare(fx("1AAY.pdb"), fx("1CRN.pdb"), "", { chainA: "Z" }).catch((e) => e);
    expect(error.code).toBe("CHAIN_NOT_FOUND");
    expect(error.remediation).toBe("Available chains: B (11 residues), C (11 residues), A (85 residues).");
    expect(error.details.available).toHaveLength(3);
  });

  it("rejects a structure with nothing to align", async () => {
    await failing(compare(fx("HEM-only.pdb"), fx("1CRN.pdb"), ""), "NO_ALIGNABLE_RESIDUES");
  });

  it.each([
    ["input errors", () => compare(path.join(dir, "missing.pdb"), fx("1CRN.pdb"), ""), "INPUT_NOT_FOUND"],
    ["a bad extension", () => compare(fx("1CRN.pdb"), path.join(dir, "x.txt"), ""), "UNSUPPORTED_STRUCTURE_FORMAT"],
  ])("passes through %s", async (_name, run, code) => {
    await failing(run(), code);
  });

  it("explains an empty result even though US-align exits 0", async () => {
    const s = stub(captured("no-residues.txt"), { stderr: captured("no-residues.stderr") });
    const error = await compareStructureFiles(fx("1CRN.pdb"), fx("1CRN.pdb"), { paths, runner: s.runner }).catch((e) => e);
    expect(error.code).toBe("USALIGN_NO_RESULT");
    expect(error.message).toContain("Cannot parse file");
  });

  it("reports a crash, a timeout, and garbage output", async () => {
    const run = (extra: Partial<RunResult>, stdout = "") => compareStructureFiles(fx("1CRN.pdb"), fx("1CRN.pdb"), { paths, runner: stub(stdout, extra).runner });
    await expect(run({ code: 139, stderr: "Segmentation fault" })).rejects.toMatchObject({ code: "USALIGN_NO_RESULT", message: expect.stringContaining("exit 139") });
    await expect(run({ timedOut: true, code: 1 })).rejects.toMatchObject({ code: "USALIGN_TIMEOUT" });
    await expect(run({}, "Aligned length= nonsense")).rejects.toMatchObject({ code: "USALIGN_OUTPUT_UNPARSEABLE" });
  });

  it("refuses to guess when the alignment does not match the structure's residues", async () => {
    await failing(compare(fx("1CRN.pdb"), fx("1CRN.pdb"), captured("crn-self.txt").replace(/TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN/g, "TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAA")), "ALIGNMENT_MAPPING_MISMATCH");
    await failing(compare(fx("1CRN.pdb"), fx("3HZ7.pdb"), captured("crn-self.txt")), "ALIGNMENT_MAPPING_MISMATCH");
  });
});
