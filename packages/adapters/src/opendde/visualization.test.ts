import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateDescription } from "@moldesk/visualizer";
import type { CollectedOutput } from "../index.js";
import { describeOpenDdeVisualization } from "./visualization.js";

const out = "/run/output";
const pred = (job: string, seed: number) => path.join(out, job, `seed_${seed}`, "predictions");
const cif = (job: string, seed: number, n: number): CollectedOutput => ({ id: "structures", path: path.join(pred(job, seed), `${job}_sample_${n}.cif`) });
const pdb = (job: string, seed: number, n: number): CollectedOutput => ({ id: "structures_pdb", path: path.join(pred(job, seed), `${job}_sample_${n}.pdb`) });
const summary = (job: string, seed: number, n: number): CollectedOutput => ({ id: "confidence", path: path.join(pred(job, seed), `${job}_summary_confidence_sample_${n}.json`) });
const atoms = (job: string, seed: number, n: number): CollectedOutput => ({ id: "atom_confidence", path: path.join(pred(job, seed), `${job}_full_data_sample_${n}.json`) });

describe("describeOpenDdeVisualization", () => {
  it("returns undefined without structures", () => {
    expect(describeOpenDdeVisualization("/in/j.json", [summary("t", 1, 0)])).toBeUndefined();
  });

  it("treats the exported PDB as the same prediction, not another scene", () => {
    const d = describeOpenDdeVisualization("/in/j.json", [cif("t", 101, 0), pdb("t", 101, 0), summary("t", 101, 0), atoms("t", 101, 0)])!;
    expect(d.scenes).toHaveLength(1);
    expect(d.resources.filter((r) => r.format === "mmcif")).toHaveLength(1);
    expect(d.resources.some((r) => r.source.path.endsWith(".pdb"))).toBe(false);
    expect(d.resources.some((r) => r.source.path.includes("full_data"))).toBe(false);
    validateDescription(d);
  });

  it("orders by seed then sample numerically and matches confidence by exact job/seed/sample", () => {
    const d = describeOpenDdeVisualization("/in/j.json", [
      cif("t", 202, 0), cif("t", 101, 10), cif("t", 101, 2),
      summary("t", 101, 2), summary("t", 202, 0),
    ])!;
    expect(d.scenes.map((s) => s.title)).toEqual([
      "Prediction 1 (seed 101, sample 2)",
      "Prediction 2 (seed 101, sample 10)",
      "Prediction 3 (seed 202, sample 0)",
    ]);
    const tables = d.panels.flatMap((p) => (p.kind === "table" ? [p] : []));
    expect(tables.map((t) => t.title)).toEqual([
      "Confidence — Prediction 1 (seed 101, sample 2)",
      "Confidence — Prediction 3 (seed 202, sample 0)",
    ]);
    expect(d.scenes.every((s) => s.rank === undefined)).toBe(true);
  });

  it("prefixes the job name when several jobs ran, and skips non-prediction layouts", () => {
    const stray: CollectedOutput = { id: "structures", path: path.join(out, "t", "not_seed", "predictions", "t_sample_0.cif") };
    const d = describeOpenDdeVisualization("/in/j.json", [cif("a", 1, 0), cif("b", 1, 0), stray])!;
    expect(d.scenes.map((s) => s.title)).toEqual(["a — Prediction 1 (seed 1, sample 0)", "b — Prediction 1 (seed 1, sample 0)"]);
  });
});
