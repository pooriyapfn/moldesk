// The "Scene API": `moldesk view --highlight/--color/--color-by/--scene`. Selectors and colors become
// plain `SceneComponent`s of the existing v1 report contract (no new fields), so reports stay
// readable by every viewer that reads v1.
import fs from "node:fs";
import path from "node:path";
import { REPORT_LIMITS, type MolecularSelection, type ResidueRef, type SceneComponent } from "@moldesk/visualizer";
import { MoldeskError } from "../errors.js";
import { parseSelector, type Selector } from "../schemas/selector.js";
import { resolveConfidence } from "./confidence.js";
import { matches, selectorNoMatch } from "./inspect.js";
import { parseStructure } from "./molstar-model.js";
import { readStructureInput } from "./structure-input.js";

export type ColorBy = "chain" | "plddt";
export type HighlightRepresentation = NonNullable<SceneComponent["representation"]>;

export interface HighlightSpec {
  selector: string;
  /** `#rrggbb`; a palette color is used when absent. */
  color?: string;
  label?: string;
  /** Default `sticks`: a second cartoon over the base cartoon would z-fight. */
  representation?: HighlightRepresentation;
}

/** What `--scene scene.json` holds; every CLI flag is shorthand for a field here. */
export interface ViewSpec {
  colorBy?: ColorBy;
  /** Selector chain and residue numbers are label ids instead of auth ids. */
  label?: boolean;
  bfactorIsPlddt?: boolean;
  components: HighlightSpec[];
}

export interface SceneFile extends ViewSpec {
  /** Structure path relative to the scene file; must stay inside its folder. */
  structure?: string;
}

/** AlphaFold DB confidence classes. */
export const PLDDT_BINS = [
  { id: "plddt-very-high", label: "pLDDT ≥ 90", min: 90, color: "#0053d6" },
  { id: "plddt-confident", label: "pLDDT 70-90", min: 70, color: "#65cbf3" },
  { id: "plddt-low", label: "pLDDT 50-70", min: 50, color: "#ffdb13" },
  { id: "plddt-very-low", label: "pLDDT < 50", min: -Infinity, color: "#ff7d45" },
] as const;

const HIGHLIGHT_PALETTE = ["#ff5500", "#ffd400", "#00c2ff", "#c264ff", "#7cff6b", "#ff4fa3"];
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_SCENE_FILE_BYTES = 1024 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function invalidScene(message: string): MoldeskError {
  return new MoldeskError({
    code: "INVALID_SCENE",
    message,
    remediation: 'A scene file looks like {"colorBy":"plddt","components":[{"selector":"A:40-60","color":"#ff5500"}]}. See docs/visualizer.md.',
  });
}

function checkKeys(value: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidScene(`${where}: expected an object`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw invalidScene(`${where}: forbidden key "${key}"`);
    if (!allowed.includes(key)) throw invalidScene(`${where}: unknown key "${key}"`);
  }
  return value as Record<string, unknown>;
}

export function parseColor(value: unknown, where: string): string {
  if (typeof value !== "string" || !COLOR.test(value)) throw invalidScene(`${where}: expected a color like #ff5500`);
  return value.toLowerCase();
}

export function parseColorBy(value: unknown, where = "colorBy"): ColorBy {
  if (value !== "chain" && value !== "plddt") throw invalidScene(`${where}: expected "chain" or "plddt"`);
  return value;
}

