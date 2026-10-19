import { pathToFileURL } from "node:url";
import {
  MoldeskError,
  createRunpodCloudDeps,
  planCloudRun,
  runModel,
  type CloudAcknowledgment,
  type CloudPlan,
  type CloudQuote,
  type CloudRunDeps,
  type RunModelResult,
} from "@moldesk/core";
import { confirm } from "../utils/confirm.js";
import { cloudExitCode, cloudExitCodeForCode } from "./cloud.js";

export interface CloudRunFlags {
  compute: string;
  cachePolicy?: string;
  gpu?: string;
  maxGpuPrice?: string;
  gpuImage?: string;
  cpuImage?: string;
  datacenter?: string;
  maxBudget?: string;
  maxLifetime?: string;
  yes?: boolean;
  dryRun?: boolean;
  acceptLifetimeRisk?: boolean;
  acceptStorageCharges?: boolean;
  acceptFileUpload?: boolean;
  output?: string;
  runtime?: string;
  param: Record<string, string>;
  json?: boolean;
  visualize?: boolean;
}

export interface CloudRunHooks {
  /** Injected for tests; production resolves Runpod wiring from the credential store. */
  deps?: () => Promise<CloudRunDeps>;
  confirm?: (question: string) => Promise<boolean>;
  interactive?: boolean;
}

function usage(code: string, message: string, remediation: string): MoldeskError {
  return new MoldeskError({ code, message, remediation });
}

const ACCEPT_FLAG: Record<CloudAcknowledgment, string> = {
  "lifetime-risk": "--accept-lifetime-risk",
  "storage-charges": "--accept-storage-charges",
  "upload-files": "--accept-file-upload",
};

function acceptedByFlag(id: CloudAcknowledgment, flags: Partial<CloudRunFlags>): boolean {
  if (id === "lifetime-risk") return flags.acceptLifetimeRisk === true;
  if (id === "storage-charges") return flags.acceptStorageCharges === true;
  return flags.acceptFileUpload === true;
}

/** Printed first and again at the prompt: there is no independent shutdown service. */
export function formatWarnings(quote: CloudQuote): string {
  const bar = "!".repeat(72);
  return [bar, "WARNING: READ BEFORE APPROVING", ...quote.warnings.flatMap((warning) => ["", warning.text]), "", bar].join("\n");
}

export function formatQuote(quote: CloudQuote): string {
  const money = (value: number): string => `$${value.toFixed(value < 1 ? 4 : 2)}`.replace(/\.?0+$/, (zeros) => (zeros.includes(".") ? "" : zeros));
  const lines = [
    formatWarnings(quote),
    "",
    `Cloud quote (${quote.provider}, prices as of ${quote.retrievedAt})`,
    `  Model:        ${quote.model} ${quote.modelVersion}`,
    `  GPU:          ${quote.gpu.name} (${quote.gpu.memoryGb} GB) in ${quote.datacenterId} at ${money(quote.gpu.priceUsdPerHour)}/h (first choice)`,
    quote.gpuRange.pinnedGpuId
      ? `  GPU range:    only ${quote.gpuRange.pinnedGpuId} (pinned with --gpu); no substitute is used`
      : `  GPU range:    if unavailable, any available ${quote.gpuRange.allowedGpuIds ? "validated " : ""}GPU >= ${quote.gpuRange.minVramGb} GB up to ${money(quote.gpuRange.maxUsdPerHour)}/h${quote.gpuRange.lockDatacenter ? ` in ${quote.datacenterId}` : ""}: ${quote.gpuRange.candidates.map((c) => `${c.name} ${money(c.priceUsdPerHour)}`).join(", ")}`,
    ...(quote.cpu ? [`  Prep CPU:     ${quote.cpu.id} x${quote.cpu.vcpuCount} at ${money(quote.cpu.priceUsdPerHour)}/h (asset preparation only)`] : []),
    `  Images:       gpu ${quote.images.gpu}${quote.cpu ? `; cpu ${quote.images.cpu}` : ""}`,
    `  Cache policy: ${quote.cachePolicy}`,
    `  Limits:       lifetime ${quote.maxLifetimeSeconds}s, budget ${money(quote.maxBudgetUsd)}`,
    `  Compute:      worst case ${money(quote.cost.worstCaseComputeUsd)} (hourly rate x lifetime limit; a ceiling for this estimate, not a provider-enforced spend cap)`,
    `  Temp storage: ${quote.cost.temporaryStorage.worstCaseUsd === null ? `container disk ${quote.cost.temporaryStorage.diskGb} GB x ${quote.cost.temporaryStorage.machines} machine(s): cost unknown (rate not published)` : `container disk worst case ${money(quote.cost.temporaryStorage.worstCaseUsd)}`}`,
    `  Retained:     ${quote.cost.recurringStorage.recurring ? `${quote.cost.recurringStorage.volumeGb} GB network volume kept until you delete it; ${quote.cost.recurringStorage.usdPerMonth === null ? "monthly cost unknown (rate not published)" : `about ${money(quote.cost.recurringStorage.usdPerMonth)}/month`}` : "nothing is kept after the run"}`,
    `  Budget:       ${money(quote.maxBudgetUsd)} is checked against ${money(quote.cost.worstCaseBudgetedUsd)}`,
    `    counts:     ${quote.budgetCoverage.counted.join("; ")}`,
    `    NOT counted: ${quote.budgetCoverage.notCounted.join("; ")}`,
    ...(quote.budgetCoverage.unknown.length > 0 ? [`    unknown:    ${quote.budgetCoverage.unknown.join("; ")}`] : []),
    `  Timing:       no measured estimate available`,
    `  Upload:       ${quote.upload.files} file(s), ${quote.upload.bytes} bytes`,
    ...quote.upload.items.map((item) => `    ${item.role === "job" ? "input" : item.role}: ${item.localPath ?? item.fileName} (${item.sizeBytes} bytes, sha256 ${item.sha256.slice(0, 12)}...)`),
    ...quote.disclosures.map((line) => `  - ${line}`),
  ];
  return lines.join("\n");
}

