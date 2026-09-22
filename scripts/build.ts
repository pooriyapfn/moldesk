#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";

const targets = ["@moldesk/registry", "@moldesk/runtime", "@moldesk/adapters", "@moldesk/core", "@moldesk/cli"];

for (const target of targets) {
  console.log(`Building ${target}...`);
  execFileSync("npm", ["run", "build", "--workspace", target], { stdio: "inherit" });
}
