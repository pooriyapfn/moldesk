import type { Command } from "commander";
import { DEFAULT_INSPECT_RADIUS, inspectStructureFile } from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

interface InspectOptions {
  radius: string;
  label?: boolean;
  bfactorIsPlddt?: boolean;
  json?: boolean;
}

export function registerInspectCommand(program: Command): void {
  program
    .command("inspect <file> <selector>")
    .description("Zoom in on a chain, residue or range (A, A:45, A:40-60, A:52A) and list neighbouring residues")
    .option("--radius <angstrom>", "list residues with a heavy atom within this distance", String(DEFAULT_INSPECT_RADIUS))
    .option("--label", "read chain and residue numbers in the selector as label ids instead of auth ids")
    .option("--bfactor-is-plddt", "treat the file's B-factor column as pLDDT (only if you know it is)")
    .option("--json", "print the result as one JSON document")
    .action(async (file: string, selector: string, options: InspectOptions) => {
      try {
        const envelope = await inspectStructureFile(file, selector, {
          radius: Number(options.radius),
          label: options.label,
          bfactorIsPlddt: options.bfactorIsPlddt,
        });
        if (options.json) {
          console.log(JSON.stringify(envelope, null, 2));
          return;
        }
        const { residues, radius } = envelope.result;
        for (const r of residues) {
          const id = `${r.chainAuthId}:${r.authSeqId}${r.insertionCode ?? ""}`;
          const ss = r.secondaryStructure ? ` ${r.secondaryStructure}` : "";
          const plddt = r.plddt === undefined ? "" : ` pLDDT ${r.plddt}`;
          console.log(`${id} ${r.name}${ss}${plddt} (${r.atomCount} atoms)`);
          for (const n of r.neighbors) {
            console.log(`    ${n.chainAuthId}:${n.authSeqId}${n.insertionCode ?? ""} ${n.name}  ${n.distance} Å  (${n.atoms.selected} - ${n.atoms.neighbor})`);
          }
          if (r.neighbors.length === 0) console.log(`    no residues within ${radius} Å`);
        }
        for (const w of envelope.warnings) console.error(`Warning: ${w.message}`);
      } catch (error) {
        reportFailure(error, options.json);
      }
    });
}
