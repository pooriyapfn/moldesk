import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createFakeSpawn, type FakeSpawnHandler } from "../testSupport/spawnMock.js";
import { registerInstallCommand } from "./install.js";

const state = vi.hoisted(() => ({
  handler: ((_cmd: string, _args: string[]) => ({ code: 127 })) as FakeSpawnHandler,
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => createFakeSpawn((c, a) => state.handler(c, a))(command, args),
}));

function noDockerNoNvidia(): FakeSpawnHandler {
  return (cmd) => {
    if (cmd === "python3" || cmd === "python" || cmd === "which") return { code: 127, spawnError: true };
    if (cmd === "docker") return { code: 127, spawnError: true };
    if (cmd === "nvidia-smi" || cmd === "nvcc") return { code: 127, spawnError: true };
    return { code: 1 };
  };
}

function dirSnapshot(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true } as { recursive: true }).map(String).sort();
}

function writeManifest(modelsDir: string, name: string, yaml: string): void {
  const dir = path.join(modelsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml);
}

const CPU_PYTHON_MANIFEST = (name: string) => `
schemaVersion: 1
name: ${name}
displayName: Test CPU Model
modelVersion: "1.0.0"
adapterVersion: "0.1.0"
description: test
category: other
status: beta
runtimes:
  - kind: python
    python: "3.11"
    installer: uv
    requirements:
      - name: torch
        version: "2.2.1"
hardware:
  platforms: [darwin-arm64, linux-x64]
input:
  formats: [".pdb"]
  required: true
outputs:
  - id: out
    glob: "*.txt"
    required: true
`;

const UNSUPPORTED_PYTHON_VERSION_MANIFEST = (name: string) => `
schemaVersion: 1
name: ${name}
displayName: Test Old Python Model
modelVersion: "1.0.0"
adapterVersion: "0.1.0"
description: test
category: other
status: beta
runtimes:
  - kind: python
    python: "3.8"
    installer: uv
    requirements:
      - name: torch
        version: "2.2.1"
hardware:
  platforms: [darwin-arm64, linux-x64]
input:
  formats: [".pdb"]
  required: true
outputs:
  - id: out
    glob: "*.txt"
    required: true
`;

const DOCKER_GPU_REQUIRED_MANIFEST = (name: string) => `
schemaVersion: 1
name: ${name}
displayName: Test Docker GPU Model
modelVersion: "1.0.0"
adapterVersion: "0.1.0"
description: test
category: other
status: beta
runtimes:
  - kind: docker
    image: example/test:latest
    digest: "sha256:${"a".repeat(64)}"
    gpu: required
hardware:
  platforms: [darwin-arm64, linux-x64]
input:
  formats: [".pdb"]
  required: true
outputs:
  - id: out
    glob: "*.txt"
    required: true
`;

let modelsDir: string;
let moldeskHome: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-models-"));
  moldeskHome = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-home-"));
  process.env["MOLDESK_MODELS_DIR"] = modelsDir;
  process.env["MOLDESK_HOME"] = moldeskHome;
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((msg: string) => {
    logs.push(String(msg));
  });
  vi.spyOn(console, "error").mockImplementation((msg: string) => {
    errors.push(String(msg));
  });
  state.handler = noDockerNoNvidia();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["MOLDESK_MODELS_DIR"];
  delete process.env["MOLDESK_HOME"];
  fs.rmSync(modelsDir, { recursive: true, force: true });
  fs.rmSync(moldeskHome, { recursive: true, force: true });
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerInstallCommand(program);
  return program;
}

