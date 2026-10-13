import type { Command } from "commander";
import {
  MoldeskError,
  connectCloudProvider,
  disconnectCloudProvider,
  getCloudStatus,
  listCloudResources,
  type CloudAccountDeps,
} from "@moldesk/core";
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
};

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

export function registerCloudCommand(program: Command, deps: CloudAccountDeps = {}): void {
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
            console.log(`Note: a key from ${result.overriddenBy === "env" ? "the environment" : "a .env file"} still takes precedence over the stored key.`);
          }
        }
      } catch (error) {
        report(error, options.json);
      }
    });

  cloud
    .command("disconnect <provider>")
    .description("Remove the stored API key (environment and .env keys are left alone)")
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
}
