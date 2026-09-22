import type { Command } from "commander";
import { getSystemReport, VERSION } from "@moldesk/core";
import type { SystemReport } from "@moldesk/core";
import { accent, failure, strong, success } from "../utils/ui.js";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function printHuman(report: SystemReport, options: { verbose?: boolean } = {}): void {
  const gpuCount = report.nvidia.gpus.length;
  const diskIssue = report.disk.probeFailed;
  const dockerIssue = report.docker.available && !report.docker.running;
  const status = diskIssue || dockerIssue ? "needs attention" : "ready to use";

  console.log(strong(`MolDesk system check  ·  v${VERSION}`));
  console.log(`  ${status === "ready to use" ? success("✓ Ready to use") : failure("! Needs attention")}`);
  console.log(`  ${accent("CPU models can run on this computer.")}`);

  console.log("\nYour computer");
  console.log(`  Operating system   ${report.platform} (${report.arch})`);
  console.log(`  Processor          ${report.cpu.model} · ${report.cpu.logicalCores} cores`);
  console.log(`  Memory             ${formatBytes(report.memory.totalBytes)}`);
  console.log(`  Storage            ${diskIssue ? "Could not check available space" : `${formatBytes(report.disk.availableBytes)} available`}`);

  console.log("\nOptional acceleration");
  console.log(`  GPU                ${report.nvidia.available ? `${gpuCount} NVIDIA GPU${gpuCount === 1 ? "" : "s"} available` : "No NVIDIA GPU detected"}`);
  console.log(`  Docker             ${report.docker.available ? (report.docker.running ? "Available and running" : "Installed but not running") : "Not installed"}`);

  console.log("\nWhat this means");
  console.log("  • CPU-based models are available to install and run.");
  if (!report.nvidia.available) console.log("  • GPU models will use the CPU and may run more slowly.");
  if (dockerIssue) console.log("  • Start Docker if you want to use Docker-based models.");
  if (diskIssue) console.log("  • Check free storage before installing a large model.");
  if (report.docker.gpuAccess === "unknown" && report.docker.available) {
    console.log("  • Docker GPU support is checked when a GPU model is installed.");
  }

  if (options.verbose) {
    console.log("\nTechnical details");
    const py = report.hostPython;
    console.log(`  Host Python       ${py.available ? `${py.version ?? "unknown"}${py.path ? ` (${py.path})` : ""}` : (py.error ?? "not found")} (diagnostic only)`);
    if (report.disk.probeFailed) console.log(`  Disk probe        ${report.disk.probeError ?? "probe failed"}`);
    if (report.nvidia.error) console.log(`  NVIDIA probe      ${report.nvidia.error}`);
    if (report.docker.error) console.log(`  Docker probe      ${report.docker.error}`);
    console.log(`  Docker GPU access ${report.docker.gpuAccess}`);
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check system compatibility for running models")
    .option("--verbose", "show technical diagnostics")
    .option("--json", "print the raw system report as JSON")
    .action(async (options: { json?: boolean; verbose?: boolean }) => {
      try {
        const report = await getSystemReport();
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printHuman(report, options);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
