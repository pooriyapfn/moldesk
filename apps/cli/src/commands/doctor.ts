import type { Command } from "commander";
import { getSystemReport, VERSION } from "@moldesk/core";
import type { SystemReport } from "@moldesk/core";
import { checkmark, section } from "../utils/format.js";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function printHuman(report: SystemReport): void {
  console.log(`MoleculeDesk ${VERSION}`);
  console.log(section("System"));
  console.log(`  OS           ${report.platform} (${report.arch})`);
  console.log(`  CPU          ${report.cpu.model} (${report.cpu.logicalCores} cores)`);
  console.log(`  Memory       ${formatBytes(report.memory.totalBytes)}`);
  console.log(
    `  Disk         ${report.disk.probeFailed ? `unknown (${report.disk.probeError ?? "probe failed"})` : `${formatBytes(report.disk.availableBytes)} free at ${report.disk.path}`}`,
  );
  console.log(
    `  ${checkmark(report.appleSilicon)} Apple Silicon${report.appleSilicon ? "" : " not detected"}`,
  );

  console.log(section("Compute"));
  const py = report.hostPython;
  console.log(
    `  ${checkmark(py.available)} Python       ${py.available ? `${py.version ?? "unknown"}${py.path ? ` (${py.path})` : ""}` : (py.error ?? "not found")} (diagnostic only)`,
  );
  const gpuCount = report.nvidia.gpus.length;
  const gpuDetail =
    report.nvidia.available && gpuCount > 0
      ? report.nvidia.gpus
          .map((g) => `${g.name}${typeof g.totalVramBytes === "number" ? ` (${formatBytes(g.totalVramBytes)} VRAM)` : ""}`)
          .join(", ")
      : null;
  console.log(
    `  ${checkmark(report.nvidia.available)} NVIDIA GPU   ${
      report.nvidia.available
        ? `${gpuCount} GPU${gpuCount === 1 ? "" : "s"}: ${gpuDetail ?? "detected"}` +
          `${report.nvidia.driverCudaVersion ? ` | CUDA (driver max) ${report.nvidia.driverCudaVersion}` : ""}` +
          `${report.nvidia.cudaToolkitVersion ? ` | CUDA toolkit ${report.nvidia.cudaToolkitVersion}` : ""}` +
          `${report.nvidia.driverVersion ? ` | driver ${report.nvidia.driverVersion}` : ""}`
        : (report.nvidia.error ?? "not detected")
    }`,
  );

  console.log(section("Docker"));
  const docker = report.docker;
  console.log(
    `  ${checkmark(docker.available)} Installed    ${docker.available ? (docker.version ?? "yes") : (docker.error ?? "not installed")}`,
  );
  console.log(
    `  ${checkmark(docker.running)} Running      ${docker.available ? (docker.running ? "running" : "not running") : "n/a"}`,
  );
  console.log(`  GPU access   ${docker.gpuAccess}`);

  console.log(section("Notes"));
  if (!report.nvidia.available) {
    console.log("  No NVIDIA GPU detected: CUDA/GPU models will run on CPU only.");
    console.log("  Docker GPU runtimes need the same host NVIDIA driver — Docker does not provide GPU access independently.");
  }
  if (report.docker.available && !report.docker.running) {
    console.log("  Start the Docker daemon to enable docker runtimes.");
  }
  if (report.docker.gpuAccess === "unknown") {
    console.log("  Docker GPU access not yet verified (run `moldesk install` to verify; doctor never pulls images).");
  }
  console.log("  Host Python is diagnostic only; installs use managed uv Python.");
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check system compatibility for running models")
    .option("--json", "print the raw system report as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const report = await getSystemReport();
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printHuman(report);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
