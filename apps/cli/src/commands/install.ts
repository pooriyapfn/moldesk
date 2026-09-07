import type { Command } from "commander";
import { listAvailableModels } from "@moldesk/core";

export function registerInstallCommand(program: Command): void {
  program
    .command("install <model>")
    .description("Install a model (coming soon)")
    .action((model: string) => {
      const available = listAvailableModels();
      const manifest = available.find((m) => m.name === model);

      if (!manifest) {
        console.error(`Unknown model "${model}". Run \`moldesk list\` to see available models.`);
        process.exitCode = 1;
        return;
      }

      console.log(`Installing "${model}" is not yet supported.`);
      console.log("Track progress at https://github.com/pooriyapfn/moldesk");
    });
}
