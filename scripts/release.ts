#!/usr/bin/env tsx
/**
 * Local release helper: builds every package/app in dependency order.
 * Publishing to npm is done by .github/workflows/release.yml when a vX.Y.Z tag
 * is pushed (see the workflow header for the rules); this script is only for
 * building locally. Docker Hub publishing is still manual.
 */
import { execFileSync } from "node:child_process";

execFileSync("tsx", ["scripts/build.ts"], { stdio: "inherit" });

console.log("\nBuild complete. To publish to npm: bump every package to the same version, merge to main,");
console.log("then push the tag:  git tag vX.Y.Z && git push origin vX.Y.Z");
console.log("To publish the Docker image:");
console.log("  docker build -f docker/Dockerfile -t moldesk/moldesk:<version> .");
