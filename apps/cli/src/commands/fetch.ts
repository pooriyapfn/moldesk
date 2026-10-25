import type { Command } from "commander";
import { fetchStructure, MoldeskError } from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

interface FetchCommandOptions {
  format?: string;
  output?: string;
  refresh?: boolean;
  json?: boolean;
}

export function registerFetchCommand(program: Command): void {
  program
    .command("fetch <source:id>")
    .description("Download a structure or sequence into the cache: pdb:1M17, afdb:P00533 or uniprot:P00533")
    .option("--format <format>", "mmcif (default) or pdb, for pdb: and afdb:")
    .option("--output <dir>", "also copy the file and its provenance into this directory (never overwrites)")
    .option("--refresh", "download again even if the cache has a verified copy")
    .option("--json", "print the result as one JSON document")
    .action(async (spec: string, options: FetchCommandOptions) => {
      const controller = new AbortController();
      const onSignal = (): void => controller.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const format = options.format;
        if (format !== undefined && format !== "mmcif" && format !== "pdb") {
          throw new MoldeskError({ code: "INVALID_FETCH_ARGS", message: `Unknown --format "${format}".`, remediation: "Use mmcif or pdb." });
        }
        const envelope = await fetchStructure(spec, {
          format: format as "mmcif" | "pdb" | undefined,
          outputDir: options.output,
          refresh: options.refresh,
          signal: controller.signal,
        });
        if (options.json) {
          console.log(JSON.stringify(envelope, null, 2));
          return;
        }
        const { result } = envelope;
        const p = result.provenance;
        console.log(`${result.source}:${result.id} ${result.fromCache ? "(from cache)" : "(downloaded)"}`);
        for (const file of result.files) console.log(`  ${file.path}  ${file.sizeBytes} bytes`);
        console.log(`  SHA-256 ${p.sha256}`);
        console.log(`  Source ${p.url}${p.sourceVersion ? ` (${p.sourceVersion})` : ""}`);
        console.log(`  License ${p.license.name}${p.license.notice ? `: ${p.license.notice}` : ""}`);
        for (const w of envelope.warnings) console.error(`Warning: ${w.message}`);
      } catch (error) {
        reportFailure(error, options.json);
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
    });
}
