import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGlobOutputs } from "./outputs.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-outputs-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("collectGlobOutputs", () => {
  it("matches a single-wildcard segment glob (regression: seqs/*.fa)", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "seqs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "seqs", "a.fa"), "a");
    fs.writeFileSync(path.join(dir, "seqs", "b.fa"), "b");
    fs.writeFileSync(path.join(dir, "seqs", "c.txt"), "c");

    const outputs = collectGlobOutputs(dir, [{ id: "sequences", glob: "seqs/*.fa", required: true }]);
    expect(outputs.map((o) => o.path).sort()).toEqual(
      [path.join(dir, "seqs", "a.fa"), path.join(dir, "seqs", "b.fa")].sort(),
    );
  });

  it("recursively matches ** across multiple nested directory levels", () => {
    const dir = tempDir();
    const nested = path.join(dir, "boltz_results_input", "predictions", "record-1");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "record-1.cif"), "structure");
    fs.writeFileSync(path.join(dir, "top-level.cif"), "structure");

    const outputs = collectGlobOutputs(dir, [{ id: "structures", glob: "**/*.cif", required: true }]);
    expect(outputs.map((o) => o.path).sort()).toEqual(
      [path.join(nested, "record-1.cif"), path.join(dir, "top-level.cif")].sort(),
    );
  });

  it("does not match files at the wrong depth for a fixed-depth glob", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "seqs", "extra"), { recursive: true });
    fs.writeFileSync(path.join(dir, "seqs", "extra", "nested.fa"), "nested");

    const outputs = collectGlobOutputs(dir, [{ id: "sequences", glob: "seqs/*.fa", required: false }]);
    expect(outputs).toEqual([]);
  });

  it("throws MISSING_REQUIRED_OUTPUT when a required glob has no matches", () => {
    const dir = tempDir();
    expect(() => collectGlobOutputs(dir, [{ id: "structures", glob: "**/*.cif", required: true }])).toThrow(
      expect.objectContaining({ code: "MISSING_REQUIRED_OUTPUT" }),
    );
  });

  it("does not throw when a non-required glob has no matches", () => {
    const dir = tempDir();
    expect(collectGlobOutputs(dir, [{ id: "optional", glob: "**/*.json", required: false }])).toEqual([]);
  });
});
