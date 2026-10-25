// What `moldesk fetch` may download: three sources, each with one allowed host, a strict ID grammar,
// the exact URL shapes verified against the live services, a content check and a license record.
import { MoldeskError } from "../errors.js";

export type FetchSource = "pdb" | "afdb" | "uniprot";
export type FetchFormat = "mmcif" | "pdb" | "fasta";

export const FETCH_SOURCES: readonly FetchSource[] = ["pdb", "afdb", "uniprot"];

/** PDB entry id: a digit 1-9 followed by three letters or digits (extended 12-character ids are not in use yet). */
const PDB_ID = /^[1-9][A-Z0-9]{3}$/;
/** UniProt's own accession pattern (https://www.uniprot.org/help/accession_numbers). No isoform suffix. */
const UNIPROT_ACCESSION = /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

export interface FetchSpec {
  source: FetchSource;
  id: string;
}

export function invalidSpec(message: string): MoldeskError {
  return new MoldeskError({
    code: "INVALID_FETCH_SPEC",
    message,
    remediation: "Use pdb:<4-character id> (pdb:1M17), afdb:<UniProt accession> (afdb:P00533) or uniprot:<accession> (uniprot:P00533).",
  });
}

/** Parses `<source>:<id>`. Runs before any network call or path join; the id is uppercased only after it passes. */
export function parseFetchSpec(text: string): FetchSpec {
  const colon = text.indexOf(":");
  const source = colon < 0 ? "" : text.slice(0, colon).toLowerCase();
  const id = colon < 0 ? "" : text.slice(colon + 1).toUpperCase();
  if (!(FETCH_SOURCES as readonly string[]).includes(source)) throw invalidSpec(`Unknown source in "${text.slice(0, 80)}".`);
  const pattern = source === "pdb" ? PDB_ID : UNIPROT_ACCESSION;
  if (!pattern.test(id)) {
    throw invalidSpec(`"${id.slice(0, 40)}" is not a valid ${source === "pdb" ? "PDB id" : "UniProt accession"}.`);
  }
  return { source: source as FetchSource, id };
}

export interface SourceEndpoint {
  /** `host[:port]` every request, redirect and API-supplied URL must match exactly. */
  host: string;
  scheme: "https" | "http";
}

export const ENDPOINTS: Record<FetchSource, SourceEndpoint> = {
  pdb: { host: "files.rcsb.org", scheme: "https" },
  afdb: { host: "alphafold.ebi.ac.uk", scheme: "https" },
  uniprot: { host: "rest.uniprot.org", scheme: "https" },
};

export const MAX_STRUCTURE_BYTES = 64 * 1024 * 1024;
export const MAX_FASTA_BYTES = 4 * 1024 * 1024;
export const MAX_API_BYTES = 1024 * 1024;

export interface LicenseInfo {
  name: string;
  url: string;
  notice?: string;
}

export const LICENSES: Record<FetchSource, LicenseInfo> = {
  pdb: { name: "CC0 1.0", url: "https://www.rcsb.org/pages/policies", notice: "wwPDB archive data files are in the public domain (CC0 1.0 Universal)." },
  afdb: {
    name: "CC-BY-4.0",
    url: "https://alphafold.ebi.ac.uk/assets/License-Disclaimer.pdf",
    notice: "AlphaFold DB predictions are under CC-BY 4.0 (attribution required; subject to EMBL-EBI terms of use). They are predictions, not experimental structures.",
  },
  uniprot: { name: "CC-BY-4.0", url: "https://www.uniprot.org/help/license", notice: "UniProt data are under CC BY 4.0 (attribution required)." },
};

/** Where an AlphaFold DB file may live: the API's URL is untrusted, so its host and path shape are checked. */
export function afdbFileUrlPattern(accession: string, format: "mmcif" | "pdb"): RegExp {
  return new RegExp(`^https://alphafold\\.ebi\\.ac\\.uk/files/AF-${accession}-F1-model_v(\\d+)\\.${format === "mmcif" ? "cif" : "pdb"}$`);
}

export function fileName(spec: FetchSpec, format: FetchFormat): string {
  const stem = spec.source === "afdb" ? `AF-${spec.id}-F1` : spec.id;
  return `${stem}.${format === "mmcif" ? "cif" : format}`;
}

function badContent(spec: FetchSpec, why: string): MoldeskError {
  return new MoldeskError({
    code: "FETCH_BAD_CONTENT",
    message: `The response for ${spec.source}:${spec.id} is not what was asked for: ${why}.`,
    remediation: "Nothing was saved. Try again later; if it persists, the service may have changed.",
  });
}

/** Decodes and checks the bytes; throws FETCH_BAD_CONTENT. Returns nothing: only valid content is ever written. */
export function sniffContent(spec: FetchSpec, format: FetchFormat, bytes: Uint8Array): void {
  if (bytes.length === 0) throw badContent(spec, "it is empty");
  if (bytes.includes(0)) throw badContent(spec, "it is binary");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw badContent(spec, "it is not UTF-8 text");
  }
  if (format === "mmcif") {
    const block = /^data_(\S+)/.exec(text.replace(/^(?:#[^\n]*\n|[ \t]*\n)*/, ""));
    const expected = spec.source === "afdb" ? `AF-${spec.id}-F1` : spec.id;
    if (!block) throw badContent(spec, 'it does not start with a "data_" block');
    if (block[1].toUpperCase() !== expected) throw badContent(spec, `the data block is "${block[1].slice(0, 40)}", not ${expected}`);
    if (!/^_atom_site\./m.test(text)) throw badContent(spec, "it has no _atom_site category");
  } else if (format === "pdb") {
    if (!/^(ATOM {2}|HETATM)/m.test(text)) throw badContent(spec, "it has no ATOM or HETATM records");
  } else {
    const records = text.split("\n").filter((l) => l.startsWith(">")).length;
    const sequence = text.split("\n").filter((l) => !l.startsWith(">") && l.trim() !== "");
    if (!text.startsWith(">")) throw badContent(spec, 'it does not start with ">"');
    if (records !== 1) throw badContent(spec, `it has ${records} FASTA records, expected 1`);
    if (sequence.length === 0 || sequence.some((l) => !/^[A-Za-z*\-\s]+$/.test(l))) throw badContent(spec, "its sequence has unexpected characters");
  }
}
