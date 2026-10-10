import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateDescription } from "@moldesk/visualizer";
import type { CollectedOutput } from "../index.js";
import { describeBindCraft2Visualization } from "./visualization.js";

let out: string;
beforeEach(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-bc2-viz-"));
});
afterEach(() => fs.rmSync(out, { recursive: true, force: true }));

const file = (rel: string, content = "x"): string => {
  const p = path.join(out, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
const o = (id: string, rel: string, content?: string): CollectedOutput => ({ id, path: file(rel, content) });
const titles = (d: ReturnType<typeof describeBindCraft2Visualization>) => d!.scenes.map((s) => s.title);

describe("describeBindCraft2Visualization", () => {
  it("returns undefined when there is no eligible structure", () => {
    expect(describeBindCraft2Visualization("/in/c.json", [o("campaign", "moldesk-campaign.json")])).toBeUndefined();
  });

  it("orders accepted designs by the rank in the ranked table, with quoted cells, and sets verified ranks", () => {
    const d = describeBindCraft2Visualization("/in/c.json", [
      o("ranked", "3_Ranked/!_Ranked.csv", 'design,rank,sequence\nd_b,2,"AAA,BBB"\nd_a,1,CCC\n'),
      o("accepted_structures", "3_Ranked/d_b.cif"),
      o("accepted_structures", "3_Ranked/d_a.cif"),
      o("accepted_structures", "3_Ranked/d_a_monomer.cif"),
    ])!;
    expect(titles(d)).toEqual(["#1 · d_a", "#2 · d_b"]);
    expect(d.scenes.map((s) => s.rank)).toEqual([1, 2]);
    expect(d.resources.some((r) => r.source.path.endsWith("_monomer.cif"))).toBe(false);
    expect(d.panels.some((p) => p.kind === "table" && p.title === "Ranked designs")).toBe(true);
    validateDescription(d);
  });

  it("uses the single non-monomer <design>_*.cif and refuses ambiguous matches", () => {
    const ranked = o("ranked", "3_Ranked/!_Ranked.csv", "design,rank\nd,1\n");
    const ok = describeBindCraft2Visualization("/in/c.json", [ranked, o("accepted_structures", "3_Ranked/d_relaxed.cif"), o("accepted_structures", "3_Ranked/d_monomer.cif")])!;
    expect(ok.resources.find((r) => r.format === "mmcif")!.source.path).toMatch(/d_relaxed\.cif$/);
    expect(() =>
      describeBindCraft2Visualization("/in/c.json", [ranked, o("accepted_structures", "3_Ranked/d_a.cif"), o("accepted_structures", "3_Ranked/d_b.cif")]),
    ).toThrow(/More than one/);
    expect(() => describeBindCraft2Visualization("/in/c.json", [ranked, o("accepted_structures", "3_Ranked/other.cif")])).toThrow(/No accepted/);
  });

  it("rejects an invalid rank instead of inventing one", () => {
    expect(() =>
      describeBindCraft2Visualization("/in/c.json", [o("ranked", "3_Ranked/!_Ranked.csv", "design,rank\nd,first\n"), o("accepted_structures", "3_Ranked/d.cif")]),
    ).toThrow(/invalid design or rank/);
  });

  it("falls back to refolded then trajectories (unranked) when nothing was accepted", () => {
    const d = describeBindCraft2Visualization("/in/c.json", [
      o("trajectory_structures", "1_Trajectories/t1/a.cif"),
      o("refolded_structures", "2_Refolded/r1.cif"),
      o("trajectories", "1_Trajectories/!_Trajectories.csv", "design,trajectory\na,1\n"),
    ])!;
    expect(titles(d)).toEqual(["Refolded · r1", "Trajectory · t1 / a"]);
    expect(d.scenes.every((s) => s.rank === undefined)).toBe(true);
    validateDescription(d);
  });

  it("includes a lower tier only whole: an oversized trajectory set is left out, ranked stays", () => {
    const outputs: CollectedOutput[] = [
      o("ranked", "3_Ranked/!_Ranked.csv", "design,rank\nd,1\n"),
      o("accepted_structures", "3_Ranked/d.cif"),
    ];
    for (let i = 0; i < 300; i++) outputs.push({ id: "trajectory_structures", path: path.join(out, `1_Trajectories/t${i}/x.cif`) });
    const d = describeBindCraft2Visualization("/in/c.json", outputs)!;
    expect(titles(d)).toEqual(["#1 · d"]);
    validateDescription(d);
  });
});
