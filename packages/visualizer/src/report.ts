// Report envelope, trusted HTML template, and strict extraction/decoding.
// Nothing here executes or evaluates report content.

import { randomUUID } from "node:crypto";
import { REPORT_LIMITS } from "./limits.js";
import { sha256Hex, TEMPLATE_VERSION, type ViewerBundle } from "./bundle.js";
import {
  ContractError,
  validateReport,
  type MolecularReportV1,
  type Panel,
  type ReportResource,
  type ResourceFormat,
  type Scene,
} from "./contract.js";

export const ENVELOPE_MAGIC = "moldesk-molecular-report";
export const ENVELOPE_ELEMENT_ID = "moldesk-report";
const ENVELOPE_OPEN = `<script type="application/json" id="${ENVELOPE_ELEMENT_ID}">`;
const SCRIPT_CLOSE = "</script>";

export interface ReportEnvelopeV1 {
  magic: typeof ENVELOPE_MAGIC;
  envelopeVersion: 1;
  payloadEncoding: "base64-json";
  /** UTF-8 MolecularReportV1 JSON, base64. */
  payload: string;
  payloadSha256: string;
  viewer: {
    version: string;
    molstarVersion: string;
    bundleSha256: string;
    templateVersion: number;
  };
  lastUpdatedAt?: string;
}

export class ReportFormatError extends Error {
  readonly code = "INVALID_REPORT";
  constructor(message: string) {
    super(message);
    this.name = "ReportFormatError";
  }
}

export interface ReportInput {
  title: string;
  resources: Array<{ id: string; label: string; format: ResourceFormat; bytes: Uint8Array }>;
  scenes: Scene[];
  panels: Panel[];
  provenance: { runId?: string; model?: string; modelVersion?: string };
  id?: string;
  createdAt?: string;
}

/** Builds a validated report. Resource hashes are over the original bytes. */
export function createReport(input: ReportInput): MolecularReportV1 {
  const report = {
    schemaVersion: 1 as const,
    id: input.id ?? randomUUID(),
    title: input.title,
    resources: input.resources.map(
      (r): ReportResource => ({
        id: r.id,
        label: r.label,
        format: r.format,
        sha256: sha256Hex(r.bytes),
        sizeBytes: r.bytes.byteLength,
        encoding: "base64",
        data: Buffer.from(r.bytes).toString("base64"),
      }),
    ),
    scenes: input.scenes,
    panels: input.panels,
    provenance: { createdAt: input.createdAt ?? new Date().toISOString(), ...input.provenance },
  };
  return validateReport(report);
}

