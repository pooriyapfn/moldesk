#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "@moldesk/core";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerCloudCommand } from "./commands/cloud.js";
import { registerCompareCommand } from "./commands/compare.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerListCommand } from "./commands/list.js";
import { registerFetchCommand } from "./commands/fetch.js";
import { registerInspectCommand } from "./commands/inspect.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSchemaCommand } from "./commands/schema.js";
import { registerUninstallCommand } from "./commands/uninstall.js";
import { registerViewCommand } from "./commands/view.js";
import { registerVisualizerCommand } from "./commands/visualizer.js";

const program = new Command();

program
  .name("moldesk")
  .description("Install and run computational biology models")
  .version(VERSION);

registerDoctorCommand(program);
registerListCommand(program);
registerInstallCommand(program);
registerUninstallCommand(program);
registerRunCommand(program);
registerViewCommand(program);
registerFetchCommand(program);
registerAnalyzeCommand(program);
registerInspectCommand(program);
registerCompareCommand(program);
registerSchemaCommand(program);
registerCloudCommand(program);
registerVisualizerCommand(program);

program.parse();
