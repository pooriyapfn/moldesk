import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { evaluateCompatibility, listAvailableModels, validateEnvelope, type SystemReport } from "@moldesk/core";
import { createFakeSpawn, type FakeSpawnHandler } from "../testSupport/spawnMock.js";
import { registerDescribeCommand } from "./describe.js";
import { registerDoctorCommand } from "./doctor.js";

const state = vi.hoisted(() => ({ handler: ((_c: string, _a: string[]) => ({ code: 127, spawnError: true })) as FakeSpawnHandler }));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => createFakeSpawn((c, a) => state.handler(c, a))(command, args),
}));

let home: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-cli-describe-"));
  process.env["MOLDESK_HOME"] = home;
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  state.handler = () => ({ code: 127, spawnError: true });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["MOLDESK_HOME"];
  process.exitCode = undefined;
  fs.rmSync(home, { recursive: true, force: true });
});

async function run(register: (p: Command) => void, ...args: string[]) {
  const program = new Command();
  program.exitOverride();
  register(program);
  await program.parseAsync(args, { from: "user" });
}
const doctor = (...a: string[]) => run(registerDoctorCommand, "doctor", ...a);
const describeCmd = (...a: string[]) => run(registerDescribeCommand, "describe", ...a);

const A100 = (cmd: string, args: string[]) => {
  if (cmd === "nvidia-smi" && args.join(" ").includes("memory.total")) return { code: 0, stdout: "0, NVIDIA A100, 81920\n" };
  if (cmd === "nvidia-smi" && args.includes("-x")) return { code: 0, stdout: "<nvidia_smi_log><cuda_version>12.4</cuda_version></nvidia_smi_log>" };
  if (cmd === "nvidia-smi") return { code: 0, stdout: "550.54.15\n" };
  return { code: 127, spawnError: true };
};
const SMALL_GPU = (cmd: string, args: string[]) => {
  if (cmd === "nvidia-smi" && args.join(" ").includes("memory.total")) return { code: 0, stdout: "0, NVIDIA T4, 8192\n" };
  if (cmd === "nvidia-smi" && args.includes("-x")) return { code: 0, stdout: "<nvidia_smi_log><cuda_version>11.2</cuda_version></nvidia_smi_log>" };
  if (cmd === "nvidia-smi") return { code: 0, stdout: "460.32\n" };
  return { code: 127, spawnError: true };
};

describe("moldesk describe", () => {
  it("prints exactly one valid moldesk.model envelope with --json", async () => {
    await describeCmd("boltz", "--json");
    expect(out).toHaveLength(1);
    const envelope = validateEnvelope(JSON.parse(out[0]), "moldesk.model");
    expect(envelope.result).toMatchObject({ name: "boltz", cloud: { available: true } });
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a readable summary without --json", async () => {
    await describeCmd("boltz");
    const text = out.join("\n");
    expect(text).toContain("Boltz-2 (boltz 2.2.1, available): structure-prediction");
    expect(text).toContain("default by platform: gpu on linux-x64, mps on darwin-arm64");
    expect(text).toContain("Cloud: Runpod (at least 24 GB VRAM, 32 GB RAM)");
  });

  it("exits 3 for an unknown model and 2 for a bad --runtime", async () => {
    await describeCmd("nope", "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "UNKNOWN_MODEL" });
    expect(process.exitCode).toBe(3);
    out.length = 0;
    process.exitCode = undefined;
    await describeCmd("boltz", "--runtime", "podman", "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "INVALID_DESCRIBE_ARGS" });
    expect(process.exitCode).toBe(2);
  });

  describe.each([
    ["no hardware found", (() => ({ code: 127, spawnError: true })) as FakeSpawnHandler],
    ["an A100 with CUDA 12.4", A100 as FakeSpawnHandler],
    ["a small GPU with old CUDA", SMALL_GPU as FakeSpawnHandler],
  ])("on %s", (_label, handler) => {
    it("gives every model the same verdict as the compatibility check on the report that `doctor --json` prints", async () => {
      state.handler = handler;
      await doctor("--json");
      const report = JSON.parse(out[0]) as SystemReport;
      for (const manifest of listAvailableModels()) {
        out.length = 0;
        await describeCmd(manifest.name, "--json");
        const { result } = JSON.parse(out[0]);
        expect(result.compatibility, manifest.name).toEqual(evaluateCompatibility(manifest, report));
      }
    });
  });

  it("the three mocked profiles really differ in what doctor sees, so the comparison above is not vacuous", async () => {
    const seen: string[] = [];
    for (const handler of [(() => ({ code: 127, spawnError: true })) as FakeSpawnHandler, A100 as FakeSpawnHandler, SMALL_GPU as FakeSpawnHandler]) {
      state.handler = handler;
      out.length = 0;
      await doctor("--json");
      const report = JSON.parse(out[0]) as SystemReport;
      seen.push(JSON.stringify([report.nvidia.available, report.nvidia.gpus.map((g) => [g.name, g.totalVramBytes]), report.nvidia.driverCudaVersion]));
    }
    expect(new Set(seen).size).toBe(3);
  });
});
