import type { Command } from "commander";
import { listAvailableModels, listInstalledModels } from "@moldesk/core";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List available and installed models")
    .action(() => {
      const available = listAvailableModels();
      const installed = listInstalledModels();
      const installedNames = new Set(installed.map((m) => m.name));

      if (available.length === 0) {
        console.log("No models found in the registry.");
        return;
      }

      console.log("Available models:\n");
      for (const model of available) {
        const status = installedNames.has(model.name) ? "installed" : "not installed";
        console.log(`  ${model.name.padEnd(12)} ${model.version.padEnd(10)} ${status}`);
      }
    });
}