function parseBudget(raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value <= 0) throw usage("CLOUD_BUDGET_REQUIRED", "A positive --max-budget (USD) is required.", "Pass --max-budget <usd>.");
  return value;
}

function parseGpuPrice(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw usage("CLOUD_GPU_PRICE_RANGE_INVALID", "--max-gpu-price must be a positive USD amount per hour.", "Pass --max-gpu-price <usd-per-hour>.");
  return value;
}

function parseLifetime(raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value <= 0) throw usage("CLOUD_LIFETIME_REQUIRED", "A positive integer --max-lifetime (seconds) is required.", "Pass --max-lifetime <seconds>.");
  return value;
}

/** Rejects cloud-only flags on a local run, before anything happens. */
export function assertNoCloudFlagsForLocal(flags: Partial<CloudRunFlags>): void {
  const used: Array<readonly [string, string | undefined]> = (
    [
      ["--cache-policy", flags.cachePolicy],
      ["--gpu", flags.gpu],
      ["--max-gpu-price", flags.maxGpuPrice],
      ["--gpu-image", flags.gpuImage],
      ["--cpu-image", flags.cpuImage],
      ["--datacenter", flags.datacenter],
      ["--max-budget", flags.maxBudget],
      ["--max-lifetime", flags.maxLifetime],
    ] as const
  ).filter(([, value]) => value !== undefined);
  if (flags.yes || flags.dryRun || flags.acceptLifetimeRisk || flags.acceptStorageCharges || flags.acceptFileUpload) used.push(["--yes/--dry-run/--accept-*", "set"]);
  if (used.length > 0) {
    throw usage("CLOUD_OPTIONS_WITHOUT_CLOUD", `${used.map(([name]) => name).join(", ")} only apply with --compute runpod.`, "Add --compute runpod, or remove those options.");
  }
}

