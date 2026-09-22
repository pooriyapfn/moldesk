import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PythonRuntimeProvider } from "./python.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-python-provider-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("PythonRuntimeProvider.prepare", () => {
  it("resolves the venv executable when present", async () => {
    const targetDir = tempDir();
    fs.mkdirSync(path.join(targetDir, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, ".venv", "bin", "python"), "");

    const provider = new PythonRuntimeProvider();
    const prepared = await provider.prepare({
      modelName: "proteinmpnn",
      modelVersion: "v_48_020",
      runtimeFingerprint: "python-abc",
      targetDir,
    });
    expect(prepared.executable).toBe(path.join(targetDir, ".venv", "bin", "python"));
  });

  it("throws MODEL_NOT_INSTALLED when the venv is missing", async () => {
    const provider = new PythonRuntimeProvider();
    await expect(
      provider.prepare({ modelName: "proteinmpnn", modelVersion: "v_48_020", runtimeFingerprint: "python-abc", targetDir: tempDir() }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_INSTALLED" });
  });
});

describe("PythonRuntimeProvider.execute", () => {
  it("streams stdout/stderr to log files under cwd and forwards live chunks", async () => {
    const cwd = tempDir();
    const chunks: Array<{ stream: string; text: string }> = [];
    const provider = new PythonRuntimeProvider();
    const result = await provider.execute({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('out\\n'); process.stderr.write('err\\n');"],
      cwd,
      onStdout: (chunk) => chunks.push({ stream: "stdout", text: chunk }),
      onStderr: (chunk) => chunks.push({ stream: "stderr", text: chunk }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutPath).toBe(path.join(cwd, "stdout.log"));
    expect(result.stderrPath).toBe(path.join(cwd, "stderr.log"));
    expect(fs.readFileSync(result.stdoutPath, "utf8")).toContain("out");
    expect(fs.readFileSync(result.stderrPath, "utf8")).toContain("err");
    expect(chunks.some((c) => c.stream === "stdout" && c.text.includes("out"))).toBe(true);
  });
});
