import { MoldeskError } from "../errors.js";
import { RESULT_SCHEMAS } from "./results.js";

/** Versioned envelope shared by every structure-intelligence command's `--json` output. */
export const ENVELOPE_SCHEMA_VERSION = 1;

export const ENVELOPE_KINDS = [
  "moldesk.analysis",
  "moldesk.inspect",
  "moldesk.compare",
  "moldesk.fetch",
  "moldesk.model",
] as const;

export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

export interface AnalysisEnvelope<R = Record<string, unknown>> {
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  kind: EnvelopeKind;
  status: "ok";
  /** Absent for kinds that do not read a structure file (fetch, model). */
  input?: { path: string; format: "pdb" | "mmcif"; sha256: string };
  /** Kind-specific payload; each feature tightens its own `result` schema. */
  result: R;
  warnings: Array<{ code: string; message: string }>;
  provenance: { moldeskVersion: string; tool?: { name: string; version: string } };
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isKind(value: unknown): value is EnvelopeKind {
  return typeof value === "string" && (ENVELOPE_KINDS as readonly string[]).includes(value);
}

/** JSON Schema (draft-07) for one envelope kind, including that kind's `result` shape. */
export function envelopeSchema(kind: EnvelopeKind): Record<string, unknown> {
  const string = { type: "string", minLength: 1 };
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `https://moldesk.dev/schemas/${kind}/v${ENVELOPE_SCHEMA_VERSION}`,
    title: kind,
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "kind", "status", "result", "warnings", "provenance"],
    properties: {
      schemaVersion: { const: ENVELOPE_SCHEMA_VERSION },
      kind: { const: kind },
      status: { const: "ok" },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["path", "format", "sha256"],
        properties: {
          path: string,
          format: { enum: ["pdb", "mmcif"] },
          sha256: { type: "string", pattern: SHA256_PATTERN.source },
        },
      },
      result: RESULT_SCHEMAS[kind] ?? { type: "object" },
      warnings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message"],
          properties: { code: string, message: { type: "string" } },
        },
      },
      provenance: {
        type: "object",
        additionalProperties: false,
        required: ["moldeskVersion"],
        properties: {
          moldeskVersion: string,
          tool: {
            type: "object",
            additionalProperties: false,
            required: ["name", "version"],
            properties: { name: string, version: string },
          },
        },
      },
    },
  };
}

/** Looks up a schema by kind; throws UNKNOWN_SCHEMA_KIND for anything else. */
export function schemaForKind(kind: string): Record<string, unknown> {
  if (!isKind(kind)) {
    throw new MoldeskError({
      code: "UNKNOWN_SCHEMA_KIND",
      message: `Unknown schema kind "${kind}".`,
      remediation: `Use one of: ${ENVELOPE_KINDS.join(", ")}.`,
    });
  }
  return envelopeSchema(kind);
}

function invalid(where: string, message: string): never {
  throw new MoldeskError({
    code: "INVALID_ENVELOPE",
    message: `${where}: ${message}`,
    remediation: "Regenerate the document with a matching MoleculeDesk version.",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) invalid(where, "expected an object");
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) invalid(where, `forbidden key "${key}"`);
    if (!allowed.includes(key)) invalid(where, `unknown key "${key}"`);
  }
  return value;
}

function nonEmpty(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(where, "expected a non-empty string");
  return value;
}

/** Rejects `__proto__`-style keys anywhere in the free-form `result` payload. */
function rejectForbiddenKeys(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => rejectForbiddenKeys(v, `${where}[${i}]`));
  } else if (isRecord(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) invalid(where, `forbidden key "${key}"`);
      rejectForbiddenKeys(v, `${where}.${key}`);
    }
  }
}

/** Validates an untrusted envelope (e.g. parsed `--json` output); `kind` pins the expected kind. */
export function validateEnvelope(value: unknown, kind?: EnvelopeKind): AnalysisEnvelope {
  const o = object(value, "envelope", [
    "schemaVersion",
    "kind",
    "status",
    "input",
    "result",
    "warnings",
    "provenance",
  ]);
  if (o.schemaVersion !== ENVELOPE_SCHEMA_VERSION) {
    invalid("envelope.schemaVersion", `unsupported version ${String(o.schemaVersion)}`);
  }
  if (!isKind(o.kind)) invalid("envelope.kind", `unknown kind ${JSON.stringify(o.kind)}`);
  if (kind !== undefined && o.kind !== kind) invalid("envelope.kind", `expected "${kind}"`);
  if (o.status !== "ok") invalid("envelope.status", 'expected "ok"');

  if (o.input !== undefined) {
    const input = object(o.input, "envelope.input", ["path", "format", "sha256"]);
    nonEmpty(input.path, "envelope.input.path");
    if (input.format !== "pdb" && input.format !== "mmcif") invalid("envelope.input.format", "expected pdb or mmcif");
    if (typeof input.sha256 !== "string" || !SHA256_PATTERN.test(input.sha256)) {
      invalid("envelope.input.sha256", "expected a lowercase hex SHA-256");
    }
  }

  if (!isRecord(o.result)) invalid("envelope.result", "expected an object");
  rejectForbiddenKeys(o.result, "envelope.result");

  if (!Array.isArray(o.warnings)) invalid("envelope.warnings", "expected an array");
  o.warnings.forEach((w, i) => {
    const warning = object(w, `envelope.warnings[${i}]`, ["code", "message"]);
    nonEmpty(warning.code, `envelope.warnings[${i}].code`);
    if (typeof warning.message !== "string") invalid(`envelope.warnings[${i}].message`, "expected a string");
  });

  const provenance = object(o.provenance, "envelope.provenance", ["moldeskVersion", "tool"]);
  nonEmpty(provenance.moldeskVersion, "envelope.provenance.moldeskVersion");
  if (provenance.tool !== undefined) {
    const tool = object(provenance.tool, "envelope.provenance.tool", ["name", "version"]);
    nonEmpty(tool.name, "envelope.provenance.tool.name");
    nonEmpty(tool.version, "envelope.provenance.tool.version");
  }
  return o as unknown as AnalysisEnvelope;
}