export async function runCloudCommand(model: string, input: string, flags: CloudRunFlags, hooks: CloudRunHooks = {}): Promise<void> {
  const out = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
  try {
    if (flags.compute !== "runpod") throw usage("CLOUD_OPTIONS_REQUIRED", `Unsupported --compute "${flags.compute}".`, "Expected local|runpod.");
    if (flags.runtime === "docker") throw usage("CLOUD_RUNTIME_UNSUPPORTED", "The docker runtime is not supported for cloud execution.", "Use the python runtime.");
    if (flags.cachePolicy !== "ephemeral" && flags.cachePolicy !== "persistent") {
      throw usage("CLOUD_OPTIONS_REQUIRED", "--cache-policy ephemeral|persistent is required for cloud runs.", "Choose ephemeral (nothing retained) or persistent (a billed volume is kept).");
    }
    const cachePolicy: "ephemeral" | "persistent" = flags.cachePolicy;
    const quoteOptions = {
      cachePolicy,
      ...(flags.gpu ? { gpuId: flags.gpu } : {}),
      ...(flags.datacenter ? { datacenterId: flags.datacenter } : {}),
      ...(flags.maxGpuPrice !== undefined ? { maxGpuUsdPerHour: parseGpuPrice(flags.maxGpuPrice) } : {}),
      ...(flags.gpuImage ? { gpuImage: flags.gpuImage } : {}),
      ...(flags.cpuImage ? { cpuImage: flags.cpuImage } : {}),
      maxBudgetUsd: parseBudget(flags.maxBudget),
      maxLifetimeSeconds: parseLifetime(flags.maxLifetime),
    };

    const deps = await (hooks.deps ?? (() => createRunpodCloudDeps()))();
    const plan: CloudPlan = await planCloudRun(model, input, { params: flags.param, cloud: quoteOptions }, deps);

    if (flags.json) {
      if (flags.dryRun) return out({ status: "quote", quote: plan.quote });
    } else {
      console.error(formatQuote(plan.quote));
      if (flags.dryRun) return void console.error("\nDry run: nothing was uploaded or provisioned.");
    }

    const interactive = hooks.interactive ?? (process.stdin.isTTY === true);
    const ask = hooks.confirm ?? ((question: string) => confirm(question));
    const canPrompt = interactive || hooks.confirm !== undefined;

    // Each warning needs its own explicit acknowledgment: a flag, or an answered prompt. `--yes` alone never counts.
    const acknowledged: CloudAcknowledgment[] = [];
    for (const warning of plan.quote.warnings) {
      const flagged = acceptedByFlag(warning.id, flags);
      if (flagged) {
        acknowledged.push(warning.id);
        continue;
      }
      if (!canPrompt) {
        throw usage(
          "CLOUD_ACKNOWLEDGMENT_REQUIRED",
          `You must acknowledge: ${warning.text}`,
          `Re-run with ${ACCEPT_FLAG[warning.id]} (and --yes) to accept without a terminal.`,
        );
      }
      console.error(`\n${warning.text}`);
      if (!(await ask(warning.id === "upload-files" ? "Copy these files to Runpod?" : "Do you understand and accept this risk?"))) {
        if (flags.json) out({ status: "declined", quoteId: plan.quote.id, reason: `warning not acknowledged: ${warning.id}` });
        else console.error("Not acknowledged. Nothing was uploaded or provisioned.");
        process.exitCode = 2;
        return;
      }
      acknowledged.push(warning.id);
    }

    let approved = flags.yes === true;
    if (!approved) {
      if (!canPrompt) {
        throw usage("CLOUD_APPROVAL_MISMATCH", "This quote needs your approval, and no terminal is attached.", "Review it with --dry-run, then re-run with --yes to approve exactly this quote.");
      }
      approved = await ask("Approve this quote and start the cloud run?");
      if (!approved) {
        if (flags.json) out({ status: "declined", quoteId: plan.quote.id });
        else console.error("Not approved. Nothing was uploaded or provisioned.");
        process.exitCode = 2;
        return;
      }
    }

    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    let result: RunModelResult;
    try {
      result = await runModel(model, input, {
        compute: "runpod",
        params: flags.param,
        outputDir: flags.output,
        visualize: flags.visualize,
        signal: controller.signal,
        cloudDeps: deps,
        cloud: { ...quoteOptions, quote: plan.quote, approval: { quoteId: plan.quote.id, approvedAt: new Date().toISOString(), acknowledged } },
        onLog: flags.json ? undefined : (stream, chunk) => (stream === "stdout" ? process.stdout : process.stderr).write(chunk),
        onProgress: flags.json ? undefined : (event) => console.error(`[${event.stage}]${event.message ? ` ${event.message}` : ""}`),
      });
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }

    if (flags.json) {
      out({ model, ...result });
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
      if (result.record.compute?.hardware) console.log(`  Ran on: ${result.record.compute.hardware.name} (${result.record.compute.datacenterId})`);
      console.log(`  Run directory: ${result.record.command.cwd}`);
      console.log(`  Logs: ${result.record.logs.stdout} and ${result.record.logs.stderr}`);
    }

    if (result.cleanupPending) {
      const ids = result.cleanupPending.resources.map((resource) => `${resource.role} ${resource.providerId}`).join(", ");
      console.error(`CLOUD_CLEANUP_PENDING: these paid resources could not be confirmed deleted: ${ids}.`);
      console.error(`Run \`moldesk cloud recover ${result.record.id}\` and check \`moldesk cloud resources\`.`);
      process.exitCode = 13;
    } else if (result.status === "cancelled") process.exitCode = 8;
    else if (result.status === "failed" || result.exportError) process.exitCode = cloudExitCodeForCode(result.record.error?.code) ?? 7;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof MoldeskError ? error.code : undefined;
    const remediation = error instanceof MoldeskError ? error.remediation : undefined;
    if (flags.json) out({ model, status: "error", message, code, remediation });
    else {
      console.error(message);
      if (remediation) console.error(remediation);
    }
    process.exitCode = cloudExitCode(error);
  }
}
