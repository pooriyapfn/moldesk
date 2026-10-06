import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MoldeskError } from "@moldesk/registry";
import { stageCompanionInputs } from "./companion-inputs.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  // Canonicalize immediately: on macOS, os.tmpdir() lives under a symlink
  // (/var/folders -> /private/var/folders), and stageCompanionInputs now
  // always returns realpathSync-canonicalized paths (that's the P1 fix this
  // file tests) — comparing against the pre-canonicalized path would fail
  // for reasons unrelated to what each test actually checks.
  return fs.realpathSync(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("stageCompanionInputs", () => {
  it("stages a companion file into an id-namespaced subdirectory and records its original + stored paths", () => {
    const jobDir = tempDir("moldesk-companion-job-");
    const jobFilePath = path.join(jobDir, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    const proteinPath = path.join(jobDir, "protein.pdb");
    fs.writeFileSync(proteinPath, "ATOM\n");
    const runDir = tempDir("moldesk-companion-run-");
    const inputDir = path.join(runDir, "input");
    fs.mkdirSync(inputDir, { recursive: true });

    const staged = stageCompanionInputs({
      jobFilePath,
      refs: [{ id: "protein", sourcePath: "protein.pdb" }],
      inputDir,
    });

    expect(staged).toHaveLength(1);
    expect(staged[0]!.id).toBe("protein");
    expect(staged[0]!.originalPath).toBe(proteinPath);
    expect(staged[0]!.storedPath).toBe(path.join(inputDir, "protein", "protein.pdb"));
    expect(fs.readFileSync(staged[0]!.storedPath, "utf8")).toBe("ATOM\n");
  });

  it("resolves relative sourcePath against the job file's own directory, not the process cwd", () => {
    const jobDir = tempDir("moldesk-companion-job-");
    const nested = path.join(jobDir, "nested");
    fs.mkdirSync(nested, { recursive: true });
    const jobFilePath = path.join(nested, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    fs.writeFileSync(path.join(nested, "ligand.sdf"), "ligand-bytes");
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(inputDir, { recursive: true });

    const staged = stageCompanionInputs({
      jobFilePath,
      refs: [{ id: "ligand", sourcePath: "ligand.sdf" }],
      inputDir,
    });
    expect(staged[0]!.originalPath).toBe(path.join(nested, "ligand.sdf"));
  });

  it("rejects a missing referenced file", () => {
    const jobDir = tempDir("moldesk-companion-job-");
    const jobFilePath = path.join(jobDir, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(inputDir, { recursive: true });

    expect(() =>
      stageCompanionInputs({ jobFilePath, refs: [{ id: "protein", sourcePath: "missing.pdb" }], inputDir }),
    ).toThrowError(MoldeskError);
    try {
      stageCompanionInputs({ jobFilePath, refs: [{ id: "protein", sourcePath: "missing.pdb" }], inputDir });
      expect.unreachable();
    } catch (error) {
      expect((error as MoldeskError).code).toBe("INVALID_RUN_INPUT");
    }
  });

  it("rejects ../ traversal escaping the allowed root", () => {
    const jobDir = tempDir("moldesk-companion-job-");
    const jobFilePath = path.join(jobDir, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    const outsideDir = tempDir("moldesk-companion-outside-");
    fs.writeFileSync(path.join(outsideDir, "secret.pdb"), "secret");
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(inputDir, { recursive: true });

    const traversal = path.relative(jobDir, path.join(outsideDir, "secret.pdb"));
    try {
      stageCompanionInputs({ jobFilePath, refs: [{ id: "protein", sourcePath: traversal }], inputDir });
      expect.unreachable();
    } catch (error) {
      expect((error as MoldeskError).code).toBe("UNSAFE_COMPANION_INPUT_PATH");
    }
  });

  it("rejects a sibling-prefix path a naive string.startsWith(allowedRoot) check would wrongly accept", () => {
    const parent = tempDir("moldesk-companion-parent-");
    const allowedRoot = path.join(parent, "allowed-root");
    const evilSibling = path.join(parent, "allowed-root-evil");
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(evilSibling, { recursive: true });
    const jobFilePath = path.join(allowedRoot, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    fs.writeFileSync(path.join(evilSibling, "secret.pdb"), "secret");
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(inputDir, { recursive: true });

    // A plain `string.startsWith(allowedRoot)` check would incorrectly accept this,
    // since "/…/allowed-root-evil/secret.pdb" starts with "/…/allowed-root". The
    // correct `path.relative`-based confinement must reject it.
    const absoluteEscape = path.join(evilSibling, "secret.pdb");
    try {
      stageCompanionInputs({ jobFilePath, refs: [{ id: "protein", sourcePath: absoluteEscape }], inputDir, allowedRoot });
      expect.unreachable();
    } catch (error) {
      expect((error as MoldeskError).code).toBe("UNSAFE_COMPANION_INPUT_PATH");
    }
  });

  it("rejects a symlink whose target escapes the allowed root", () => {
    const jobDir = tempDir("moldesk-companion-job-");
    const jobFilePath = path.join(jobDir, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    const outsideDir = tempDir("moldesk-companion-outside-");
    const secretPath = path.join(outsideDir, "secret.pdb");
    fs.writeFileSync(secretPath, "secret");
    const linkPath = path.join(jobDir, "link.pdb");
    fs.symlinkSync(secretPath, linkPath);
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(inputDir, { recursive: true });

    try {
      stageCompanionInputs({ jobFilePath, refs: [{ id: "protein", sourcePath: "link.pdb" }], inputDir });
      expect.unreachable();
    } catch (error) {
      expect((error as MoldeskError).code).toBe("UNSAFE_COMPANION_INPUT_PATH");
    }
  });

  it("rejects a reference reached through a symlinked ANCESTOR directory, not just a symlinked leaf file", () => {
    // allowedRoot/sub is a symlink to a directory outside allowedRoot. The leaf
    // reference itself ("sub/secret.pdb") is a normal file, not a symlink — only
    // an ancestor path component is. `lstat` on the leaf alone would report a
    // regular file (the OS silently resolves the ancestor symlink during
    // traversal), so this only fails if the full resolved path is canonicalized
    // with `realpathSync` before the boundary check, not just the leaf.
    const jobDir = tempDir("moldesk-companion-job-");
    const jobFilePath = path.join(jobDir, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    const outsideDir = tempDir("moldesk-companion-outside-");
    fs.writeFileSync(path.join(outsideDir, "secret.pdb"), "secret");
    fs.symlinkSync(outsideDir, path.join(jobDir, "sub"));
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(inputDir, { recursive: true });

    try {
      stageCompanionInputs({ jobFilePath, refs: [{ id: "protein", sourcePath: "sub/secret.pdb" }], inputDir });
      expect.unreachable();
    } catch (error) {
      expect((error as MoldeskError).code).toBe("UNSAFE_COMPANION_INPUT_PATH");
    }
  });

  it("rejects a directory reference", () => {
    const jobDir = tempDir("moldesk-companion-job-");
    const jobFilePath = path.join(jobDir, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    fs.mkdirSync(path.join(jobDir, "a-directory"));
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(inputDir, { recursive: true });

    try {
      stageCompanionInputs({ jobFilePath, refs: [{ id: "protein", sourcePath: "a-directory" }], inputDir });
      expect.unreachable();
    } catch (error) {
      expect((error as MoldeskError).code).toBe("UNSAFE_COMPANION_INPUT_TYPE");
    }
  });

  it("rejects duplicate companion input ids before touching disk", () => {
    const jobDir = tempDir("moldesk-companion-job-");
    const jobFilePath = path.join(jobDir, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    fs.writeFileSync(path.join(jobDir, "a.pdb"), "a");
    fs.writeFileSync(path.join(jobDir, "b.pdb"), "b");
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(inputDir, { recursive: true });

    try {
      stageCompanionInputs({
        jobFilePath,
        refs: [{ id: "protein", sourcePath: "a.pdb" }, { id: "protein", sourcePath: "b.pdb" }],
        inputDir,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as MoldeskError).code).toBe("DUPLICATE_STAGED_INPUT");
    }
    expect(fs.existsSync(path.join(inputDir, "protein"))).toBe(false);
  });

  it("refuses to overwrite an existing staged destination", () => {
    const jobDir = tempDir("moldesk-companion-job-");
    const jobFilePath = path.join(jobDir, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    fs.writeFileSync(path.join(jobDir, "protein.pdb"), "content");
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(path.join(inputDir, "protein"), { recursive: true });
    fs.writeFileSync(path.join(inputDir, "protein", "protein.pdb"), "pre-existing");

    try {
      stageCompanionInputs({ jobFilePath, refs: [{ id: "protein", sourcePath: "protein.pdb" }], inputDir });
      expect.unreachable();
    } catch (error) {
      expect((error as MoldeskError).code).toBe("STAGED_INPUT_DESTINATION_EXISTS");
    }
    expect(fs.readFileSync(path.join(inputDir, "protein", "protein.pdb"), "utf8")).toBe("pre-existing");
  });

  it("re-validates at staging time rather than trusting an earlier discovery-time check (TOCTOU: file replaced with an escaping symlink)", () => {
    const jobDir = tempDir("moldesk-companion-job-");
    const jobFilePath = path.join(jobDir, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    const refPath = path.join(jobDir, "protein.pdb");
    fs.writeFileSync(refPath, "original content");
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(inputDir, { recursive: true });

    // Simulate an earlier "discovery" check (e.g. an adapter's own validateInput)
    // that inspected the file when it was still a safe regular file.
    expect(fs.existsSync(refPath)).toBe(true);
    expect(fs.lstatSync(refPath).isFile()).toBe(true);

    // Between discovery and staging, the file is replaced with a symlink escaping
    // the allowed root.
    const outsideDir = tempDir("moldesk-companion-outside-");
    const secretPath = path.join(outsideDir, "secret.pdb");
    fs.writeFileSync(secretPath, "secret");
    fs.rmSync(refPath);
    fs.symlinkSync(secretPath, refPath);

    try {
      stageCompanionInputs({ jobFilePath, refs: [{ id: "protein", sourcePath: "protein.pdb" }], inputDir });
      expect.unreachable();
    } catch (error) {
      expect((error as MoldeskError).code).toBe("UNSAFE_COMPANION_INPUT_PATH");
    }
  });

  it("stages multiple distinct companion inputs independently", () => {
    const jobDir = tempDir("moldesk-companion-job-");
    const jobFilePath = path.join(jobDir, "job.json");
    fs.writeFileSync(jobFilePath, "{}");
    fs.writeFileSync(path.join(jobDir, "protein.pdb"), "protein-bytes");
    fs.writeFileSync(path.join(jobDir, "ligand.sdf"), "ligand-bytes");
    const inputDir = path.join(tempDir("moldesk-companion-run-"), "input");
    fs.mkdirSync(inputDir, { recursive: true });

    const staged = stageCompanionInputs({
      jobFilePath,
      refs: [
        { id: "protein", sourcePath: "protein.pdb" },
        { id: "ligand", sourcePath: "ligand.sdf" },
      ],
      inputDir,
    });
    expect(staged.map((s) => s.id).sort()).toEqual(["ligand", "protein"]);
    expect(fs.readFileSync(path.join(inputDir, "protein", "protein.pdb"), "utf8")).toBe("protein-bytes");
    expect(fs.readFileSync(path.join(inputDir, "ligand", "ligand.sdf"), "utf8")).toBe("ligand-bytes");
  });
});
