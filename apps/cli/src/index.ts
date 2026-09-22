#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "@moldesk/core";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerListCommand } from "./commands/list.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerRunCommand } from "./commands/run.js";
import { registerUninstallCommand } from "./commands/uninstall.js";
import { printWelcome } from "./utils/ui.js";

const program = new Command();

program
  .name("moldesk")
  .description("Install and run molecular models")
  .version(VERSION);

registerDoctorCommand(program);
registerListCommand(program);
registerInstallCommand(program);
registerUninstallCommand(program);
registerRunCommand(program);

// The welcome screen belongs to the CLI entry page, not individual commands.
if (process.argv.length <= 2) {
  printWelcome();
  program.outputHelp();
} else {
  program.parse();
}
