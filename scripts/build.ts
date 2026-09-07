#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";

const targets = ["@moldesk/runtime", "@moldesk/registry", "@moldesk/core", "@moldesk/cli"];

for (const target of targets) {
  console.log(`Building ${target}...`);
  execFileSync("pnpm", ["--filter", target, "build"], { stdio: "inherit" });
}
