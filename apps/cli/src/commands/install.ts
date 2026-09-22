import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  MoldeskError,
  createInstallationPlan,
  evaluateCompatibility,
  getSystemReport,
  installModel,
  isImageCachedLocally,
  listAvailableModels,
  probeDockerGpuAccess,
  pullDockerImage,
  requiresInstallConfirmation,
} from "@moldesk/core";
import type { RuntimeKind } from "@moldesk/core";
import { createProgressLine, failure, strong, success } from "../utils/ui.js";

// The underlying command's stderr (e.g. a Python build failure) is what actually
// explains an INSTALL_COMMAND_FAILED error — `error.message` alone is just
// "<command> failed with exit code N", so surface the tail of stderr too.
const FAILURE_DETAIL_MAX_LINES = 20;

function commandFailureDetail(error: unknown): string | undefined {
  if (!(error instanceof MoldeskError)) return undefined;
  const stderr = error.details?.["stderr"];
  if (typeof stderr !== "string" || !stderr.trim()) return undefined;
  const lines = stderr.trim().split(/\r?\n/);
  return lines.slice(-FAILURE_DETAIL_MAX_LINES).join("\n");
}

// A handful of build failures are common enough, and fixable enough, to call
// out by name instead of leaving the user to dig through --verbose output.
function knownFailureHint(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  if (detail.includes("Xcode license") || detail.includes("xcodebuild -license")) {
    return "This model needs to compile part of its code, which requires accepting Xcode's license. Run `sudo xcodebuild -license` in Terminal, accept it, then retry with --reinstall.";
  }
  return undefined;
}

// Pinned by digest (nvidia/cuda:12.4.1-base-ubuntu22.04), resolved via the
// Docker Registry HTTP API against a reachable daemon/registry.
const DOCKER_GPU_PROBE_IMAGE = "nvidia/cuda@sha256:0f6bfcbf267e65123bcc2287e2153dedfc0f24772fb5ce84afe16ac4b2fada95";
const PULL_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 10_000;

