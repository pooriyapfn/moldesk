import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeStructureFile } from "./analyze.js";
import { chainsToFasta, validateFasta, writeFastaFile } from "./fasta.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../../visualizer/test/fixtures");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-fasta-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const fasta = (text: string) => {
  const file = path.join(dir, "x.fa");
  fs.writeFileSync(file, text);
  return file;
};

describe("chainsToFasta / writeFastaFile", () => {
  it("writes one record per polymer chain with unique headers, and never overwrites", async () => {
    const envelope = await analyzeStructureFile(path.join(FIXTURES, "1AAY.pdb"));
    const text = chainsToFasta(envelope);
    const headers = text.split("\n").filter((l) => l.startsWith(">"));
    expect(headers).toEqual([
      ">1AAY|chain B|label B|dna",
      ">1AAY|chain C|label C|dna",
      ">1AAY|chain A|label A|protein",
    ]);

    const dest = path.join(dir, "sub", "out.fa");
    await writeFastaFile(envelope, dest);
    expect(fs.readFileSync(dest, "utf8")).toBe(text);
    await expect(writeFastaFile(envelope, dest)).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["out.fa"]);
    validateFasta(dest);
  });

  it("refuses a structure with no polymer chains", async () => {
    const envelope = await analyzeStructureFile(path.join(FIXTURES, "HEM-only.pdb"));
    await expect(writeFastaFile(envelope, path.join(dir, "o.fa"))).rejects.toMatchObject({ code: "NO_POLYMER_CHAINS" });
    expect(fs.existsSync(path.join(dir, "o.fa"))).toBe(false);
  });
});

describe("validateFasta", () => {
  it("accepts protein and nucleotide records, wrapped lines and blank lines", () => {
    const checked = validateFasta(fasta(">a desc\nACDE\nFGHI\n\n>b\nACGU\n"));
    expect(checked.records).toEqual([
      { header: "a desc", length: 8 },
      { header: "b", length: 4 },
    ]);
  });

  it.each([
    ["empty record", ">a\n>b\nACD\n", /no sequence/],
    ["duplicate header", ">a\nAC\n>a\nGT\n", /duplicate header/],
    ["bad alphabet", ">a\nAC1D\n", /invalid characters/],
    ["sequence before header", "ACGT\n>a\nAC\n", /before the first/],
    ["no records", "\n\n", /no ">" header/],
  ])("rejects %s", (_name, text, message) => {
    expect(() => validateFasta(fasta(text))).toThrow(message);
    expect(() => validateFasta(fasta(text))).toThrow(expect.objectContaining({ code: "INVALID_FASTA" }));
  });

  it("rejects an empty file with a specific code", () => {
    expect(() => validateFasta(fasta(""))).toThrow(expect.objectContaining({ code: "INPUT_EMPTY" }));
  });
});
