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

const CHECKPOINT_TARGET = path.join("model_params", "ligandmpnn_v_32_010_25.pt");

/** run.py writes `<out_folder>/seqs/<pdb_name>.fa` (verified against the pinned source revision). */
const OUTPUTS: OutputSpec[] = [{ id: "sequences", glob: "seqs/*.fa", required: true }];

const PARAMS: ParamDescriptor[] = [
  { name: "temperature", type: "number", default: 0.1, min: 0, description: "Temperature to sample sequences" },
  { name: "seed", type: "number", default: 0, description: "Random seed for torch, numpy, and python random" },
  { name: "batch_size", type: "number", default: 1, min: 1, description: "Number of sequences to generate per pass" },
  { name: "number_of_batches", type: "number", default: 1, min: 1, description: "Number of times to design sequences using the batch size" },
];

export const ligandmpnnAdapter: ModelAdapterDefinition = {
  modelName: "ligandmpnn",
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
        message: `LigandMPNN requires a .pdb input file, got "${path.extname(inputPath) || "(no extension)"}".`,
        remediation: "Provide a .pdb structure file.",
      });
    }
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
  async command(context: RunContext): Promise<CommandSpec> {
    const params = context.params;
    const args: string[] = [
      path.join(context.modelDir, "source", "run.py"),
      "--pdb_path", context.inputPath,
      "--out_folder", context.outputDir,
      // run.py defaults to model_type=protein_mpnn; must be set explicitly for LigandMPNN.
      "--model_type", "ligand_mpnn",
      "--checkpoint_ligand_mpnn", path.join(context.assetsDir, CHECKPOINT_TARGET),
    ];
    if (params.temperature !== undefined) args.push("--temperature", String(params.temperature));
    if (params.seed !== undefined) args.push("--seed", String(params.seed));
    if (params.batch_size !== undefined) args.push("--batch_size", String(params.batch_size));
    if (params.number_of_batches !== undefined) args.push("--number_of_batches", String(params.number_of_batches));
    return { executable: context.runtimeExecutable, args };
  },
  async collectOutputs(context: RunContext): Promise<CollectedOutput[]> {
    return collectGlobOutputs(context.outputDir, OUTPUTS);
  },
  async verifyInstallation(context: InstallContext): Promise<VerificationResult> {
    const requiredFiles = [
      path.join(context.modelDir, "source", "run.py"),
      path.join(context.assetsDir, CHECKPOINT_TARGET),
    ];
    const missing = requiredFiles.filter((file) => !fs.existsSync(file));
    if (missing.length > 0) return { passed: false, output: `Missing ${missing.join(", ")}` };
    const python = path.join(context.modelDir, ".venv", "bin", "python");
    const result = await (context.runner ?? runCommand)(python, ["-c", "import numpy, prody, torch"], { timeoutMs: 30_000 });
    return { passed: result.code === 0, output: (result.code === 0 ? result.stdout : result.stderr).trim() };
  },
};
