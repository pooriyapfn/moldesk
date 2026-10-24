import { describe, expect, it } from "vitest";
import { APPLIED, captured } from "../testSupport/usalign.js";
import { parseUsalignOutput } from "./usalign-output.js";

const close = (a: number[], b: number[], tolerance = 1e-3) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tolerance));

describe("parseUsalignOutput on captured US-align 20260527 output", () => {
  it("reads a self alignment: TM 1, RMSD 0, identity transform", () => {
    const out = parseUsalignOutput(captured("crn-self.txt"));
    expect(out).toMatchObject({ lengthA: 46, lengthB: 46, alignedLength: 46, rmsd: 0, sequenceIdentity: 1, tmScoreByA: 1, tmScoreByB: 1 });
    expect(out.alignedA).toBe("TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN");
    expect(out.alignedB).toBe(out.alignedA);
    out.rotation.forEach((row, i) => close(row, [0, 1, 2].map((j) => (i === j ? 1 : 0))));
    close(out.translation, [0, 0, 0]);
  });

  it("returns the transform that was applied to make the second structure", () => {
    const out = parseUsalignOutput(captured("crn-to-moved.txt"));
    expect(out).toMatchObject({ tmScoreByA: 1, tmScoreByB: 1, rmsd: 0 });
    APPLIED.R.forEach((row, i) => close(out.rotation[i], row));
    close(out.translation, APPLIED.t);
  });

  it("returns the inverse transform when the structures are swapped", () => {
    const out = parseUsalignOutput(captured("moved-to-crn.txt"));
    const { R, t } = APPLIED;
    // inverse of x' = R x + t is x = R^T (x' - t)
    const inverseR = [0, 1, 2].map((i) => [0, 1, 2].map((j) => R[j][i]));
    const inverseT = [0, 1, 2].map((i) => -[0, 1, 2].reduce((sum, j) => sum + inverseR[i][j] * t[j], 0));
    inverseR.forEach((row, i) => close(out.rotation[i], row));
    close(out.translation, inverseT);
  });

  it("reads a real alignment with gaps and different lengths", () => {
    const out = parseUsalignOutput(captured("crn-vs-3hz7.txt"));
    expect(out).toMatchObject({ lengthA: 46, lengthB: 73, alignedLength: 28, rmsd: 2.58, tmScoreByA: 0.38324, tmScoreByB: 0.27834 });
    expect(out.alignedA).toHaveLength(out.alignedB.length);
    expect(out.alignedA.startsWith("TTC-----C--PSIVARS")).toBe(true);
    expect(out.alignedB.startsWith("---MITIDALGQVPIPV")).toBe(true);
  });

  it("keeps the `*` between multimer chains, including the trailing one", () => {
    const out = parseUsalignOutput(captured("aay-multimer.txt"));
    expect(out.lengthA).toBe(107);
    expect(out.alignedA.split("*")).toEqual(["agcgtgggcgt", "tacgcccacgc", expect.stringMatching(/^RPYAC.*HLR$/), ""]);
  });

  it.each([
    ["empty output", ""],
    ["output with no alignment", captured("no-residues.txt")],
    ["a missing matrix", captured("crn-self.txt").split("------ The rotation")[0]],
    ["a mangled matrix row", captured("crn-self.txt").replace(/^1 .*$/m, "1 not numbers")],
    ["unequal aligned lines", captured("crn-self.txt").replace("TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN\n\n------", "TTCC\n\n------")],
  ])("rejects %s", (_name, text) => {
    expect(() => parseUsalignOutput(text)).toThrow(expect.objectContaining({ code: "USALIGN_OUTPUT_UNPARSEABLE" }));
  });
});
