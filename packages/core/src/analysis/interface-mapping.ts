import { MoldeskError } from "../errors.js";
import { digest } from "../hash.js";
import { parseStructure, STANDARD_PROTEIN_RESIDUES as STANDARD } from "./molstar-model.js";
import type { StructureInput } from "./structure-input.js";

export function unsupported(message: string): never {
  throw new MoldeskError({ code: "UNSUPPORTED_INTERFACE_INPUT", message, remediation: "Use one complete Boltz mmCIF model with exactly two standard protein chains and explicit author chain roles." });
}

/** Validate raw CIF atom/token order as well as Mol*'s parsed identity. No sequence-length guesses. */
export async function mapBoltzProteinTokens(input: StructureInput, target: string, binder: string) {
  if (input.format !== "mmcif") unsupported("Only Boltz mmCIF is supported.");
  const parsed = await parseStructure(input);
  if (parsed.modelCount !== 1 || parsed.chains.length !== 2) unsupported("Expected exactly two chains in one model.");
  if (!target || !binder || target === binder) unsupported("Target and binder author chain IDs must be distinct.");
  const chains = parsed.chains;
  for (const id of [target, binder]) if (chains.filter((c) => c.authId === id).length !== 1) unsupported(`Ambiguous or missing author chain ${id}.`);
  if (new Set(chains.map((c) => c.labelId)).size !== 2) unsupported("Ambiguous label chain IDs.");
  const atomCounts = new Map<string, Map<string, number>>();
  parsed.heavyAtoms.name.forEach((name, i) => {
    const key = `${parsed.heavyAtoms.chain[i]}:${parsed.heavyAtoms.residue[i]}`;
    const counts = atomCounts.get(key) ?? new Map<string, number>();
    counts.set(name, (counts.get(name) ?? 0) + 1); atomCounts.set(key, counts);
  });
  for (const chain of chains) {
    if (chain.entityType !== "polymer" || !chain.residues.length) unsupported("Both chains must be proteins.");
    if (chain.entitySequence && chain.entitySequence.length !== chain.residues.length) unsupported("Unmodeled protein residues are unsupported.");
    chain.residues.forEach((r, i) => {
      if (!STANDARD.has(r.name) || r.kind !== "protein" || r.hetero || r.insertionCode || !r.trace?.every(Number.isFinite) || r.labelSeqId !== i + 1) unsupported("Unsupported residue, trace atom or noncontiguous label numbering.");
      const counts = atomCounts.get(`${chains.indexOf(chain)}:${i}`);
      if (counts?.get("CA") !== 1 || (r.name !== "GLY" && counts?.get("CB") !== 1)) unsupported("ipSAE requires one CA and one CB (CA for glycine) per residue.");
    });
  }
  const { CIF } = await import("molstar/lib/mol-io/reader/cif.js");
  const cif = await CIF.parse(input.text).run();
  if (cif.isError || cif.result.blocks.length !== 1) unsupported("Expected one CIF data block.");
  const categories = cif.result.blocks[0].categories;
  const atoms = categories.atom_site;
  if (!atoms) unsupported("No atom_site records.");
  const field = (key: string, i: number) => {
    const column = atoms.getField(key);
    if (!column) unsupported(`Missing atom_site.${key}.`);
    return column.str(i);
  };
  const expected = chains.flatMap((c) => c.residues.map((r) => ({ authId: c.authId, labelId: c.labelId, labelSeqId: r.labelSeqId!, authSeqId: r.authSeqId, name: r.name })));
  if (expected.length > 2048) unsupported("ipSAE supports at most 2,048 protein tokens.");
  const tokens: typeof expected = [];
  const canonical: string[] = [];
  const seen = new Set<string>();
  let tokenIndex = -1, previous = "";
  const atomIds = new Set<string>();
  for (let i = 0; i < atoms.rowCount; i++) {
    if (field("group_PDB", i) !== "ATOM" || ![".", "?", ""].includes(field("label_alt_id", i)) || field("pdbx_PDB_model_num", i) !== "1") unsupported("Hetero atoms, alternate locations or multiple models are unsupported.");
    const labelId = field("label_asym_id", i), labelSeqId = Number(field("label_seq_id", i));
    const key = `${labelId}:${labelSeqId}`;
    if (key !== previous) {
      if (seen.has(key)) unsupported("Interleaved atom/token order.");
      seen.add(key); previous = key; tokenIndex++;
    }
    const token = expected[tokenIndex];
    if (!token || token.labelId !== labelId || token.labelSeqId !== labelSeqId || token.authId !== field("auth_asym_id", i) || token.name !== field("label_comp_id", i) || token.authSeqId !== Number(field("auth_seq_id", i))) unsupported("CIF token order does not match parsed chain/residue identity.");
    const name = field("label_atom_id", i), element = field("type_symbol", i);
    if (!/^[A-Z0-9]+$/.test(name) || !/^[A-Za-z]+$/.test(element) || atomIds.has(`${key}:${name}`)) unsupported("Ambiguous atom name or duplicate atom.");
    atomIds.add(`${key}:${name}`);
    if (name === "CA") tokens.push(token);
    const xyz = ["Cartn_x", "Cartn_y", "Cartn_z"].map((f) => { const value = field(f, i); return value.trim() ? Number(value) : NaN; });
    if (!xyz.every(Number.isFinite)) unsupported("Non-finite coordinates.");
    // A/B in exact token order avoids upstream's lexical chain sorting for confidence indices.
    const c = labelId === chains[0].labelId ? "A" : "B";
    canonical.push(`ATOM ${i + 1} ${element} ${name} . ${token.name} ${labelSeqId} ${labelSeqId} ? ${c} ${xyz.join(" ")} 1 ${c === "A" ? 1 : 2} ${c} ${token.name} 90 1`);
  }
  if (JSON.stringify(tokens) !== JSON.stringify(expected)) unsupported("Trace tokens do not exactly match protein residues.");
  const asym = categories.struct_asym;
  if (!asym || asym.rowCount !== 2 || chains.some((c, i) => asym.getField("id")?.str(i) !== c.labelId)) unsupported("Missing/ambiguous Boltz chain order in struct_asym.");
  const headers = "group_PDB id type_symbol label_atom_id label_alt_id label_comp_id label_seq_id auth_seq_id pdbx_PDB_ins_code label_asym_id Cartn_x Cartn_y Cartn_z occupancy label_entity_id auth_asym_id auth_comp_id B_iso_or_equiv pdbx_PDB_model_num".split(" ");
  return {
    chains: { target: { authId: target, labelId: chains.find((c) => c.authId === target)!.labelId }, binder: { authId: binder, labelId: chains.find((c) => c.authId === binder)!.labelId } },
    targetAlias: chains[0].authId === target ? "A" : "B", binderAlias: chains[0].authId === binder ? "A" : "B",
    tokenMapping: { mode: "boltz-two-protein-chains" as const, count: tokens.length, sha256: digest(tokens) },
    tokens,
    canonicalCif: `data_prediction\nloop_\n${headers.map((h) => `_atom_site.${h}`).join("\n")}\n${canonical.join("\n")}\n#\n`,
  };
}
