// Opt-in CPU validation using an existing Python with NumPy; never installs or downloads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "@moldesk/runtime";
import { npz } from "../testSupport/interface.js";
import { IPSAE_RESOURCES } from "../tools/ipsae.js";
const python = process.env.MOLDESK_TEST_IPSAE_PYTHON;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
async function validate(bytes: Buffer, count = 4, plddt?: Buffer) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-npz-")); dirs.push(cwd);
  fs.writeFileSync(path.join(cwd, "pae_prediction.npz"), bytes);
  if (plddt) fs.writeFileSync(path.join(cwd, "plddt_prediction.npz"), plddt);
  return runCommand(python!, ["-I", "-B", path.join(IPSAE_RESOURCES, "validate.py"), String(count)], { cwd, timeoutMs: 15000, maxOutputBytes: 4096 });
}
describe.runIf(!!python)("NPZ validation on CPU", () => {
  it("accepts directional asymmetric PAE without symmetrizing, and optional pLDDT", async () => {
    expect((await validate(npz(), 4, npz([4], [90, 80, 70, 60], { key: "plddt" }))).code).toBe(0);
  });
  it.each([
    ["negative", () => npz([4, 4], Array(16).fill(-1))],
    ["NaN", () => npz([4, 4], Array(16).fill(NaN))],
    ["infinity", () => npz([4, 4], Array(16).fill(Infinity))],
    ["object dtype", () => npz([4, 4], undefined, { dtype: "|O8" })],
    ["wrong member", () => npz([4, 4], undefined, { key: "unexpected" })],
    ["oversized header", () => npz([4, 4], undefined, { header: " ".repeat(5000) })],
    ["oversized declared shape", () => npz([4, 4], undefined, { header: "{'descr':'<f8','fortran_order':False,'shape':(999999999,999999999),}" })],
    ["too many directory entries", () => { const b = npz(); b.writeUInt16LE(65535, b.length - 12); return b; }],
    ["decompression limit", () => { const b = npz(), at = b.indexOf(Buffer.from([0x50,0x4b,0x01,0x02])); b.writeUInt32LE(500_000_000, at + 24); return b; }],
  ])("rejects %s before scoring", async (_name, bytes) => { expect((await validate(bytes())).code).toBe(2); });
  it("distinguishes token dimension mismatch, pLDDT mismatch and token limit", async () => {
    expect((await validate(npz([3, 3]))).stderr).toContain("PAE_STRUCTURE_MISMATCH");
    expect((await validate(npz(), 4, npz([3], undefined, { key: "plddt" }))).code).toBe(2);
    expect((await validate(npz(), 2049)).code).toBe(2);
  });
});
