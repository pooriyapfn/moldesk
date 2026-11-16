import type { Command } from "commander";
import { openInBrowser } from "@moldesk/core";
import { startStudioServer } from "../studio/server.js";
import { reportFailure } from "../utils/report-errors.js";

interface StudioOptions {
  workspace: string;
  open?: boolean;
  json?: boolean;
}

export function registerStudioCommand(program: Command): void {
  program
    .command("studio")
    .description("Open a local loopback Studio for editing, planning and inspecting workflows")
    .requiredOption("--workspace <dir>", "directory whose YAML drafts and input files Studio may read")
    .option("--no-open", "do not open a browser")
    .option("--json", "print JSON")
    .action(async (options: StudioOptions) => {
      let studio: Awaited<ReturnType<typeof startStudioServer>> | undefined;
      const stop = async (): Promise<void> => {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        await studio?.close();
      };
      const onSignal = (): void => {
        void stop();
      };
      try {
        studio = await startStudioServer({ workspaceRoot: options.workspace });
        const warnings: Array<{ code: string; message: string }> = [];
        let opened: boolean | undefined;
        if (options.open !== false) {
          const outcome = await openInBrowser(studio.url);
          opened = outcome.opened;
          if (!outcome.opened) {
            warnings.push({ code: "OPEN_FAILED", message: `Could not open a browser: ${outcome.error ?? "unknown error"}` });
          }
        }
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                status: "ok",
                url: studio.url,
                workspaceRoot: studio.workspaceRoot,
                ...(opened === undefined ? {} : { opened }),
                warnings,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(`Studio listening at ${studio.url}`);
          console.log(`Workspace: ${studio.workspaceRoot}`);
          for (const warning of warnings) console.error(`Warning: ${warning.message}`);
          console.log("Press Ctrl+C to stop.");
        }
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        await new Promise<void>((resolve) => studio?.server.once("close", resolve));
      } catch (error) {
        reportFailure(error, options.json);
        await stop();
      }
    });
}
