import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { MoldeskError } from "@moldesk/registry";
import type { CompanionInputRef } from "@moldesk/runtime";

/**
 * RFD4-Proteina "condition spec" handling. The spec is a map of design name to
 * `{input, input_as_annotated_cif?, contig?, conditions?}` plus an optional `global_args`
 * of shared defaults (per-design values win, shallow merge, exactly as upstream folds them).
 *
 * MoleculeDesk validates the user's YAML/JSON against a closed grammar and hands upstream a
 * *resolved JSON* rewritten to staged copies of the structure files. Upstream therefore never
 * parses the user's original text (its YAML 1.1 `safe_load` differs from the YAML 1.2 parsed
 * here), and never sees an absolute path the user chose.
 *
 * Objects are `Map`s throughout: `conditions` apply "in declaration order, last write wins",
 * and a plain JS object would silently reorder integer-like keys (`{2: …, 1: …}`).
 */

export const MAX_SPEC_BYTES = 1024 * 1024;
export const MAX_DESIGNS = 8;
export const MAX_INPUT_FILES = 16;
const MAX_FILES_PER_DESIGN = 8;
const MAX_STRING = 512;
const MAX_PATH = 256;
const MAX_ANNOTATIONS = 64;
const MAX_VALUES = 64;
const MAX_ENTRIES = 256;

export const DESIGN_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ANNOTATION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VALUE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.,:+-]{0,127}$/;
const DESIGN_FIELDS = ["input", "input_as_annotated_cif", "contig", "conditions"] as const;
const SPEC_EXTENSIONS = [".yaml", ".yml", ".json"];
/** The CIF/BinaryCIF suffixes upstream's `is_structure_file` accepts, minus PDB (unsupported there). */
export const STRUCTURE_SUFFIXES = [".cif", ".cif.gz", ".cif.gzip", ".cif.zst", ".bcif", ".bcif.gz", ".bcif.gzip", ".bcif.zst"];

export type ConditionEntry = Map<string, string | number>;
export type Conditions = Map<string, Map<string, ConditionEntry[]>>;
export interface Design {
  name: string;
  /** Normalized POSIX paths relative to the spec's folder. `string` keeps a single-file spelling. */
  input: string | string[];
  inputAsAnnotatedCif?: boolean;
  contig?: string;
  conditions?: Conditions;
}
export interface ParsedSpec {
  designs: Design[];
}

export function fail(message: string, code = "INVALID_RUN_INPUT"): never {
  throw new MoldeskError({
    code,
    message,
    remediation: "Use examples/rfd4-proteina/monomer.yaml as a template; see models/rfd4-proteina/README.md for the accepted fields.",
  });
}

function isMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}

function hasControl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING || hasControl(value)) {
    fail(`${label} must be a non-empty string of at most ${MAX_STRING} characters without control characters.`);
  }
  return value;
}

/**
 * A structure reference: relative, POSIX-style, no traversal, a CIF/BinaryCIF suffix. Absolute
 * paths are rejected (upstream would accept them) because cloud runs upload these files and a
 * spec must only reach into its own folder.
 */
export function normalizeInputPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH) fail(`${label} must be a non-empty relative path.`);
  if (hasControl(value) || value.includes("\\")) fail(`${label} must not contain backslashes or control characters.`);
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)) fail(`${label} must be relative to the spec file; absolute paths are not allowed.`);
  const segments = value.split("/");
  if (segments.some((s) => s === "..")) fail(`${label} must not contain "..".`);
  if (segments.some((s) => s === "")) fail(`${label} must not contain empty path segments.`);
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")) fail(`${label} is not a valid relative file path.`);
  const lower = normalized.toLowerCase();
  if (!STRUCTURE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    fail(`${label} must be a CIF or BinaryCIF file (${STRUCTURE_SUFFIXES.join(", ")}); PDB files are not supported by RFD4-Proteina.`);
  }
  return normalized;
}

function parseInput(value: unknown, label: string): string | string[] {
  if (typeof value === "string") return normalizeInputPath(value, label);
  if (Array.isArray(value) && value.length > 0 && value.length <= MAX_FILES_PER_DESIGN) {
    const files = value.map((entry, i) => normalizeInputPath(entry, `${label}[${i}]`));
    if (new Set(files).size !== files.length) fail(`${label} lists the same file twice.`);
    return files;
  }
  return fail(`${label} must be a file path or a list of 1-${MAX_FILES_PER_DESIGN} file paths.`);
}

