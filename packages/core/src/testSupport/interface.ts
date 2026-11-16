import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import type { RunRecord } from "../run.js";
import { hashArtifact } from "../analysis/boltz-artifacts.js";

/** Synthetic two-chain fixture, with CA/CB and exact entity/atom order. Not a genuine prediction. */
export function proteinCif(auth = ["A", "B"], labels = ["A", "B"]): string {
  const fields = "group_PDB id type_symbol label_atom_id label_alt_id label_comp_id label_seq_id auth_seq_id pdbx_PDB_ins_code label_asym_id Cartn_x Cartn_y Cartn_z occupancy label_entity_id auth_asym_id auth_comp_id B_iso_or_equiv pdbx_PDB_model_num".split(" ");
  const atoms = Array.from({ length: 4 }, (_, i) => ["CA", "CB"].map((atom, j) => `ATOM ${i * 2 + j + 1} C ${atom} . ALA ${i % 2 + 1} ${i % 2 + 1} ? ${labels[i >> 1]} ${i % 2 * 3} ${(i >> 1) * 4 + j} 0 1 ${(i >> 1) + 1} ${auth[i >> 1]} ALA 90 1`)).flat();
  return `data_prediction\nloop_\n_entity.id\n_entity.type\n1 polymer\n2 polymer\n#\nloop_\n_struct_asym.id\n_struct_asym.entity_id\n${labels[0]} 1\n${labels[1]} 2\n#\nloop_\n_entity_poly_seq.entity_id\n_entity_poly_seq.num\n_entity_poly_seq.mon_id\n1 1 ALA\n1 2 ALA\n2 1 ALA\n2 2 ALA\n#\nloop_\n${fields.map((f) => `_atom_site.${f}`).join("\n")}\n${atoms.join("\n")}\n#\n`;
}
// Minimal standard ZIP/NPY writer for testing the Python validator with adversarial archives.
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function npz(shape = [4, 4], values?: number[], options: { key?: string; dtype?: string; header?: string } = {}): Buffer {
  const name = Buffer.from(`${options.key ?? "pae"}.npy`);
  let header = options.header ?? `{'descr': '${options.dtype ?? "<f8"}', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  header += " ".repeat((64 - ((10 + header.length + 1) % 64)) % 64) + "\n";
  const data = Buffer.alloc(shape.reduce((a, b) => a * b, 1) * 8);
  for (let i = 0; i < data.length / 8; i++) data.writeDoubleLE(values?.[i] ?? (i < 8 ? 1 : 2), i * 8);
  const preamble = Buffer.from([0x93, 78, 85, 77, 80, 89, 1, 0, 0, 0]); preamble.writeUInt16LE(Buffer.byteLength(header), 8);
  const raw = Buffer.concat([preamble, Buffer.from(header), data]), packed = deflateRawSync(raw), crc = crc32(raw);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + packed.length, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}
export const IPSAE_TABLE = "Chn1 Chn2 PAE Dist Type ipSAE ipSAE_d0chn Model\nA B 15 15 asym 0.5 0.99 prediction\nB A 15 15 asym 0.2 0.99 prediction\nA B 15 15 max 0.5 0.99 prediction\n";
export async function boltzRecord(root: string, records = ["job"], ranks = [0]): Promise<RunRecord> {
  const outputs = [];
  for (const record of records) for (const rank of ranks) {
    const dir = path.join(root, `boltz_results_job/predictions/${record}`); fs.mkdirSync(dir, { recursive: true });
    const stem = `${record}_model_${rank}`;
    for (const [id, name, bytes] of [["structures", `${stem}.cif`, proteinCif()], ["confidence", `confidence_${stem}.json`, JSON.stringify({ pair_chains_iptm: { "0": { "0": 1, "1": .8 }, "1": { "0": .8, "1": 1 } } })], ["pae", `pae_${stem}.npz`, npz()], ["plddt", `plddt_${stem}.npz`, npz([4], [90, 90, 90, 90], { key: "plddt" })]] as const) {
      const file = path.join(dir, name); fs.writeFileSync(file, bytes); outputs.push({ id, ...await hashArtifact(file) });
    }
  }
  return { schemaVersion: 1, id: "prediction-run", model: "boltz", status: "succeeded", modelVersion: "2.2.1", adapterVersion: "0.2.0", parameters: { supplied: {}, effective: { write_full_pae: true, diffusion_samples: ranks.length } }, input: [], outputs } as unknown as RunRecord;
}
