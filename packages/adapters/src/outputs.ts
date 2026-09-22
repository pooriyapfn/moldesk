import fs from "node:fs";
import path from "node:path";
import type { OutputSpec } from "@moldesk/registry";
import { MoldeskError } from "@moldesk/registry";
import type { CollectedOutput } from "./index.js";

function segmentPattern(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Matches a manifest output glob (segment-wise `*` wildcards, e.g. "seqs/*.fa") against files under `root`. */
function matchGlob(root: string, glob: string): string[] {
  let candidates = [root];
  for (const segment of glob.split("/")) {
    const pattern = segmentPattern(segment);
    const next: string[] = [];
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (pattern.test(entry)) next.push(path.join(dir, entry));
      }
    }
    candidates = next;
  }
  return candidates.filter((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile()).sort();
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
