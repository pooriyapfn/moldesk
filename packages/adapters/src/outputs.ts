import fs from "node:fs";
import path from "node:path";
import type { OutputSpec } from "@moldesk/registry";
import { MoldeskError } from "@moldesk/registry";
import type { CollectedOutput } from "./index.js";

function segmentPattern(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function isDirectory(entryPath: string): boolean {
  try {
    return fs.statSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

/**
 * Matches glob segments against files under `currentDir`. A literal `**`
 * segment matches zero or more directory levels (true recursion), not one
 * fixed level — required for real adapter output layouts nested more than
 * one directory deep (e.g. Boltz's `predictions/<id>/*.cif`).
 */
function matchSegments(currentDir: string, segments: string[]): string[] {
  if (!fs.existsSync(currentDir) || segments.length === 0) return [];
  const [head, ...rest] = segments;

  if (head === "**") {
    const results: string[] = rest.length === 0 ? walkFiles(currentDir) : matchSegments(currentDir, rest);
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory()) results.push(...matchSegments(path.join(currentDir, entry.name), segments));
    }
    return results;
  }

  const pattern = segmentPattern(head);
  const results: string[] = [];
  for (const entry of fs.readdirSync(currentDir)) {
    if (!pattern.test(entry)) continue;
    const full = path.join(currentDir, entry);
    if (rest.length === 0) {
      if (fs.statSync(full).isFile()) results.push(full);
    } else if (isDirectory(full)) {
      results.push(...matchSegments(full, rest));
    }
  }
  return results;
}

/** Matches a manifest output glob (segment-wise `*` wildcards, recursive `**`) against files under `root`. */
function matchGlob(root: string, glob: string): string[] {
  return [...new Set(matchSegments(root, glob.split("/")))].sort();
}

/**
 * Resolves manifest-declared output globs against a run's output directory.
 * Throws `MISSING_REQUIRED_OUTPUT` if any `required` output has no matches —
 * a nonzero exit code alone is not sufficient (spec §4.4).
 */
export function collectGlobOutputs(outputDir: string, outputs: OutputSpec[]): CollectedOutput[] {
  const collected: CollectedOutput[] = [];
  for (const output of outputs) {
    const matches = matchGlob(outputDir, output.glob);
    if (matches.length === 0 && output.required) {
      throw new MoldeskError({
        code: "MISSING_REQUIRED_OUTPUT",
        message: `Required output "${output.id}" (glob "${output.glob}") produced no files in ${outputDir}.`,
        remediation: "Check stdout.log/stderr.log in the run directory for the underlying failure.",
        details: { id: output.id, glob: output.glob, outputDir },
      });
    }
    for (const match of matches) collected.push({ id: output.id, path: match });
  }
  return collected;
}
