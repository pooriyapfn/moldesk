import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEnvelope } from "../schemas/envelope.js";
import { analyzeStructureFile } from "./analyze.js";
import { MOLSTAR_VERSION } from "./molstar-model.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../../visualizer/test/fixtures");
const GOLDEN = path.resolve(import.meta.dirname, "testdata/golden");
const reference = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "testdata/reference.json"), "utf8")) as Record<
  string,
  { sequences: Record<string, string>; waterResidues: number; centerOfMass: number[]; radiusOfGyration: number }
>;
const fixture = (name: string) => path.join(FIXTURES, name);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-analyze-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const fails = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

describe("analyzeStructureFile against independent Biopython reference values", () => {
  it.each(Object.keys(reference))("%s", async (name) => {
    const expected = reference[name];
    const envelope = await analyzeStructureFile(fixture(name));
    validateEnvelope(envelope, "moldesk.analysis");

    const sequences = Object.fromEntries(
      envelope.result.chains.filter((c) => c.sequence).map((c) => [`${c.authId}:${c.type}`, c.sequence]),
    );
    expect(sequences).toEqual(expected.sequences);
    const waters = envelope.result.chains.filter((c) => c.type === "water").reduce((n, c) => n + c.residueCount, 0);
    expect(waters).toBe(expected.waterResidues);

    const g = envelope.result.geometry!;
    g.centerOfMass.forEach((v, k) => expect(Math.abs(v - expected.centerOfMass[k])).toBeLessThan(1e-3));
    expect(Math.abs(g.radiusOfGyration - expected.radiusOfGyration)).toBeLessThan(1e-3);
  });
});

describe("golden output", () => {
  it.each(Object.keys(reference))("%s", async (name) => {
    const envelope = await analyzeStructureFile(fixture(name));
    const stable = { ...envelope, input: { ...envelope.input!, path: name }, provenance: { ...envelope.provenance, moldeskVersion: "x" } };
    await expect(`${JSON.stringify(stable, null, 2)}\n`).toMatchFileSnapshot(path.join(GOLDEN, `${name}.json`));
  });
});

describe("structure details", () => {
  it("reports both chain ids, entity types and a ligand", async () => {
    const { chains } = (await analyzeStructureFile(fixture("1AAY.pdb"))).result;
    expect(chains.map((c) => c.type)).toEqual(["dna", "dna", "protein", "ligand", "water", "water", "water"]);
    expect(chains.find((c) => c.type === "ligand")!.residues![0]).toMatchObject({ name: "ZN", authSeqId: 201 });
  });

  it("uses the file's HELIX/SHEET records, or DSSP when there are none", async () => {
    expect((await analyzeStructureFile(fixture("1CRN.pdb"))).result.secondaryStructure.source).toBe("file");
    const computed = await analyzeStructureFile(fixture("1IGT-VH.pdb"));
    expect(computed.result.secondaryStructure.source).toBe("computed");
    expect(computed.result.chains[0].secondaryStructure!.strand).toBeGreaterThan(0.3);
  });

  it("keeps insertion codes and reports numbering gaps", async () => {
    const [chain] = (await analyzeStructureFile(fixture("1IGT-VH.pdb"))).result.chains;
    expect(chain.residues!.some((r) => r.insertionCode === "H")).toBe(true);
    expect(chain.gaps).toContainEqual({
      after: { authSeqId: 97, labelSeqId: 101 },
      before: { authSeqId: 100, labelSeqId: 102, insertionCode: "H" },
      missing: 2,
    });
  });

  it("analyzes the first model of an NMR ensemble and says so", async () => {
    const envelope = await analyzeStructureFile(fixture("1D3Z-3models.pdb"));
    expect(envelope.result.modelCount).toBe(3);
    expect(envelope.warnings.map((w) => w.code)).toContain("MULTIPLE_MODELS");
  });

  it("marks non-standard residues X", async () => {
    expect((await analyzeStructureFile(fixture("3HZ7.pdb"))).result.chains[0].sequence).toMatch(/^XITIDAL/);
  });

  it("records the pinned Mol* version it ran with", () => {
    const installed = createRequire(import.meta.url)("molstar/package.json") as { version: string };
    expect(MOLSTAR_VERSION).toBe(installed.version);
  });
});

describe("mmCIF unobserved residues", () => {
  it("lists them per chain for model 1", async () => {
    const cif = `${fs.readFileSync(fixture("1CRN.cif"), "utf8")}
loop_
_pdb_unobs_or_zero_occ_residues.id
_pdb_unobs_or_zero_occ_residues.PDB_model_num
_pdb_unobs_or_zero_occ_residues.polymer_flag
_pdb_unobs_or_zero_occ_residues.occupancy_flag
_pdb_unobs_or_zero_occ_residues.auth_asym_id
_pdb_unobs_or_zero_occ_residues.auth_comp_id
_pdb_unobs_or_zero_occ_residues.auth_seq_id
_pdb_unobs_or_zero_occ_residues.PDB_ins_code
_pdb_unobs_or_zero_occ_residues.label_asym_id
_pdb_unobs_or_zero_occ_residues.label_comp_id
_pdb_unobs_or_zero_occ_residues.label_seq_id
1 1 1 1 A GLY 47 ? A GLY 47
2 2 1 1 A GLY 48 ? A GLY 48
#
`.replace(/_pdb_unobs_or_zero_occ_residues/g, "_pdbx_unobs_or_zero_occ_residues");
    const [chain] = (await analyzeStructureFile(write("unobs.cif", cif))).result.chains;
    expect(chain.unobserved).toEqual([{ authSeqId: 47, labelSeqId: 47, name: "GLY" }]);
  });
});

