import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  createInstallationPlan,
  evaluateCompatibility,
  getSystemReport,
  installModel,
  isImageCachedLocally,
  listAvailableModels,
  probeDockerGpuAccess,
  pullDockerImage,
  requiresInstallConfirmation,
  shortReason,
} from "@moldesk/core";
import type { RuntimeKind } from "@moldesk/core";

// TODO: pin by digest (`docker manifest inspect nvidia/cuda:12.4.1-base-ubuntu22.04`)
// before release — kept as a tag here since resolving a real digest needs a
// reachable Docker daemon/registry, and fabricating one would be worse than
// a tag (a wrong digest fails every pull; a tag just isn't reproducible yet).
const DOCKER_GPU_PROBE_IMAGE = "nvidia/cuda:12.4.1-base-ubuntu22.04";
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
    .description("Install a model into an isolated, reproducible environment")
    .option("--runtime <kind>", "select runtime python|docker (no silent fallback)")
    .option("--yes", "accept downloads and installation without prompting")
    .option("--reinstall", "stage and atomically replace an existing installation")
    .option("--json", "print compatibility/plan result as JSON")
    .action(async (model: string, options: { runtime?: string; yes?: boolean; json?: boolean; reinstall?: boolean }) => {
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
        const reason = shortReason(compatibility);
        if (options.json) {
          console.log(
            JSON.stringify({ model, status: "unsupported", compatibility }, null, 2),
          );
        } else {
          console.error(`Cannot install "${model}": ${reason || "unsupported on this machine"}.`);
          for (const rt of compatibility.runtimes) {
            console.error(`  [${rt.kind}] ${rt.status}`);
            for (const r of rt.reasons) {
              console.error(`    ${r.code}: ${r.message}${r.remediation ? ` — ${r.remediation}` : ""}`);
            }
          }
          console.error("No files were written.");
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
        console.log(`Installation plan for ${manifest.displayName} (${runtime.kind}):`);
        for (const [index, step] of planned.plan.steps.entries()) console.log(`  ${index + 1}. ${step.description}`);
        console.log(`  Download: ${formatBytes(planned.estimatedDownloadBytes)}${planned.downloadSizeUnknown ? " (partly unknown)" : ""}`);
        console.log(`  Additional disk: ${formatBytes(planned.estimatedDiskBytes)}${planned.diskSizeUnknown ? " (unknown)" : ""}`);
        console.log(`  Target: ${planned.targetDir}`);
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

      try {
        const result = await installModel(planned, {
          reinstall: options.reinstall,
          onProgress: options.json ? undefined : (progress) => {
            if (progress.receivedBytes !== undefined && progress.totalBytes) {
              const percent = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
              console.log(`  [${progress.step}] ${progress.message} (${percent}%)`);
            } else {
              console.log(`  [${progress.step}] ${progress.message}`);
            }
          },
        });
        if (options.json) console.log(JSON.stringify({ ...payload, status: result.status, installation: result.installation }, null, 2));
        else console.log(`${manifest.displayName}: ${result.status}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) console.log(JSON.stringify({ ...payload, status: "failed", message }, null, 2));
        else console.error(`Installation failed: ${message}`);
        process.exitCode = 1;
      }
    });
}
