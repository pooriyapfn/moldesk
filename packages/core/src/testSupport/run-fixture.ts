import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMoldeskPaths, type InstallCommandRunner, type ExecuteRequest, type ExecutionResult, type RuntimeProvider } from "@moldesk/runtime";
import { listAvailableModels } from "@moldesk/registry";
import { createInstallationPlan, installModel } from "../installation.js";

export const homes: string[] = [];

export function tempPaths() {
  // Intentionally includes a space to exercise the "paths containing spaces" requirement.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk core run "));
  homes.push(home);
  return getMoldeskPaths({ MOLDESK_HOME: home });
}

export function successfulInstallRunner(revision: string): InstallCommandRunner {
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

/** Installs a real ProteinMPNN fixture (fake install commands, no network) so `runModel` has a genuine `InstalledModel` to resolve. */
export async function installFixture(paths: ReturnType<typeof getMoldeskPaths>) {
  const manifest = { ...listAvailableModels().find((item) => item.name === "proteinmpnn")!, assets: [] };
  const runtime = manifest.runtimes.find((item) => item.kind === "python")!;
  const planned = await createInstallationPlan(manifest, runtime, paths);
  await installModel(planned, { paths, runner: successfulInstallRunner(manifest.source!.revision), uvExecutable: "uv" });
  return planned.targetDir;
}

/** A fake RuntimeProvider whose `execute()` is fully scripted by the test. */
export function fakeProvider(
  behavior: (request: ExecuteRequest) => ExecutionResult | Promise<ExecutionResult>,
): RuntimeProvider {
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

export function writeSequenceOutput(request: ExecuteRequest): void {
  const seqsDir = path.join(request.cwd, "output", "seqs");
  fs.mkdirSync(seqsDir, { recursive: true });
  fs.writeFileSync(path.join(seqsDir, "input.fa"), ">input\nMKV\n");
}

export function writeInputFixture(dir: string, name = "input.pdb"): string {
  fs.mkdirSync(dir, { recursive: true });
  const inputPath = path.join(dir, name);
  fs.writeFileSync(inputPath, "ATOM      1  N   MET A   1\n");
  return inputPath;
}

