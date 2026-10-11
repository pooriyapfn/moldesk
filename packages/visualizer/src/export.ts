// Trusted exporter: assembles a report HTML from verified bytes and publishes it safely.

import { constants, promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadBundle, sha256Hex, type ViewerBundle } from "./bundle.js";
import { buildEnvelope, createReport, renderHtml, type ReportInput } from "./report.js";
import type { MolecularReportV1 } from "./contract.js";

export interface ExportedReport {
  html: string;
  report: MolecularReportV1;
  sha256: string;
  sizeBytes: number;
  sourceSha256: string[];
  viewerVersion: string;
  bundleSha256: string;
}

export class PublishError extends Error {
  constructor(
    readonly code: "OUTPUT_EXISTS" | "REPORT_CONFLICT" | "UNSUPPORTED_REPORT" | "INVALID_REPORT",
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export function exportReport(input: ReportInput, bundle: ViewerBundle = loadBundle()): ExportedReport {
  const report = createReport(input);
  const envelope = buildEnvelope(report, bundle);
  const html = renderHtml(envelope, bundle, report.title);
  return {
    html,
    report,
    sha256: sha256Hex(html),
    sizeBytes: Buffer.byteLength(html),
    sourceSha256: report.resources.map((r) => r.sha256),
    viewerVersion: bundle.metadata.viewerVersion,
    bundleSha256: bundle.metadata.bundleSha256,
  };
}

/**
 * Writes `content` to a new file that must not already exist. Staged in the destination
 * directory, then published with an exclusive link (copy fallback) so a concurrent writer
 * is never overwritten.
 */
export async function writeFileExclusive(dest: string, content: string | Uint8Array, mode = 0o644): Promise<void> {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await fsp.writeFile(tmp, content, { flag: "wx", mode });
    try {
      await fsp.link(tmp, dest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new PublishError("OUTPUT_EXISTS", `Refusing to overwrite existing file: ${dest}`);
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw error;
      try {
        await fsp.copyFile(tmp, dest, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === "EEXIST") {
          throw new PublishError("OUTPUT_EXISTS", `Refusing to overwrite existing file: ${dest}`);
        }
        throw copyError;
      }
    }
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}
