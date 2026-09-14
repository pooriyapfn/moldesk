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

export const ligandmpnnAdapter: ModelAdapterDefinition = {
  modelName: "ligandmpnn",
  async validateInput(_inputPath: string): Promise<void> {
    plannedAdapterOperation("ligandmpnn", "validate input");
  },
  async installPlan(_context: InstallContext): Promise<InstallPlan> {
    return {
      steps: [
        { id: "source", description: "Fetch the pinned LigandMPNN source revision" },
        { id: "checkpoint", description: "Download and checksum the LigandMPNN checkpoint" },
        { id: "python", description: "Create an isolated managed Python 3.11 environment" },
        { id: "dependencies", description: "Install pinned Python dependencies" },
        { id: "verify", description: "Verify source, checkpoint, and Python imports" },
      ],
    };
  },
  async command(_context: RunContext): Promise<CommandSpec> {
    return plannedAdapterOperation("ligandmpnn", "build a run command");
  },
  async collectOutputs(_context: RunContext): Promise<CollectedOutput[]> {
    return plannedAdapterOperation("ligandmpnn", "collect outputs");
  },
  async verifyInstallation(context: InstallContext): Promise<VerificationResult> {
    const requiredFiles = [
      path.join(context.modelDir, "source", "run.py"),
      path.join(context.assetsDir, "model_params", "ligandmpnn_v_32_010_25.pt"),
    ];
    const missing = requiredFiles.filter((file) => !fs.existsSync(file));
    if (missing.length > 0) return { passed: false, output: `Missing ${missing.join(", ")}` };
    const python = path.join(context.modelDir, ".venv", "bin", "python");
    const result = await (context.runner ?? runCommand)(python, ["-c", "import numpy, prody, torch"], { timeoutMs: 30_000 });
    return { passed: result.code === 0, output: (result.code === 0 ? result.stdout : result.stderr).trim() };
  },
};