describe("confidence", () => {
  const modelcif = `
loop_
_ma_qa_metric.id
_ma_qa_metric.name
_ma_qa_metric.mode
_ma_qa_metric.type
1 pLDDT local pLDDT
2 other local other
#
loop_
_ma_qa_metric_local.ordinal_id
_ma_qa_metric_local.model_id
_ma_qa_metric_local.label_asym_id
_ma_qa_metric_local.label_seq_id
_ma_qa_metric_local.label_comp_id
_ma_qa_metric_local.metric_id
_ma_qa_metric_local.metric_value
1 1 A 1 THR 1 91.5
2 1 A 1 THR 2 3.0
3 1 A 2 THR 1 70.25
#
`;

  it("is null for an experimental structure and never reads B-factors as pLDDT", async () => {
    const { result, warnings } = await analyzeStructureFile(fixture("1CRN.pdb"));
    expect(result.confidence).toBeNull();
    expect(result.chains[0].residues!.some((r) => r.plddt !== undefined)).toBe(false);
    expect(warnings.map((w) => w.code)).toContain("NO_CONFIDENCE_SOURCE");
  });

  it("reads ModelCIF local pLDDT", async () => {
    const file = write("m.cif", fs.readFileSync(fixture("1CRN.cif"), "utf8") + modelcif);
    const { result } = await analyzeStructureFile(file);
    expect(result.confidence).toMatchObject({ source: "modelcif", scale: "0-100", mean: 80.88 });
    expect(result.chains[0].residues!.slice(0, 3).map((r) => r.plddt)).toEqual([91.5, 70.25, undefined]);
  });

  it("trusts the B-factor column only with --bfactor-is-plddt", async () => {
    const { result } = await analyzeStructureFile(fixture("1CRN.pdb"), { bfactorIsPlddt: true });
    expect(result.confidence?.source).toBe("user-flag");
    expect(result.chains[0].residues![0].plddt).toBeGreaterThan(0);
  });

  describe("Boltz run outputs", () => {
    function boltzRun(model = "boltz", mutate = false) {
      const run = path.join(dir, "run");
      const predictions = path.join(run, "output", "boltz_results_job", "predictions", "job");
      const structure = write(path.relative(dir, path.join(predictions, "job_model_0.cif")), fs.readFileSync(fixture("1CRN.cif")));
      write(path.relative(dir, path.join(predictions, "confidence_job_model_0.json")), JSON.stringify({ confidence_score: 0.9, ptm: 0.8 }));
      const sha256 = createHash("sha256").update(fs.readFileSync(structure)).digest("hex");
      write("run/run.json", JSON.stringify({ schemaVersion: 1, id: "run-1", model, outputs: [{ id: "structures", path: structure, sha256 }] }));
      if (mutate) fs.appendFileSync(structure, "# edited after the run\n");
      return structure;
    }

    it("treats the B-factor as pLDDT and attaches the confidence JSON", async () => {
      const { result } = await analyzeStructureFile(boltzRun());
      expect(result.confidence).toMatchObject({ source: "moldesk-run", summary: { confidence_score: 0.9, ptm: 0.8 } });
      expect(result.chains[0].residues![0].plddt).toBeGreaterThan(0);
    });

    it.each([
      ["another model", () => boltzRun("opendde")],
      ["a file changed after the run", () => boltzRun("boltz", true)],
    ])("does not for %s", async (_name, make) => {
      const { result } = await analyzeStructureFile(make());
      expect(result.confidence).toBeNull();
    });
  });
});

describe("bad input", () => {
  const PDB = fs.readFileSync(fixture("1CRN.pdb"), "utf8");
  const CIF = fs.readFileSync(fixture("1CRN.cif"), "utf8");

  it.each([
    ["missing file", () => path.join(dir, "nope.pdb"), "INPUT_NOT_FOUND"],
    ["a directory", () => dir, "UNSUPPORTED_STRUCTURE_FORMAT"],
    ["unsupported extension", () => write("a.xyz", PDB), "UNSUPPORTED_STRUCTURE_FORMAT"],
    ["empty file", () => write("e.pdb", ""), "INPUT_EMPTY"],
    ["binary file", () => write("b.pdb", Buffer.from([1, 2, 0, 3])), "INPUT_BINARY"],
    ["PDB without atoms", () => write("n.pdb", "HEADER    NOTHING HERE\nEND\n"), "STRUCTURE_PARSE_FAILED"],
    ["mmCIF without atoms", () => write("n.cif", "data_x\n_entry.id x\n"), "STRUCTURE_PARSE_FAILED"],
    ["truncated mmCIF", () => write("t.cif", CIF.slice(0, CIF.indexOf("_atom_site.") + 400)), "STRUCTURE_PARSE_FAILED"],
    ["mmCIF cut inside a data row", () => write("r.cif", CIF.slice(0, CIF.indexOf("\nATOM", CIF.indexOf("\nATOM") + 2000) + 40)), "STRUCTURE_PARSE_FAILED"],
    ["PDB cut inside an ATOM line", () => write("r.pdb", PDB.slice(0, PDB.indexOf("\nATOM      6") + 45)), "STRUCTURE_PARSE_FAILED"],
    ["PDB with a non-numeric coordinate", () => write("x.pdb", PDB.replace("17.047", "  abc  ")), "STRUCTURE_PARSE_FAILED"],
    ["truncated PDB header only", () => write("t.pdb", PDB.slice(0, PDB.indexOf("ATOM"))), "STRUCTURE_PARSE_FAILED"],
  ])("rejects %s", async (_name, make, code) => {
    await fails(analyzeStructureFile(make()), code);
  });

  it("rejects an oversize file before reading it", async () => {
    const file = path.join(dir, "big.pdb");
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, 65 * 1024 * 1024);
    await fails(analyzeStructureFile(file), "INPUT_TOO_LARGE");
  });
});
