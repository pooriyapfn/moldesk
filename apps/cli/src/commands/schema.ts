import type { Command } from "commander";
import { ENVELOPE_KINDS, schemaForKind } from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

export function registerSchemaCommand(program: Command): void {
  program
    .command("schema [kind]")
    .description(`Print the JSON Schema for a --json output kind (${ENVELOPE_KINDS.join(", ")})`)
    .action((kind: string | undefined) => {
      try {
        if (kind === undefined) {
          console.log(JSON.stringify({ kinds: ENVELOPE_KINDS }, null, 2));
          return;
        }
        console.log(JSON.stringify(schemaForKind(kind), null, 2));
      } catch (error) {
        // The schema is the machine-readable payload, so errors are always JSON on stdout.
        reportFailure(error, true);
      }
    });
}
