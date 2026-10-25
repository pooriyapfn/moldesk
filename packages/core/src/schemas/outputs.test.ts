// Every command's real `--json` envelope against the schema `moldesk schema <kind>` prints, checked with an
// independent JSON Schema validator (ajv), plus mutations that must be rejected.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Ajv from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMoldeskPaths } from "@moldesk/runtime";
import { analyzeStructureFile } from "../analysis/analyze.js";
import { compareStructureFiles } from "../analysis/compare.js";
import { fastaValidationEnvelope, validateFasta } from "../analysis/fasta.js";
import { inspectStructureFile } from "../analysis/inspect.js";
import { describeModel } from "../describe/describe.js";
import { fetchStructure } from "../fetch/fetch.js";
import { captured, usalignHome } from "../testSupport/usalign.js";
import { ENVELOPE_KINDS, schemaForKind, validateEnvelope, type EnvelopeKind } from "./envelope.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../../visualizer/test/fixtures");
const fx = (name: string) => path.join(FIXTURES, name);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const validator = (kind: EnvelopeKind) => new Ajv({ allErrors: true }).compile(schemaForKind(kind));

const MODELCIF = `
loop_
_ma_qa_metric.id
_ma_qa_metric.name
_ma_qa_metric.mode
1 pLDDT local
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
#
`;

