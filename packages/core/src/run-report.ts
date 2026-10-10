import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CollectedOutput, ModelAdapterDefinition, RunContext } from "@moldesk/adapters";
import { isWithinRoot } from "@moldesk/runtime";
import {
  exportReport,
  REPORT_LIMITS,
  validateDescription,
  writeFileExclusive,
  type ViewerBundle,
} from "@moldesk/visualizer";
import { MoldeskError } from "./errors.js";

export interface RunArtifact {
  id: string;
  kind: "molecular-report";
  path: string;
  sha256: string;
  sizeBytes: number;
  sourceSha256: string[];
  viewerVersion: string;
  bundleSha256: string;
}

export interface RunWarning {
  code: string;
  message: string;
}

export interface RunReportInput {
  adapter: ModelAdapterDefinition;
  context: RunContext;
  runDirPath: string;
  record: {
    id: string;
    model: string;
    modelVersion: string;
    input: Array<{ storedPath: string; sha256: string }>;
    outputs: Array<{ id: string; path: string; sha256: string }>;
  };
  signal?: AbortSignal;
  /** Test seam; defaults to the installed viewer bundle. */
  bundle?: ViewerBundle;
}

class Cancelled extends Error {}

function refuse(code: string, message: string): MoldeskError {
  return new MoldeskError({ code, message, remediation: "The model results are unaffected; re-run with --no-visualize to skip the report." });
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Cancelled();
}

/**
 * Resolves one adapter-declared source. Only exact paths the run already recorded (and
 * checksummed) are allowed; the file is re-checked as a regular, non-symlink file inside
 * the run directory at the moment of reading, and its bytes must still match the recorded
 * checksum. The adapter never gets to request an arbitrary read.
 */
function readSource(
  kind: "output" | "input",
  sourcePath: string,
  known: ReadonlyMap<string, string>,
  root: string,
): Buffer {
  const expected = known.get(sourcePath);
  if (expected === undefined) {
    throw refuse("VISUALIZATION_SOURCE_NOT_ALLOWED", `The report referenced a ${kind} file that this run did not record: ${path.basename(sourcePath)}`);
  }
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw refuse("VISUALIZATION_SOURCE_NOT_ALLOWED", `${path.basename(sourcePath)} is not a regular file.`);
  }
  if (!isWithinRoot(root, fs.realpathSync(sourcePath))) {
    throw refuse("VISUALIZATION_SOURCE_NOT_ALLOWED", `${path.basename(sourcePath)} resolves outside the run directory.`);
  }
  if (stat.size > REPORT_LIMITS.maxResourceBytes) {
    throw refuse("VISUALIZATION_SOURCE_TOO_LARGE", `${path.basename(sourcePath)} is too large to embed (${stat.size} bytes).`);
  }
  const bytes = fs.readFileSync(sourcePath);
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw refuse("VISUALIZATION_SOURCE_CHANGED", `${path.basename(sourcePath)} changed after it was checksummed.`);
  }
  return bytes;
}

/**
 * Builds `artifacts/viewer.html` for a successful run. Never throws: any failure becomes a
 * warning so a successful scientific run stays successful. Cancellation yields a warning
 * and no file. Writes nothing until the report is fully built and verified.
 */
export async function generateRunReport(
  input: RunReportInput,
): Promise<{ artifact?: RunArtifact; warning?: RunWarning }> {
  try {
    checkAbort(input.signal);
    const outputs: CollectedOutput[] = input.record.outputs.map(({ id, path: p }) => ({ id, path: p }));
    const description = await input.adapter.describeVisualization?.(input.context, outputs);
    if (!description) return {};
    checkAbort(input.signal);

    const valid = validateDescription(description);
    const knownOutputs = new Map(input.record.outputs.map((o) => [o.path, o.sha256]));
    const knownInputs = new Map(input.record.input.map((i) => [i.storedPath, i.sha256]));
    const roots = {
      output: fs.realpathSync(path.join(input.runDirPath, "output")),
      input: fs.realpathSync(path.join(input.runDirPath, "input")),
    };

    const resources = [];
    for (const r of valid.resources) {
      const bytes = readSource(
        r.source.kind,
        r.source.path,
        r.source.kind === "output" ? knownOutputs : knownInputs,
        roots[r.source.kind],
      );
      resources.push({ id: r.id, label: r.label, format: r.format, bytes });
      checkAbort(input.signal);
    }

    const exported = exportReport(
      {
        title: valid.title,
        resources,
        scenes: valid.scenes,
        panels: valid.panels,
        provenance: { runId: input.record.id, model: input.record.model, modelVersion: input.record.modelVersion },
      },
      input.bundle,
    );
    checkAbort(input.signal);

    const artifactsDir = path.join(input.runDirPath, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    const dest = path.join(artifactsDir, "viewer.html");
    await writeFileExclusive(dest, exported.html);
    return {
      artifact: {
        id: "molecular-report",
        kind: "molecular-report",
        path: dest,
        sha256: exported.sha256,
        sizeBytes: exported.sizeBytes,
        sourceSha256: exported.sourceSha256,
        viewerVersion: exported.viewerVersion,
        bundleSha256: exported.bundleSha256,
      },
    };
  } catch (error) {
    if (error instanceof Cancelled) {
      return { warning: { code: "VISUALIZATION_CANCELLED", message: "Report generation was cancelled. The model results are unaffected." } };
    }
    const code = error instanceof MoldeskError ? error.code : typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "VISUALIZATION_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    return { warning: { code, message: `Could not create the molecular report: ${message}` } };
  }
}
