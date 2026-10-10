import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { visualizationDir } from "@moldesk/runtime";
import {
  exportReport,
  REPORT_LIMITS,
  writeFileExclusive,
  type MolecularFormat,
  type ViewerBundle,
} from "@moldesk/visualizer";
import { MoldeskError } from "./errors.js";

export interface StandaloneReportOptions {
  /** Explicit report file. Must not already exist. Default: an owned path under the cache. */
  outputPath?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to the installed viewer bundle. */
  bundle?: ViewerBundle;
}

export interface StandaloneReportResult {
  id: string;
  path: string;
  fileUrl: string;
  sha256: string;
  sizeBytes: number;
  format: MolecularFormat;
  sourceSha256: string[];
  viewerVersion: string;
  bundleSha256: string;
}

const EXTENSIONS: Record<string, MolecularFormat> = {
  ".pdb": "pdb",
  ".cif": "mmcif",
  ".mmcif": "mmcif",
};

const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function invalid(message: string, remediation: string, code = "INVALID_VIEW_INPUT"): MoldeskError {
  return new MoldeskError({ code, message, remediation });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MoldeskError({ code: "VIEW_CANCELLED", message: "Cancelled.", remediation: "Run the command again." });
}

/** Lightweight preflight only; real parsing stays in the browser's Mol*. */
function preflight(text: string, format: MolecularFormat, file: string): void {
  if (text.includes("\0")) {
    throw invalid(`${file} looks like a binary file, not a structure.`, "Provide a text PDB or mmCIF file.");
  }
  const ok =
    format === "pdb"
      ? /^(ATOM  |HETATM)/m.test(text)
      : /^data_\S*/m.test(text) && /^_atom_site\./m.test(text);
  if (!ok) {
    throw invalid(
      format === "pdb"
        ? `${file} has no ATOM or HETATM records.`
        : `${file} is not a macromolecular mmCIF file (no _atom_site category).`,
      format === "pdb"
        ? "Provide a PDB file with coordinates."
        : "Provide a macromolecular mmCIF. Arbitrary crystallographic CIF files are not supported.",
    );
  }
}

/** Direct `moldesk view <file>`: one scene from one local PDB/mmCIF file. */
export async function createStandaloneReport(
  inputPath: string,
  options: StandaloneReportOptions = {},
): Promise<StandaloneReportResult> {
  if (URL_LIKE.test(inputPath)) {
    throw invalid("URLs are not supported.", "Download the file first and pass its local path.");
  }
  const file = path.resolve(inputPath);
  const format = EXTENSIONS[path.extname(file).toLowerCase()];
  if (!format) {
    throw invalid(
      `Unsupported file type: ${path.basename(file)}`,
      "Use a .pdb, .cif, or .mmcif file.",
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw invalid(`File not found: ${file}`, "Check the path and try again.");
  }
  if (!stat.isFile()) throw invalid(`Not a regular file: ${file}`, "Pass a structure file, not a directory.");
  if (stat.size === 0) throw invalid(`File is empty: ${file}`, "Provide a non-empty structure file.");
  if (stat.size > REPORT_LIMITS.maxResourceBytes) {
    throw invalid(
      `File is too large (${stat.size} bytes; limit ${REPORT_LIMITS.maxResourceBytes}).`,
      "Use a smaller structure file.",
    );
  }
  throwIfAborted(options.signal);
  const bytes = fs.readFileSync(file);
  preflight(bytes.toString("utf8"), format, path.basename(file));
  throwIfAborted(options.signal);

  const id = randomUUID();
  const name = path.basename(file);
  let exported;
  try {
    exported = exportReport(
      {
        id,
        title: name,
        resources: [{ id: "structure", label: name, format, bytes }],
        scenes: [{ id: "scene-1", title: name, structures: [{ id: "structure-1", resourceId: "structure" }] }],
        panels: [{ id: "structure-panel", kind: "structure", sceneIds: ["scene-1"] }],
        provenance: {},
      },
      options.bundle,
    );
  } catch (error) {
    throw asMoldeskError(error);
  }
  throwIfAborted(options.signal);

  const dest =
    options.outputPath !== undefined
      ? path.resolve(options.outputPath)
      : path.join(visualizationDir(id, options.env), "viewer.html");
  if (options.outputPath !== undefined && fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
    throw invalid(`--output must be a file path, not a directory: ${dest}`, "Pass a file name such as ./report.html.");
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await writeFileExclusive(dest, exported.html);
  } catch (error) {
    throw asMoldeskError(error);
  }
  return {
    id,
    path: dest,
    fileUrl: pathToFileURL(dest).href,
    sha256: exported.sha256,
    sizeBytes: exported.sizeBytes,
    format,
    sourceSha256: exported.sourceSha256,
    viewerVersion: exported.viewerVersion,
    bundleSha256: exported.bundleSha256,
  };
}

const REMEDIATION: Record<string, string> = {
  OUTPUT_EXISTS: "Choose a different --output path or remove the existing file.",
  INVALID_REPORT: "Check that the file is a valid MoleculeDesk report.",
  UNSUPPORTED_REPORT: "Your report has not been changed.",
  REPORT_CONFLICT: "Run the command again.",
  VISUALIZER_BUNDLE_INVALID: "Reinstall MoleculeDesk.",
};

/** Maps typed visualizer errors onto MoldeskError so the CLI can pick exit codes by code. */
export function asMoldeskError(error: unknown): MoldeskError {
  if (error instanceof MoldeskError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof Error && typeof code === "string" && code in REMEDIATION) {
    return new MoldeskError({ code, message: error.message, remediation: REMEDIATION[code], cause: error });
  }
  return new MoldeskError({
    code: "VISUALIZATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    remediation: "Try again; if this persists, report an issue.",
    cause: error,
  });
}
