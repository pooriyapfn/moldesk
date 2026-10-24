// JSON Schema (draft-07) for the `result` of each envelope kind. Required fields and types are pinned so agents
// can rely on them; extra fields are allowed so a later release can add data without breaking readers.
type Schema = Record<string, unknown>;

const string: Schema = { type: "string" };
const boolean: Schema = { type: "boolean" };
const number: Schema = { type: "number" };
const integer: Schema = { type: "integer" };
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });
const array = (items: Schema): Schema => ({ type: "array", items });
const tuple3: Schema = { type: "array", items: number, minItems: 3, maxItems: 3 };
const sha256: Schema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const oneOf = (...values: Array<string | number>): Schema => ({ enum: values });
const object = (required: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema => ({
  type: "object",
  required: Object.keys(required),
  properties: { ...required, ...optional },
});

const residueId = { authSeqId: integer, labelSeqId: nullable(integer) };
const insertionCode = { insertionCode: string };
const structureInput = object({ path: string, format: oneOf("pdb", "mmcif"), sha256 });
const mappedResidue = object({ chainAuthId: string, ...residueId, name: string }, insertionCode);

const analysisStructure = object(
  {
    modelCount: integer,
    analyzedModel: { const: 0 },
    chains: array(
      object(
        { authId: string, labelId: string, entityId: string, type: oneOf("protein", "dna", "rna", "polymer", "ligand", "water", "other"), residueCount: integer },
        {
          sequence: string,
          gaps: array(object({ after: object(residueId, insertionCode), before: object(residueId, insertionCode), missing: integer })),
          unobserved: array(object({ ...residueId, name: string }, insertionCode)),
          secondaryStructure: object({ helix: number, strand: number, coil: number }),
          meanPlddt: number,
          residues: array(object({ ...residueId, name: string }, { ...insertionCode, secondaryStructure: oneOf("H", "E", "C"), plddt: number })),
        },
      ),
    ),
    secondaryStructure: object({ source: oneOf("file", "computed", "none") }),
    geometry: nullable(object({ centerOfMass: tuple3, radiusOfGyration: number, boundingBox: object({ min: tuple3, max: tuple3 }) })),
    confidence: nullable(object({ source: oneOf("modelcif", "moldesk-run", "user-flag"), detail: string, scale: { const: "0-100" }, mean: nullable(number) }, { summary: { type: "object" } })),
  },
);

const analysisFasta = object({
  fasta: object({ path: string, sha256, valid: { const: true }, records: array(object({ header: string, length: integer })) }),
});

const inspectResult = object({
  selector: object({ text: string, namespace: oneOf("auth", "label") }),
  radius: number,
  residues: array(
    object(
      { chainAuthId: string, chainLabelId: string, ...residueId, name: string, atomCount: integer, neighbors: array(
        object({ chainAuthId: string, chainLabelId: string, ...residueId, name: string, distance: number, atoms: object({ selected: string, neighbor: string }) }, insertionCode),
      ) },
      { ...insertionCode, secondaryStructure: oneOf("H", "E", "C"), plddt: number },
    ),
  ),
});

const matrix4: Schema = { type: "array", minItems: 4, maxItems: 4, items: { type: "array", items: number, minItems: 4, maxItems: 4 } };
const compareResult = object(
  {
    mode: oneOf("monomer", "multimer"),
    inputs: object({ a: structureInput, b: structureInput }),
    chains: object({ a: array(string), b: array(string) }),
    lengths: object({ a: integer, b: integer }),
    alignedLength: integer,
    rmsd: number,
    sequenceIdentity: number,
    tmScore: object({ normalizedByA: number, normalizedByB: number }),
    transform: object({ matrix: matrix4 }),
    mapping: array(object({ a: mappedResidue, b: mappedResidue, distance: number })),
    citation: array(string),
  },
  { report: object({ path: string, fileUrl: string, sha256, sizeBytes: integer, deviationThreshold: number, residuesAboveThreshold: integer }) },
);

const license = object({ name: string, url: string }, { notice: string });
const fetchResult = object({
  source: oneOf("pdb", "afdb", "uniprot"),
  id: string,
  format: oneOf("mmcif", "pdb", "fasta"),
  fromCache: boolean,
  cacheDir: string,
  files: array(object({ name: string, format: oneOf("mmcif", "pdb", "fasta"), path: string, sha256, sizeBytes: integer })),
  provenance: object(
    {
      schemaVersion: { const: 1 },
      source: oneOf("pdb", "afdb", "uniprot"),
      id: string,
      file: string,
      format: oneOf("mmcif", "pdb", "fasta"),
      url: string,
      retrievedAt: string,
      sha256,
      sizeBytes: integer,
      sourceVersion: nullable(string),
      sourceVersionKind: oneOf("http-last-modified", "alphafold-model-version", "uniprot-release"),
      details: { type: "object", additionalProperties: string },
      license,
      moldeskVersion: string,
    },
    { apiUrl: string },
  ),
});

const platform = oneOf("darwin-arm64", "linux-x64");
const requirement = oneOf("required", "recommended", "unsupported");
const reason = object({ code: string, severity: oneOf("info", "warning", "error"), message: string }, { remediation: string });
const status = oneOf("compatible", "warning", "unsupported");
const parameterValue: Schema = { type: ["string", "number", "boolean"] };
const modelResult = object(
  {
    name: string,
    displayName: string,
    modelVersion: string,
    adapterVersion: string,
    description: string,
    category: string,
    status: oneOf("available", "beta", "planned"),
    capabilities: object({ category: string, installable: boolean, installed: boolean, cloud: boolean }),
    input: object({ formats: array(string), required: boolean }),
    outputs: array(object({ id: string, glob: string, required: boolean })),
    parameters: array(
      object(
        { name: string, type: oneOf("string", "number", "boolean"), required: boolean },
        {
          default: parameterValue,
          defaultsByPlatform: { type: "object", additionalProperties: parameterValue },
          min: number,
          max: number,
          enum: array({ type: ["string", "number"] }),
          description: string,
        },
      ),
    ),
    runtimes: array(
      object(
        { kind: oneOf("python", "docker") },
        { platforms: array(platform), python: string, installer: string, image: string, gpu: string, nvidiaGpu: requirement, cuda: object({ level: requirement }, { minDriverCudaVersion: string }), minVramGb: number, estimatedDownloadBytes: integer, estimatedDiskBytes: integer },
      ),
    ),
    hardware: object({}, { platforms: array(platform), minRamGb: number, minDiskGb: number, nvidiaGpu: requirement, minVramGb: number, cuda: object({ level: requirement }, { minDriverCudaVersion: string }) }),
    assets: array(object({ id: string, url: string }, { sizeBytes: integer, license: string, source: string })),
    compatibility: object({ status, reasons: array(reason), runtimes: array(object({ kind: oneOf("python", "docker"), status, reasons: array(reason) })) }, { selectedRuntime: oneOf("python", "docker") }),
    verdict: string,
    cloud: {
      anyOf: [
        object({ available: { const: false } }),
        object({ available: { const: true }, provider: { const: "runpod" }, platform, minVramGb: number, minRamGb: number, ephemeralDiskGb: integer, volumeGb: integer, cpuAssetPreparation: boolean }, { gpuAllowList: array(string) }),
      ],
    },
  },
  {
    license: string,
    homepage: string,
    source: object({ repository: string, revision: string }),
    adapterVerification: object({ lastVerifiedAt: string, platforms: array(string) }, { notes: string }),
  },
);

/** The `result` schema for a kind. */
export const RESULT_SCHEMAS: Record<string, Schema> = {
  "moldesk.analysis": { anyOf: [analysisStructure, analysisFasta] },
  "moldesk.inspect": inspectResult,
  "moldesk.compare": compareResult,
  "moldesk.fetch": fetchResult,
  "moldesk.model": modelResult,
};
