import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createFakeSpawn, type FakeSpawnHandler } from "../testSupport/spawnMock.js";
import { registerListCommand } from "./list.js";

const state = vi.hoisted(() => ({
  handler: ((_cmd: string, _args: string[]) => ({ code: 127, spawnError: true })) as FakeSpawnHandler,
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => createFakeSpawn((c, a) => state.handler(c, a))(command, args),
}));

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
    digest: "sha256:${"b".repeat(64)}"
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
let logs: string[];

beforeEach(() => {
  modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-models-"));
  process.env["MOLDESK_MODELS_DIR"] = modelsDir;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((msg: string) => {
    logs.push(String(msg));
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Nvidia runtime registered but never explicitly probed/pulled by `list`.
  state.handler = (cmd, args) => {
    if (cmd === "docker" && args[0] === "--version") return { code: 0, stdout: "Docker version 24.0.7\n" };
    if (cmd === "docker" && args[0] === "info") return { code: 0, stdout: JSON.stringify({ Runtimes: { runc: {}, nvidia: {} } }) };
    if (cmd === "docker") throw new Error(`list must never run/pull docker images (got: ${args.join(" ")})`);
    return { code: 127, spawnError: true };
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["MOLDESK_MODELS_DIR"];
  fs.rmSync(modelsDir, { recursive: true, force: true });
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerListCommand(program);
  return program;
}

describe("list (real command, faked process boundary only)", () => {
  it("never runs or pulls a Docker image, even for a docker-gpu-required manifest", async () => {
    writeManifest(modelsDir, "gpu-model", DOCKER_GPU_REQUIRED_MANIFEST("gpu-model"));
    const program = buildProgram();
    await program.parseAsync(["list"], { from: "user" });
    // The handler above throws if `docker run`/`docker pull` is ever invoked;
    // reaching this line without a thrown error is the assertion.
    expect(logs.join("\n")).toContain("gpu-model");
  });

  it("--json output is valid JSON and includes a per-runtime breakdown for each row", async () => {
    writeManifest(modelsDir, "good-python", CPU_PYTHON_MANIFEST("good-python"));
    writeManifest(modelsDir, "old-python", UNSUPPORTED_PYTHON_VERSION_MANIFEST("old-python"));
    const program = buildProgram();
    await program.parseAsync(["list", "--json"], { from: "user" });
    const rows = JSON.parse(logs.join("\n")) as Array<{ manifest: { name: string }; compatibility: { status: string; runtimes: unknown[] } }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Array.isArray(row.compatibility.runtimes)).toBe(true);
      expect(row.compatibility.runtimes.length).toBeGreaterThan(0);
    }
    const goodRow = rows.find((r) => r.manifest.name === "good-python");
    const oldRow = rows.find((r) => r.manifest.name === "old-python");
    expect(goodRow?.compatibility.status).toBe("compatible");
    expect(oldRow?.compatibility.status).toBe("unsupported");
  });

  it("human-mode table's compatibility column matches evaluateCompatibility's status for compatible/unsupported/docker-unverified rows", async () => {
    writeManifest(modelsDir, "good-python", CPU_PYTHON_MANIFEST("good-python"));
    writeManifest(modelsDir, "old-python", UNSUPPORTED_PYTHON_VERSION_MANIFEST("old-python"));
    writeManifest(modelsDir, "gpu-model", DOCKER_GPU_REQUIRED_MANIFEST("gpu-model"));
    const program = buildProgram();
    await program.parseAsync(["list"], { from: "user" });
    const lines = logs.join("\n").split("\n");
    const line = (name: string) => lines.find((l) => l.includes(name));
    expect(line("good-python")).toMatch(/\bcompatible\b/);
    expect(line("old-python")).toMatch(/unsupported: MANAGED_PYTHON_VERSION_UNSUPPORTED/);
    expect(line("gpu-model")).toMatch(/unsupported: DOCKER_GPU_UNVERIFIED/);
  });
});
