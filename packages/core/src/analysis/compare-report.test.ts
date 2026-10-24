import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mat4, Vec3 } from "molstar/lib/mol-math/linear-algebra.js";
import { decodeEnvelope, extractEnvelope } from "@moldesk/visualizer";
import type { InstallCommandRunner, MoldeskPaths } from "@moldesk/runtime";
import { APPLIED, captured, usalignHome } from "../testSupport/usalign.js";
import { compareStructureFiles, type CompareResult } from "./compare.js";
import { createComparisonReport, deviationRows, invertRigid, overlayTransformForB, toColumnMajor } from "./compare-report.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../../visualizer/test/fixtures");
const fx = (name: string) => path.join(FIXTURES, name);

let dir: string;
let paths: MoldeskPaths;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-overlay-"));
  paths = usalignHome(dir, { installed: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function stub(output: string) {
  const calls: string[][] = [];
  const runner: InstallCommandRunner = async (_command, args) => {
    calls.push(args);
    return { code: 0, stdout: output, stderr: "" };
  };
  return { runner, calls };
}

/** 90 degrees about z, then translate by (1, 2, 3): x' = (-y + 1, x + 2, z + 3). */
const ROW_MAJOR = [[0, -1, 0, 1], [1, 0, 0, 2], [0, 0, 1, 3], [0, 0, 0, 1]];
const apply = (m: number[][], p: number[]) => [0, 1, 2].map((i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3]);

describe("matrix conversion", () => {
  it("lays a row-major 4x4 out column by column", () => {
    expect(toColumnMajor(ROW_MAJOR)).toEqual([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  });

  it("inverts a rigid transform", () => {
    const inverse = invertRigid(ROW_MAJOR);
    expect(apply(inverse, apply(ROW_MAJOR, [4, 5, 6]))).toEqual([4, 5, 6]);
    expect(inverse[3]).toEqual([0, 0, 0, 1]);
  });

  it("gives B the matrix that moves B back onto A, as Mol* applies it", () => {
    // US-align's matrix sends A to B. B must carry the inverse so that B lands on A.
    const a = [1, 0, 0];
    const b = apply(ROW_MAJOR, a);
    expect(b).toEqual([1, 3, 3]);
    const viewer = Mat4.fromArray(Mat4(), overlayTransformForB(ROW_MAJOR), 0);
    const moved = Vec3.transformMat4(Vec3(), Vec3.create(b[0], b[1], b[2]), viewer);
    [0, 1, 2].forEach((i) => expect(moved[i]).toBeCloseTo(a[i], 12));
    // ...and the matrix itself, not its inverse, would have sent B somewhere else.
    const wrong = Vec3.transformMat4(Vec3(), Vec3.create(b[0], b[1], b[2]), Mat4.fromArray(Mat4(), toColumnMajor(ROW_MAJOR), 0));
    expect(Math.abs(wrong[0] - a[0])).toBeGreaterThan(1);
  });

  it("undoes the transform applied to a real structure copy", () => {
    // captured: US-align's matrix for 1CRN -> moved 1CRN is the applied transform.
    const out = [...APPLIED.R.map((row, i) => [...row, APPLIED.t[i]]), [0, 0, 0, 1]];
    const point = [3.5, -2, 8];
    const moved = apply(out, point);
    const viewer = Mat4.fromArray(Mat4(), overlayTransformForB(out), 0);
    const back = Vec3.transformMat4(Vec3(), Vec3.create(moved[0], moved[1], moved[2]), viewer);
    [0, 1, 2].forEach((i) => expect(back[i]).toBeCloseTo(point[i], 9));
  });
});

async function compare(a: string, b: string, output: string, report?: { outputPath: string; deviationThreshold?: number }, extra: { multimer?: boolean } = {}) {
  const s = stub(output);
  const envelope = await compareStructureFiles(a, b, { paths, runner: s.runner, ...extra, ...(report ? { report } : {}) });
  return { envelope, ...s };
}

describe("deviation per aligned residue", () => {
  it("equals the distance between the superposed trace atoms, computed here from raw coordinates", async () => {
    const { envelope } = await compare(fx("1CRN.pdb"), fx("3HZ7.pdb"), captured("crn-vs-3hz7.txt"));
    const trace = (file: string) =>
      new Map(
        fs.readFileSync(file, "utf8").split("\n")
          .filter((l) => l.startsWith("ATOM") && l.slice(12, 16) === " CA ")
          .map((l) => [Number(l.slice(22, 26)), [30, 38, 46].map((s) => Number(l.slice(s, s + 8)))] as const),
      );
    const [ca, cb] = [trace(fx("1CRN.pdb")), trace(fx("3HZ7.pdb"))];
    const m = envelope.result.transform.matrix;
    expect(envelope.result.mapping).toHaveLength(28);
    for (const pair of envelope.result.mapping) {
      const p = apply(m, ca.get(pair.a.authSeqId)!);
      const q = cb.get(pair.b.authSeqId);
      if (!q) continue; // an MSE residue is HETATM in this file; it has no ATOM trace line
      expect(Math.abs(pair.distance - Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))).toBeLessThan(2e-3);
    }
    // US-align prints the least-squares RMSD of the aligned pairs (TMalign.h recomputes it with Kabsch,
    // "not t & u"), while its matrix is the TM-score-optimal one. The RMS under that matrix can therefore
    // never be below the printed RMSD.
    const rms = Math.sqrt(envelope.result.mapping.reduce((s, p) => s + p.distance ** 2, 0) / envelope.result.mapping.length);
    expect(rms).toBeGreaterThanOrEqual(envelope.result.rmsd - 0.005);
    expect(rms).toBeLessThan(envelope.result.rmsd + 1);
  });

  it("is zero everywhere for a structure against itself", async () => {
    const { envelope } = await compare(fx("1CRN.pdb"), fx("1CRN.pdb"), captured("crn-self.txt"));
    expect(Math.max(...envelope.result.mapping.map((p) => p.distance))).toBeLessThan(1e-3);
  });

  it("builds one row per pair with a selector-style label and the threshold flag", async () => {
    const { envelope } = await compare(fx("1CRN.pdb"), fx("3HZ7.pdb"), captured("crn-vs-3hz7.txt"));
    const rows = deviationRows(envelope.result, 2);
    expect(rows).toHaveLength(28);
    expect(rows[0]).toEqual({ index: 1, chainA: "A", a: "A:4", nameA: "CYS", b: "A:6", nameB: "ALA", deviation: envelope.result.mapping[0].distance, aboveThreshold: envelope.result.mapping[0].distance > 2 });
    expect(rows.filter((r) => r.aboveThreshold)).toHaveLength(envelope.result.mapping.filter((p) => p.distance > 2).length);
  });
});

describe("the overlay report", () => {
  const read = (file: string) => {
    const report = decodeEnvelope(extractEnvelope(fs.readFileSync(file, "utf8")));
    const dataset = JSON.parse(Buffer.from(report.resources.find((r) => r.id === "deviation")!.data, "base64").toString()) as { rows: Array<Record<string, unknown>> };
    return { report, dataset };
  };

  it("holds both structures, moves only B, and highlights what is above the threshold", async () => {
    const out = path.join(dir, "overlay.html");
    const { envelope } = await compare(fx("1CRN.pdb"), fx("3HZ7.pdb"), captured("crn-vs-3hz7.txt"), { outputPath: out });
    const { report, dataset } = read(out);
    const above = envelope.result.mapping.filter((p) => p.distance > 2);

    expect(envelope.result.report).toMatchObject({ path: out, deviationThreshold: 2, residuesAboveThreshold: above.length });
    expect(report.resources.map((r) => [r.id, r.format])).toEqual([["structure-a", "pdb"], ["structure-b", "pdb"], ["deviation", "json"]]);
    expect(Buffer.from(report.resources[0].data, "base64").equals(fs.readFileSync(fx("1CRN.pdb")))).toBe(true);

    expect(report.scenes).toHaveLength(1);
    const [scene] = report.scenes;
    expect(scene.structures).toHaveLength(2);
    const [sa, sb] = scene.structures;
    expect(sa.transform).toBeUndefined();
    expect(sb.transform).toEqual(overlayTransformForB(envelope.result.transform.matrix));

    expect(scene.components!.map((c) => c.id)).toEqual(["a", "b", "a-deviation", "b-deviation"]);
    expect(scene.components![0]).toMatchObject({ structureId: "a", selection: { kind: "chains", ids: ["A"] }, color: "#4ea1ff" });
    expect(scene.components![1]).toMatchObject({ structureId: "b", color: "#ffa94d" });
    const refs = (c: string) => (scene.components!.find((x) => x.id === c)!.selection as { residues: Array<{ sequenceId: number }> }).residues.map((r) => r.sequenceId);
    expect(refs("a-deviation")).toEqual(above.map((p) => p.a.authSeqId));
    expect(refs("b-deviation")).toEqual(above.map((p) => p.b.authSeqId));

    expect(dataset.rows).toHaveLength(28);
    const chart = report.panels.find((p) => p.kind === "chart")!;
    expect(chart).toMatchObject({ dataset: { resourceId: "deviation", rowsKey: "rows" }, chart: { type: "line", x: { field: "index" }, y: { field: "deviation", unit: "Å" } } });
    expect((chart as { chart: { seriesField?: string } }).chart.seriesField).toBeUndefined();
  });

  it("highlights nothing and writes no deviation components when everything is under the threshold", async () => {
    const out = path.join(dir, "self.html");
    const { envelope } = await compare(fx("1CRN.pdb"), fx("1CRN.pdb"), captured("crn-self.txt"), { outputPath: out });
    expect(envelope.result.report!.residuesAboveThreshold).toBe(0);
    expect(read(out).report.scenes[0].components!.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("uses a custom threshold and one series per chain for a multimer", async () => {
    const out = path.join(dir, "mm.html");
    const { envelope } = await compare(fx("1AAY.pdb"), fx("1AAY.pdb"), captured("aay-multimer.txt"), { outputPath: out, deviationThreshold: 0.25 }, { multimer: true });
    const { report, dataset } = read(out);
    // (the captured matrix belongs to a moved copy, so these two identical files do deviate)
    const above = envelope.result.mapping.filter((p) => p.distance > 0.25).length;
    expect(above).toBeGreaterThan(0);
    expect(envelope.result.report).toMatchObject({ deviationThreshold: 0.25, residuesAboveThreshold: above });
    expect(report.scenes[0].components!.map((c) => c.id)).toEqual(["a", "b", "a-deviation", "b-deviation"]);
    expect((report.panels.find((p) => p.kind === "chart") as { chart: { seriesField: string } }).chart.seriesField).toBe("chainA");
    expect([...new Set(dataset.rows.map((r) => r.chainA))]).toEqual(["B", "C", "A"]);
    expect(report.scenes[0].components![0].selection).toEqual({ kind: "chains", namespace: "auth", ids: ["B", "C", "A"] });
  });

  it("refuses an existing file before running US-align, and writes nothing on a bad threshold", async () => {
    const out = path.join(dir, "exists.html");
    fs.writeFileSync(out, "keep");
    const s = stub(captured("crn-self.txt"));
    await expect(compareStructureFiles(fx("1CRN.pdb"), fx("1CRN.pdb"), { paths, runner: s.runner, report: { outputPath: out } })).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    await expect(compareStructureFiles(fx("1CRN.pdb"), fx("1CRN.pdb"), { paths, runner: s.runner, report: { outputPath: dir } })).rejects.toMatchObject({ code: "INVALID_VIEW_INPUT" });
    for (const deviationThreshold of [0, -1, NaN, 101]) {
      await expect(compareStructureFiles(fx("1CRN.pdb"), fx("1CRN.pdb"), { paths, runner: s.runner, report: { outputPath: path.join(dir, "t.html"), deviationThreshold } })).rejects.toMatchObject({ code: "INVALID_COMPARE_ARGS" });
    }
    expect(s.calls).toHaveLength(0);
    expect(fs.readFileSync(out, "utf8")).toBe("keep");
    expect(fs.existsSync(path.join(dir, "t.html"))).toBe(false);
  });

  it("does not embed a structure that changed since it was compared", async () => {
    const { envelope } = await compare(fx("1CRN.pdb"), fx("1CRN.pdb"), captured("crn-self.txt"));
    const copy = path.join(dir, "copy.pdb");
    fs.copyFileSync(fx("1CRN.pdb"), copy);
    const result: CompareResult = { ...envelope.result, inputs: { ...envelope.result.inputs, a: { ...envelope.result.inputs.a, path: copy } } };
    fs.appendFileSync(copy, "REMARK edited after the comparison\n");
    await expect(createComparisonReport(result, { outputPath: path.join(dir, "x.html") })).rejects.toMatchObject({ code: "INPUT_CHANGED" });
    expect(fs.existsSync(path.join(dir, "x.html"))).toBe(false);
  });
});
