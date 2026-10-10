import type { Command } from "commander";
import { createStandaloneReport, openInBrowser } from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

export function registerViewCommand(program: Command): void {
  program
    .command("view <file>")
    .description("Create an offline, interactive 3D report for a PDB or mmCIF file")
    .option("--output <file>", "write the report to this file (must not exist)")
    .option("--open", "open the report in your default browser")
    .option("--json", "print the result as JSON")
    .action(async (file: string, options: { output?: string; open?: boolean; json?: boolean }) => {
      const controller = new AbortController();
      const onSignal = (): void => controller.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const result = await createStandaloneReport(file, {
          outputPath: options.output,
          signal: controller.signal,
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
