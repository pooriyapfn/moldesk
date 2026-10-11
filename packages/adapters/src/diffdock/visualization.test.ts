import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateDescription } from "@moldesk/visualizer";
import type { CollectedOutput } from "../index.js";
import { describeDiffDockVisualization } from "./visualization.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-dd-viz-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const out = () => path.join(dir, "run", "output");
const pose = (name: string): CollectedOutput => ({ id: "ranked_poses", path: path.join(out(), "cplx", name) });
const top = (): CollectedOutput => ({ id: "top_pose", path: path.join(out(), "cplx", "rank1.sdf") });

function summary(poses: Array<{ rank: number; confidence: number; sdfFile: string }>): CollectedOutput {
  fs.mkdirSync(out(), { recursive: true });
  const p = path.join(out(), "poses_summary.json");
  fs.writeFileSync(p, JSON.stringify({ complexName: "cplx", topPoseFile: "rank1.sdf", poses }));
  return { id: "poses_summary", path: p };
}

const POSES = [
  { rank: 2, confidence: -1.23, sdfFile: "rank2_confidence-1.23.sdf" },
  { rank: 1, confidence: 0.85, sdfFile: "rank1_confidence0.85.sdf" },
];
const receptorOf = () => ({ id: "protein", path: path.join(dir, "run", "input", "protein", "receptor.pdb") });

describe("describeDiffDockVisualization", () => {
  const outputs = () => [top(), pose("rank2_confidence-1.23.sdf"), pose("rank1_confidence0.85.sdf"), summary(POSES)];

  it("puts the staged receptor and each ranked pose in one scene, sharing the receptor resource", () => {
    const d = describeDiffDockVisualization({ inputPath: "/in/job.json", companionInputs: [receptorOf()] }, outputs())!;
    expect(d.scenes.map((s) => [s.title, s.rank])).toEqual([
      ["Pose 1 (confidence 0.85)", 1],
      ["Pose 2 (confidence -1.23)", 2],
    ]);
    const receptors = d.resources.filter((r) => r.source.kind === "input");
    expect(receptors).toHaveLength(1);
    expect(receptors[0]).toMatchObject({ format: "pdb", source: { path: receptorOf().path } });
    for (const s of d.scenes) {
      expect(s.structures[0].resourceId).toBe(receptors[0].id);
      expect(s.structures).toHaveLength(2);
      expect(s.components?.map((c) => c.role)).toEqual(["receptor", "ligand"]);
    }
    validateDescription(d);
  });

  it("does not create a second scene for the rank1.sdf duplicate of the top pose", () => {
    const d = describeDiffDockVisualization({ inputPath: "/in/job.json", companionInputs: [receptorOf()] }, outputs())!;
    expect(d.resources.some((r) => r.source.path.endsWith(`${path.sep}rank1.sdf`))).toBe(false);
  });

  it("shows the pose summary as a table over its poses array", () => {
    const d = describeDiffDockVisualization({ inputPath: "/in/job.json", companionInputs: [receptorOf()] }, outputs())!;
    const table = d.panels.find((p) => p.kind === "table");
    expect(table).toMatchObject({ title: "Poses", dataset: { rowsKey: "poses" } });
  });

  it.each([
    ["no staged companions", undefined],
    ["no protein companion", [{ id: "ligand", path: "/x/ligand.sdf" }]],
    ["a receptor that is not PDB/mmCIF", [{ id: "protein", path: "/x/receptor.mol2" }]],
  ])("refuses to describe a docking result with %s (never ligand-only)", (_name, companionInputs) => {
    expect(() => describeDiffDockVisualization({ inputPath: "/in/job.json", companionInputs }, outputs())).toThrowError(
      expect.objectContaining({ code: "VISUALIZATION_RECEPTOR_MISSING" }),
    );
  });

  it("accepts an mmCIF receptor", () => {
    const d = describeDiffDockVisualization({ inputPath: "/in/job.json", companionInputs: [{ id: "protein", path: "/x/r.cif" }] }, outputs())!;
    expect(d.resources.find((r) => r.source.kind === "input")!.format).toBe("mmcif");
  });

  it("errors when a summarized pose file was not collected, and returns undefined with no poses", () => {
    expect(() => describeDiffDockVisualization({ inputPath: "/in/job.json", companionInputs: [receptorOf()] }, [pose("rank1_confidence0.85.sdf"), summary(POSES)])).toThrowError(
      expect.objectContaining({ code: "VISUALIZATION_POSE_MISSING" }),
    );
    expect(describeDiffDockVisualization({ inputPath: "/in/job.json", companionInputs: [receptorOf()] }, [])).toBeUndefined();
  });
});
