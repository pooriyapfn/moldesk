import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { uninstallModel } from "@moldesk/core";
import type { RuntimeKind } from "@moldesk/core";

function parseRuntime(value: string): RuntimeKind {
  if (value === "python" || value === "docker") return value;
  throw new Error(`Invalid --runtime "${value}". Expected python|docker.`);
}

async function confirmUninstall(model: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Uninstall ${model} and its isolated environments? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall <model>")
    .description("Remove a model's managed installations (shared download cache is retained)")
    .option("--runtime <kind>", "remove only the selected python|docker runtime")
    .option("--all", "remove every installed runtime variant")
    .option("--yes", "uninstall without prompting")
    .option("--json", "print result as JSON")
    .action(async (model: string, options: { yes?: boolean; json?: boolean; runtime?: string; all?: boolean }) => {
      if (options.runtime && options.all) {
        const message = "Use either --runtime or --all, not both.";
        if (options.json) console.log(JSON.stringify({ model, status: "failed", message }, null, 2));
        else console.error(message);
        process.exitCode = 1;
        return;
      }
      if (!options.yes && !await confirmUninstall(model)) {
        if (options.json) console.log(JSON.stringify({ model, status: "cancelled" }, null, 2));
        else console.log("Uninstall cancelled. Re-run with --yes for non-interactive use.");
        return;
      }
      try {
        const removed = await uninstallModel(model, {
          runtime: options.runtime ? parseRuntime(options.runtime) : undefined,
          all: options.all,
        });
        const status = removed.length > 0 ? "uninstalled" : "not-installed";
        if (options.json) console.log(JSON.stringify({ model, status, removed }, null, 2));
        else console.log(removed.length > 0 ? `${model}: uninstalled ${removed.length} environment(s).` : `${model} is not installed.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) console.log(JSON.stringify({ model, status: "failed", message }, null, 2));
        else console.error(`Uninstall failed: ${message}`);
        process.exitCode = 1;
      }
    });
}
