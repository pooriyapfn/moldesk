import fs from "node:fs";
import path from "node:path";
import type { CommandSpec, OutputSpec } from "@moldesk/registry";
import { MoldeskError } from "@moldesk/registry";
import { runCommand } from "@moldesk/runtime";
import type {
  CollectedOutput,
  InstallContext,
  InstallPlan,
  ModelAdapterDefinition,
  ParamDescriptor,
  RunContext,
  VerificationResult,
} from "../index.js";
import { collectGlobOutputs } from "../outputs.js";

/** Pinned to the manifest's modelVersion; protein_mpnn_run.py loads `<path_to_model_weights>/<model_name>.pt`. */
const MODEL_NAME = "v_48_020";

/** protein_mpnn_run.py writes `<out_folder>/seqs/<pdb_name>.fa` (verified against the pinned source revision). */
const OUTPUTS: OutputSpec[] = [{ id: "sequences", glob: "seqs/*.fa", required: true }];

const PARAMS: ParamDescriptor[] = [
  { name: "num_seq_per_target", type: "number", default: 1, min: 1, description: "Number of sequences to generate per target" },
  // Upstream parses this as a space-separated string of temperatures, not a single float.
  { name: "sampling_temp", type: "string", default: "0.1", description: "Sampling temperature(s), e.g. \"0.1\" or \"0.1 0.2\"" },
  { name: "seed", type: "number", default: 0, description: "Random seed; 0 picks a random seed" },
  { name: "batch_size", type: "number", default: 1, min: 1, description: "Batch size" },
  { name: "ca_only", type: "boolean", default: false, description: "Parse CA-only structures and use CA-only models" },
];

export const proteinmpnnAdapter: ModelAdapterDefinition = {
  modelName: "proteinmpnn",
  params: PARAMS,
  async validateInput(inputPath: string): Promise<void> {
    if (!fs.existsSync(inputPath)) {
      throw new MoldeskError({
        code: "INVALID_RUN_INPUT",
        message: `Input file not found: ${inputPath}.`,
        remediation: "Provide a path to an existing .pdb file.",
      });
    }
    if (path.extname(inputPath).toLowerCase() !== ".pdb") {
      throw new MoldeskError({
        code: "INVALID_RUN_INPUT",
        message: `ProteinMPNN requires a .pdb input file, got "${path.extname(inputPath) || "(no extension)"}".`,
        remediation: "Provide a .pdb structure file.",
      });
    }
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
  async command(context: RunContext): Promise<CommandSpec> {
    const params = context.params;
    const args: string[] = [
      path.join(context.modelDir, "source", "protein_mpnn_run.py"),
      "--pdb_path", context.inputPath,
      "--out_folder", context.outputDir,
      "--path_to_model_weights", path.join(context.assetsDir, "vanilla_model_weights"),
      "--model_name", MODEL_NAME,
    ];
    if (params.num_seq_per_target !== undefined) args.push("--num_seq_per_target", String(params.num_seq_per_target));
    if (params.sampling_temp !== undefined) args.push("--sampling_temp", String(params.sampling_temp));
    if (params.seed !== undefined) args.push("--seed", String(params.seed));
    if (params.batch_size !== undefined) args.push("--batch_size", String(params.batch_size));
    if (params.ca_only === true) args.push("--ca_only");
    return { executable: context.runtimeExecutable, args };
  },
  async collectOutputs(context: RunContext): Promise<CollectedOutput[]> {
    return collectGlobOutputs(context.outputDir, OUTPUTS);
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
