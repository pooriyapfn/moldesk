import type { Command } from "commander";
import { analyzeStructureFile, fastaValidationEnvelope, MoldeskError, validateFasta, writeFastaFile } from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

interface AnalyzeOptions {
  fasta?: string;
  validateFasta?: string;
  bfactorIsPlddt?: boolean;
  json?: boolean;
}

function usage(message: string): MoldeskError {
  return new MoldeskError({
    code: "INVALID_ANALYZE_ARGS",
    message,
    remediation: "Run `moldesk analyze <file>` or `moldesk analyze --validate-fasta <file>`.",
  });
}

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze [file]")
    .description("Summarize a PDB/mmCIF structure: chains, sequences, secondary structure, geometry, confidence")
    .option("--fasta <file>", "also write the polymer chain sequences as FASTA (must not exist)")
    .option("--validate-fasta <file>", "check a FASTA file instead of analyzing a structure")
    .option("--bfactor-is-plddt", "treat the file's B-factor column as pLDDT (only if you know it is)")
    .option("--json", "print the result as one JSON document")
    .action(async (file: string | undefined, options: AnalyzeOptions) => {
      try {
        if (options.validateFasta !== undefined) {
          if (file !== undefined || options.fasta !== undefined || options.bfactorIsPlddt) {
            throw usage("--validate-fasta cannot be combined with a structure file or other options.");
          }
          const checked = validateFasta(options.validateFasta);
          if (options.json) {
            console.log(JSON.stringify(fastaValidationEnvelope(checked), null, 2));
          } else {
            console.log(`${checked.path}: valid FASTA, ${checked.records.length} record(s).`);
          }
          return;
        }
        if (file === undefined) throw usage("Missing <file>.");

        const envelope = await analyzeStructureFile(file, { bfactorIsPlddt: options.bfactorIsPlddt });
        const fastaPath = options.fasta === undefined ? undefined : await writeFastaFile(envelope, options.fasta);
        if (options.json) {
          console.log(JSON.stringify(envelope, null, 2));
          return;
        }
        const { result } = envelope;
        console.log(`${envelope.input?.path} (${envelope.input?.format}, ${result.modelCount} model(s))`);
        for (const chain of result.chains) {
          console.log(`  ${chain.authId}/${chain.labelId}  ${chain.type}  ${chain.residueCount} residue(s)`);
        }
        if (result.geometry) {
          console.log(`Radius of gyration: ${result.geometry.radiusOfGyration} Å`);
        }
        if (fastaPath) console.log(`FASTA written: ${fastaPath}`);
        for (const w of envelope.warnings) console.error(`Warning: ${w.message}`);
      } catch (error) {
        reportFailure(error, options.json);
      }
    });
}
