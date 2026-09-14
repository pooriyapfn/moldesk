import fs from "node:fs";
import path from "node:path";
import type { CommandSpec } from "@moldesk/registry";
import { runCommand } from "@moldesk/runtime";
import type {
  CollectedOutput,
  InstallContext,
  InstallPlan,
  ModelAdapterDefinition,
  RunContext,
  VerificationResult,
} from "../index.js";
import { plannedAdapterOperation } from "../planned.js";

export const proteinmpnnAdapter: ModelAdapterDefinition = {
  modelName: "proteinmpnn",
  async validateInput(_inputPath: string): Promise<void> {
    plannedAdapterOperation("proteinmpnn", "validate input");
  },
  async installPlan(_context: InstallContext): Promise<InstallPlan> {
    return {
      steps: [
        { id: "source", description: "Fetch the pinned ProteinMPNN source revision" },
        { id: "checkpoint", description: "Download and checksum the ProteinMPNN checkpoint" },
        { id: "python", description: "Create an isolated managed Python 3.11 environment" },
        { id: "dependencies", description: "Install pinned Python dependencies" },
        { id: "verify", description: "Verify source, checkpoint, and Python imports" },
      ],
    };
  },
  async command(_context: RunContext): Promise<CommandSpec> {
    return plannedAdapterOperation("proteinmpnn", "build a run command");
  },
  async collectOutputs(_context: RunContext): Promise<CollectedOutput[]> {
    return plannedAdapterOperation("proteinmpnn", "collect outputs");
  },
  async verifyInstallation(context: InstallContext): Promise<VerificationResult> {
    const requiredFiles = [
      path.join(context.modelDir, "source", "protein_mpnn_run.py"),
      path.join(context.assetsDir, "vanilla_model_weights", "v_48_020.pt"),
    ];
    const missing = requiredFiles.filter((file) => !fs.existsSync(file));
    if (missing.length > 0) return { passed: false, output: `Missing ${missing.join(", ")}` };
    const python = path.join(context.modelDir, ".venv", "bin", "python");
    const result = await (context.runner ?? runCommand)(python, ["-c", "import numpy, torch"], { timeoutMs: 30_000 });
    return { passed: result.code === 0, output: (result.code === 0 ? result.stdout : result.stderr).trim() };
  },
};