/** YAML keys arrive typed (`true`, `1`, `0.0`, `null`); upstream's JSON dialect uses their string spelling. */
function keyString(key: unknown, label: string): string {
  if (typeof key === "string") return key;
  if (typeof key === "number" && Number.isFinite(key)) return String(key);
  if (typeof key === "boolean") return String(key);
  if (key === null) return "null";
  return fail(`${label} has an unsupported key type.`);
}

function parseConditions(value: unknown, label: string): Conditions {
  if (!isMap(value)) fail(`${label} must be a mapping of annotation name to values.`);
  if (value.size > MAX_ANNOTATIONS) fail(`${label} has more than ${MAX_ANNOTATIONS} annotations.`);
  const result: Conditions = new Map();
  for (const [rawName, rawValues] of value) {
    if (typeof rawName !== "string" || !ANNOTATION_NAME.test(rawName)) fail(`${label} has an invalid annotation name.`);
    if (result.has(rawName)) fail(`${label} repeats annotation ${rawName}.`);
    if (!isMap(rawValues) || rawValues.size === 0 || rawValues.size > MAX_VALUES) fail(`${label}.${rawName} must map 1-${MAX_VALUES} values to selection lists.`);
    const values = new Map<string, ConditionEntry[]>();
    for (const [rawKey, rawEntries] of rawValues) {
      const key = keyString(rawKey, `${label}.${rawName}`);
      if (!VALUE_KEY.test(key) || key.startsWith("__")) fail(`${label}.${rawName} has an unsupported value key.`);
      if (values.has(key)) fail(`${label}.${rawName} repeats value ${key}.`);
      if (!Array.isArray(rawEntries) || rawEntries.length === 0 || rawEntries.length > MAX_ENTRIES) fail(`${label}.${rawName}.${key} must be a list of 1-${MAX_ENTRIES} selections.`);
      values.set(
        key,
        rawEntries.map((rawEntry, i) => {
          const where = `${label}.${rawName}.${key}[${i}]`;
          if (!isMap(rawEntry)) fail(`${where} must be a mapping with "select".`);
          const entry: ConditionEntry = new Map();
          for (const [field, fieldValue] of rawEntry) {
            if (field === "select") entry.set("select", text(fieldValue, `${where}.select`));
            else if (field === "group") {
              if (typeof fieldValue === "number" && Number.isSafeInteger(fieldValue)) entry.set("group", fieldValue);
              else entry.set("group", text(fieldValue, `${where}.group`));
            } else fail(`${where} has unsupported field ${String(field)}; only "select" and "group" are allowed.`);
          }
          if (!entry.has("select")) fail(`${where} needs a "select" string.`);
          return entry;
        }),
      );
    }
    result.set(rawName, values);
  }
  return result;
}

