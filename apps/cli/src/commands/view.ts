import type { Command } from "commander";
import { createStandaloneReport, openInBrowser, resolveViewRequest } from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

interface ViewOptions {
  output?: string;
  open?: boolean;
  json?: boolean;
  highlight?: string[];
  color?: string[];
  colorBy?: string;
  scene?: string;
  label?: boolean;
  bfactorIsPlddt?: boolean;
}

const collect = (value: string, all: string[] = []): string[] => [...all, value];

export function registerViewCommand(program: Command): void {
  program
    .command("view [file]")
    .description("Create an offline, interactive 3D report for a PDB or mmCIF file")
    .option("--highlight <selector>", "highlight a chain, residue or range such as A:40-60 (repeatable)", collect)
    .option("--color <#rrggbb>", "highlight color: one for all highlights, or one per --highlight", collect)
    .option("--color-by <mode>", "color the structure by chain (default) or plddt")
    .option("--scene <file>", "read highlights and coloring from a scene JSON file")
    .option("--label", "read selector chain and residue numbers as label ids instead of auth ids")
    .option("--bfactor-is-plddt", "treat the file's B-factor column as pLDDT (only if you know it is)")
    .option("--output <file>", "write the report to this file (must not exist)")
    .option("--open", "open the report in your default browser")
    .option("--json", "print the result as JSON")
    .action(async (file: string | undefined, options: ViewOptions) => {
      const controller = new AbortController();
      const onSignal = (): void => controller.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const request = resolveViewRequest({
          file,
          scene: options.scene,
          highlights: options.highlight,
          colors: options.color,
          colorBy: options.colorBy,
          label: options.label,
          bfactorIsPlddt: options.bfactorIsPlddt,
        });
        const result = await createStandaloneReport(request.file, {
          outputPath: options.output,
          signal: controller.signal,
          view: request.view,
        });
        const warnings: Array<{ code: string; message: string }> = [];
        let opened: boolean | undefined;
        if (options.open) {
          const outcome = await openInBrowser(result.path);
          opened = outcome.opened;
          if (!outcome.opened) {
            warnings.push({
              code: "OPEN_FAILED",
              message: `Could not open a browser: ${outcome.error ?? "unknown error"}. The report was saved.`,
            });
          }
        }
        if (options.json) {
          console.log(
            JSON.stringify(
              { status: "created", ...result, ...(opened === undefined ? {} : { opened }), warnings },
              null,
              2,
            ),
          );
        } else {
          console.log(`Report created: ${result.path}`);
          console.log(`Open in your browser: ${result.fileUrl}`);
          for (const w of warnings) console.error(`Warning: ${w.message}`);
        }
      } catch (error) {
        reportFailure(error, options.json);
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
    });
}
