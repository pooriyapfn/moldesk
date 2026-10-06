import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMoldeskPaths, type InstallCommandRunner, type ExecuteRequest, type ExecutionResult, type RuntimeProvider } from "@moldesk/runtime";
import { listAvailableModels } from "@moldesk/registry";
import { createInstallationPlan, installModel } from "./installation.js";

/**
 * Proves `ModelAdapterDefinition.resolveParamDefaults` (the hook `run.ts` calls
 * before `validateParams`, per the Boltz milestone's "resolved accelerator must
 * already be in run.json's parameters.effective" requirement): its output lands
 * in `run.json`'s `parameters.effective`, and an explicit `--param` still wins
 * over it. Mocks `@moldesk/adapters`'s `getAdapter` to return the real
 * ProteinMPNN adapter augmented with a fake `resolveParamDefaults`, so the rest
 * of `runModel`'s install/execute plumbing is exercised unchanged.
 */
vi.mock("@moldesk/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moldesk/adapters")>();
  const fakeAdapter = {
    ...actual.adapterCatalog["proteinmpnn"]!,
    resolveParamDefaults: () => ({ num_seq_per_target: 5 }),
  };
  return {
    ...actual,
    getAdapter: (name: string) => (name === "proteinmpnn" ? fakeAdapter : actual.getAdapter(name)),
  };
});

const { runModel } = await import("./run.js");

const homes: string[] = [];

function tempPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk core run dyn "));
  homes.push(home);
  return getMoldeskPaths({ MOLDESK_HOME: home });
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function successfulInstallRunner(revision: string): InstallCommandRunner {
  return async (command, args) => {
    if (command === "git" && args[0] === "init") {
      const source = args[1]!;
      fs.mkdirSync(path.join(source, "vanilla_model_weights"), { recursive: true });
      fs.mkdirSync(path.join(path.dirname(source), "assets", "vanilla_model_weights"), { recursive: true });
      fs.writeFileSync(path.join(source, "protein_mpnn_run.py"), "# pinned source\n");
      fs.writeFileSync(path.join(source, "vanilla_model_weights", "v_48_020.pt"), "weights");
      fs.writeFileSync(path.join(path.dirname(source), "assets", "vanilla_model_weights", "v_48_020.pt"), "weights");
    }
    if (command === "git" && args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
    if (command === "uv" && args[0] === "venv") fs.mkdirSync(path.join(args.at(-1)!, "bin"), { recursive: true });
    if (command === "uv" && args.includes("freeze")) return { code: 0, stdout: "numpy==1.26.4\ntorch==2.2.1\n", stderr: "" };
    if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function installFixture(paths: ReturnType<typeof getMoldeskPaths>) {
  const manifest = { ...listAvailableModels().find((item) => item.name === "proteinmpnn")!, assets: [] };
  const runtime = manifest.runtimes.find((item) => item.kind === "python")!;
  const planned = await createInstallationPlan(manifest, runtime, paths);
  await installModel(planned, { paths, runner: successfulInstallRunner(manifest.source!.revision), uvExecutable: "uv" });
}

function fakeProvider(behavior: (request: ExecuteRequest) => ExecutionResult | Promise<ExecutionResult>): RuntimeProvider {
  return {
    kind: "python",
    async inspect() {
      return { kind: "python", available: true };
    },
    async prepare(request) {
      return { kind: "python", executable: request.targetDir, fingerprint: request.runtimeFingerprint };
    },
    async execute(request) {
      request.onSpawn?.(4242);
      return behavior(request);
    },
    async remove() {},
  };
}

function writeSequenceOutput(request: ExecuteRequest): void {
  const seqsDir = path.join(request.cwd, "output", "seqs");
  fs.mkdirSync(seqsDir, { recursive: true });
  fs.writeFileSync(path.join(seqsDir, "input.fa"), ">input\nMKV\n");
}

function writeInputFixture(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const inputPath = path.join(dir, "input.pdb");
  fs.writeFileSync(inputPath, "ATOM      1  N   MET A   1\n");
  return inputPath;
}

describe("runModel dynamic param defaults (resolveParamDefaults)", () => {
  it("merges resolveParamDefaults's output into run.json's parameters.effective when the caller supplied nothing for that key", async () => {
    const paths = tempPaths();
    await installFixture(paths);
    const inputPath = writeInputFixture(paths.home);

    const result = await runModel("proteinmpnn", inputPath, {
      paths,
      runtimeProvider: fakeProvider((request) => {
        writeSequenceOutput(request);
        return { exitCode: 0, stdoutPath: path.join(request.cwd, "stdout.log"), stderrPath: path.join(request.cwd, "stderr.log") };
      }),
    });

    expect(result.status).toBe("succeeded");
    expect(result.record.parameters.effective.num_seq_per_target).toBe(5);
    expect(result.record.parameters.supplied.num_seq_per_target).toBeUndefined();
  });

  it("lets an explicit --param override resolveParamDefaults's value", async () => {
    const paths = tempPaths();
    await installFixture(paths);
    const inputPath = writeInputFixture(paths.home);

    const result = await runModel("proteinmpnn", inputPath, {
      paths,
      params: { num_seq_per_target: "9" },
      runtimeProvider: fakeProvider((request) => {
        writeSequenceOutput(request);
        return { exitCode: 0, stdoutPath: path.join(request.cwd, "stdout.log"), stderrPath: path.join(request.cwd, "stderr.log") };
      }),
    });

    expect(result.status).toBe("succeeded");
    expect(result.record.parameters.effective.num_seq_per_target).toBe(9);
  });
});
