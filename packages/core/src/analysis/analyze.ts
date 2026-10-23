import { ENVELOPE_SCHEMA_VERSION, type AnalysisEnvelope } from "../schemas/envelope.js";
import { VERSION } from "../version.js";
import { resolveConfidence } from "./confidence.js";
import { MOLSTAR_VERSION, parseStructure, type ParsedChain, type ParsedResidue, type ParsedStructure } from "./molstar-model.js";
import { readStructureInput } from "./structure-input.js";

export interface ResidueId {
  authSeqId: number;
  labelSeqId: number | null;
  insertionCode?: string;
}

export interface ResidueSummary extends ResidueId {
  name: string;
  secondaryStructure?: "H" | "E" | "C";
  plddt?: number;
}

export interface ChainAnalysis {
  authId: string;
  labelId: string;
  entityId: string;
  type: "protein" | "dna" | "rna" | "polymer" | "ligand" | "water" | "other";
  residueCount: number;
  /** Polymer chains only; `X` marks a non-standard residue. */
  sequence?: string;
  /** Polymer chains only: jumps in author numbering. `missing` residues sit between the two. */
  gaps?: Array<{ after: ResidueId; before: ResidueId; missing: number }>;
  /** Polymer chains of mmCIF files that list unobserved residues. */
  unobserved?: Array<ResidueId & { name: string }>;
  /** Protein chains: fractions of residues. */
  secondaryStructure?: { helix: number; strand: number; coil: number };
  /** Mean pLDDT (0-100) over residues that have one. */
  meanPlddt?: number;
  /** Everything except water, in file order. */
  residues?: ResidueSummary[];
}

export interface AnalysisResult {
  modelCount: number;
  /** Zero-based; only the first model is analyzed. */
  analyzedModel: 0;
  chains: ChainAnalysis[];
  secondaryStructure: { source: "file" | "computed" | "none" };
  /** Heavy, non-water atoms of the analyzed model; Å. */
  geometry: {
    centerOfMass: [number, number, number];
    radiusOfGyration: number;
    boundingBox: { min: [number, number, number]; max: [number, number, number] };
  } | null;
  confidence: { source: string; detail: string; scale: "0-100"; mean: number | null; summary?: Record<string, unknown> } | null;
}

export const NO_CONFIDENCE_WARNING = {
  code: "NO_CONFIDENCE_SOURCE",
  message:
    "No known pLDDT source (ModelCIF metrics or a Boltz run output), so confidence is null. B-factors are not assumed to be pLDDT; pass --bfactor-is-plddt if they are.",
};

export interface AnalyzeOptions {
  /** The user states that the file's B-factor column holds pLDDT. */
  bfactorIsPlddt?: boolean;
}

export const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const mean = (values: number[]): number | null => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export function residueId(r: ParsedResidue): ResidueId {
  return { authSeqId: r.authSeqId, labelSeqId: r.labelSeqId, ...(r.insertionCode ? { insertionCode: r.insertionCode } : {}) };
}

export function summarizeResidue(r: ParsedResidue, plddt: number | null): ResidueSummary {
  return {
    ...residueId(r),
    name: r.name,
    ...(r.secondaryStructure ? { secondaryStructure: r.secondaryStructure } : {}),
    ...(plddt !== null ? { plddt: round(plddt, 2) } : {}),
  };
}

export function chainType(chain: ParsedChain): ChainAnalysis["type"] {
  switch (chain.entityType) {
    case "water":
      return "water";
    case "non-polymer":
    case "branched":
      return "ligand";
    case "polymer": {
      const kind = chain.residues[0]?.kind;
      return kind === "protein" || kind === "dna" || kind === "rna" ? kind : "polymer";
    }
    default:
      return "other";
  }
}

function geometry(atoms: ParsedStructure["atoms"]): AnalysisResult["geometry"] {
  const n = atoms.mass.length;
  if (n === 0) return null;
  let total = 0;
  const com = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const p = [atoms.x[i], atoms.y[i], atoms.z[i]];
    total += atoms.mass[i];
    for (let k = 0; k < 3; k++) {
      com[k] += atoms.mass[i] * p[k];
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  for (let k = 0; k < 3; k++) com[k] /= total;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += atoms.mass[i] * ((atoms.x[i] - com[0]) ** 2 + (atoms.y[i] - com[1]) ** 2 + (atoms.z[i] - com[2]) ** 2);
  }
  const triple = (v: number[]): [number, number, number] => [round(v[0]), round(v[1]), round(v[2])];
  return {
    centerOfMass: triple(com),
    radiusOfGyration: round(Math.sqrt(sum / total)),
    boundingBox: { min: triple(min), max: triple(max) },
  };
}

