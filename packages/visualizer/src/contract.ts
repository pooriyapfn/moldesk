// Browser-neutral report contract: types plus runtime validation.
// No Node or DOM imports; used by adapters (types), the exporter and the viewer.

import { REPORT_LIMITS as L } from "./limits.js";

export { REPORT_LIMITS } from "./limits.js";

export type MolecularFormat = "pdb" | "mmcif" | "sdf";
export type DataFormat = "json" | "csv";
export type ResourceFormat = MolecularFormat | DataFormat;

export type SourceRef = { kind: "output"; path: string } | { kind: "input"; path: string };

export type MolecularSelection =
  | { kind: "all" }
  | {
      kind: "molecule";
      type: "protein" | "dna" | "rna" | "nucleic" | "ligand" | "ion" | "water";
    }
  | { kind: "chains"; namespace: "label" | "auth"; ids: string[] }
  | { kind: "entities"; ids: string[] }
  | { kind: "residues"; residues: ResidueRef[] };

export interface ResidueRef {
  chainNamespace: "label" | "auth";
  chainId: string;
  residueNamespace: "label" | "auth";
  sequenceId: number;
  insertionCode?: string;
}

export interface SceneStructure {
  id: string;
  resourceId: string;
  /** Zero-based model index within the source file. */
  modelIndex?: number;
  assemblyId?: string;
  /** 16 finite values, column-major (Mol* Mat4 / WebGL convention). */
  transform?: number[];
}

export interface SceneComponent {
  id: string;
  structureId: string;
  selection: MolecularSelection;
  label?: string;
  role?: "target" | "binder" | "receptor" | "ligand";
  representation?: "cartoon" | "sticks" | "surface";
  /** `#rrggbb` only. */
  color?: string;
}

export interface Scene {
  id: string;
  title: string;
  /** Only set from verified ranking information. */
  rank?: number;
  structures: SceneStructure[];
  components?: SceneComponent[];
}

export interface DatasetRef {
  resourceId: string;
  /** Own array property of a JSON root object. */
  rowsKey?: string;
}

export interface Column {
  field: string;
  label: string;
  unit?: string;
}

export type ChartSpec =
  | { type: "line" | "scatter" | "bar"; x: Column; y: Column; seriesField?: string }
  | { type: "heatmap"; x: Column; y: Column; value: Column };

export type Panel =
  | { id: string; kind: "structure"; sceneIds: string[] }
  | { id: string; kind: "table"; title?: string; dataset: DatasetRef; columns: Column[] }
  | { id: string; kind: "chart"; title?: string; dataset: DatasetRef; chart: ChartSpec };

/** What an adapter returns: references to files, resolved by the exporter. */
export interface ReportDescription {
  title: string;
  resources: Array<{ id: string; source: SourceRef; format: ResourceFormat; label: string }>;
  scenes: Scene[];
  panels: Panel[];
}

export interface ReportResource {
  id: string;
  label: string;
  format: ResourceFormat;
  /** SHA-256 (hex) of the original bytes. */
  sha256: string;
  sizeBytes: number;
  encoding: "base64";
  /** Original bytes, base64. Never regenerated coordinates. */
  data: string;
}

export interface MolecularReportV1 {
  schemaVersion: 1;
  id: string;
  title: string;
  resources: ReportResource[];
  scenes: Scene[];
  panels: Panel[];
  provenance: { createdAt: string; runId?: string; model?: string; modelVersion?: string };
}

