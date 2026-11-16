import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import { getMoldeskPaths, type RunOptions } from "@moldesk/runtime";
import { scoreProteinInterface } from "./interface.js";
import { hashArtifact, resolveBoltzPredictionArtifacts } from "./boltz-artifacts.js";
import { parseIpsaeOutput } from "./ipsae-output.js";
import { mapBoltzProteinTokens } from "./interface-mapping.js";
import { readStructureInput } from "./structure-input.js";
import { envelopeSchema } from "../schemas/envelope.js";
import { boltzRecord, proteinCif, IPSAE_TABLE } from "../testSupport/interface.js";

vi.mock("../tools/ipsae.js", () => ({ requireIpsae: vi.fn(async () => ({ dir: "/tool", executable: "/tool/python", receipt: { revision: "a".repeat(40), sourceSha256: "b".repeat(64) } })) }));
const dirs: string[] = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-interface-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.clearAllMocks(); });
const runner = async (_cmd: string, args: string[], options: RunOptions) => {
  if (args.includes("/tool/ipsae.py")) fs.writeFileSync(path.join(options.cwd!, "prediction_15_15.txt"), IPSAE_TABLE);
  return { code: 0, stdout: "validated\n", stderr: "" };
};
async function options() {
  const root = tmp(), record = await boltzRecord(root), a = await resolveBoltzPredictionArtifacts(record);
  return { runRecord: record, structure: a.structure.path, pae: a.pae!.path, confidence: a.confidence.path, plddt: a.plddt!.path, targetChain: "A", binderChain: "B", outputPath: path.join(root, "interface.json"), paths: getMoldeskPaths({ MOLDESK_HOME: root }), runner };
}
describe("exact Boltz artifact identity", () => {
  it("rejects ambiguous records/ranks; pairs by exact directory/stem; verifies hashes", async () => {
    const run = await boltzRecord(tmp(), ["first", "second"], [0, 1]);
    await expect(resolveBoltzPredictionArtifacts(run)).rejects.toMatchObject({ code: "BOLTZ_ARTIFACT_MISMATCH" });
    const a = await resolveBoltzPredictionArtifacts(run, { recordId: "second", predictionRank: 1 });
    expect(a.pae!.path).toContain("/second/pae_second_model_1.npz");
    fs.appendFileSync(a.pae!.path, "changed");
    await expect(resolveBoltzPredictionArtifacts(run, { recordId: "second", predictionRank: 1 })).rejects.toMatchObject({ code: "BOLTZ_ARTIFACT_MISMATCH" });
  });
  it("rejects duplicate sidecars and file/directory symlinks", async () => {
    const run = await boltzRecord(tmp()); run.outputs.push(run.outputs.find((o) => o.id === "confidence")!);
    await expect(resolveBoltzPredictionArtifacts(run)).rejects.toMatchObject({ code: "BOLTZ_ARTIFACT_MISMATCH" });
    const outside = path.join(tmp(), "link"); fs.symlinkSync(path.dirname(run.outputs[0].path), outside);
    await expect(hashArtifact(path.join(outside, path.basename(run.outputs[0].path)))).rejects.toMatchObject({ code: "BOLTZ_ARTIFACT_MISMATCH" });
  });
});
describe("interface mapping and scoring", () => {
  it("preserves author/label differences and reversed input chain order", async () => {
    const file = path.join(tmp(), "reverse.cif"); fs.writeFileSync(file, proteinCif(["Binder", "Target"], ["B", "A"]));
    const m = await mapBoltzProteinTokens(readStructureInput(file), "Target", "Binder");
    expect(m.chains.target).toEqual({ authId: "Target", labelId: "A" });
    expect(m.targetAlias).toBe("B"); expect(m.tokens.map((t) => t.authId)).toEqual(["Binder", "Binder", "Target", "Target"]);
  });
  it.each([
    ["missing CB", (s: string) => s.split("\n").filter((l) => !l.startsWith("ATOM 2 ")).join("\n")],
    ["modified residue", (s: string) => s.replaceAll("ALA", "MSE")],
    ["ambiguous author IDs", (_s: string) => proteinCif(["A", "A"])],
    ["multiple models", (s: string) => s.replace(/(ATOM 8 .* )1\n/, "$12\n")],
    ["missing trace", (s: string) => s.replace(" C CA .", " C XX .")],
  ])("rejects %s", async (_name, modify) => {
    const file = path.join(tmp(), "bad.cif"); fs.writeFileSync(file, modify(proteinCif()));
    await expect(mapBoltzProteinTokens(readStructureInput(file), "A", "B")).rejects.toMatchObject({ code: "UNSUPPORTED_INTERFACE_INPUT" });
  });
  it("publishes a schema-valid envelope with hashed audit files and refuses overwrite", async () => {
    const o = await options(); const e = await scoreProteinInterface(o);
    expect(e.result.scores).toEqual({ ipsaeTargetToBinder: .5, ipsaeBinderToTarget: .2, ipsaeMax: .5 });
    const validate = new Ajv().compile(envelopeSchema("moldesk.interface")); expect(validate(e), JSON.stringify(validate.errors)).toBe(true);
    expect(e.result.artifacts.some((a) => a.path.endsWith("original.cif"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(o.outputPath, "utf8"))).toEqual(e);
    await expect(scoreProteinInterface(o)).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  });
  it("rejects swapped sidecars, invalid cutoffs, and cancellation before execution", async () => {
    const o = await options();
    await expect(scoreProteinInterface({ ...o, pae: o.plddt })).rejects.toMatchObject({ code: "BOLTZ_ARTIFACT_MISMATCH" });
    await expect(scoreProteinInterface({ ...o, paeCutoffAngstrom: .5 })).rejects.toMatchObject({ code: "INVALID_INTERFACE_ARGS" });
    await expect(scoreProteinInterface({ ...o, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "INTERFACE_CANCELLED" });
  });
  it.each([
    [{ code: 2, stdout: "", stderr: "object arrays" }, "INVALID_PAE"],
    [{ code: 2, stdout: "", stderr: "PAE_STRUCTURE_MISMATCH: bad shape" }, "PAE_STRUCTURE_MISMATCH"],
    [{ code: 124, timedOut: true, stdout: "", stderr: "" }, "IPSAE_EXECUTION_FAILED"],
    [{ code: 0, cancelled: true, stdout: "", stderr: "" }, "INTERFACE_CANCELLED"],
    [{ code: 0, outputLimitExceeded: true, stdout: "", stderr: "" }, "IPSAE_EXECUTION_FAILED"],
  ])("maps execution failure to %s", async (result, code) => {
    const o = await options(); await expect(scoreProteinInterface({ ...o, runner: async () => result })).rejects.toMatchObject({ code });
    expect(fs.existsSync(`${o.outputPath}.artifacts/validate.py.stderr.log`)).toBe(true);
  });
  it("does not treat a zero exit with no table as success", async () => {
    const o = await options(); await expect(scoreProteinInterface({ ...o, runner: async () => ({ code: 0, stdout: "", stderr: "" }) })).rejects.toMatchObject({ code: "IPSAE_NO_RESULT" });
  });
});
it("reads the ipSAE column, validates directional/max rows, never substitutes d0chn", () => {
  expect(parseIpsaeOutput(IPSAE_TABLE, "B", "A", 15, 15)).toEqual({ ipsaeTargetToBinder: .2, ipsaeBinderToTarget: .5, ipsaeMax: .5 });
  for (const bad of [IPSAE_TABLE.replace("0.5 0.99", "NaN 0.99"), IPSAE_TABLE + "A B 15 15 asym 0.6 0.99 prediction\n", IPSAE_TABLE.replace("max 0.5", "max 0.1")]) expect(() => parseIpsaeOutput(bad, "A", "B", 15, 15)).toThrow();
});
