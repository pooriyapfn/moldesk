import fs from "node:fs";
import path from "node:path";
import type { ParsedChain, ParsedResidue, ParsedStructure } from "./molstar-model.js";
import type { StructureInput } from "./structure-input.js";

export type ConfidenceSource = "modelcif" | "moldesk-run" | "user-flag";

export interface Confidence {
  source: ConfidenceSource;
  /** Where the value came from, in words an agent can quote. */
  detail: string;
  /** pLDDT on the 0-100 scale for one residue, or null when this residue has none. */
  plddt(chain: ParsedChain, residue: ParsedResidue): number | null;
  /** The model's own confidence JSON (Boltz), attached verbatim. */
  summary?: Record<string, unknown>;
}

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_PARENT_LEVELS = 8;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BOLTZ_STRUCTURE = /^(.+)_model_(\d+)\.cif$/;

/** Reads a small JSON file that is a regular, non-symlink file; anything else is "absent". */
function readSmallJson(file: string): Record<string, unknown> | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return undefined;
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    if (Object.keys(value).some((k) => FORBIDDEN_KEYS.has(k))) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Finds the MoleculeDesk run that produced this exact file: a `run.json` in a parent
 * directory that lists an output with the same SHA-256. A file that merely sits in a folder
 * named like a run is not trusted.
 */
function findRunOutput(input: StructureInput): { model: string; outputId: string; runId: string } | undefined {
  let dir = path.dirname(input.path);
  for (let level = 0; level < MAX_PARENT_LEVELS; level++) {
    const record = readSmallJson(path.join(dir, "run.json"));
    if (record && record.schemaVersion === 1 && typeof record.model === "string" && Array.isArray(record.outputs)) {
      const hit = (record.outputs as Array<Record<string, unknown>>).find((o) => o.sha256 === input.sha256);
      if (hit && typeof hit.id === "string") return { model: record.model, outputId: hit.id, runId: String(record.id) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Decides where pLDDT may come from. Returns undefined when no source is known; a B-factor is
 * never assumed to be pLDDT.
 *  - ModelCIF `ma_qa_metric_local` pLDDT in the file itself.
 *  - A Boltz run output, whose writer stores pLDDT x 100 in the B-factor column (verified in
 *    jwohlwend/boltz at the pinned revision, src/boltz/data/write/mmcif.py).
 *  - `--bfactor-is-plddt`, the user's explicit statement.
 * OpenDDE's B-factor semantics are not verified, so its runs are not listed here.
 */
export function resolveConfidence(
  input: StructureInput,
  parsed: ParsedStructure,
  options: { bfactorIsPlddt?: boolean },
): Confidence | undefined {
  const local = parsed.modelcifPlddt;
  if (local) {
    return {
      source: "modelcif",
      detail: "ModelCIF ma_qa_metric_local pLDDT",
      plddt: (chain, residue) => (residue.labelSeqId === null ? null : local.get(`${chain.labelId}:${residue.labelSeqId}`) ?? null),
    };
  }

  const bfactor = (chain: ParsedChain, residue: ParsedResidue): number | null =>
    chain.entityType === "polymer" ? residue.bfactor : null;

  const run = findRunOutput(input);
  if (run && run.model === "boltz" && run.outputId === "structures") {
    const match = BOLTZ_STRUCTURE.exec(path.basename(input.path));
    const summary = match
      ? readSmallJson(path.join(path.dirname(input.path), `confidence_${match[1]}_model_${match[2]}.json`))
      : undefined;
    return {
      source: "moldesk-run",
      detail: `B-factor column of a Boltz-2 output from MoleculeDesk run ${run.runId} (pLDDT x 100)`,
      plddt: bfactor,
      ...(summary ? { summary } : {}),
    };
  }

  if (options.bfactorIsPlddt) {
    return { source: "user-flag", detail: "B-factor column, as stated by --bfactor-is-plddt", plddt: bfactor };
  }
  return undefined;
}