export class ContractError extends Error {
  readonly code = "INVALID_REPORT";
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

const MOLECULAR_FORMATS: readonly string[] = ["pdb", "mmcif", "sdf"];
const DATA_FORMATS: readonly string[] = ["json", "csv"];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function isMolecularFormat(format: string): format is MolecularFormat {
  return MOLECULAR_FORMATS.includes(format);
}

export function isDataFormat(format: string): format is DataFormat {
  return DATA_FORMATS.includes(format);
}

function fail(where: string, message: string): never {
  throw new ContractError(`${where}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads only own, non-prototype-sensitive properties; rejects unknown keys. */
function object(value: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) fail(where, "expected an object");
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(where, `forbidden key "${key}"`);
    if (!allowed.includes(key)) fail(where, `unknown key "${key}"`);
  }
  return value;
}

function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function str(value: unknown, where: string, max: number, opts: { empty?: boolean } = {}): string {
  if (typeof value !== "string") fail(where, "expected a string");
  if (!opts.empty && value.length === 0) fail(where, "must not be empty");
  if (value.length > max) fail(where, `longer than ${max} characters`);
  return value;
}

function id(value: unknown, where: string): string {
  const s = str(value, where, L.maxIdLength);
  if (!ID_PATTERN.test(s)) fail(where, "invalid identifier");
  return s;
}

function list(value: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(where, "expected an array");
  if (value.length > max) fail(where, `more than ${max} entries`);
  return value;
}

function finite(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(where, "expected a finite number");
  return value;
}

function int(value: unknown, where: string, min = 0): number {
  const n = finite(value, where);
  if (!Number.isInteger(n) || n < min) fail(where, `expected an integer >= ${min}`);
  return n;
}

function oneOf<T extends string>(value: unknown, where: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(where, `expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function unique(set: Set<string>, value: string, where: string): void {
  if (set.has(value)) fail(where, `duplicate id "${value}"`);
  set.add(value);
}

function validateColumn(value: unknown, where: string): Column {
  const o = object(value, where, ["field", "label", "unit"]);
  const unit = own(o, "unit");
  return {
    field: str(own(o, "field"), `${where}.field`, L.maxFieldLength),
    label: str(own(o, "label"), `${where}.label`, L.maxLabelLength),
    ...(unit === undefined ? {} : { unit: str(unit, `${where}.unit`, 32) }),
  };
}

function validateSelection(value: unknown, where: string): MolecularSelection {
  if (!isRecord(value)) fail(where, "expected an object");
  const kind = oneOf(own(value, "kind"), `${where}.kind`, [
    "all",
    "molecule",
    "chains",
    "entities",
    "residues",
  ] as const);
  switch (kind) {
    case "all":
      object(value, where, ["kind"]);
      return { kind };
    case "molecule": {
      const o = object(value, where, ["kind", "type"]);
      const type = oneOf(own(o, "type"), `${where}.type`, [
        "protein",
        "dna",
        "rna",
        "nucleic",
        "ligand",
        "ion",
        "water",
      ] as const);
      return { kind, type };
    }
    case "chains": {
      const o = object(value, where, ["kind", "namespace", "ids"]);
      return {
        kind,
        namespace: oneOf(own(o, "namespace"), `${where}.namespace`, ["label", "auth"] as const),
        ids: list(own(o, "ids"), `${where}.ids`, L.maxSelectionIds).map((v, i) =>
          str(v, `${where}.ids[${i}]`, 16),
        ),
      };
    }
    case "entities": {
      const o = object(value, where, ["kind", "ids"]);
      return {
        kind,
        ids: list(own(o, "ids"), `${where}.ids`, L.maxSelectionIds).map((v, i) =>
          str(v, `${where}.ids[${i}]`, 16),
        ),
      };
    }
    case "residues": {
      const o = object(value, where, ["kind", "residues"]);
      const residues = list(own(o, "residues"), `${where}.residues`, L.maxResidueRefs).map((v, i) => {
        const w = `${where}.residues[${i}]`;
        const r = object(v, w, [
          "chainNamespace",
          "chainId",
          "residueNamespace",
          "sequenceId",
          "insertionCode",
        ]);
        const ins = own(r, "insertionCode");
        return {
          chainNamespace: oneOf(own(r, "chainNamespace"), `${w}.chainNamespace`, ["label", "auth"] as const),
          chainId: str(own(r, "chainId"), `${w}.chainId`, 16),
          residueNamespace: oneOf(own(r, "residueNamespace"), `${w}.residueNamespace`, [
            "label",
            "auth",
          ] as const),
          sequenceId: int(own(r, "sequenceId"), `${w}.sequenceId`, -1_000_000),
          ...(ins === undefined ? {} : { insertionCode: str(ins, `${w}.insertionCode`, 1) }),
        } satisfies ResidueRef;
      });
      return { kind, residues };
    }
  }
}

function validateScene(value: unknown, where: string, resourceFormats: Map<string, string>): Scene {
  const o = object(value, where, ["id", "title", "rank", "structures", "components"]);
  const sceneId = id(own(o, "id"), `${where}.id`);
  const rank = own(o, "rank");
  const structureIds = new Set<string>();
  const structures = list(own(o, "structures"), `${where}.structures`, L.maxStructuresPerScene).map((v, i) => {
    const w = `${where}.structures[${i}]`;
    const s = object(v, w, ["id", "resourceId", "modelIndex", "assemblyId", "transform"]);
    const structureId = id(own(s, "id"), `${w}.id`);
    unique(structureIds, structureId, w);
    const resourceId = id(own(s, "resourceId"), `${w}.resourceId`);
    const format = resourceFormats.get(resourceId);
    if (format === undefined) fail(w, `unknown resource "${resourceId}"`);
    if (!isMolecularFormat(format)) fail(w, `resource "${resourceId}" is not a molecular format`);
    const modelIndex = own(s, "modelIndex");
    const assemblyId = own(s, "assemblyId");
    const transform = own(s, "transform");
    return {
      id: structureId,
      resourceId,
      ...(modelIndex === undefined ? {} : { modelIndex: int(modelIndex, `${w}.modelIndex`) }),
      ...(assemblyId === undefined ? {} : { assemblyId: str(assemblyId, `${w}.assemblyId`, 32) }),
      ...(transform === undefined
        ? {}
        : {
            transform: (() => {
              const t = list(transform, `${w}.transform`, 16);
              if (t.length !== 16) fail(`${w}.transform`, "expected exactly 16 values");
              return t.map((n, k) => finite(n, `${w}.transform[${k}]`));
            })(),
          }),
    } satisfies SceneStructure;
  });
  if (structures.length === 0) fail(where, "scene needs at least one structure");

  const componentIds = new Set<string>();
  const rawComponents = own(o, "components");
  const components =
    rawComponents === undefined
      ? undefined
      : list(rawComponents, `${where}.components`, L.maxComponentsPerScene).map((v, i) => {
          const w = `${where}.components[${i}]`;
          const c = object(v, w, ["id", "structureId", "selection", "label", "role", "representation", "color"]);
          const componentId = id(own(c, "id"), `${w}.id`);
          unique(componentIds, componentId, w);
          const structureId = id(own(c, "structureId"), `${w}.structureId`);
          if (!structureIds.has(structureId)) fail(w, `unknown structure "${structureId}"`);
          const label = own(c, "label");
          const role = own(c, "role");
          const representation = own(c, "representation");
          const color = own(c, "color");
          if (color !== undefined && (typeof color !== "string" || !COLOR_PATTERN.test(color))) {
            fail(`${w}.color`, "expected #rrggbb");
          }
          return {
            id: componentId,
            structureId,
            selection: validateSelection(own(c, "selection"), `${w}.selection`),
            ...(label === undefined ? {} : { label: str(label, `${w}.label`, L.maxLabelLength) }),
            ...(role === undefined
              ? {}
              : { role: oneOf(role, `${w}.role`, ["target", "binder", "receptor", "ligand"] as const) }),
            ...(representation === undefined
              ? {}
              : {
                  representation: oneOf(representation, `${w}.representation`, [
                    "cartoon",
                    "sticks",
                    "surface",
                  ] as const),
                }),
            ...(color === undefined ? {} : { color: color as string }),
          } satisfies SceneComponent;
        });

  return {
    id: sceneId,
    title: str(own(o, "title"), `${where}.title`, L.maxLabelLength),
    ...(rank === undefined ? {} : { rank: int(rank, `${where}.rank`, 1) }),
    structures,
    ...(components === undefined ? {} : { components }),
  };
}

function validateDataset(value: unknown, where: string, resourceFormats: Map<string, string>): DatasetRef {
  const o = object(value, where, ["resourceId", "rowsKey"]);
  const resourceId = id(own(o, "resourceId"), `${where}.resourceId`);
  const format = resourceFormats.get(resourceId);
  if (format === undefined) fail(where, `unknown resource "${resourceId}"`);
  if (!isDataFormat(format)) fail(where, `resource "${resourceId}" is not a data format`);
  const rowsKey = own(o, "rowsKey");
  if (rowsKey !== undefined) {
    const key = str(rowsKey, `${where}.rowsKey`, L.maxFieldLength);
    if (FORBIDDEN_KEYS.has(key)) fail(`${where}.rowsKey`, "forbidden key");
    if (format !== "json") fail(`${where}.rowsKey`, "only valid for json resources");
    return { resourceId, rowsKey: key };
  }
  return { resourceId };
}

function validatePanel(
  value: unknown,
  where: string,
  resourceFormats: Map<string, string>,
  sceneIds: Set<string>,
): Panel {
  if (!isRecord(value)) fail(where, "expected an object");
  const kind = oneOf(own(value, "kind"), `${where}.kind`, ["structure", "table", "chart"] as const);
  if (kind === "structure") {
    const o = object(value, where, ["id", "kind", "sceneIds"]);
    const ids = list(own(o, "sceneIds"), `${where}.sceneIds`, L.maxScenes).map((v, i) => {
      const sid = id(v, `${where}.sceneIds[${i}]`);
      if (!sceneIds.has(sid)) fail(where, `unknown scene "${sid}"`);
      return sid;
    });
    return { id: id(own(o, "id"), `${where}.id`), kind, sceneIds: ids };
  }
  if (kind === "table") {
    const o = object(value, where, ["id", "kind", "title", "dataset", "columns"]);
    const title = own(o, "title");
    return {
      id: id(own(o, "id"), `${where}.id`),
      kind,
      ...(title === undefined ? {} : { title: str(title, `${where}.title`, L.maxLabelLength) }),
      dataset: validateDataset(own(o, "dataset"), `${where}.dataset`, resourceFormats),
      columns: list(own(o, "columns"), `${where}.columns`, L.maxColumns).map((c, i) =>
        validateColumn(c, `${where}.columns[${i}]`),
      ),
    };
  }
  const o = object(value, where, ["id", "kind", "title", "dataset", "chart"]);
  const title = own(o, "title");
  const chartRaw = own(o, "chart");
  if (!isRecord(chartRaw)) fail(`${where}.chart`, "expected an object");
  const type = oneOf(own(chartRaw, "type"), `${where}.chart.type`, [
    "line",
    "scatter",
    "bar",
    "heatmap",
  ] as const);
  let chart: ChartSpec;
  if (type === "heatmap") {
    const c = object(chartRaw, `${where}.chart`, ["type", "x", "y", "value"]);
    chart = {
      type,
      x: validateColumn(own(c, "x"), `${where}.chart.x`),
      y: validateColumn(own(c, "y"), `${where}.chart.y`),
      value: validateColumn(own(c, "value"), `${where}.chart.value`),
    };
  } else {
    const c = object(chartRaw, `${where}.chart`, ["type", "x", "y", "seriesField"]);
    const seriesField = own(c, "seriesField");
    chart = {
      type,
      x: validateColumn(own(c, "x"), `${where}.chart.x`),
      y: validateColumn(own(c, "y"), `${where}.chart.y`),
      ...(seriesField === undefined
        ? {}
        : { seriesField: str(seriesField, `${where}.chart.seriesField`, L.maxFieldLength) }),
    };
  }
  return {
    id: id(own(o, "id"), `${where}.id`),
    kind,
    ...(title === undefined ? {} : { title: str(title, `${where}.title`, L.maxLabelLength) }),
    dataset: validateDataset(own(o, "dataset"), `${where}.dataset`, resourceFormats),
    chart,
  };
}

function validateScenesAndPanels(
  scenesRaw: unknown,
  panelsRaw: unknown,
  resourceFormats: Map<string, string>,
): { scenes: Scene[]; panels: Panel[] } {
  const sceneIds = new Set<string>();
  const scenes = list(scenesRaw, "scenes", L.maxScenes).map((s, i) => {
    const scene = validateScene(s, `scenes[${i}]`, resourceFormats);
    unique(sceneIds, scene.id, `scenes[${i}]`);
    return scene;
  });
  const panelIds = new Set<string>();
  const panels = list(panelsRaw, "panels", L.maxPanels).map((p, i) => {
    const panel = validatePanel(p, `panels[${i}]`, resourceFormats, sceneIds);
    unique(panelIds, panel.id, `panels[${i}]`);
    return panel;
  });
  return { scenes, panels };
}

function validateResourceHeader(o: Record<string, unknown>, where: string) {
  return {
    id: id(own(o, "id"), `${where}.id`),
    label: str(own(o, "label"), `${where}.label`, L.maxLabelLength),
    format: oneOf(own(o, "format"), `${where}.format`, [...MOLECULAR_FORMATS, ...DATA_FORMATS] as ResourceFormat[]),
  };
}

/** Validates an adapter-provided description. Sources are checked for shape only. */
export function validateDescription(value: unknown): ReportDescription {
  const o = object(value, "description", ["title", "resources", "scenes", "panels"]);
  const formats = new Map<string, string>();
  const resources = list(own(o, "resources"), "resources", L.maxResources).map((r, i) => {
    const w = `resources[${i}]`;
    const ro = object(r, w, ["id", "source", "format", "label"]);
    const header = validateResourceHeader(ro, w);
    unique(new Set(formats.keys()), header.id, w);
    formats.set(header.id, header.format);
    const so = object(own(ro, "source"), `${w}.source`, ["kind", "path"]);
    const path = str(own(so, "path"), `${w}.source.path`, 4096);
    if (URL_LIKE.test(path) && !/^[a-zA-Z]:[\\/]/.test(path)) fail(`${w}.source.path`, "URLs are not allowed");
    return {
      id: header.id,
      source: { kind: oneOf(own(so, "kind"), `${w}.source.kind`, ["output", "input"] as const), path },
      format: header.format,
      label: header.label,
    };
  });
  const { scenes, panels } = validateScenesAndPanels(own(o, "scenes"), own(o, "panels"), formats);
  return { title: str(own(o, "title"), "title", L.maxTitleLength), resources, scenes, panels };
}

/** Structural validation of an exported report. Hash/size integrity is checked by the decoder. */
export function validateReport(value: unknown): MolecularReportV1 {
  const o = object(value, "report", ["schemaVersion", "id", "title", "resources", "scenes", "panels", "provenance"]);
  if (own(o, "schemaVersion") !== 1) fail("report.schemaVersion", "unsupported schema version");
  const formats = new Map<string, string>();
  let total = 0;
  const resources = list(own(o, "resources"), "resources", L.maxResources).map((r, i) => {
    const w = `resources[${i}]`;
    const ro = object(r, w, ["id", "label", "format", "sha256", "sizeBytes", "encoding", "data"]);
    const header = validateResourceHeader(ro, w);
    if (formats.has(header.id)) fail(w, `duplicate id "${header.id}"`);
    formats.set(header.id, header.format);
    const sha256 = own(ro, "sha256");
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) fail(`${w}.sha256`, "expected lowercase hex SHA-256");
    const sizeBytes = int(own(ro, "sizeBytes"), `${w}.sizeBytes`);
    if (sizeBytes > L.maxResourceBytes) fail(w, "resource exceeds size limit");
    total += sizeBytes;
    if (total > L.maxTotalResourceBytes) fail("resources", "total size exceeds limit");
    if (own(ro, "encoding") !== "base64") fail(`${w}.encoding`, "expected base64");
    const data = str(own(ro, "data"), `${w}.data`, Math.ceil((L.maxResourceBytes * 4) / 3) + 8, { empty: true });
    if (Math.ceil(sizeBytes / 3) * 4 !== data.length) fail(w, "data length does not match sizeBytes");
    return { ...header, sha256, sizeBytes, encoding: "base64" as const, data };
  });
  const { scenes, panels } = validateScenesAndPanels(own(o, "scenes"), own(o, "panels"), formats);
  const p = object(own(o, "provenance"), "provenance", ["createdAt", "runId", "model", "modelVersion"]);
  const runId = own(p, "runId");
  const model = own(p, "model");
  const modelVersion = own(p, "modelVersion");
  return {
    schemaVersion: 1,
    id: id(own(o, "id"), "id"),
    title: str(own(o, "title"), "title", L.maxTitleLength),
    resources,
    scenes,
    panels,
    provenance: {
      createdAt: str(own(p, "createdAt"), "provenance.createdAt", 64),
      ...(runId === undefined ? {} : { runId: str(runId, "provenance.runId", 128) }),
      ...(model === undefined ? {} : { model: str(model, "provenance.model", 128) }),
      ...(modelVersion === undefined ? {} : { modelVersion: str(modelVersion, "provenance.modelVersion", 128) }),
    },
  };
}
