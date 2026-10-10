// Local viewer replacement. Inspects the target as data only; never executes it.

import { promises as fsp, type Stats } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadBundle, sha256Hex, type ViewerBundle } from "./bundle.js";
import { PublishError, writeFileExclusive } from "./export.js";
import { REPORT_LIMITS } from "./limits.js";
import { buildEnvelope, decodeEnvelope, extractEnvelope, ReportFormatError, renderHtml } from "./report.js";
import type { ReportEnvelopeV1 } from "./report.js";

export type UpdateStatus = "noop" | "replace" | "unsupported";

export interface UpdatePlan {
  status: UpdateStatus;
  /** Why an update is unsupported. */
  reason?: string;
  targetPath: string;
  outputPath?: string;
  originalSha256: string;
  originalSizeBytes: number;
  payloadSha256?: string;
  fromViewerVersion?: string;
  toViewerVersion: string;
  toBundleSha256: string;
  /** Internal: state needed to commit safely. */
  original: Buffer;
  identity: { ino: number; dev: number; size: number; mtimeMs: number; mode: number };
  newHtml?: string;
}

export interface UpdateResult {
  status: "updated" | "copied";
  path: string;
  backupPath?: string;
  sha256: string;
  sizeBytes: number;
  payloadSha256: string;
  viewerVersion: string;
  bundleSha256: string;
}

function identityOf(s: Stats) {
  return { ino: s.ino, dev: s.dev, size: s.size, mtimeMs: s.mtimeMs, mode: s.mode & 0o777 };
}

async function readRegularFile(target: string): Promise<{ bytes: Buffer; stat: Stats }> {
  let stat: Stats;
  try {
    stat = await fsp.lstat(target);
  } catch {
    throw new ReportFormatError(`Report not found: ${target}`);
  }
  if (stat.isSymbolicLink()) throw new ReportFormatError("Report path is a symbolic link");
  if (!stat.isFile()) throw new ReportFormatError("Report path is not a regular file");
  if (stat.size > REPORT_LIMITS.maxReportFileBytes) throw new ReportFormatError("Report file is too large");
  return { bytes: await fsp.readFile(target), stat };
}

export async function planUpdate(
  target: string,
  options: { output?: string; bundle?: ViewerBundle; now?: () => Date } = {},
): Promise<UpdatePlan> {
  const bundle = options.bundle ?? loadBundle();
  const { bytes, stat } = await readRegularFile(target);
  const html = bytes.toString("utf8");
  const base = {
    targetPath: target,
    ...(options.output === undefined ? {} : { outputPath: options.output }),
    originalSha256: sha256Hex(bytes),
    originalSizeBytes: bytes.byteLength,
    toViewerVersion: bundle.metadata.viewerVersion,
    toBundleSha256: bundle.metadata.bundleSha256,
    original: bytes,
    identity: identityOf(stat),
  };

  const envelope = extractEnvelope(html);
  const compat = bundle.metadata.compatible;
  const unsupported = (reason: string): UpdatePlan => ({ ...base, status: "unsupported", reason });
  if (!compat.envelopeVersions.includes(envelope.envelopeVersion)) {
    return unsupported("unsupported envelope version");
  }
  const report = decodeEnvelope(envelope); // throws on malformed/inconsistent payloads
  if (!compat.schemaVersions.includes(report.schemaVersion)) return unsupported("unsupported report schema");

  const common = {
    ...base,
    payloadSha256: envelope.payloadSha256,
    fromViewerVersion: envelope.viewer.version,
  };

  // Same-bundle no-op only if the actual file equals a trusted reconstruction.
  const sameBundle =
    envelope.viewer.bundleSha256 === bundle.metadata.bundleSha256 &&
    envelope.viewer.templateVersion === bundle.metadata.templateVersion;
  if (sameBundle && renderHtml(envelope, bundle, report.title) === html) {
    return { ...common, status: "noop" };
  }

  const updated: ReportEnvelopeV1 = {
    ...buildEnvelope(report, bundle, (options.now?.() ?? new Date()).toISOString()),
    // Payload kept verbatim, not re-serialized.
    payload: envelope.payload,
    payloadSha256: envelope.payloadSha256,
  };
  return { ...common, status: "replace", newHtml: renderHtml(updated, bundle, report.title) };
}

async function assertUnchanged(plan: UpdatePlan): Promise<void> {
  let current: { bytes: Buffer; stat: Stats };
  try {
    current = await readRegularFile(plan.targetPath);
  } catch {
    throw new PublishError("REPORT_CONFLICT", "The report changed while the update was being prepared. Nothing was changed.");
  }
  const a = identityOf(current.stat);
  const b = plan.identity;
  if (
    a.ino !== b.ino ||
    a.dev !== b.dev ||
    a.size !== b.size ||
    a.mtimeMs !== b.mtimeMs ||
    sha256Hex(current.bytes) !== plan.originalSha256
  ) {
    throw new PublishError("REPORT_CONFLICT", "The report changed while the update was being prepared. Nothing was changed.");
  }
}

async function writeUniqueBackup(target: string, bytes: Buffer, mode: number): Promise<string> {
  const { dir, name, ext } = path.parse(target);
  for (let n = 0; n < 1000; n++) {
    const candidate = path.join(dir, `${name}.backup${n === 0 ? "" : `-${n}`}${ext}`);
    try {
      await fsp.writeFile(candidate, bytes, { flag: "wx", mode });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new PublishError("OUTPUT_EXISTS", "Could not find an unused backup file name");
}

function digestsOf(html: string | Buffer) {
  return { sha256: sha256Hex(html), sizeBytes: Buffer.byteLength(html) };
}

export async function applyUpdate(plan: UpdatePlan): Promise<UpdateResult> {
  if (plan.status === "unsupported") {
    throw new PublishError("UNSUPPORTED_REPORT", plan.reason ?? "Report cannot be updated");
  }
  await assertUnchanged(plan);
  const payloadSha256 = plan.payloadSha256 ?? "";

  if (plan.outputPath !== undefined) {
    const content = plan.status === "replace" ? (plan.newHtml as string) : plan.original;
    await writeFileExclusive(plan.outputPath, content, plan.identity.mode);
    return {
      status: plan.status === "replace" ? "updated" : "copied",
      path: plan.outputPath,
      payloadSha256,
      viewerVersion: plan.toViewerVersion,
      bundleSha256: plan.toBundleSha256,
      ...digestsOf(content),
    };
  }

  if (plan.status === "noop" || plan.newHtml === undefined) {
    throw new PublishError("REPORT_CONFLICT", "Nothing to update");
  }
  const backupPath = await writeUniqueBackup(plan.targetPath, plan.original, plan.identity.mode);
  const tmp = path.join(path.dirname(plan.targetPath), `.${path.basename(plan.targetPath)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await fsp.writeFile(tmp, plan.newHtml, { flag: "wx", mode: plan.identity.mode });
    await fsp.chmod(tmp, plan.identity.mode);
    await fsp.rename(tmp, plan.targetPath);
  } catch (error) {
    await fsp.rm(tmp, { force: true });
    throw error;
  }
  return {
    status: "updated",
    path: plan.targetPath,
    backupPath,
    payloadSha256,
    viewerVersion: plan.toViewerVersion,
    bundleSha256: plan.toBundleSha256,
    ...digestsOf(plan.newHtml),
  };
}
