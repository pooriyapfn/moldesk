import fs from "node:fs";
import path from "node:path";
import { writeFileExclusive } from "@moldesk/visualizer";
import { MoldeskError } from "../errors.js";
import { ENVELOPE_SCHEMA_VERSION, type AnalysisEnvelope } from "../schemas/envelope.js";
import { VERSION } from "../version.js";
import type { AnalysisResult } from "./analyze.js";
import { asMoldeskError } from "../visualization.js";
import { readTextInput } from "./structure-input.js";

/** Standard residues plus ambiguity codes (B, X, Z, U, O), a stop `*` and a gap `-`. */
const ALPHABET = /^[ACDEFGHIKLMNPQRSTVWYBXZUO*-]+$/i;
const MAX_REPORTED_ISSUES = 10;

/** One FASTA record per polymer chain; the header carries both chain ids so it is unique. */
export function chainsToFasta(envelope: AnalysisEnvelope<AnalysisResult>): string {
  const stem = path.basename(envelope.input?.path ?? "structure").replace(/\.[^.]*$/, "");
  return envelope.result.chains
    .filter((chain) => chain.sequence)
    .map((chain) => `>${stem}|chain ${chain.authId}|label ${chain.labelId}|${chain.type}\n${chain.sequence}\n`)
    .join("");
}

/** Writes the chain sequences atomically; refuses to overwrite an existing file. Returns the absolute path. */
export async function writeFastaFile(envelope: AnalysisEnvelope<AnalysisResult>, dest: string): Promise<string> {
  const fasta = chainsToFasta(envelope);
  if (fasta === "") {
    throw new MoldeskError({
      code: "NO_POLYMER_CHAINS",
      message: "The structure has no polymer chains to write as FASTA.",
      remediation: "Use a structure that contains protein or nucleic-acid chains.",
    });
  }
  const resolved = path.resolve(dest);
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    await writeFileExclusive(resolved, fasta);
  } catch (error) {
    throw asMoldeskError(error);
  }
  return resolved;
}

/** The `moldesk.analysis` envelope for a FASTA file that passed validation. */
export function fastaValidationEnvelope(checked: { path: string; sha256: string; records: FastaRecord[] }): AnalysisEnvelope {
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    kind: "moldesk.analysis",
    status: "ok",
    result: { fasta: { path: checked.path, sha256: checked.sha256, valid: true, records: checked.records } },
    warnings: [],
    provenance: { moldeskVersion: VERSION },
  };
}

export interface FastaRecord {
  header: string;
  length: number;
}

/** Checks alphabet, empty records and duplicate headers; throws INVALID_FASTA listing the problems. */
export function validateFasta(file: string): { path: string; sha256: string; records: FastaRecord[] } {
  const { text, ...input } = readTextInput(file, "FASTA");
  const issues: string[] = [];
  const records: Array<{ header: string; sequence: string }> = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    if (line.startsWith(">")) {
      records.push({ header: line.slice(1).trim(), sequence: "" });
    } else if (records.length === 0) {
      issues.push(`line ${index + 1}: sequence before the first ">" header`);
    } else {
      const sequence = line.replace(/\s+/g, "");
      if (!ALPHABET.test(sequence)) issues.push(`line ${index + 1}: invalid characters in "${records.at(-1)!.header}"`);
      records.at(-1)!.sequence += sequence;
    }
  });
  if (records.length === 0) issues.push('no ">" header found');
  const seen = new Set<string>();
  for (const record of records) {
    if (record.header === "") issues.push("a record has an empty header");
    if (record.sequence === "") issues.push(`record "${record.header}" has no sequence`);
    if (seen.has(record.header)) issues.push(`duplicate header "${record.header}"`);
    seen.add(record.header);
  }
  if (issues.length > 0) {
    const shown = issues.slice(0, MAX_REPORTED_ISSUES).join("; ");
    const more = issues.length > MAX_REPORTED_ISSUES ? ` (and ${issues.length - MAX_REPORTED_ISSUES} more)` : "";
    throw new MoldeskError({
      code: "INVALID_FASTA",
      message: `${path.basename(input.path)} is not valid FASTA: ${shown}${more}.`,
      remediation: "Fix the listed records and run the check again.",
    });
  }
  return { ...input, records: records.map((r) => ({ header: r.header, length: r.sequence.length })) };
}
