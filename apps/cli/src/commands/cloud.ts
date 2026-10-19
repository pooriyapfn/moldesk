import type { Command } from "commander";
import {
  MoldeskError,
  connectCloudProvider,
  createRunpodCloudDeps,
  disconnectCloudProvider,
  executeCloudCacheDeletion,
  getCloudStatus,
  listCloudCaches,
  listCloudResources,
  planCloudCacheDeletion,
  recoverCloudRun,
  type CloudAccountDeps,
  type CloudRunDeps,
} from "@moldesk/core";
import { confirm } from "../utils/confirm.js";
import { readSecret } from "../utils/secret-input.js";

/** Cloud exit codes live beside the run codes (0/7/8 outcomes, 2-5 usage). */
const CLOUD_EXIT_CODES: Record<string, number> = {
  CREDENTIAL_UNSUPPORTED_PROVIDER: 2,
  CREDENTIAL_INVALID: 2,
  CREDENTIAL_MISSING: 11,
  CLOUD_AUTH_FAILED: 11,
  CLOUD_FORBIDDEN: 11,
  CREDENTIAL_STORE_UNAVAILABLE: 11,
  CLOUD_PAYMENT_REQUIRED: 12,
  CLOUD_RATE_LIMITED: 12,
  CLOUD_CAPACITY_UNAVAILABLE: 12,
  CLOUD_UNAVAILABLE: 12,
  CLOUD_BUDGET_REQUIRED: 2,
  CLOUD_LIFETIME_REQUIRED: 2,
  CLOUD_BUDGET_EXCEEDED: 2,
  CLOUD_GPU_UNKNOWN: 2,
  CLOUD_GPU_INELIGIBLE: 2,
  CLOUD_GPU_PRICE_RANGE_INVALID: 2,
  CLOUD_IMAGE_INVALID: 2,
  CLOUD_OPTIONS_REQUIRED: 2,
  CLOUD_OPTIONS_WITHOUT_CLOUD: 2,
  CLOUD_RUNTIME_UNSUPPORTED: 2,
  CLOUD_COMPANION_LIMIT: 2,
  CLOUD_MODEL_UNSUPPORTED: 4,
  // Consent and safety refusals: nothing was provisioned.
  CLOUD_APPROVAL_MISMATCH: 14,
  CLOUD_APPROVAL_EXPIRED: 14,
  CLOUD_REQUOTE_REQUIRED: 14,
  CLOUD_ACKNOWLEDGMENT_REQUIRED: 14,
  CLOUD_WORKER_BUNDLE_UNCONFIGURED: 14,
  CLOUD_WORKER_BUNDLE_INVALID: 14,
  CLOUD_UNRESOLVED_RESOURCES: 13,
  CLOUD_RUN_UNKNOWN: 2,
  CLOUD_CACHE_IN_USE: 2,
};

/** Exit code for a cloud error code that is more specific than "run failed" (7), or undefined. */
export function cloudExitCodeForCode(code: string | undefined): number | undefined {
  return code !== undefined && code in CLOUD_EXIT_CODES && CLOUD_EXIT_CODES[code]! >= 11 ? CLOUD_EXIT_CODES[code] : undefined;
}

export function cloudExitCode(error: unknown): number {
  return error instanceof MoldeskError && error.code in CLOUD_EXIT_CODES ? CLOUD_EXIT_CODES[error.code]! : 10;
}

function report(error: unknown, json: boolean | undefined): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof MoldeskError ? error.code : undefined;
  const remediation = error instanceof MoldeskError ? error.remediation : undefined;
  if (json) console.log(JSON.stringify({ status: "error", code, message, remediation }, null, 2));
  else {
    console.error(message);
    if (remediation) console.error(remediation);
  }
  process.exitCode = cloudExitCode(error);
}

async function readKeyFromStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n[\s\S]*$/, "");
}

export interface CloudCommandHooks {
  /** Resolves provider/backend wiring for recover and cache commands; injected for tests. */
  runDeps?: () => Promise<CloudRunDeps>;
  confirm?: (question: string) => Promise<boolean>;
}

