#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "@moldesk/core";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerListCommand } from "./commands/list.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerRunCommand } from "./commands/run.js";

const program = new Command();

program
  .name("moldesk")
  .description("Install and run computational biology models")
  .version(VERSION);

registerDoctorCommand(program);
registerListCommand(program);
registerInstallCommand(program);
registerRunCommand(program);

program.parse();
