import fs from "node:fs";
import path from "node:path";
import type { CommandSpec } from "@moldesk/registry";
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

const ACCEPTED_EXTENSIONS = [".fa", ".fas", ".fasta", ".yml", ".yaml"];

const REQUIRED_ASSETS = ["boltz2_conf.ckpt", "boltz2_aff.ckpt", "mols"];

const PARAMS: ParamDescriptor[] = [
  // Defaults to "gpu": the pinned revision (v2.2.1) has a confirmed upstream
  // CPU-precision bug (github.com/jwohlwend/boltz#653, #662) that isn't fixed in
  // any released version yet — never silently default to the broken path.
  { name: "accelerator", type: "string", enum: ["cpu", "gpu"], default: "gpu", description: "Inference device; cpu is a known-degraded, informed opt-in for v0.1" },
  { name: "recycling_steps", type: "number", default: 3, min: 0, description: "Number of recycling steps" },
  { name: "sampling_steps", type: "number", default: 200, min: 1, description: "Number of diffusion sampling steps" },
  { name: "diffusion_samples", type: "number", default: 1, min: 1, description: "Number of diffusion samples to generate" },
  { name: "step_scale", type: "number", description: "Diffusion step size (upstream default: 1.5 for Boltz-2 when omitted)" },
  { name: "seed", type: "number", description: "Random seed" },
  { name: "override", type: "boolean", default: false, description: "Overwrite existing predictions in the output directory" },
];

export const boltzAdapter: ModelAdapterDefinition = {
  modelName: "boltz",
  params: PARAMS,
  async validateInput(inputPath: string): Promise<void> {
    if (!fs.existsSync(inputPath)) {
      throw new MoldeskError({
        code: "INVALID_RUN_INPUT",
        message: `Input file not found: ${inputPath}.`,
        remediation: "Provide a path to an existing .fasta or .yaml input.",
      });
    }
    const extension = path.extname(inputPath).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(extension)) {
      throw new MoldeskError({
        code: "INVALID_RUN_INPUT",
        message: `Boltz-2 requires a .fasta or .yaml input file, got "${extension || "(no extension)"}".`,
        remediation: `Provide one of: ${ACCEPTED_EXTENSIONS.join(", ")}.`,
      });
    }
  },
  async installPlan(_context: InstallContext): Promise<InstallPlan> {
    return {
      steps: [
        { id: "source", description: "Fetch the pinned Boltz-2 source revision" },
        { id: "checkpoint", description: "Download and checksum the Boltz-2 checkpoints and molecule dictionary" },
        { id: "python", description: "Create an isolated managed Python 3.11 environment" },
        { id: "dependencies", description: "Install pinned Python dependencies" },
        { id: "verify", description: "Verify checkpoints, molecule cache, and Python imports" },
      ],
    };
  },
  async command(context: RunContext): Promise<CommandSpec> {
    const params = context.params;
    const args: string[] = [
      "predict",
      context.inputPath,
      "--out_dir", context.outputDir,
      "--cache", context.assetsDir,
      // Hardcoded, never a configurable param: the manifest only declares a
      // *.cif output, so allowing "pdb" would make a successful run look
      // like a MISSING_REQUIRED_OUTPUT failure.
      "--output_format", "mmcif",
      "--accelerator", typeof params.accelerator === "string" ? params.accelerator : "gpu",
    ];
    if (params.recycling_steps !== undefined) args.push("--recycling_steps", String(params.recycling_steps));
    if (params.sampling_steps !== undefined) args.push("--sampling_steps", String(params.sampling_steps));
    if (params.diffusion_samples !== undefined) args.push("--diffusion_samples", String(params.diffusion_samples));
    if (params.step_scale !== undefined) args.push("--step_scale", String(params.step_scale));
    if (params.seed !== undefined) args.push("--seed", String(params.seed));
    if (params.override === true) args.push("--override");
    return { executable: path.join(context.modelDir, ".venv", "bin", "boltz"), args };
  },
  async collectOutputs(context: RunContext): Promise<CollectedOutput[]> {
    return collectGlobOutputs(context.outputDir, [{ id: "structures", glob: "**/*.cif", required: true }]);
  },
  async verifyInstallation(context: InstallContext): Promise<VerificationResult> {
    const missing = REQUIRED_ASSETS
      .map((name) => path.join(context.assetsDir, name))
      .filter((file) => !fs.existsSync(file));
    if (missing.length > 0) return { passed: false, output: `Missing ${missing.join(", ")}` };
    const python = path.join(context.modelDir, ".venv", "bin", "python");
    const result = await (context.runner ?? runCommand)(python, ["-c", "import boltz"], { timeoutMs: 30_000 });
    return { passed: result.code === 0, output: (result.code === 0 ? result.stdout : result.stderr).trim() };
  },
};
