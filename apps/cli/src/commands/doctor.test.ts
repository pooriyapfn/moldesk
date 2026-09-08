import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Command } from "commander";
import { createFakeSpawn, type FakeSpawnHandler } from "../testSupport/spawnMock.js";
import { registerDoctorCommand, printHuman } from "./doctor.js";
import type { SystemReport } from "@moldesk/core";

const state = vi.hoisted(() => ({
  handler: ((_cmd: string, _args: string[]) => ({ code: 127, spawnError: true })) as FakeSpawnHandler,
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => createFakeSpawn((c, a) => state.handler(c, a))(command, args),
}));

let moldeskHome: string;
let logs: string[];

beforeEach(() => {
  moldeskHome = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-home-"));
  process.env["MOLDESK_HOME"] = moldeskHome;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((msg: string) => {
    logs.push(String(msg));
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.handler = () => ({ code: 127, spawnError: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["MOLDESK_HOME"];
  fs.rmSync(moldeskHome, { recursive: true, force: true });
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerDoctorCommand(program);
  return program;
}

describe("doctor (real command, faked process boundary only)", () => {
  it("never triggers a docker pull or gpu-run probe (doctor stays fast, no pulls)", async () => {
    state.handler = (cmd, args) => {
      expect(args).not.toContain("pull");
      if (cmd === "docker" && args[0] === "run") throw new Error("doctor must never run a docker container");
      return { code: 127, spawnError: true };
    };
    const program = buildProgram();
    await program.parseAsync(["doctor"], { from: "user" });
  });

  it("prints GPU count and per-GPU VRAM when GPUs are present", async () => {
    state.handler = (cmd, args) => {
      if (cmd === "nvidia-smi" && args.join(" ").includes("memory.total"))
        return { code: 0, stdout: "0, NVIDIA A100, 81920\n1, NVIDIA A100, 81920\n" };
      if (cmd === "nvidia-smi" && args.includes("-x"))
        return { code: 0, stdout: "<nvidia_smi_log><cuda_version>12.4</cuda_version></nvidia_smi_log>" };
      if (cmd === "nvidia-smi") return { code: 0, stdout: "550.54.15\n" };
      return { code: 127, spawnError: true };
    };
    const program = buildProgram();
    await program.parseAsync(["doctor"], { from: "user" });
    const output = logs.join("\n");
    expect(output).toContain("2 GPUs:");
    expect(output).toContain("80.0 GB VRAM");
    expect(output).toContain("CUDA (driver max) 12.4");
  });

  it("renders the corrected no-NVIDIA guidance instead of the misleading Docker-fallback note", async () => {
    const program = buildProgram();
    await program.parseAsync(["doctor"], { from: "user" });
    const output = logs.join("\n");
    expect(output).toContain("No NVIDIA GPU detected: CUDA/GPU models will run on CPU only.");
    expect(output).toContain("Docker GPU runtimes need the same host NVIDIA driver");
    expect(output).not.toMatch(/CPU or Docker fallbacks/);
  });

  it("renders 'unknown (<error>)' instead of '0 MB' when the disk probe failed", () => {
    const report: SystemReport = {
      capturedAt: "2026-01-01T00:00:00.000Z",
      platform: "linux",
      arch: "x64",
      cpu: { model: "Test CPU", logicalCores: 8 },
      memory: { totalBytes: 32 * 1024 ** 3 },
      disk: { availableBytes: 0, path: "/tmp/moldesk", probeFailed: true, probeError: "EACCES: permission denied" },
      appleSilicon: false,
      hostPython: { available: false, error: "no python" },
      docker: { available: false, running: false, gpuAccess: "unknown" },
      nvidia: { available: false, gpus: [], error: "no gpu" },
    };
    printHuman(report);
    const output = logs.join("\n");
    expect(output).toContain("unknown (EACCES: permission denied)");
    expect(output).not.toContain("0 MB");
  });

  it("renders the free-space reading normally when the disk probe succeeds (including a genuine zero)", () => {
    const report: SystemReport = {
      capturedAt: "2026-01-01T00:00:00.000Z",
      platform: "linux",
      arch: "x64",
      cpu: { model: "Test CPU", logicalCores: 8 },
      memory: { totalBytes: 32 * 1024 ** 3 },
      disk: { availableBytes: 0, path: "/tmp/moldesk" },
      appleSilicon: false,
      hostPython: { available: false, error: "no python" },
      docker: { available: false, running: false, gpuAccess: "unknown" },
      nvidia: { available: false, gpus: [], error: "no gpu" },
    };
    printHuman(report);
    const output = logs.join("\n");
    expect(output).toContain("0 MB free at /tmp/moldesk");
  });
});