let dir: string;
let server: http.Server;
let host: string;
const samples: Partial<Record<EnvelopeKind, unknown[]>> = {};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-outputs-"));
  const add = (kind: EnvelopeKind, value: unknown) => (samples[kind] ??= []).push(plain(value));

  add("moldesk.analysis", await analyzeStructureFile(fx("1CRN.pdb")));
  add("moldesk.analysis", await analyzeStructureFile(fx("1AAY.pdb")));
  add("moldesk.analysis", await analyzeStructureFile(fx("1D3Z-3models.pdb"), { bfactorIsPlddt: true }));
  fs.writeFileSync(path.join(dir, "m.cif"), fs.readFileSync(fx("1CRN.cif"), "utf8") + MODELCIF);
  add("moldesk.analysis", await analyzeStructureFile(path.join(dir, "m.cif")));
  fs.writeFileSync(path.join(dir, "x.fa"), ">a\nACDE\n>b\nGHIK\n");
  add("moldesk.analysis", fastaValidationEnvelope(validateFasta(path.join(dir, "x.fa"))));

  add("moldesk.inspect", await inspectStructureFile(fx("1CRN.pdb"), "A:7-9"));
  add("moldesk.inspect", await inspectStructureFile(fx("1IGT-VH.pdb"), "B:100H", { radius: 6 }));
  add("moldesk.inspect", await inspectStructureFile(fx("1AAY.pdb"), "A:201"));

  const paths = usalignHome(dir, { installed: true });
  const stub = (output: string) => async () => ({ code: 0, stdout: output, stderr: "" });
  add("moldesk.compare", await compareStructureFiles(fx("1CRN.pdb"), fx("1CRN.pdb"), { paths, runner: stub(captured("crn-self.txt")) }));
  add("moldesk.compare", await compareStructureFiles(fx("1CRN.pdb"), fx("3HZ7.pdb"), { paths, runner: stub(captured("crn-vs-3hz7.txt")), report: { outputPath: path.join(dir, "r.html") } }));
  add("moldesk.compare", await compareStructureFiles(fx("1AAY.pdb"), fx("1AAY.pdb"), { paths, runner: stub(captured("aay-multimer.txt")), multimer: true }));

  server = http.createServer((req, res) => {
    if (req.url === "/download/1M17.cif") res.writeHead(200, { "last-modified": "Mon, 22 Sep 2025 00:17:19 GMT" }).end("data_1M17\nloop_\n_atom_site.id\n1\n");
    else if (req.url === "/uniprotkb/P00533.fasta") res.writeHead(200, { "x-uniprot-release": "2026_03" }).end(">sp|P00533|E\nMRPSG\n");
    else if (req.url === "/api/prediction/P00533") res.end(JSON.stringify([{ entryId: "AF-P00533-F1", modelCreatedDate: "2025-08-01T00:00:00Z", cifUrl: "https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.cif" }]));
    else if (req.url === "/files/AF-P00533-F1-model_v6.cif") res.end("data_AF-P00533-F1\nloop_\n_atom_site.id\n1\n");
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoint = { host, scheme: "http" as const };
  const opts = { paths: getMoldeskPaths({ MOLDESK_HOME: path.join(dir, "fetch-home") }), endpoints: { pdb: endpoint, afdb: endpoint, uniprot: endpoint } };
  for (const spec of ["pdb:1M17", "afdb:P00533", "uniprot:P00533", "pdb:1M17"]) add("moldesk.fetch", await fetchStructure(spec, opts)); // the last one is a cache hit

  const report = { capturedAt: "2026-01-01T00:00:00.000Z", platform: "linux", arch: "x64", cpu: { model: "T", logicalCores: 8 }, memory: { totalBytes: 64 * 1024 ** 3 }, disk: { availableBytes: 500 * 1024 ** 3, path: "/tmp" }, appleSilicon: false, hostPython: { available: false }, docker: { available: false, running: false, gpuAccess: "unknown" }, nvidia: { available: false, gpus: [] } } as never;
  for (const name of ["boltz", "proteinmpnn", "bindcraft2"]) add("moldesk.model", await describeModel(name, { report, paths }));
}, 120_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("every kind has real output to check", () => {
  it.each(ENVELOPE_KINDS)("%s", (kind) => {
    expect(samples[kind]?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe.each(ENVELOPE_KINDS)("%s output validates against its schema", (kind) => {
  it("with the independent validator and the envelope validator", () => {
    const validate = validator(kind);
    for (const sample of samples[kind]!) {
      expect(validate(sample), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
      validateEnvelope(sample, kind);
    }
  });

  it("and not against another kind's schema", () => {
    const other = ENVELOPE_KINDS.find((k) => k !== kind)!;
    expect(validator(other)(samples[kind]![0])).toBe(false);
  });
});

describe("the schemas reject drift", () => {
  const mutations: Record<string, Array<(e: any) => void>> = {
    "moldesk.analysis": [
      (e) => delete e.schemaVersion,
      (e) => (e.warnings = "none"),
      (e) => delete e.result.chains[0].authId,
      (e) => (e.result.chains[0].residueCount = "46"),
      (e) => (e.result.geometry.centerOfMass = [1, 2]),
      (e) => (e.result.confidence = { source: "guess" }),
      (e) => (e.result.secondaryStructure.source = "alpha"),
    ],
    "moldesk.inspect": [
      (e) => delete e.result.residues[0].atomCount,
      (e) => (e.result.residues[0].neighbors[0].distance = "3.4"),
      (e) => (e.result.selector.namespace = "both"),
    ],
    "moldesk.compare": [
      (e) => (e.result.transform.matrix = e.result.transform.matrix.slice(0, 3)),
      (e) => delete e.result.mapping[0].distance,
      (e) => (e.result.tmScore.normalizedByA = "1"),
      (e) => (e.result.mode = "dimer"),
      (e) => (e.result.inputs.a.sha256 = "xyz"),
    ],
    "moldesk.fetch": [
      (e) => delete e.result.provenance.license,
      (e) => (e.result.provenance.sha256 = "short"),
      (e) => (e.result.source = "pubchem"),
      (e) => (e.result.files = {}),
    ],
    "moldesk.model": [
      (e) => delete e.result.capabilities,
      (e) => (e.result.cloud = { available: true }),
      (e) => (e.result.parameters[0].type = "integer"),
    ],
  };
  describe.each(Object.entries(mutations))("%s", (kind, list) => {
    it.each(list.map((m, i) => [i, m] as const))("mutation %i is rejected", (_i, mutate) => {
      const bad = plain(samples[kind as EnvelopeKind]![0]);
      mutate(bad);
      expect(validator(kind as EnvelopeKind)(bad)).toBe(false);
    });
  });
});
