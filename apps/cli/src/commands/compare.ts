import type { Command } from "commander";
import { compareStructureFiles } from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

interface CompareOptions {
  chainA?: string;
  chainB?: string;
  multimer?: boolean;
  json?: boolean;
}

export function registerCompareCommand(program: Command): void {
  program
    .command("compare <a> <b>")
    .description("Superpose two structures with US-align: TM-scores, RMSD, transform and residue mapping")
    .option("--chain-a <id>", "auth chain id in the first structure (default: its first polymer chain)")
    .option("--chain-b <id>", "auth chain id in the second structure (default: its first polymer chain)")
    .option("--multimer", "align all polymer chains of both structures instead of one chain each")
    .option("--json", "print the result as one JSON document")
    .action(async (a: string, b: string, options: CompareOptions) => {
      try {
        const envelope = await compareStructureFiles(a, b, { chainA: options.chainA, chainB: options.chainB, multimer: options.multimer });
        if (options.json) {
          console.log(JSON.stringify(envelope, null, 2));
          return;
        }
        const r = envelope.result;
        console.log(`US-align ${envelope.provenance.tool?.version}: ${r.mode}, chains ${r.chains.a.join(",")} vs ${r.chains.b.join(",")}`);
        console.log(`TM-score: ${r.tmScore.normalizedByA.toFixed(4)} (normalized by A, ${r.lengths.a} residues), ${r.tmScore.normalizedByB.toFixed(4)} (by B, ${r.lengths.b} residues)`);
        console.log(`RMSD: ${r.rmsd.toFixed(2)} Å over ${r.alignedLength} aligned residues (sequence identity ${r.sequenceIdentity.toFixed(3)})`);
        console.log("Transform (A onto B), [R | t]:");
        for (const row of r.transform.matrix.slice(0, 3)) console.log(`  ${row.map((v) => v.toFixed(4).padStart(9)).join(" ")}`);
        for (const w of envelope.warnings) console.error(`Warning: ${w.message}`);
      } catch (error) {
        reportFailure(error, options.json);
      }
    });
}
