import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPORT_LIMITS } from "@moldesk/visualizer";
import { MoldeskError } from "../errors.js";

export type StructureFormat = "pdb" | "mmcif";

export interface StructureInput {
  /** Absolute path. */
  path: string;
  format: StructureFormat;
  sha256: string;
  text: string;
}

const EXTENSIONS: Record<string, StructureFormat> = {
  ".pdb": "pdb",
  ".ent": "pdb",
  ".cif": "mmcif",
  ".mmcif": "mmcif",
};

function fail(code: string, message: string, remediation: string): never {
  throw new MoldeskError({ code, message, remediation });
}

/** Reads a plain-text input, rejecting missing, empty, oversize and binary files. `what` names the kind of file in messages. */
export function readTextInput(file: string, what: string, maxBytes = REPORT_LIMITS.maxResourceBytes): { path: string; sha256: string; text: string } {
  const resolved = path.resolve(file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail("INPUT_NOT_FOUND", `File not found: ${resolved}`, "Check the path and try again.");
  }
  if (!stat.isFile()) fail("INPUT_NOT_FOUND", `Not a regular file: ${resolved}`, `Pass a ${what} file, not a directory.`);
  if (stat.size === 0) fail("INPUT_EMPTY", `File is empty: ${resolved}`, `Provide a non-empty ${what} file.`);
  if (stat.size > maxBytes) {
    fail("INPUT_TOO_LARGE", `File is too large (${stat.size} bytes; limit ${maxBytes}).`, `Use a smaller ${what} file.`);
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.includes(0)) fail("INPUT_BINARY", `${path.basename(resolved)} looks like a binary file.`, `Provide a text ${what} file.`);
  return { path: resolved, sha256: createHash("sha256").update(bytes).digest("hex"), text: bytes.toString("utf8") };
}

/**
 * Mol*'s PDB reader accepts a half-written ATOM line and silently gives it zero coordinates, so a
 * truncated file would yield plausible but wrong geometry. Require complete, numeric coordinates.
 */
function checkPdbCoordinates(text: string, file: string): void {
  let line = 0;
  for (const raw of text.split("\n")) {
    line++;
    if (!raw.startsWith("ATOM  ") && !raw.startsWith("HETATM")) continue;
    const complete = raw.length >= 54 && [30, 38, 46].every((start) => Number.isFinite(Number(raw.slice(start, start + 8))) && raw.slice(start, start + 8).trim() !== "");
    if (!complete) {
      fail(
        "STRUCTURE_PARSE_FAILED",
        `${path.basename(file)} line ${line}: incomplete ATOM/HETATM record (the file may be truncated).`,
        "Provide a complete PDB file.",
      );
    }
  }
}

export function readStructureInput(file: string): StructureInput {
  const format = EXTENSIONS[path.extname(file).toLowerCase()];
  if (!format) {
    fail("UNSUPPORTED_STRUCTURE_FORMAT", `Unsupported file type: ${path.basename(file)}`, "Use a .pdb, .ent, .cif, or .mmcif file.");
  }
  const input = readTextInput(file, "structure");
  if (format === "pdb") checkPdbCoordinates(input.text, input.path);
  return { ...input, format };
}
