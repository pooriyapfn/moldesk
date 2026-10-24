// Opt-in: talks to the real RCSB, AlphaFold DB and UniProt services and saves what they return.
//   MOLDESK_LIVE_FETCH=1 pnpm --filter @moldesk/core exec vitest run src/fetch/fetch.live.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMoldeskPaths } from "@moldesk/runtime";
import { analyzeStructureFile } from "../analysis/analyze.js";
import { validateFasta } from "../analysis/fasta.js";
import { fetchStructure } from "./fetch.js";

describe.runIf(process.env.MOLDESK_LIVE_FETCH === "1")("fetch from the real services", () => {
  let dir: string;
  let paths: ReturnType<typeof getMoldeskPaths>;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-live-fetch-"));
    paths = getMoldeskPaths({ MOLDESK_HOME: path.join(dir, "home") });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("pdb:1M17 as mmCIF and PDB, readable by analyze, with provenance", async () => {
    const cif = (await fetchStructure("pdb:1M17", { paths })).result;
    expect(cif).toMatchObject({ format: "mmcif", fromCache: false, provenance: { license: { name: "CC0 1.0" } } });
    expect(cif.provenance.url).toBe("https://files.rcsb.org/download/1M17.cif");
    expect(cif.provenance.sourceVersion).toMatch(/^\d{4}-\d\d-\d\dT/);
    const analysis = await analyzeStructureFile(cif.files[0].path);
    expect(analysis.result.chains.some((c) => c.type === "protein" && (c.sequence?.length ?? 0) > 200)).toBe(true);

    const pdb = (await fetchStructure("pdb:1m17", { paths, format: "pdb" })).result;
    expect(pdb.files[0].name).toBe("1M17.pdb");
    expect((await analyzeStructureFile(pdb.files[0].path)).result.chains.length).toBeGreaterThan(0);
    expect((await fetchStructure("pdb:1M17", { paths })).result.fromCache).toBe(true);
  }, 120_000);

  it("afdb:P00533 resolved through the API, with the model version and ModelCIF pLDDT", async () => {
    const { result, warnings } = await fetchStructure("afdb:P00533", { paths });
    expect(result.provenance).toMatchObject({ sourceVersionKind: "alphafold-model-version", details: { entryId: "AF-P00533-F1" } });
    expect(result.provenance.sourceVersion).toMatch(/^v\d+$/);
    expect(result.provenance.url).toMatch(/^https:\/\/alphafold\.ebi\.ac\.uk\/files\/AF-P00533-F1-model_v\d+\.cif$/);
    expect(warnings.map((w) => w.code)).toContain("PREDICTED_STRUCTURE");
    const analysis = await analyzeStructureFile(result.files[0].path);
    expect(analysis.result.confidence).toMatchObject({ source: "modelcif" });
    expect((await fetchStructure("afdb:P00533", { paths, format: "pdb" })).result.files[0].name).toBe("AF-P00533-F1.pdb");
  }, 180_000);

  it("uniprot:P00533 as FASTA that the FASTA validator accepts", async () => {
    const { result } = await fetchStructure("uniprot:P00533", { paths });
    expect(result.provenance).toMatchObject({ sourceVersionKind: "uniprot-release" });
    expect(result.provenance.sourceVersion).toMatch(/^\d{4}_\d\d$/);
    expect(validateFasta(result.files[0].path).records).toHaveLength(1);
  }, 60_000);

  it("a well-formed accession that does not exist is not found and leaves nothing in the cache", async () => {
    // PDB ids are dense (every 4-character id checked exists), so the check uses accessions.
    for (const spec of ["afdb:Z9ZZZ9", "uniprot:Z9ZZZ9"]) {
      await expect(fetchStructure(spec, { paths })).rejects.toMatchObject({ code: "FETCH_NOT_FOUND" });
    }
    expect(fs.existsSync(path.join(paths.cache, "fetch", "afdb", "Z9ZZZ9"))).toBe(false);
    expect(fs.existsSync(path.join(paths.cache, "fetch", "uniprot", "Z9ZZZ9"))).toBe(false);
  }, 60_000);
});
