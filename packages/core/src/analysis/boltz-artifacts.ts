import fs from "node:fs";
import path from "node:path";
import { MoldeskError } from "../errors.js";
import { sha256File } from "../hash.js";
import type { RunRecord } from "../run.js";

export interface HashedFile { path: string; sha256: string; sizeBytes: number }
export interface BoltzPredictionArtifacts {
  recordId: string;
  predictionRank: number;
  structure: HashedFile;
  confidence: HashedFile;
  pae?: HashedFile;
  plddt?: HashedFile;
}
export function artifactMismatch(message: string): never {
  throw new MoldeskError({ code: "BOLTZ_ARTIFACT_MISMATCH", message, remediation: "Select one complete, unchanged prediction from its original run record." });
}

/** Reject symlinks in any path component, including prediction directories. */
export async function hashArtifact(file: string, maxBytes = Infinity): Promise<HashedFile> {
  const absolute = path.resolve(file);
  // realpath can differ at /tmp on macOS; inspect components rather than comparing strings.
  let current = path.parse(absolute).root;
  try {
    for (const part of absolute.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      // OS-owned /tmp and /var aliases are allowed; user-controlled components are not.
      if (fs.lstatSync(current).isSymbolicLink() && !["/tmp", "/var"].includes(current)) artifactMismatch(`Symlink artifact: ${current}`);
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) artifactMismatch(`Invalid artifact size/type: ${absolute}`);
    return { path: absolute, sizeBytes: stat.size, sha256: await sha256File(absolute) };
  } catch (error) {
    if (error instanceof MoldeskError) throw error;
    return artifactMismatch(`Cannot read artifact: ${absolute}`);
  }
}
export async function verifyArtifact(file: HashedFile): Promise<void> {
  const actual = await hashArtifact(file.path);
  if (actual.sha256 !== file.sha256 || actual.sizeBytes !== file.sizeBytes) artifactMismatch(`Artifact changed: ${file.path}`);
}

export async function resolveBoltzPredictionArtifacts(
  record: RunRecord,
  selector: { recordId?: string; predictionRank?: number } = {},
): Promise<BoltzPredictionArtifacts> {
  if (record.model !== "boltz" || record.status !== "succeeded") artifactMismatch("Expected a successful Boltz run.");
  const matches = record.outputs.filter((o) => o.id === "structures").flatMap((structure) => {
    const m = /^(.*)_model_(\d+)\.cif$/.exec(path.basename(structure.path));
    if (!m || path.basename(path.dirname(structure.path)) !== m[1]) return [];
    const predictionRank = Number(m[2]);
    return (selector.recordId === undefined || selector.recordId === m[1]) &&
      (selector.predictionRank === undefined || selector.predictionRank === predictionRank)
      ? [{ structure, recordId: m[1], predictionRank }] : [];
  });
  if (matches.length !== 1) artifactMismatch(`Expected one prediction; found ${matches.length}. Specify recordId and predictionRank.`);
  const { structure, recordId, predictionRank } = matches[0];
  const sidecar = (id: string, prefix: string, ext: string, required: boolean): HashedFile | undefined => {
    const expected = path.join(path.dirname(structure.path), `${prefix}${path.basename(structure.path, ".cif")}${ext}`);
    const found = record.outputs.filter((o) => o.id === id && path.resolve(o.path) === path.resolve(expected));
    if (found.length > 1 || (required && found.length !== 1)) artifactMismatch(`Missing/duplicate ${id} for ${structure.path}`);
    return found[0];
  };
  const result = { recordId, predictionRank, structure, confidence: sidecar("confidence", "confidence_", ".json", true)!,
    pae: sidecar("pae", "pae_", ".npz", false), plddt: sidecar("plddt", "plddt_", ".npz", false) };
  for (const file of [result.structure, result.confidence, result.pae, result.plddt]) if (file) await verifyArtifact(file);
  return result;
}
