import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  evaluateCompatibility,
  getSystemReport,
  isImageCachedLocally,
  listAvailableModels,
  probeDockerGpuAccess,
  pullDockerImage,
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
    .description("Install a model (compatibility gate; full engine lands in Step 3)")
    .option("--runtime <kind>", "select runtime python|docker (no silent fallback)")
    .option("--yes", "skip the confirmation prompt before downloading the Docker GPU verification image")
    .option("--json", "print compatibility/plan result as JSON")
    .action(async (model: string, options: { runtime?: string; yes?: boolean; json?: boolean }) => {
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

      // Compatibility passed (compatible|warning). Full install lifecycle is Step 3:
      // perform zero writes here.
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              model,
              status: compatibility.status,
              selectedRuntime: compatibility.selectedRuntime,
              compatibility,
              note: "Install engine lands in Step 3; no files written.",
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        `Model "${model}" is ${compatibility.status} via ${compatibility.selectedRuntime ?? "unknown"} runtime.`,
      );
      if (compatibility.status === "warning") {
        console.log(`  ${shortReason(compatibility)}`);
      }
      console.log("Installation engine lands in Step 3; no files were written.");
    });
}
