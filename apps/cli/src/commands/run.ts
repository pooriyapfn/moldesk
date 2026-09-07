import type { Command } from "commander";

export function registerRunCommand(program: Command): void {
  program
    .command("run <model> <input>")
    .description("Run a model against an input file (coming soon)")
    .action((model: string, input: string) => {
      console.log(`Running "${model}" on "${input}" is not yet supported.`);
      console.log("Track progress at https://github.com/pooriyapfn/moldesk");
    });
}
