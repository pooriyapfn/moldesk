import type { Command } from "commander";
import { getSystemReport, VERSION } from "@moldesk/core";
import { checkmark, section } from "../utils/format.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check system compatibility for running models")
    .action(async () => {
      const report = await getSystemReport();
      const { hardware, python, docker } = report;

      console.log(`MoleculeDesk ${VERSION}`);
      console.log(section("System"));
      console.log(`  OS           ${hardware.platform} (${hardware.arch})`);
      console.log(`  CPU          ${hardware.cpuModel} (${hardware.cpuCores} cores)`);
      console.log(`  Memory       ${hardware.totalMemoryGb} GB`);
      console.log(
        `  ${checkmark(hardware.isAppleSilicon)} Apple Silicon${hardware.isAppleSilicon ? "" : " not detected"}`
      );

      console.log(section("Compute"));
      console.log(
        `  ${checkmark(python.found)} Python       ${python.found ? python.version : "not found"}`
      );
      console.log(
        `  ${checkmark(docker.installed)} Docker       ${
          docker.installed ? (docker.running ? `${docker.version} (running)` : `${docker.version} (not running)`) : "not installed"
        }`
      );

      console.log(section("Models"));
      console.log("  No models installed yet. Run `moldesk list` to see what's available.");
    });
}
