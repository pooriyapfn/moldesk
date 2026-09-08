import type { Command } from "commander";
import {
  evaluateCompatibility,
  getSystemReport,
  listAvailableModels,
  listInstalledModels,
  shortReason,
} from "@moldesk/core";
import type { RuntimeKind } from "@moldesk/core";

function parseRuntime(value: string): RuntimeKind {
  if (value === "python" || value === "docker") return value;
  console.error(`Invalid --runtime "${value}". Expected python|docker.`);
  process.exit(1);
  throw new Error("unreachable");
}

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List available models with compatibility")
    .option("--json", "print raw manifests + compatibility results as JSON")
    .option("--runtime <kind>", "constrain compatibility selection to python|docker")
    .option("--installed", "show installed models only (Step 3 provides state)")
    .action(async (options: { json?: boolean; runtime?: string; installed?: boolean }) => {
      try {
        const requestedRuntime = options.runtime ? parseRuntime(options.runtime) : undefined;
        const available = listAvailableModels();
        const installed = listInstalledModels();
        const installedNames = new Set(installed.map((m) => m.name));

        if (options.installed) {
          if (options.json) {
            console.log(JSON.stringify({ installed }, null, 2));
            return;
          }
          if (installed.length === 0) {
            console.log("No models installed yet.");
            return;
          }
          for (const model of installed) {
            console.log(`  ${model.name} ${model.modelVersion}`);
          }
          return;
        }

        if (available.length === 0) {
          if (options.json) {
            console.log(JSON.stringify([], null, 2));
            return;
          }
          console.log("No models found in the registry.");
          return;
        }

        const report = await getSystemReport();
        const rows = available.map((manifest) => {
          const compatibility = evaluateCompatibility(manifest, report, { requestedRuntime });
          return { manifest, compatibility };
        });

        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        const header = `${"MODEL".padEnd(14)} ${"CATEGORY".padEnd(21)} ${"STATUS".padEnd(11)} COMPATIBILITY`;
        console.log(header);
        for (const { manifest, compatibility } of rows) {
          const installedMark = installedNames.has(manifest.name) ? "*" : " ";
          const compat =
            compatibility.status === "compatible"
              ? "compatible"
              : compatibility.status === "warning"
                ? `warning: ${shortReason(compatibility)}`
                : manifest.status === "planned"
                  ? "not installable"
                  : `unsupported: ${shortReason(compatibility)}`;
          console.log(
            `${installedMark}${manifest.name.padEnd(13)} ${manifest.category.padEnd(21)} ${manifest.status.padEnd(11)} ${compat}`,
          );
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