export function buildEnvelope(
  report: MolecularReportV1,
  bundle: ViewerBundle,
  lastUpdatedAt?: string,
): ReportEnvelopeV1 {
  const payload = Buffer.from(JSON.stringify(report), "utf8").toString("base64");
  return {
    magic: ENVELOPE_MAGIC,
    envelopeVersion: 1,
    payloadEncoding: "base64-json",
    payload,
    payloadSha256: sha256Hex(payload),
    viewer: {
      version: bundle.metadata.viewerVersion,
      molstarVersion: bundle.metadata.molstarVersion,
      bundleSha256: bundle.metadata.bundleSha256,
      templateVersion: TEMPLATE_VERSION,
    },
    ...(lastUpdatedAt === undefined ? {} : { lastUpdatedAt }),
  };
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** JSON that cannot terminate a script element or be misread as HTML. */
function inertJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function cspHash(text: string): string {
  return `'sha256-${Buffer.from(sha256Hex(text), "hex").toString("base64")}'`;
}

/** Restrictive policy: no network of any kind; only the two hashed inline blocks may run/style. */
export function contentSecurityPolicy(js: string, css: string): string {
  return [
    "default-src 'none'",
    `script-src ${cspHash(js)}`,
    `style-src-elem ${cspHash(css)}`,
    "img-src data: blob:",
    "worker-src blob:",
    "connect-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Deterministic: same envelope + bundle always yields identical bytes. */
export function renderHtml(envelope: ReportEnvelopeV1, bundle: ViewerBundle, title: string): string {
  const csp = contentSecurityPolicy(bundle.js, bundle.css);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${bundle.css}</style>`,
    "</head>",
    "<body>",
    '<div id="root"></div>',
    `${ENVELOPE_OPEN}${inertJson(envelope)}${SCRIPT_CLOSE}`,
    `<script>${bundle.js}${SCRIPT_CLOSE}`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Narrow exact extractor: exactly one envelope element, no HTML parsing, no script execution. */
export function extractEnvelope(html: string): ReportEnvelopeV1 {
  if (html.length > REPORT_LIMITS.maxReportFileBytes) throw new ReportFormatError("Report file is too large");
  const first = html.indexOf(ENVELOPE_OPEN);
  if (first === -1) throw new ReportFormatError("This file is not a MoleculeDesk molecular report");
  if (html.indexOf(ENVELOPE_OPEN, first + 1) !== -1 || html.split(`id="${ENVELOPE_ELEMENT_ID}"`).length !== 2) {
    throw new ReportFormatError("Report contains more than one report envelope");
  }
  const start = first + ENVELOPE_OPEN.length;
  const end = html.indexOf(SCRIPT_CLOSE, start);
  if (end === -1) throw new ReportFormatError("Report envelope is not terminated");
  let parsed: unknown;
  try {
    parsed = JSON.parse(html.slice(start, end));
  } catch {
    throw new ReportFormatError("Report envelope is not valid JSON");
  }
  return validateEnvelope(parsed);
}

const ENVELOPE_KEYS = ["magic", "envelopeVersion", "payloadEncoding", "payload", "payloadSha256", "viewer", "lastUpdatedAt"];
const VIEWER_KEYS = ["version", "molstarVersion", "bundleSha256", "templateVersion"];

function validateEnvelope(value: unknown): ReportEnvelopeV1 {
  const bad = (m: string): never => {
    throw new ReportFormatError(`Invalid report envelope: ${m}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("not an object");
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some((k) => !ENVELOPE_KEYS.includes(k))) bad("unknown field");
  if (o.magic !== ENVELOPE_MAGIC) bad("wrong magic");
  if (o.envelopeVersion !== 1) bad("unsupported envelope version");
  if (o.payloadEncoding !== "base64-json") bad("unsupported payload encoding");
  if (typeof o.payload !== "string" || typeof o.payloadSha256 !== "string") bad("missing payload");
  const v = o.viewer as Record<string, unknown> | null;
  if (typeof v !== "object" || v === null || Object.keys(v).some((k) => !VIEWER_KEYS.includes(k))) bad("viewer metadata");
  if (
    typeof v!.version !== "string" ||
    typeof v!.molstarVersion !== "string" ||
    typeof v!.bundleSha256 !== "string" ||
    typeof v!.templateVersion !== "number"
  ) {
    bad("viewer metadata");
  }
  if (o.lastUpdatedAt !== undefined && typeof o.lastUpdatedAt !== "string") bad("lastUpdatedAt");
  return o as unknown as ReportEnvelopeV1;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Verifies payload and every resource against its recorded digest, then validates the schema. */
export function decodeEnvelope(envelope: ReportEnvelopeV1): MolecularReportV1 {
  const maxPayload = Math.ceil((REPORT_LIMITS.maxTotalResourceBytes * 4) / 3) * 2;
  if (envelope.payload.length > maxPayload) throw new ReportFormatError("Report payload is too large");
  if (!BASE64.test(envelope.payload) || envelope.payload.length % 4 !== 0) {
    throw new ReportFormatError("Report payload is not valid base64");
  }
  if (sha256Hex(envelope.payload) !== envelope.payloadSha256) {
    throw new ReportFormatError("Report payload does not match its recorded digest");
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch {
    throw new ReportFormatError("Report payload is not valid JSON");
  }
  let report: MolecularReportV1;
  try {
    report = validateReport(json);
  } catch (error) {
    if (error instanceof ContractError) throw new ReportFormatError(error.message);
    throw error;
  }
  for (const r of report.resources) {
    if (!BASE64.test(r.data)) throw new ReportFormatError(`Resource "${r.id}" is not valid base64`);
    const bytes = Buffer.from(r.data, "base64");
    if (bytes.byteLength !== r.sizeBytes || sha256Hex(bytes) !== r.sha256) {
      throw new ReportFormatError(`Resource "${r.id}" does not match its recorded digest`);
    }
  }
  return report;
}