/** Structural summary of a PDB/mmCIF file (first model), as an `moldesk.analysis` envelope. */
export async function analyzeStructureFile(file: string, options: AnalyzeOptions = {}): Promise<AnalysisEnvelope<AnalysisResult>> {
  const input = readStructureInput(file);
  const parsed = await parseStructure(input);
  const confidence = resolveConfidence(input, parsed, options);
  const warnings: AnalysisEnvelope["warnings"] = [];
  const allPlddt: number[] = [];

  const chains = parsed.chains.map((chain): ChainAnalysis => {
    const type = chainType(chain);
    const out: ChainAnalysis = {
      authId: chain.authId,
      labelId: chain.labelId,
      entityId: chain.entityId,
      type,
      residueCount: chain.residueCount,
    };
    if (type === "water") return out;

    const plddt: number[] = [];
    out.residues = chain.residues.map((r) => {
      const value = confidence?.plddt(chain, r) ?? null;
      if (value !== null) plddt.push(value);
      return summarizeResidue(r, value);
    });
    allPlddt.push(...plddt);
    const chainMean = mean(plddt);
    if (chainMean !== null) out.meanPlddt = round(chainMean, 2);

    if (chain.entityType === "polymer") {
      out.sequence = chain.residues.map((r) => r.letter ?? "X").join("");
      out.gaps = [];
      for (let i = 1; i < chain.residues.length; i++) {
        const [a, b] = [chain.residues[i - 1], chain.residues[i]];
        if (b.authSeqId - a.authSeqId > 1) {
          out.gaps.push({ after: residueId(a), before: residueId(b), missing: b.authSeqId - a.authSeqId - 1 });
        }
      }
      const unobserved = parsed.unobserved.filter((u) => u.authChainId === chain.authId);
      if (unobserved.length > 0) {
        out.unobserved = unobserved.map((u) => ({
          authSeqId: u.authSeqId,
          labelSeqId: u.labelSeqId,
          ...(u.insertionCode ? { insertionCode: u.insertionCode } : {}),
          name: u.name,
        }));
      }
    }

    const proteinResidues = chain.residues.filter((r) => r.secondaryStructure);
    if (proteinResidues.length > 0) {
      const share = (code: string): number => round(proteinResidues.filter((r) => r.secondaryStructure === code).length / proteinResidues.length);
      out.secondaryStructure = { helix: share("H"), strand: share("E"), coil: share("C") };
    }
    return out;
  });

  if (parsed.modelCount > 1) {
    warnings.push({ code: "MULTIPLE_MODELS", message: `The file has ${parsed.modelCount} models; only model 0 was analyzed.` });
  }
  if (!confidence) {
    warnings.push(NO_CONFIDENCE_WARNING);
  }
  if (parsed.atomsWithoutMass > 0) {
    warnings.push({ code: "UNKNOWN_ELEMENT", message: `${parsed.atomsWithoutMass} atoms with an unknown element were left out of the geometry.` });
  }

  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    kind: "moldesk.analysis",
    status: "ok",
    input: { path: input.path, format: input.format, sha256: input.sha256 },
    result: {
      modelCount: parsed.modelCount,
      analyzedModel: 0,
      chains,
      secondaryStructure: { source: parsed.secondaryStructureSource },
      geometry: geometry(parsed.atoms),
      confidence: confidence
        ? {
            source: confidence.source,
            detail: confidence.detail,
            scale: "0-100",
            mean: allPlddt.length ? round(mean(allPlddt) as number, 2) : null,
            ...(confidence.summary ? { summary: confidence.summary } : {}),
          }
        : null,
    },
    warnings,
    provenance: { moldeskVersion: VERSION, tool: { name: "molstar", version: MOLSTAR_VERSION } },
  };
}
