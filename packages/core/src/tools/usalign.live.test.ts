// Opt-in: downloads the pinned US-align source, builds it with your compiler and aligns real structures.
//   MOLDESK_LIVE_USALIGN=1 pnpm --filter @moldesk/core exec vitest run src/tools/usalign.live.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareStructureFiles } from "../analysis/compare.js";
import { APPLIED, usalignHome } from "../testSupport/usalign.js";
import { installUsalign, requireUsalign, uninstallUsalign } from "./usalign.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../../visualizer/test/fixtures");
const fx = (name: string) => path.join(FIXTURES, name);

/** The fixture with every coordinate moved by the known rigid transform. */
function moved(source: string, target: string): void {
  const { R, t } = APPLIED;
  const lines = fs.readFileSync(source, "utf8").split("\n").map((line) => {
    if (!line.startsWith("ATOM") && !line.startsWith("HETATM")) return line;
    const p = [30, 38, 46].map((s) => Number(line.slice(s, s + 8)));
    const q = [0, 1, 2].map((i) => R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2] + t[i]);
    return line.slice(0, 30) + q.map((v) => v.toFixed(3).padStart(8)).join("") + line.slice(54);
  });
  fs.writeFileSync(target, lines.join("\n"));
}

describe.runIf(process.env.MOLDESK_LIVE_USALIGN === "1")("US-align, for real", () => {
  let dir: string;
  let paths: ReturnType<typeof usalignHome>;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-live-usalign-"));
    paths = usalignHome(dir);
    await installUsalign({ paths });
    moved(fx("1CRN.pdb"), path.join(dir, "crn-moved.pdb"));
    moved(fx("1AAY.pdb"), path.join(dir, "aay-moved.pdb"));
  }, 300_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("installs a verified binary and is idempotent", async () => {
    const installation = requireUsalign(paths);
    expect(installation.receipt.compiler.version).not.toBe("");
    expect((await installUsalign({ paths })).status).toBe("already-installed");
  });

  it("self-compare: TM 1, RMSD about 0, every residue paired with itself", async () => {
    const { result } = await compareStructureFiles(fx("1CRN.pdb"), fx("1CRN.cif"), { paths });
    expect(result).toMatchObject({ alignedLength: 46, rmsd: 0, tmScore: { normalizedByA: 1, normalizedByB: 1 } });
    expect(result.mapping.every((p) => p.a.authSeqId === p.b.authSeqId)).toBe(true);
  });

  it("a rigidly moved copy: TM about 1 and the returned transform is the applied one, and its inverse the other way", async () => {
    const forward = await compareStructureFiles(fx("1CRN.pdb"), path.join(dir, "crn-moved.pdb"), { paths });
    expect(forward.result.tmScore.normalizedByA).toBeGreaterThan(0.999);
    const m = forward.result.transform.matrix;
    APPLIED.R.forEach((row, i) => row.forEach((v, j) => expect(Math.abs(m[i][j] - v)).toBeLessThan(1e-3)));
    APPLIED.t.forEach((v, i) => expect(Math.abs(m[i][3] - v)).toBeLessThan(1e-3));

    const back = (await compareStructureFiles(path.join(dir, "crn-moved.pdb"), fx("1CRN.pdb"), { paths })).result.transform.matrix;
    const applied = [...APPLIED.R.map((row, i) => [...row, APPLIED.t[i]]), [0, 0, 0, 1]];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const value = [0, 1, 2, 3].reduce((sum, k) => sum + back[i][k] * applied[k][j], 0);
        expect(Math.abs(value - (i === j ? 1 : 0))).toBeLessThan(1e-3);
      }
    }
  });

  it("different proteins, selenomethionine residues, DNA, insertion codes, an NMR ensemble and a complex", async () => {
    expect((await compareStructureFiles(fx("1CRN.pdb"), fx("3HZ7.pdb"), { paths })).result.alignedLength).toBeGreaterThan(10);
    expect((await compareStructureFiles(fx("3HZ7.pdb"), fx("3HZ7.pdb"), { paths })).result.tmScore.normalizedByA).toBe(1);
    expect((await compareStructureFiles(fx("1AAY.pdb"), fx("1BNA.pdb"), { paths, chainA: "B", chainB: "A" })).result.chains).toEqual({ a: ["B"], b: ["A"] });
    expect((await compareStructureFiles(fx("1IGT-VH.pdb"), fx("1IGT-VH.pdb"), { paths })).result.mapping).toHaveLength(126);
    expect((await compareStructureFiles(fx("1D3Z-3models.pdb"), fx("1D3Z-3models.pdb"), { paths })).result.mapping).toHaveLength(76);
    const complex = await compareStructureFiles(fx("1AAY.pdb"), path.join(dir, "aay-moved.pdb"), { paths, multimer: true });
    expect(complex.result).toMatchObject({ mode: "multimer", alignedLength: 107, chains: { a: ["B", "C", "A"] } });
    expect(complex.result.tmScore.normalizedByA).toBeGreaterThan(0.999);
  });

  it("uninstalls", async () => {
    expect(await uninstallUsalign({ paths })).toBe(true);
    await expect(compareStructureFiles(fx("1CRN.pdb"), fx("1CRN.pdb"), { paths })).rejects.toMatchObject({ code: "USALIGN_NOT_INSTALLED" });
  });
});