describe("install (real command, faked process boundary only)", () => {
  it("performs zero filesystem writes for an unsupported install", async () => {
    writeManifest(modelsDir, "old-python", UNSUPPORTED_PYTHON_VERSION_MANIFEST("old-python"));
    const before = dirSnapshot(moldeskHome);
    const program = buildProgram();
    await program.parseAsync(["install", "old-python"], { from: "user" });
    const after = dirSnapshot(moldeskHome);
    expect(after).toEqual(before);
    expect(errors.some((e) => e.includes("Nothing was changed."))).toBe(true);
  });

  it("--json output is valid JSON for an unsupported install", async () => {
    writeManifest(modelsDir, "old-python", UNSUPPORTED_PYTHON_VERSION_MANIFEST("old-python"));
    const program = buildProgram();
    await program.parseAsync(["install", "old-python", "--json"], { from: "user" });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("unsupported");
    expect(parsed.compatibility.runtimes[0].reasons.some((r: { code: string }) => r.code === "MANAGED_PYTHON_VERSION_UNSUPPORTED")).toBe(true);
  });

  it("--json output is valid JSON for a compatible install", async () => {
    writeManifest(modelsDir, "good-python", CPU_PYTHON_MANIFEST("good-python"));
    const program = buildProgram();
    await program.parseAsync(["install", "good-python", "--json"], { from: "user" });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("compatible");
    expect(parsed.compatibility.selectedRuntime).toBe("python");
  });

  it("human output includes remediation text per reason", async () => {
    writeManifest(modelsDir, "old-python", UNSUPPORTED_PYTHON_VERSION_MANIFEST("old-python"));
    const program = buildProgram();
    await program.parseAsync(["install", "old-python", "--verbose"], { from: "user" });
    expect(errors.some((e) => e.includes("MANAGED_PYTHON_VERSION_UNSUPPORTED") && e.includes("Use a manifest requesting one of"))).toBe(true);
  });

  it("keeps technical compatibility codes out of the default output", async () => {
    writeManifest(modelsDir, "old-python", UNSUPPORTED_PYTHON_VERSION_MANIFEST("old-python"));
    const program = buildProgram();
    await program.parseAsync(["install", "old-python"], { from: "user" });
    expect(errors.join("\n")).not.toContain("MANAGED_PYTHON_VERSION_UNSUPPORTED");
    expect(errors.join("\n")).toContain("cannot be installed on this computer");
  });

  it("a docker-gpu-required manifest with unverified GPU access surfaces DOCKER_GPU_UNVERIFIED, not UNAVAILABLE", async () => {
    writeManifest(modelsDir, "gpu-model", DOCKER_GPU_REQUIRED_MANIFEST("gpu-model"));
    // A registered nvidia runtime leaves Tier 1 as "unknown" (unverified) rather than
    // "unavailable" — this is the case a real GPU-capable Docker host would present.
    state.handler = (cmd, args) => {
      if (cmd === "docker" && args[0] === "--version") return { code: 0, stdout: "Docker version 24.0.7\n" };
      if (cmd === "docker" && args[0] === "info") return { code: 0, stdout: JSON.stringify({ Runtimes: { runc: {}, nvidia: {} } }) };
      if (cmd === "docker" && args[0] === "image") return { code: 1, stderr: "No such image" };
      return { code: 127, spawnError: true };
    };
    const program = buildProgram();
    // Declined download (no --yes, no interactive stdin in test) -> stays unverified.
    await program.parseAsync(["install", "gpu-model", "--json"], { from: "user" });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("unsupported");
    const dockerReasons = parsed.compatibility.runtimes[0].reasons.map((r: { code: string }) => r.code);
    expect(dockerReasons).toContain("DOCKER_GPU_UNVERIFIED");
    expect(dockerReasons).not.toContain("DOCKER_GPU_UNAVAILABLE");
  });

  it("--yes confirms the download and a successful pull+probe transitions the install to compatible", async () => {
    writeManifest(modelsDir, "gpu-model", DOCKER_GPU_REQUIRED_MANIFEST("gpu-model"));
    state.handler = (cmd, args) => {
      if (cmd === "docker" && args[0] === "--version") return { code: 0, stdout: "Docker version 24.0.7\n" };
      if (cmd === "docker" && args[0] === "info") return { code: 0, stdout: JSON.stringify({ Runtimes: { runc: {}, nvidia: {} } }) };
      if (cmd === "docker" && args[0] === "image") return { code: 1, stderr: "No such image" }; // not cached
      if (cmd === "docker" && args[0] === "pull") return { code: 0, stdout: "Status: Downloaded newer image" };
      if (cmd === "docker" && args[0] === "run") return { code: 0, stdout: "GPU 0: NVIDIA A100" };
      return { code: 127, spawnError: true };
    };
    const program = buildProgram();
    await program.parseAsync(["install", "gpu-model", "--json", "--yes"], { from: "user" });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("compatible");
    expect(parsed.selectedRuntime).toBe("docker");
  });

  it("unknown model prints a message and writes no files", async () => {
    const before = dirSnapshot(moldeskHome);
    const program = buildProgram();
    await program.parseAsync(["install", "does-not-exist"], { from: "user" });
    expect(dirSnapshot(moldeskHome)).toEqual(before);
    expect(errors.some((e) => e.includes("Unknown model"))).toBe(true);
  });
});
