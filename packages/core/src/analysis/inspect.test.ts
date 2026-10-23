import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEnvelope } from "../schemas/envelope.js";
import { inspectStructureFile } from "./inspect.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../../visualizer/test/fixtures");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-inspect-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Atom = [name: string, residue: string, seq: number, ins: string, x: number, y: number, z: number];

/** Fixed-column PDB with the given atoms, all in chain A. */
function pdb(atoms: Atom[]): string {
  const lines = atoms.map(([name, res, seq, ins, x, y, z], i) => {
    const f = (v: number) => v.toFixed(3).padStart(8);
    return `ATOM  ${String(i + 1).padStart(5)} ${name.padEnd(4)} ${res} A${String(seq).padStart(4)}${ins}   ${f(x)}${f(y)}${f(z)}  1.00 20.00           ${name.trim()[0].padStart(2)}`;
  });
  return `${lines.join("\n")}\nEND\n`;
}

// Residue 1 (N at the origin, CA 1.5 Å up), residue 2 at 3.4 Å, residue 3 at 8 Å, plus 52 and 52A far away.
const ATOMS: Atom[] = [
  ["N", "ALA", 1, " ", 0, 0, 0],
  ["CA", "ALA", 1, " ", 0, 1.5, 0],
  ["CA", "GLY", 2, " ", 3.4, 0, 0],
  ["CA", "SER", 3, " ", 8, 0, 0],
  ["CA", "ALA", 52, " ", 30, 0, 0],
  ["CA", "ALA", 52, "A", 30, 3.8, 0],
];

function structure(atoms = ATOMS): string {
  const file = path.join(dir, "tiny.pdb");
  fs.writeFileSync(file, pdb(atoms));
  return file;
}

const summary = (r: { authSeqId: number; insertionCode?: string; distance: number; atoms: { selected: string; neighbor: string } }) =>
  [r.authSeqId, r.insertionCode ?? "", r.distance, r.atoms.selected, r.atoms.neighbor];

describe("inspectStructureFile neighbours", () => {
  it("returns exact neighbours at radius 4 and 9", async () => {
    const file = structure();
    const at4 = await inspectStructureFile(file, "A:1", { radius: 4 });
    expect(at4.result.residues[0].atomCount).toBe(2);
    expect(at4.result.residues[0].neighbors.map(summary)).toEqual([[2, "", 3.4, "N", "CA"]]);

    const at9 = await inspectStructureFile(file, "A:1", { radius: 9 });
    expect(at9.result.residues[0].neighbors.map(summary)).toEqual([
      [2, "", 3.4, "N", "CA"],
      [3, "", 8, "N", "CA"],
    ]);

    const middle = await inspectStructureFile(file, "A:2", { radius: 9 });
    expect(middle.result.residues[0].neighbors.map(summary)).toEqual([
      [1, "", 3.4, "CA", "N"],
      [3, "", 4.6, "CA", "CA"],
    ]);
  });

  it("includes a neighbour exactly at the radius and uses the default radius of 5", async () => {
    const exact = await inspectStructureFile(structure(), "A:1", { radius: 3.4 });
    expect(exact.result.residues[0].neighbors).toHaveLength(1);
    const dflt = await inspectStructureFile(structure(), "A:1");
    expect(dflt.result.radius).toBe(5);
    expect(dflt.result.residues[0].neighbors.map((n) => n.authSeqId)).toEqual([2]);
  });

  it("matches a brute-force search on a real structure", async () => {
    const file = path.join(FIXTURES, "1CRN.pdb");
    const atoms = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("ATOM"))
      .map((l) => ({ seq: Number(l.slice(22, 26)), name: l.slice(12, 16).trim(), p: [30, 38, 46].map((s) => Number(l.slice(s, s + 8))), el: l.slice(76, 78).trim() }))
      .filter((a) => a.el !== "H");
    const { result } = await inspectStructureFile(file, "A", { radius: 4.5 });
    expect(result.residues).toHaveLength(46);
    for (const residue of result.residues) {
      const expected = new Map<number, number>();
      for (const a of atoms.filter((a) => a.seq === residue.authSeqId)) {
        for (const b of atoms.filter((b) => b.seq !== residue.authSeqId)) {
          const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
          if (d <= 4.5) expected.set(b.seq, Math.min(expected.get(b.seq) ?? Infinity, d));
        }
      }
      expect(new Map(residue.neighbors.map((n) => [n.authSeqId, n.distance]))).toEqual(
        new Map([...expected].map(([seq, d]) => [seq, Number(d.toFixed(3))])),
      );
    }
  });
});

describe("selectors", () => {
  it("resolves insertion codes exactly and includes them in ranges", async () => {
    const file = structure();
    const ids = async (selector: string) =>
      (await inspectStructureFile(file, selector)).result.residues.map((r) => `${r.authSeqId}${r.insertionCode ?? ""}`);
    expect(await ids("A:52A")).toEqual(["52A"]);
    expect(await ids("A:52")).toEqual(["52"]);
    expect(await ids("A:50-60")).toEqual(["52", "52A"]);
    expect(await ids("A")).toEqual(["1", "2", "3", "52", "52A"]);
    expect(await ids("A:1-2")).toEqual(["1", "2"]);
  });

  it("uses auth ids by default and label ids with label: true", async () => {
    const file = path.join(FIXTURES, "1AAY.pdb");
    const auth = await inspectStructureFile(file, "A:201");
    expect(auth.result.residues).toMatchObject([{ name: "ZN", authSeqId: 201, labelSeqId: 88 }]);
    const label = await inspectStructureFile(file, "A:88", { label: true });
    expect(label.result.selector.namespace).toBe("label");
    expect(label.result.residues.map((r) => r.name)).toEqual(["ZN"]);
  });

  it("reports secondary structure, atom counts and a valid envelope", async () => {
    const envelope = await inspectStructureFile(path.join(FIXTURES, "1CRN.pdb"), "A:7-9");
    validateEnvelope(envelope, "moldesk.inspect");
    expect(envelope.result.residues.map((r) => [r.authSeqId, r.name, r.secondaryStructure, r.atomCount])).toEqual([
      [7, "ILE", "H", 8],
      [8, "VAL", "H", 7],
      [9, "ALA", "H", 5],
    ]);
    expect(envelope.warnings.map((w) => w.code)).toEqual(["NO_CONFIDENCE_SOURCE"]);
  });

  it.each(["A:99", "Z", "A:4-9", "B:1"])("exits with SELECTOR_NO_MATCH for %s (never an empty success)", async (selector) => {
    await expect(inspectStructureFile(structure(), selector)).rejects.toMatchObject({ code: "SELECTOR_NO_MATCH" });
  });

  it("never selects water", async () => {
    await expect(inspectStructureFile(path.join(FIXTURES, "3HZ7.pdb"), "A:2000")).rejects.toMatchObject({ code: "SELECTOR_NO_MATCH" });
  });

  it.each(["A:", ":5", "A:60-40", "A:4x"])("rejects invalid selector %j", async (selector) => {
    await expect(inspectStructureFile(structure(), selector)).rejects.toMatchObject({ code: "INVALID_SELECTOR" });
  });

  it.each([0, -1, NaN, Infinity, 31])("rejects radius %s", async (radius) => {
    await expect(inspectStructureFile(structure(), "A:1", { radius })).rejects.toMatchObject({ code: "INVALID_INSPECT_ARGS" });
  });
});