export function registerCloudCommand(program: Command, deps: CloudAccountDeps = {}, hooks: CloudCommandHooks = {}): void {
  const resolveRunDeps = hooks.runDeps ?? (() => createRunpodCloudDeps({ paths: deps.paths, store: deps.store }));
  const ask = hooks.confirm ?? ((question: string) => confirm(question));
  const cloud = program.command("cloud").description("Connect and inspect cloud compute accounts");

  cloud
    .command("connect <provider>")
    .description("Store a provider API key in the OS credential store after validating it")
    .option("--key-stdin", "read the key from standard input instead of prompting (never pass keys as arguments)")
    .option("--json", "print the result as JSON")
    .action(async (provider: string, options: { keyStdin?: boolean; json?: boolean }) => {
      try {
        if (!options.keyStdin && process.stdin.isTTY !== true) {
          throw new MoldeskError({
            code: "CREDENTIAL_INVALID",
            message: "No terminal is attached to prompt for the key.",
            remediation: "Run in a terminal, or pipe the key with --key-stdin.",
          });
        }
        const key = options.keyStdin
          ? await readKeyFromStdin()
          : await readSecret({ input: process.stdin, output: process.stderr, prompt: `${provider} API key (input hidden): ` });
        const result = await connectCloudProvider(provider, key.trim(), deps);
        if (options.json) console.log(JSON.stringify({ status: "connected", ...result }, null, 2));
        else {
          console.log(`Connected to ${provider}. Key stored in the OS credential store.`);
          if (result.overriddenBy) {
            console.log(`Note: a key from the environment still takes precedence over the stored key.`);
          }
        }
      } catch (error) {
        report(error, options.json);
      }
    });

  cloud
    .command("disconnect <provider>")
    .description("Remove the stored API key (an environment variable is left alone)")
    .option("--json", "print the result as JSON")
    .action(async (provider: string, options: { json?: boolean }) => {
      try {
        const result = await disconnectCloudProvider(provider, deps);
        if (options.json) console.log(JSON.stringify({ status: "ok", ...result }, null, 2));
        else console.log(result.removed ? `Removed the stored ${provider} key.` : `No stored ${provider} key to remove.`);
      } catch (error) {
        report(error, options.json);
      }
    });

  cloud
    .command("status")
    .description("Show credential source, live connection and unfinished cloud work")
    .option("--provider <name>", "cloud provider", "runpod")
    .option("--json", "print the result as JSON")
    .action(async (options: { provider: string; json?: boolean }) => {
      try {
        const status = await getCloudStatus(options.provider, deps);
        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(`Provider:    ${status.provider}`);
          console.log(`Credential:  ${status.credential.source === "none" ? "none (run `moldesk cloud connect " + status.provider + "`)" : status.credential.source}`);
          if (status.connection) {
            console.log(`Connection:  ${status.connection.ok ? "ok" : `failed (${status.connection.code}): ${status.connection.message}`}`);
          }
          console.log(`Open jobs:   ${status.journal.openJobs.length}`);
          console.log(`Unresolved resources: ${status.journal.unresolvedResources.length}`);
          for (const job of status.journal.openJobs) console.log(`  job ${job.runId}: ${job.stage} (${job.status}), deadline ${job.deadlineAt}`);
        }
        if (status.connection && !status.connection.ok) process.exitCode = cloudExitCode(new MoldeskError({ code: status.connection.code, message: status.connection.message }));
      } catch (error) {
        report(error, options.json);
      }
    });

  cloud
    .command("resources")
    .description("List cloud resources this installation owns, orphans and owed cleanup")
    .option("--provider <name>", "cloud provider", "runpod")
    .option("--json", "print the result as JSON")
    .action(async (options: { provider: string; json?: boolean }) => {
      try {
        const listing = await listCloudResources(options.provider, deps);
        if (options.json) {
          console.log(JSON.stringify(listing, null, 2));
          return;
        }
        console.log(`Owned by this installation (${listing.owned.length}):`);
        for (const entry of listing.owned) {
          const detail =
            entry.kind === "pod"
              ? `${entry.status}${entry.costUsdPerHour != null ? `, $${entry.costUsdPerHour}/h` : ""}`
              : `${entry.sizeGb} GB volume (retained storage is billed)`;
          console.log(`  ${entry.kind} ${entry.record.providerId}  ${entry.record.name}  ${detail}`);
        }
        if (listing.orphaned.length > 0) {
          console.log(`Orphaned (named like ours, no journal owner; not deleted automatically) (${listing.orphaned.length}):`);
          for (const entry of listing.orphaned) console.log(`  ${entry.providerId}  ${entry.name}`);
        }
        if (listing.cleanupOwed.length > 0) {
          console.log(`Cleanup owed (${listing.cleanupOwed.length}):`);
          for (const record of listing.cleanupOwed) console.log(`  ${record.providerId}  ${record.name}  ${record.state}`);
        }
        console.log(`Other resources on the account (not managed by MoleculeDesk): ${listing.unmanagedCount}`);
        const changed = listing.reconciliation;
        if (changed.adopted.length + changed.abandoned.length + changed.vanished.length > 0) {
          console.log(`Journal reconciled: ${changed.adopted.length} adopted, ${changed.abandoned.length} never created, ${changed.vanished.length} already gone.`);
        }
        if (listing.orphaned.length > 0 || listing.cleanupOwed.length > 0) process.exitCode = 13;
      } catch (error) {
        report(error, options.json);
      }
    });

  cloud
    .command("recover <run-id>")
    .description("Resume transfer and cleanup for an interrupted or failed cloud run (never restarts inference)")
    .option("--terminate", "also terminate a machine whose job is still running (loses unfinished results)")
    .option("--json", "print the result as JSON")
    .action(async (runId: string, options: { terminate?: boolean; json?: boolean }) => {
      try {
        const runDeps = await resolveRunDeps();
        const result = await recoverCloudRun(runId, runDeps, { terminateRunning: options.terminate });
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`Run ${result.runId}: ${result.status}${result.collected ? " (results downloaded and verified)" : ""}.`);
          if (result.cleanup.confirmed) console.log("Cloud resources: confirmed deleted.");
          else if (result.status === "running") console.log("The job is still running; its machine was left alone. Re-run with --terminate to stop it.");
          else console.error(`Cleanup still pending: ${result.cleanup.pending.map((resource) => `${resource.role} ${resource.providerId}`).join(", ")}.`);
        }
        if (!result.cleanup.confirmed) process.exitCode = 13;
      } catch (error) {
        report(error, options.json);
      }
    });

  const cache = cloud.command("cache").description("Inspect and delete retained model caches (billed network volumes)");

  cache
    .command("list")
    .description("List retained caches and whether their volumes still exist")
    .option("--json", "print the result as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const listing = await listCloudCaches(await resolveRunDeps());
        if (options.json) return void console.log(JSON.stringify(listing, null, 2));
        if (listing.length === 0) return void console.log("No retained caches.");
        for (const entry of listing) {
          const volume = entry.volumeExists === undefined ? "volume status unknown" : entry.volumeExists ? `volume ${entry.cache.volumeId}${entry.volumeSizeGb ? ` (${entry.volumeSizeGb} GB, billed)` : ""}` : "volume no longer exists";
          console.log(`${entry.cache.model} ${entry.cache.modelVersion}  ${entry.cache.state}  ${entry.cache.datacenterId}  ${volume}`);
        }
      } catch (error) {
        report(error, options.json);
      }
    });

  cache
    .command("delete <model>")
    .description("Delete the retained volume(s) holding a model's cache (billing stops)")
    .option("--yes", "skip the confirmation prompt")
    .option("--json", "print the result as JSON")
    .action(async (model: string, options: { yes?: boolean; json?: boolean }) => {
      try {
        const runDeps = await resolveRunDeps();
        const plan = await planCloudCacheDeletion(model, runDeps);
        if (plan.volumes.length === 0) {
          if (options.json) console.log(JSON.stringify({ status: "nothing-to-delete", model }, null, 2));
          else console.log(`No retained cache for ${model}.`);
          return;
        }
        if (!options.json) {
          console.error(`This permanently deletes ${plan.volumes.length} volume(s) and everything on them:`);
          for (const volume of plan.volumes) console.error(`  ${volume.volumeId}  ${volume.datacenterId}${volume.sizeGb ? `  ${volume.sizeGb} GB` : ""}`);
          for (const blocker of plan.blockers) console.error(`  Blocked: ${blocker}`);
        }
        if (plan.blockers.length === 0 && !options.yes) {
          if (!(await ask("Delete these volumes?"))) {
            if (options.json) console.log(JSON.stringify({ status: "declined", plan }, null, 2));
            else console.error("Not deleted.");
            process.exitCode = 2;
            return;
          }
        }
        const result = await executeCloudCacheDeletion(plan, runDeps);
        if (options.json) console.log(JSON.stringify({ status: result.failed.length > 0 ? "partial" : "deleted", ...result }, null, 2));
        else {
          for (const item of result.deleted) console.log(`Deleted volume ${item.volumeId}.`);
          for (const item of result.failed) console.error(`Could not delete ${item.volumeId}: ${item.reason}`);
        }
        if (result.failed.length > 0) process.exitCode = 12;
      } catch (error) {
        report(error, options.json);
      }
    });
}
