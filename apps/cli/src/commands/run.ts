import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import { MoldeskError, runModel, type RuntimeKind } from "@moldesk/core";
import { assertNoCloudFlagsForLocal, runCloudCommand, type CloudRunHooks } from "./run-cloud.js";

function parseRuntime(value: string): RuntimeKind {
  if (value === "python" || value === "docker") return value;
  console.error(`Invalid --runtime "${value}". Expected python|docker.`);
  process.exit(2);
  throw new Error("unreachable");
}

function collectParam(value: string, previous: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0) {
    console.error(`Invalid --param "${value}". Expected key=value.`);
    process.exit(2);
  }
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
}

/**
 * Maps `MoldeskError.code` for usage errors thrown *before* a run directory is
 * allocated (spec §4.2 steps 1-3). Run outcomes (succeeded/failed/cancelled)
 * never throw — their exit code (0/7/8) comes from `result.status` instead.
 */
const EXIT_CODES: Record<string, number> = {
  UNKNOWN_MODEL: 3,
  ADAPTER_NOT_FOUND: 3,
  MODEL_NOT_INSTALLED: 5,
  INVALID_RUN_PARAMS: 2,
  INVALID_RUN_INPUT: 2,
  RUN_RUNTIME_SELECTION_REQUIRED: 2,
  RUNTIME_EXECUTION_UNSUPPORTED: 4,
};

function exitCodeFor(error: unknown): number {
  if (error instanceof MoldeskError && error.code in EXIT_CODES) return EXIT_CODES[error.code];
  return 10;
}

export function registerRunCommand(program: Command, cloudHooks: CloudRunHooks = {}): void {
  program
    .command("run <model> <input>")
    .description("Run a model against an input file")
    .option("--output <directory>", "copy declared outputs to this directory")
    .option("--runtime <kind>", "select runtime python|docker (no silent fallback)")
    .option("--param <key=value>", "set a model parameter (repeatable)", collectParam, {} as Record<string, string>)
    .option("--no-visualize", "skip creating the offline molecular report")
    .option("--json", "print the run result as JSON")
    .option("--compute <kind>", "where to run: local (default) or runpod", "local")
    .option("--cache-policy <policy>", "cloud: ephemeral (nothing retained) or persistent (a billed volume is kept)")
    .option("--gpu <id>", "cloud: GPU type id (default: cheapest eligible)")
    .option("--datacenter <id>", "cloud: datacenter id")
    .option("--max-budget <usd>", "cloud: maximum budget in USD (a guard on the quote, not a provider cap)")
    .option("--max-lifetime <seconds>", "cloud: lifetime limit in seconds, enforced by MoleculeDesk only while it is running and connected (shutdown is not guaranteed)")
    .option("--yes", "cloud: approve exactly the quote shown (required without a terminal)")
    .option("--accept-lifetime-risk", "cloud: acknowledge that machines may keep running and charging if MoleculeDesk closes or disconnects")
    .option("--accept-storage-charges", "cloud: acknowledge that a persistent cache keeps billing until you delete it")
    .option("--dry-run", "cloud: print the quote and exit without uploading or provisioning")
    .action(
      async (
        model: string,
        input: string,
        options: {
          output?: string;
          runtime?: string;
          param: Record<string, string>;
          json?: boolean;
          visualize?: boolean;
          compute: string;
          cachePolicy?: string;
          gpu?: string;
          datacenter?: string;
          maxBudget?: string;
          maxLifetime?: string;
          yes?: boolean;
          dryRun?: boolean;
          acceptLifetimeRisk?: boolean;
          acceptStorageCharges?: boolean;
        },
      ) => {
        if (options.compute !== "local") {
          await runCloudCommand(model, input, options, cloudHooks);
          return;
        }
        try {
          assertNoCloudFlagsForLocal(options);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 2;
          return;
        }
        const runtime = options.runtime ? parseRuntime(options.runtime) : undefined;
        const controller = new AbortController();
        const onSignal = (): void => controller.abort();
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        try {
          const result = await runModel(model, input, {
            runtime,
            params: options.param,
            outputDir: options.output,
            visualize: options.visualize,
            signal: controller.signal,
            onLog: options.json
              ? undefined
              : (stream, chunk) => (stream === "stdout" ? process.stdout : process.stderr).write(chunk),
          });

          if (options.json) {
            console.log(JSON.stringify({ model, ...result }, null, 2));
          } else {
            console.log(`${result.record.model}: ${result.status}.`);
            for (const output of result.record.outputs) console.log(`  ${output.id}: ${output.path}`);
            for (const artifact of result.record.artifacts ?? []) {
              console.log(`  report: ${artifact.path}`);
              console.log(`  Open in your browser: ${pathToFileURL(artifact.path).href}`);
            }
            for (const warning of result.record.warnings ?? []) console.error(`  Warning (${warning.code}): ${warning.message}`);
            if (result.record.error) console.error(`  ${result.record.error.code}: ${result.record.error.message}`);
            if (result.exportError) console.error(`  --output copy failed: ${result.exportError.message}`);
            console.log(`  Run directory: ${result.record.command.cwd}`);
          }

          if (result.status === "cancelled") process.exitCode = 8;
          else if (result.status === "failed" || result.exportError) process.exitCode = 7;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (options.json) {
            console.log(
              JSON.stringify(
                { model, status: "error", message, code: error instanceof MoldeskError ? error.code : undefined },
                null,
                2,
              ),
            );
          } else {
            console.error(message);
          }
          process.exitCode = exitCodeFor(error);
        } finally {
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
        }
      },
    );
}