function parseRuntime(value: string): RuntimeKind {
  if (value === "python" || value === "docker") return value;
  console.error(`Invalid --runtime "${value}". Expected python|docker.`);
  process.exit(1);
  throw new Error("unreachable");
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function friendlyInstallProgress(
  step: string,
  percent?: number,
): string {
  const labels: Record<string, string> = {
    uv: "Preparing the installer",
    source: "Getting the model ready",
    python: "Creating a private workspace",
    dependencies: "Adding the model's requirements",
    asset: "Downloading model files",
    verify: "Checking everything works",
  };
  const label = labels[step] ?? "Preparing the model";
  return percent === undefined ? label : `${label} ${percent}%`;
}

async function confirmDownload(image: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Verifying Docker GPU access requires downloading ${image}. Continue? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function confirmInstallation(model: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Install ${model}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

type ConfirmationDecision =
  | { proceed: true }
  | { proceed: false; reason: "confirmation-required" | "cancelled" };

/**
 * Cost-aware confirmation gate: proceeds without asking for small, known-size,
 * non-destructive installs; otherwise prompts interactively, or — with no TTY,
 * `--json`, or `--yes` already declining — fails before any mutation happens.
 */
async function decideInstallConfirmation(
  displayName: string,
  needsConfirmation: boolean,
  options: { yes?: boolean; json?: boolean },
): Promise<ConfirmationDecision> {
  if (!needsConfirmation || options.yes) return { proceed: true };
  if (options.json || !process.stdin.isTTY || !process.stdout.isTTY) {
    return { proceed: false, reason: "confirmation-required" };
  }
  return (await confirmInstallation(displayName))
    ? { proceed: true }
    : { proceed: false, reason: "cancelled" };
}

/**
 * Tier 2: deterministically probe Docker GPU access, but only for the one
 * runtime candidate it could actually rescue — a docker runtime with
 * `gpu: "required"` that is otherwise fully compatible except for an
 * unverified GPU signal. Never runs for `gpu: "optional"`, never runs more
 * than once, and never runs at all from `doctor`/`list`.
 */
async function verifyDockerGpuAccess(
  options: { yes?: boolean; json?: boolean },
): Promise<"available" | "unavailable" | "skipped"> {
  const cached = await isImageCachedLocally(DOCKER_GPU_PROBE_IMAGE);
  if (!cached) {
    if (!options.yes) {
      // Can't prompt interactively in --json mode without a stdin TTY; require --yes there.
      if (options.json) return "skipped";
      const confirmed = await confirmDownload(DOCKER_GPU_PROBE_IMAGE);
      if (!confirmed) return "skipped";
    }
    const pullResult = await pullDockerImage(DOCKER_GPU_PROBE_IMAGE, undefined, { timeoutMs: PULL_TIMEOUT_MS });
    if (!pullResult.ok) {
      console.error(`Could not download ${DOCKER_GPU_PROBE_IMAGE} to verify GPU access: ${pullResult.error ?? "unknown error"}`);
      return "skipped";
    }
  }
  const probeResult = await probeDockerGpuAccess(DOCKER_GPU_PROBE_IMAGE, undefined, { timeoutMs: PROBE_TIMEOUT_MS });
  return probeResult.access;
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install <model>")
    .description("Download a model and get it ready to use")
    .option("--runtime <kind>", "choose an advanced runtime: python or docker")
    .option("--yes", "start without asking for confirmation")
    .option("--reinstall", "replace the current copy with a fresh installation")
    .option("--verbose", "show technical installation details")
    .option("--json", "print compatibility/plan result as JSON")
    .action(async (model: string, options: { runtime?: string; yes?: boolean; json?: boolean; reinstall?: boolean; verbose?: boolean }) => {
      const available = listAvailableModels();
      const manifest = available.find((m) => m.name === model);

      if (!manifest) {
        const message = `Unknown model "${model}". Run \`moldesk list\` to see available models.`;
        if (options.json) {
          console.log(JSON.stringify({ model, status: "unknown-model", message }, null, 2));
        } else {
          console.error(message);
        }
        process.exitCode = 1;
        return;
      }

      const requestedRuntime = options.runtime ? parseRuntime(options.runtime) : undefined;
      let report = await getSystemReport();
      let compatibility = evaluateCompatibility(manifest, report, { requestedRuntime });

      // Deterministic Tier 2: only for the single docker+gpu:required candidate
      // that would otherwise be selected if GPU access were verified.
      if (!requestedRuntime || requestedRuntime === "docker") {
        const rescuable = compatibility.runtimes.find(
          (rt) =>
            rt.kind === "docker" &&
            rt.status === "unsupported" &&
            rt.reasons.length > 0 &&
            rt.reasons.every((r) => r.code === "DOCKER_GPU_UNVERIFIED"),
        );
        if (rescuable) {
          const verified = await verifyDockerGpuAccess(options);
          if (verified !== "skipped") {
            report = await getSystemReport({ dockerGpuAccess: verified });
            compatibility = evaluateCompatibility(manifest, report, { requestedRuntime });
          }
        }
      }

      if (compatibility.status === "unsupported") {
        const primaryReason = compatibility.runtimes.flatMap((candidate) => candidate.reasons)[0];
        if (options.json) {
          console.log(
            JSON.stringify({ model, status: "unsupported", compatibility }, null, 2),
          );
        } else {
          console.error(failure(`✗ ${manifest.displayName} cannot be installed on this computer.`));
          if (primaryReason) {
            console.error(`  ${primaryReason.message}`);
            if (primaryReason.remediation) console.error(`  ${primaryReason.remediation}`);
          }
          if (options.verbose) {
            console.error("\nTechnical details:");
            for (const rt of compatibility.runtimes) {
              console.error(`  [${rt.kind}] ${rt.status}`);
              for (const r of rt.reasons) {
                console.error(`    ${r.code}: ${r.message}${r.remediation ? ` — ${r.remediation}` : ""}`);
              }
            }
          }
          console.error("  Nothing was changed.");
        }
        process.exitCode = 1;
        return;
      }

      const runtime = manifest.runtimes.find((candidate) => candidate.kind === compatibility.selectedRuntime);
      if (!runtime) {
        console.error(`Cannot resolve selected runtime for "${model}".`);
        process.exitCode = 1;
        return;
      }

      let planned;
      try {
        planned = await createInstallationPlan(manifest, runtime);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) {
          console.log(JSON.stringify({ model, status: compatibility.status, selectedRuntime: runtime.kind, compatibility, installable: false, message }, null, 2));
        } else {
          console.error(message);
        }
        process.exitCode = 1;
        return;
      }

      const payload = {
        model,
        status: compatibility.status,
        selectedRuntime: runtime.kind,
        compatibility,
        alreadyInstalled: planned.alreadyInstalled,
        reinstall: options.reinstall ?? false,
        targetDir: planned.targetDir,
        estimatedDownloadBytes: planned.estimatedDownloadBytes,
        estimatedDiskBytes: planned.estimatedDiskBytes,
        steps: planned.plan.steps,
      };

      // An identical fingerprint that's already installed and not being replaced is a
      // successful no-op below — nothing will be mutated, so there is nothing to confirm.
      const isNoop = planned.alreadyInstalled && !options.reinstall;
      const destructive = Boolean(options.reinstall) && planned.alreadyInstalled;
      const needsConfirmation = !isNoop && requiresInstallConfirmation(
        {
          downloadBytes: planned.estimatedDownloadBytes,
          downloadSizeUnknown: planned.downloadSizeUnknown,
          diskBytes: planned.estimatedDiskBytes,
          diskSizeUnknown: planned.diskSizeUnknown,
        },
        { destructive },
      );

      if (!options.json) {
        console.log(strong(`Installing ${manifest.displayName}`));
        if (!isNoop) {
          const download = planned.downloadSizeUnknown ? "size not available" : formatBytes(planned.estimatedDownloadBytes);
          const disk = planned.diskSizeUnknown ? "size not available" : formatBytes(planned.estimatedDiskBytes);
          console.log(`  Download ${download}  •  Disk space ${disk}`);
        }
        if (options.verbose) {
          console.log(`  Method: ${runtime.kind}`);
          console.log(`  Location: ${planned.targetDir}`);
          for (const [index, step] of planned.plan.steps.entries()) console.log(`  ${index + 1}. ${step.description}`);
        }
        console.log("");
      }

      const decision = await decideInstallConfirmation(manifest.displayName, needsConfirmation, options);
      if (!decision.proceed) {
        if (decision.reason === "confirmation-required") {
          const message = `Installing ${manifest.displayName} requires confirmation (large or unknown-size download/disk use, or a destructive reinstall). Re-run with --yes.`;
          if (options.json) console.log(JSON.stringify({ ...payload, status: "confirmation-required", message }, null, 2));
          else console.error(message);
          process.exitCode = 1;
        } else {
          if (options.json) console.log(JSON.stringify({ ...payload, status: "cancelled" }, null, 2));
          else console.log("Installation cancelled. Re-run with --yes for non-interactive use.");
        }
        return;
      }

      const progressLine = createProgressLine();
      try {
        const result = await installModel(planned, {
          reinstall: options.reinstall,
          onProgress: options.json ? undefined : (progress) => {
            const percent = progress.receivedBytes !== undefined && progress.totalBytes
              ? Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100))
              : undefined;
            const message = options.verbose
              ? `${progress.message}${percent === undefined ? "" : ` ${percent}%`}`
              : friendlyInstallProgress(progress.step, percent);
            progressLine.update(message);
          },
        });
        progressLine.finish();
        if (options.json) console.log(JSON.stringify({ ...payload, status: result.status, installation: result.installation }, null, 2));
        else if (result.status === "already-installed") console.log(success(`✓ ${manifest.displayName} is already installed.`));
        else if (result.status === "reinstalled") console.log(success(`✓ ${manifest.displayName} is updated and ready.`));
        else console.log(success(`✓ ${manifest.displayName} is ready.`));
      } catch (error) {
        progressLine.finish();
        const message = error instanceof Error ? error.message : String(error);
        const detail = commandFailureDetail(error);
        const hint = knownFailureHint(detail);
        if (options.json) {
          console.log(JSON.stringify({ ...payload, status: "failed", message, detail, hint }, null, 2));
        } else {
          console.error(failure(`✗ We couldn't install ${manifest.displayName}.`));
          if (hint) console.error(`  ${hint}`);
          else if (error instanceof MoldeskError && error.remediation) console.error(`  ${error.remediation}`);
          else console.error("  Try again. If this keeps happening, add --verbose for details.");
          if (options.verbose) {
            console.error(`\nTechnical details: ${message}`);
            if (detail) console.error(detail);
          }
        }
        process.exitCode = 1;
      }
    });
}
