#!/usr/bin/env tsx
/**
 * Release helper: builds every package/app in dependency order.
 * Publishing itself is left as a manual, deliberate step (npm/Docker Hub
 * credentials should never be scripted into an unattended release path).
 */
import { execFileSync } from "node:child_process";

execFileSync("tsx", ["scripts/build.ts"], { stdio: "inherit" });

console.log("\nBuild complete. To publish:");
console.log("  cd apps/cli && npm publish");
console.log("  docker build -f docker/Dockerfile -t moldesk/moldesk:<version> .");