/** Validates scene JSON (already parsed). Selector syntax is checked later, with the structure. */
export function parseSceneFile(value: unknown): SceneFile {
  const o = checkKeys(value, "scene", ["structure", "colorBy", "label", "bfactorIsPlddt", "components"]);
  if (!Array.isArray(o.components)) throw invalidScene("scene.components: expected an array");
  if (o.components.length > REPORT_LIMITS.maxComponentsPerScene - 8) throw invalidScene("scene.components: too many components");
  for (const flag of ["label", "bfactorIsPlddt"]) {
    if (o[flag] !== undefined && typeof o[flag] !== "boolean") throw invalidScene(`scene.${flag}: expected a boolean`);
  }
  if (o.structure !== undefined && (typeof o.structure !== "string" || o.structure === "")) {
    throw invalidScene("scene.structure: expected a path");
  }
  return {
    ...(o.structure === undefined ? {} : { structure: o.structure as string }),
    ...(o.colorBy === undefined ? {} : { colorBy: parseColorBy(o.colorBy, "scene.colorBy") }),
    ...(o.label === undefined ? {} : { label: o.label as boolean }),
    ...(o.bfactorIsPlddt === undefined ? {} : { bfactorIsPlddt: o.bfactorIsPlddt as boolean }),
    components: o.components.map((c, i): HighlightSpec => {
      const where = `scene.components[${i}]`;
      const h = checkKeys(c, where, ["selector", "color", "label", "representation"]);
      if (typeof h.selector !== "string") throw invalidScene(`${where}.selector: expected a string`);
      if (h.label !== undefined && (typeof h.label !== "string" || h.label.length > REPORT_LIMITS.maxLabelLength)) {
        throw invalidScene(`${where}.label: expected a short string`);
      }
      if (h.representation !== undefined && !["cartoon", "sticks", "surface"].includes(h.representation as string)) {
        throw invalidScene(`${where}.representation: expected cartoon, sticks or surface`);
      }
      return {
        selector: h.selector,
        ...(h.color === undefined ? {} : { color: parseColor(h.color, `${where}.color`) }),
        ...(h.label === undefined ? {} : { label: h.label as string }),
        ...(h.representation === undefined ? {} : { representation: h.representation as HighlightRepresentation }),
      };
    }),
  };
}

