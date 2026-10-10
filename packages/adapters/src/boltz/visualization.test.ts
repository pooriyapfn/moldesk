import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateDescription } from "@moldesk/visualizer";
import type { CollectedOutput } from "../index.js";
import { describeBoltzVisualization } from "./visualization.js";

const out = "/run/output";
const dir = (record: string) => path.join(out, "boltz_results_job", "predictions", record);
const cif = (record: string, n: number): CollectedOutput => ({ id: "structures", path: path.join(dir(record), `${record}_model_${n}.cif`) });
const conf = (record: string, n: number): CollectedOutput => ({ id: "confidence", path: path.join(dir(record), `confidence_${record}_model_${n}.json`) });
const aff = (record: string): CollectedOutput => ({ id: "affinity", path: path.join(dir(record), `affinity_${record}.json`) });

const resource = (d: ReturnType<typeof describeBoltzVisualization>, id: string) => d!.resources.find((r) => r.id === id)!;

describe("describeBoltzVisualization", () => {
  it("returns undefined when there are no structures", () => {
    expect(describeBoltzVisualization("/in/job.yaml", [conf("a", 0)])).toBeUndefined();
  });

  it("makes one scene per model, ordered by model index, without inventing ranks", () => {
    // Collected order deliberately scrambled: association must not depend on it.
    const d = describeBoltzVisualization("/in/job.yaml", [cif("a", 2), cif("a", 0), cif("a", 10), conf("a", 10), conf("a", 0), conf("a", 2)])!;
    expect(d.scenes.map((s) => s.title)).toEqual(["Prediction 1", "Prediction 2", "Prediction 3"]);
    expect(d.scenes.every((s) => s.rank === undefined)).toBe(true);
    expect(d.scenes.map((s) => resource(d, s.structures[0].resourceId).source.path)).toEqual([
      cif("a", 0).path,
      cif("a", 2).path,
      cif("a", 10).path,
    ]);
    expect(d.title).toBe("Boltz — job.yaml");
    validateDescription(d);
  });

  it("pairs each structure only with its own confidence file", () => {
    const d = describeBoltzVisualization("/in/job.yaml", [cif("a", 0), cif("a", 1), conf("a", 1)])!;
    const tables = d.panels.filter((p) => p.kind === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0].kind === "table" && tables[0].title).toBe("Confidence — Prediction 2");
    const t = tables[0];
    expect(t.kind === "table" && resource(d, t.dataset.resourceId).source.path).toBe(conf("a", 1).path);
  });

  it("does not attach a confidence file from a different record", () => {
    const d = describeBoltzVisualization("/in/job.yaml", [cif("a", 0), conf("b", 0)])!;
    expect(d.panels.filter((p) => p.kind === "table")).toEqual([]);
  });

  it("labels records and attaches affinity once per record", () => {
    const d = describeBoltzVisualization("/in/job.yaml", [cif("a", 0), cif("a", 1), cif("b", 0), aff("a")])!;
    expect(d.scenes.map((s) => s.title)).toEqual(["a — Prediction 1", "a — Prediction 2", "b — Prediction 1"]);
    const titles = d.panels.filter((p) => p.kind === "table").map((p) => p.kind === "table" && p.title);
    expect(titles).toEqual(["Affinity — a"]);
    validateDescription(d);
  });

  it("ignores .cif files that are not model predictions", () => {
    const stray: CollectedOutput = { id: "structures", path: path.join(dir("a"), "ccd.cif") };
    expect(describeBoltzVisualization("/in/job.yaml", [stray])).toBeUndefined();
  });
});
