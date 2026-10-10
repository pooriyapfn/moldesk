import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerRunCommand } from "./run.js";

const state = vi.hoisted(() => ({ runModel: vi.fn() }));

vi.mock("@moldesk/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moldesk/core")>();
  return { ...actual, runModel: state.runModel };
});

class ProcessExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program);
  return program;
}

const baseRecord = {
  schemaVersion: 1 as const,
  id: "run-1",
  status: "succeeded" as const,
  model: "proteinmpnn",
  modelVersion: "v_48_020",
  adapterVersion: "0.1.0",
  moldeskVersion: "0.0.1",
  runtime: "python" as const,
  installationFingerprint: "python-abc",
  manifestSha256: "abc",
  hardware: {} as unknown,
  input: [],
  parameters: { supplied: {}, effective: {} },
  command: { executable: "python", args: [], cwd: "/runs/run-1" },
  startedAt: new Date().toISOString(),
  outputs: [],
  logs: { stdout: "/runs/run-1/stdout.log", stderr: "/runs/run-1/stderr.log" },
};

let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((msg: string) => {
    logs.push(String(msg));
  });
  vi.spyOn(console, "error").mockImplementation((msg: string) => {
    errors.push(String(msg));
  });
  state.runModel.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("run (CLI, faked runModel)", () => {
  it("prints the run record as JSON and leaves exit code 0 on success", async () => {
    state.runModel.mockResolvedValue({ status: "succeeded", record: baseRecord });
    const program = buildProgram();
    await program.parseAsync(["run", "proteinmpnn", "input.pdb", "--json"], { from: "user" });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("succeeded");
    expect(process.exitCode).toBeUndefined();
  });

  it("sets exit code 7 when the run failed", async () => {
    state.runModel.mockResolvedValue({
      status: "failed",
      record: { ...baseRecord, status: "failed", error: { code: "RUN_EXECUTION_FAILED", message: "exit 1" } },
    });
    const program = buildProgram();
    await program.parseAsync(["run", "proteinmpnn", "input.pdb", "--json"], { from: "user" });
    expect(process.exitCode).toBe(7);
  });

  it("sets exit code 8 when the run was cancelled", async () => {
    state.runModel.mockResolvedValue({
      status: "cancelled",
      record: { ...baseRecord, status: "cancelled", error: { code: "RUN_CANCELLED", message: "cancelled" } },
    });
    const program = buildProgram();
    await program.parseAsync(["run", "proteinmpnn", "input.pdb", "--json"], { from: "user" });
    expect(process.exitCode).toBe(8);
  });

  it("sets exit code 7 for a succeeded run whose --output copy collided", async () => {
    state.runModel.mockResolvedValue({
      status: "succeeded",
      record: baseRecord,
      exportError: { code: "OUTPUT_COLLISION", message: "already exists" },
    });
    const program = buildProgram();
    await program.parseAsync(["run", "proteinmpnn", "input.pdb", "--output", "/tmp/out", "--json"], { from: "user" });
    expect(process.exitCode).toBe(7);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("succeeded");
  });

  it("maps a thrown UNKNOWN_MODEL error to exit code 3", async () => {
    const { MoldeskError } = await import("@moldesk/core");
    state.runModel.mockRejectedValue(new MoldeskError({ code: "UNKNOWN_MODEL", message: 'Unknown model "bogus".' }));
    const program = buildProgram();
    await program.parseAsync(["run", "bogus", "input.pdb", "--json"], { from: "user" });
    expect(process.exitCode).toBe(3);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.code).toBe("UNKNOWN_MODEL");
  });

  it("maps a thrown MODEL_NOT_INSTALLED error to exit code 5", async () => {
    const { MoldeskError } = await import("@moldesk/core");
    state.runModel.mockRejectedValue(new MoldeskError({ code: "MODEL_NOT_INSTALLED", message: "not installed" }));
    const program = buildProgram();
    await program.parseAsync(["run", "proteinmpnn", "input.pdb"], { from: "user" });
    expect(process.exitCode).toBe(5);
    expect(errors.some((e) => e.includes("not installed"))).toBe(true);
  });

  it("maps an unrecognized thrown error to exit code 10", async () => {
    state.runModel.mockRejectedValue(new Error("boom"));
    const program = buildProgram();
    await program.parseAsync(["run", "proteinmpnn", "input.pdb"], { from: "user" });
    expect(process.exitCode).toBe(10);
  });

  it("forwards --param key=value pairs to runModel", async () => {
    state.runModel.mockResolvedValue({ status: "succeeded", record: baseRecord });
    const program = buildProgram();
    await program.parseAsync(
      ["run", "proteinmpnn", "input.pdb", "--param", "seed=1", "--param", "ca_only=true", "--json"],
      { from: "user" },
    );
    expect(state.runModel).toHaveBeenCalledWith(
      "proteinmpnn",
      "input.pdb",
      expect.objectContaining({ params: { seed: "1", ca_only: "true" } }),
    );
  });

  it("rejects a malformed --param with a usage error (exit 2) before calling runModel", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new ProcessExitSignal(typeof code === "number" ? code : undefined);
    });
    const program = buildProgram();
    await expect(
      program.parseAsync(["run", "proteinmpnn", "input.pdb", "--param", "no-equals-sign"], { from: "user" }),
    ).rejects.toThrow(ProcessExitSignal);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(state.runModel).not.toHaveBeenCalled();
  });

  it("defaults to visualizing and maps --no-visualize to visualize: false", async () => {
    state.runModel.mockResolvedValue({ status: "succeeded", record: baseRecord });
    await buildProgram().parseAsync(["run", "boltz", "job.yaml", "--json"], { from: "user" });
    expect(state.runModel).toHaveBeenLastCalledWith("boltz", "job.yaml", expect.objectContaining({ visualize: true }));
    await buildProgram().parseAsync(["run", "boltz", "job.yaml", "--no-visualize", "--json"], { from: "user" });
    expect(state.runModel).toHaveBeenLastCalledWith("boltz", "job.yaml", expect.objectContaining({ visualize: false }));
  });

  it("prints the report path and an encoded file URL, and a warning keeps exit code 0", async () => {
    state.runModel.mockResolvedValue({
      status: "succeeded",
      record: {
        ...baseRecord,
        artifacts: [{ id: "molecular-report", kind: "molecular-report", path: "/runs/my run/artifacts/viewer.html", sha256: "a", sizeBytes: 1, sourceSha256: [], viewerVersion: "1", bundleSha256: "b" }],
        warnings: [{ code: "VISUALIZATION_FAILED", message: "Could not create the molecular report: boom" }],
      },
    });
    await buildProgram().parseAsync(["run", "boltz", "job.yaml"], { from: "user" });
    expect(logs).toContain("  report: /runs/my run/artifacts/viewer.html");
    expect(logs).toContain("  Open in your browser: file:///runs/my%20run/artifacts/viewer.html");
    expect(errors.join("\n")).toContain("Warning (VISUALIZATION_FAILED): Could not create the molecular report: boom");
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps --json parseable with artifacts and warnings present", async () => {
    state.runModel.mockResolvedValue({
      status: "succeeded",
      record: { ...baseRecord, warnings: [{ code: "VISUALIZATION_FAILED", message: "x" }] },
    });
    await buildProgram().parseAsync(["run", "boltz", "job.yaml", "--json"], { from: "user" });
    expect(JSON.parse(logs.join("\n")).record.warnings[0].code).toBe("VISUALIZATION_FAILED");
    expect(errors).toEqual([]);
  });
});