/** Reads a scene file and resolves its structure path, which may not leave the scene's folder. */
export function readSceneFile(file: string): { scene: SceneFile; structurePath?: string } {
  const resolved = path.resolve(file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw invalidScene(`Scene file not found: ${resolved}`);
  }
  if (!stat.isFile() || stat.size > MAX_SCENE_FILE_BYTES) throw invalidScene(`${resolved} is not a regular file under ${MAX_SCENE_FILE_BYTES} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw invalidScene(`${path.basename(resolved)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const scene = parseSceneFile(json);
  if (scene.structure === undefined) return { scene };
  const dir = path.dirname(resolved);
  const structurePath = path.resolve(dir, scene.structure);
  const relative = path.relative(dir, structurePath);
  if (path.isAbsolute(scene.structure) || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw invalidScene("scene.structure must be a relative path inside the scene file's folder");
  }
  return { scene, structurePath };
}

function residueRef(selector: Selector, chainId: string, sequenceId: number, insertionCode?: string): ResidueRef {
  return {
    chainNamespace: selector.namespace,
    chainId,
    residueNamespace: selector.namespace,
    sequenceId,
    ...(insertionCode ? { insertionCode } : {}),
  };
}

function tooMany(what: string): MoldeskError {
  return new MoldeskError({
    code: "SCENE_TOO_LARGE",
    message: `${what} covers more than ${REPORT_LIMITS.maxResidueRefs} residues, the limit of one report selection.`,
    remediation: "Highlight a smaller range, or use color-by chain.",
  });
}

/** Turns a view spec into the scene components for one structure file. */
export async function buildSceneComponents(file: string, spec: ViewSpec, structureId = "structure-1"): Promise<SceneComponent[]> {
  const input = readStructureInput(file);
  const parsed = await parseStructure(input);
  const components: SceneComponent[] = [];

  const colorBy = spec.colorBy ?? "chain";
  if (colorBy === "chain") {
    // No color: the viewer colors by chain.
    components.push({ id: "base", structureId, selection: { kind: "all" }, label: "Structure", representation: "cartoon" });
  } else {
    const confidence = resolveConfidence(input, parsed, { bfactorIsPlddt: spec.bfactorIsPlddt });
    if (!confidence) {
      throw new MoldeskError({
        code: "PLDDT_UNAVAILABLE",
        message: "No known pLDDT source in this file, so it cannot be colored by pLDDT.",
        remediation: "Use a ModelCIF file or a MoleculeDesk Boltz output, or pass --bfactor-is-plddt if the B-factor column holds pLDDT.",
      });
    }
    const bins: ResidueRef[][] = PLDDT_BINS.map(() => []);
    for (const chain of parsed.chains) {
      for (const residue of chain.residues) {
        const value = confidence.plddt(chain, residue);
        if (value === null) continue;
        bins[PLDDT_BINS.findIndex((b) => value >= b.min)].push(
          residueRef({ namespace: "auth", chainId: chain.authId }, chain.authId, residue.authSeqId, residue.insertionCode),
        );
      }
    }
    PLDDT_BINS.forEach((bin, i) => {
      if (bins[i].length === 0) return;
      if (bins[i].length > REPORT_LIMITS.maxResidueRefs) throw tooMany(bin.label);
      components.push({
        id: bin.id,
        structureId,
        selection: { kind: "residues", residues: bins[i] },
        label: bin.label,
        representation: "cartoon",
        color: bin.color,
      });
    });
  }
  for (const type of ["ligand", "ion"] as const) {
    components.push({ id: type, structureId, selection: { kind: "molecule", type }, label: type === "ion" ? "Ions" : "Ligands", representation: "sticks" });
  }

  spec.components.forEach((highlight, i) => {
    const selector = parseSelector(highlight.selector, spec.label ? "label" : "auth");
    const residues: ResidueRef[] = [];
    let chainMatched = false;
    for (const chain of parsed.chains) {
      for (const residue of chain.residues) {
        if (!matches(selector, chain, residue)) continue;
        chainMatched = true;
        const id = selector.namespace === "auth" ? residue.authSeqId : residue.labelSeqId;
        if (id !== null) residues.push(residueRef(selector, selector.chainId, id, residue.insertionCode));
      }
    }
    if (!chainMatched) {
      throw selectorNoMatch("Highlight", highlight.selector, selector, parsed, input.path);
    }
    const wholeChain = selector.start === undefined;
    if (!wholeChain && residues.length > REPORT_LIMITS.maxResidueRefs) throw tooMany(`Highlight "${highlight.selector}"`);
    const selection: MolecularSelection = wholeChain
      ? { kind: "chains", namespace: selector.namespace, ids: [selector.chainId] }
      : { kind: "residues", residues };
    components.push({
      id: `highlight-${i + 1}`,
      structureId,
      selection,
      label: highlight.label ?? `Highlight ${highlight.selector}`,
      representation: highlight.representation ?? "sticks",
      color: highlight.color ?? HIGHLIGHT_PALETTE[i % HIGHLIGHT_PALETTE.length],
    });
  });
  return components;
}

export interface ViewRequest {
  file?: string;
  scene?: string;
  highlights?: string[];
  colors?: string[];
  colorBy?: string;
  label?: boolean;
  bfactorIsPlddt?: boolean;
}

function invalidView(message: string): MoldeskError {
  return new MoldeskError({ code: "INVALID_VIEW_INPUT", message, remediation: "See `moldesk view --help`." });
}

/** Combines `view`'s file argument, scene file and flags into one structure path plus an optional view spec. */
export function resolveViewRequest(request: ViewRequest): { file: string; view?: ViewSpec } {
  const highlights = request.highlights ?? [];
  const colors = (request.colors ?? []).map((c, i) => parseColor(c, `--color #${i + 1}`));
  if (request.scene !== undefined) {
    if (highlights.length > 0 || colors.length > 0 || request.colorBy !== undefined) {
      throw invalidView("--scene cannot be combined with --highlight, --color or --color-by; put them in the scene file.");
    }
    const { scene, structurePath } = readSceneFile(request.scene);
    if (request.file !== undefined && structurePath !== undefined) throw invalidView("Give the structure either as <file> or in the scene file, not both.");
    const file = request.file ?? structurePath;
    if (file === undefined) throw invalidView("Missing <file>: pass it as an argument or set \"structure\" in the scene file.");
    const { structure: _structure, ...view } = scene;
    return { file, view: { ...view, label: view.label || request.label, bfactorIsPlddt: view.bfactorIsPlddt || request.bfactorIsPlddt } };
  }
  if (request.file === undefined) throw invalidView("Missing <file>.");
  if (colors.length > 0 && highlights.length === 0) throw invalidView("--color needs at least one --highlight.");
  if (colors.length > 1 && colors.length !== highlights.length) {
    throw invalidView(`Give one --color for all highlights, or one per --highlight (${highlights.length}).`);
  }
  if (highlights.length === 0 && request.colorBy === undefined) return { file: request.file };
  return {
    file: request.file,
    view: {
      ...(request.colorBy === undefined ? {} : { colorBy: parseColorBy(request.colorBy, "--color-by") }),
      label: request.label,
      bfactorIsPlddt: request.bfactorIsPlddt,
      components: highlights.map((selector, i) => ({ selector, ...(colors.length > 0 ? { color: colors.length === 1 ? colors[0] : colors[i] } : {}) })),
    },
  };
}
