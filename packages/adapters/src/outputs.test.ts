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
  it("matches a single-segment glob", () => {
    const outputDir = tempDir();
    fs.writeFileSync(path.join(outputDir, "summary.json"), "{}");
    const outputs = collectGlobOutputs(outputDir, [{ id: "summary", glob: "summary.json", required: true }]);
    expect(outputs).toEqual([{ id: "summary", path: path.join(outputDir, "summary.json") }]);
  });

  it("matches every file for a multi-match glob, one CollectedOutput per file", () => {
    const outputDir = tempDir();
    const complexDir = path.join(outputDir, "complex_0");
    fs.mkdirSync(complexDir, { recursive: true });
    fs.writeFileSync(path.join(complexDir, "rank1_confidence0.85.sdf"), "");
    fs.writeFileSync(path.join(complexDir, "rank2_confidence-1.23.sdf"), "");
    const outputs = collectGlobOutputs(outputDir, [{ id: "ranked_poses", glob: "*/rank*_confidence*.sdf", required: true }]);
    expect(outputs.map((o) => o.id)).toEqual(["ranked_poses", "ranked_poses"]);
  });

  it("does not throw ENOTDIR when a stray file sits alongside the expected subdirectory at a wildcard-matched level", () => {
    const outputDir = tempDir();
    const complexDir = path.join(outputDir, "complex_0");
    fs.mkdirSync(complexDir, { recursive: true });
    fs.writeFileSync(path.join(complexDir, "rank1.sdf"), "");
    // A sidecar file directly under outputDir — the `*` in `*/rank1.sdf` also
    // matches this filename, and a naive matcher would try to readdir it.
    fs.writeFileSync(path.join(outputDir, "poses_summary.json"), "{}");

    const outputs = collectGlobOutputs(outputDir, [{ id: "top_pose", glob: "*/rank1.sdf", required: true }]);
    expect(outputs).toEqual([{ id: "top_pose", path: path.join(complexDir, "rank1.sdf") }]);
  });

  it("throws MISSING_REQUIRED_OUTPUT for a required output with no matches, even when an unrelated stray file exists", () => {
    const outputDir = tempDir();
    fs.writeFileSync(path.join(outputDir, "some-unrelated-file.txt"), "not a pose");
    expect(() => collectGlobOutputs(outputDir, [{ id: "top_pose", glob: "*/rank1.sdf", required: true }])).toThrowError(
      expect.objectContaining({ code: "MISSING_REQUIRED_OUTPUT" }),
    );
  });

  it("does not throw for a non-required output with no matches", () => {
    const outputDir = tempDir();
    const outputs = collectGlobOutputs(outputDir, [{ id: "optional", glob: "optional.json", required: false }]);
    expect(outputs).toEqual([]);
  });

  it("rejects a symlinked output file pointing outside outputDir instead of following it", () => {
    const outputDir = tempDir();
    const outsideDir = tempDir();
    const secretPath = path.join(outsideDir, "secret.sdf");
    fs.writeFileSync(secretPath, "secret");
    fs.symlinkSync(secretPath, path.join(outputDir, "rank1.sdf"));

    expect(() => collectGlobOutputs(outputDir, [{ id: "top_pose", glob: "rank1.sdf", required: true }])).toThrowError(
      expect.objectContaining({ code: "MISSING_REQUIRED_OUTPUT" }),
    );
  });

  it("rejects a symlinked directory reached through a wildcard segment instead of descending into it", () => {
    const outputDir = tempDir();
    const outsideDir = tempDir();
    fs.mkdirSync(path.join(outsideDir, "escaped"), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "escaped", "rank1.sdf"), "outside content");
    fs.symlinkSync(path.join(outsideDir, "escaped"), path.join(outputDir, "complex_0"));

    expect(() => collectGlobOutputs(outputDir, [{ id: "top_pose", glob: "*/rank1.sdf", required: true }])).toThrowError(
      expect.objectContaining({ code: "MISSING_REQUIRED_OUTPUT" }),
    );
  });
});
