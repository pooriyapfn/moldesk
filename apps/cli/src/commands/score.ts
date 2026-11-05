import type { Command } from "commander";
import { scoreProteinInterface } from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

export function registerScoreCommand(program: Command): void {
  program.command("score").description("Evaluate modeled interfaces with managed CPU tools")
    .command("interface <structure>")
    .description("Score one two-protein-chain Boltz prediction with ipSAE")
    .requiredOption("--pae <file>", "exact PAE NPZ sidecar")
    .requiredOption("--confidence <file>", "exact confidence JSON sidecar")
    .option("--plddt <file>", "optional exact pLDDT NPZ sidecar")
    .requiredOption("--target-chain <id>", "target author chain ID")
    .requiredOption("--binder-chain <id>", "binder author chain ID")
    .option("--pae-cutoff <angstrom>", "positive integer PAE cutoff", "15")
    .option("--distance-cutoff <angstrom>", "positive integer distance cutoff", "15")
    .option("--output <file>", "save JSON plus a private .artifacts directory; must not exist")
    .option("--json", "print one JSON envelope")
    .action(async (structure: string, options: { pae: string; confidence: string; plddt?: string; targetChain: string; binderChain: string; paeCutoff: string; distanceCutoff: string; output?: string; json?: boolean }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once("SIGINT", abort); process.once("SIGTERM", abort);
      try {
        const envelope = await scoreProteinInterface({ ...options, structure, paeCutoffAngstrom: Number(options.paeCutoff), distanceCutoffAngstrom: Number(options.distanceCutoff), outputPath: options.output, signal: controller.signal });
        if (options.json) console.log(JSON.stringify(envelope, null, 2));
        else {
          const s = envelope.result.scores;
          console.log(`ipSAE target→binder ${s.ipsaeTargetToBinder}; binder→target ${s.ipsaeBinderToTarget}; max ${s.ipsaeMax}`);
          console.log(`Artifacts: ${envelope.result.artifacts[0]?.path}`);
          for (const w of envelope.warnings) console.error(w.message);
        }
      } catch (error) { reportFailure(error, options.json); }
      finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
    });
}