/** Reads, bounds and validates a condition spec. Pure with respect to the file's references. */
export function readSpec(specPath: string): ParsedSpec {
  if (!SPEC_EXTENSIONS.includes(path.extname(specPath).toLowerCase())) fail("RFD4-Proteina needs a .yaml, .yml or .json condition spec.");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(specPath);
  } catch {
    return fail("The condition spec is missing or unreadable.");
  }
  if (!stat.isFile() || stat.size === 0) fail("The condition spec must be a non-empty regular file.");
  if (stat.size > MAX_SPEC_BYTES) fail(`The condition spec is larger than ${MAX_SPEC_BYTES} bytes.`);
  const source = fs.readFileSync(specPath, "utf8");
  if (source.includes("\0")) fail("The condition spec contains a NUL byte.");
  // YAML 1.2 core schema: no custom tags, no merge keys, no aliases (entity-expansion guard),
  // duplicate keys are errors. JSON is a subset, so .json goes through the same parser.
  const doc = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) fail(`The condition spec is not valid YAML/JSON: ${problem.message.split("\n")[0]}`);
  let root: unknown;
  try {
    root = doc.toJS({ mapAsMap: true, maxAliasCount: 0 });
  } catch (error) {
    return fail(`The condition spec could not be read: ${(error as Error).message.split("\n")[0]}`);
  }
  if (!isMap(root) || root.size === 0) fail("The condition spec must be a non-empty mapping of design name to design.");

  let globalArgs: Map<unknown, unknown> = new Map();
  const rawDesigns: Array<[string, Map<unknown, unknown>]> = [];
  for (const [key, value] of root) {
    if (typeof key !== "string") fail("Design names must be strings.");
    if (key === "global_args") {
      if (!isMap(value)) fail("global_args must be a mapping.");
      globalArgs = value;
      continue;
    }
    if (!DESIGN_NAME.test(key)) fail(`Design name "${key.slice(0, 64)}" must match ${DESIGN_NAME} (letters, digits, "_" and "-"; used in output file names).`);
    if (!isMap(value)) fail(`Design ${key} must be a mapping.`);
    rawDesigns.push([key, value]);
  }
  if (rawDesigns.length === 0) fail("The condition spec defines no designs.");
  if (rawDesigns.length > MAX_DESIGNS) fail(`A run supports at most ${MAX_DESIGNS} designs; this spec has ${rawDesigns.length}.`);
  const lowered = new Set<string>();
  for (const [name] of rawDesigns) {
    if (lowered.has(name.toLowerCase())) fail(`Design names must be unique ignoring case: ${name}.`);
    lowered.add(name.toLowerCase());
  }
  for (const key of globalArgs.keys()) {
    if (!(DESIGN_FIELDS as readonly unknown[]).includes(key)) fail(`global_args has unsupported field ${String(key)}.`);
  }

  const designs: Design[] = rawDesigns.map(([name, own]) => {
    for (const key of own.keys()) {
      if (!(DESIGN_FIELDS as readonly unknown[]).includes(key)) fail(`Design ${name} has unsupported field ${String(key)}; allowed: ${DESIGN_FIELDS.join(", ")}.`);
    }
    // Shallow merge, per-design values win: upstream's `{**global_args, **example}`.
    const effective = new Map<unknown, unknown>([...globalArgs, ...own]);
    if (!effective.has("input")) fail(`Design ${name} needs an "input" structure (directly or via global_args).`);
    const design: Design = { name, input: parseInput(effective.get("input"), `Design ${name} input`) };
    if (effective.has("input_as_annotated_cif")) {
      const flag = effective.get("input_as_annotated_cif");
      if (typeof flag !== "boolean") fail(`Design ${name} input_as_annotated_cif must be true or false.`);
      design.inputAsAnnotatedCif = flag;
    }
    if (effective.has("contig")) design.contig = text(effective.get("contig"), `Design ${name} contig`);
    if (effective.has("conditions")) design.conditions = parseConditions(effective.get("conditions"), `Design ${name} conditions`);
    return design;
  });

  if (specInputs({ designs }).length > MAX_INPUT_FILES) fail(`A spec may reference at most ${MAX_INPUT_FILES} distinct structure files.`);
  return { designs };
}

/** Distinct input files in first-appearance order across designs. */
export function specInputs(spec: ParsedSpec): string[] {
  const seen = new Set<string>();
  for (const design of spec.designs) for (const file of Array.isArray(design.input) ? design.input : [design.input]) seen.add(file);
  return [...seen];
}

/**
 * Companion ids are adapter-owned and deterministic (`input-<n>`, first-appearance order), so
 * the same id maps to the same file whether computed from the original spec at submission or
 * from the stored copy at run time. A file shared by several designs is staged once.
 */
export function companionRefs(spec: ParsedSpec): CompanionInputRef[] {
  return specInputs(spec).map((sourcePath, n) => ({ id: `input-${n}`, sourcePath }));
}

function toJson(value: unknown): string {
  if (value instanceof Map) return `{${[...value].map(([k, v]) => `${JSON.stringify(String(k))}:${toJson(v)}`).join(",")}}`;
  if (Array.isArray(value)) return `[${value.map(toJson).join(",")}]`;
  return JSON.stringify(value);
}

/**
 * The JSON handed to upstream: `global_args` flattened into every design, every `input`
 * rewritten to its staged absolute copy, object key order preserved.
 */
export function resolvedSpecJson(spec: ParsedSpec, staged: ReadonlyMap<string, string>): string {
  const stagedPath = (file: string): string => staged.get(file) ?? fail(`Internal error: no staged copy for ${file}.`);
  const out = new Map<string, Map<string, unknown>>();
  for (const design of spec.designs) {
    const entry = new Map<string, unknown>();
    entry.set("input", Array.isArray(design.input) ? design.input.map(stagedPath) : stagedPath(design.input));
    if (design.inputAsAnnotatedCif !== undefined) entry.set("input_as_annotated_cif", design.inputAsAnnotatedCif);
    if (design.contig !== undefined) entry.set("contig", design.contig);
    if (design.conditions !== undefined) entry.set("conditions", design.conditions);
    out.set(design.name, entry);
  }
  return `${toJson(out)}\n`;
}
