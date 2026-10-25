import path from "node:path";
import { MoldeskError } from "../errors.js";
import { ENVELOPE_SCHEMA_VERSION, type AnalysisEnvelope } from "../schemas/envelope.js";
import { parseSelector, type Selector } from "../schemas/selector.js";
import { VERSION } from "../version.js";
import { chainType, NO_CONFIDENCE_WARNING, residueId, round, summarizeResidue, type ResidueId, type ResidueSummary } from "./analyze.js";
import { resolveConfidence } from "./confidence.js";
import { MOLSTAR_VERSION, parseStructure, type ParsedChain, type ParsedResidue, type ParsedStructure } from "./molstar-model.js";
import { readStructureInput } from "./structure-input.js";

export const DEFAULT_INSPECT_RADIUS = 5;
const MAX_INSPECT_RADIUS = 30;
/** Mol* keeps coordinates as float32, so a neighbour exactly at the radius can measure ~1e-5 Å beyond it. */
const RADIUS_TOLERANCE = 1e-4;

interface ChainRef {
  chainAuthId: string;
  chainLabelId: string;
}

export interface NeighborResidue extends ChainRef, ResidueId {
  name: string;
  /** Minimum heavy-atom distance to the inspected residue, Å. */
  distance: number;
  atoms: { selected: string; neighbor: string };
}

export interface InspectedResidue extends ChainRef, ResidueSummary {
  /** Heavy atoms. */
  atomCount: number;
  neighbors: NeighborResidue[];
}

export interface InspectResult {
  selector: { text: string; namespace: "auth" | "label" };
  radius: number;
  residues: InspectedResidue[];
}

export interface InspectOptions {
  /** Neighbour radius in Å. */
  radius?: number;
  /** Interpret the selector's chain and residue numbers as label ids instead of auth ids. */
  label?: boolean;
  bfactorIsPlddt?: boolean;
}

function usage(message: string): MoldeskError {
  return new MoldeskError({
    code: "INVALID_INSPECT_ARGS",
    message,
    remediation: `Use a radius greater than 0 and at most ${MAX_INSPECT_RADIUS} Å.`,
  });
}

export function matches(selector: Selector, chain: ParsedChain, residue: ParsedResidue): boolean {
  if ((selector.namespace === "auth" ? chain.authId : chain.labelId) !== selector.chainId) return false;
  if (selector.start === undefined || selector.end === undefined) return true;
  const number = selector.namespace === "auth" ? residue.authSeqId : residue.labelSeqId;
  if (number === null || number < selector.start || number > selector.end) return false;
  // A single-residue selector names one residue exactly, insertion code included (none = blank).
  return selector.start !== selector.end || (residue.insertionCode ?? "") === (selector.insertionCode ?? "");
}

/**
 * The error for a selector that selects nothing: says which part failed (no such chain, or no such
 * residue in an existing chain) and lists what the file does have, in both text and `details`.
 */
export function selectorNoMatch(what: string, text: string, selector: Selector, parsed: ParsedStructure, file: string): MoldeskError {
  const ns = selector.namespace;
  const chainId = (c: ParsedChain): string => (ns === "auth" ? c.authId : c.labelId);
  const available = parsed.chains
    .filter((c) => c.entityType !== "water")
    .map((c) => {
      const numbers = c.residues.map((r) => (ns === "auth" ? r.authSeqId : r.labelSeqId)).filter((n): n is number => n !== null);
      return {
        chainId: chainId(c),
        type: chainType(c),
        residueCount: c.residues.length,
        residues: numbers.length > 0 ? `${Math.min(...numbers)}-${Math.max(...numbers)}` : null,
      };
    });
  const known = available.filter((c) => c.chainId === selector.chainId);
  const reason = known.length === 0 ? "no-chain" : "no-residue";
  const wanted =
    selector.start === undefined ? "" : selector.start === selector.end ? `residue ${selector.start}${selector.insertionCode ?? ""}` : `residues ${selector.start}-${selector.end}`;
  const why =
    reason === "no-chain"
      ? `there is no chain "${selector.chainId}" (${ns} ids)`
      : `chain "${selector.chainId}" (${ns} ids) has ${known.map((c) => `${c.type} residues ${c.residues ?? "(unnumbered)"}`).join(" and ")}, but no ${wanted}`;
  return new MoldeskError({
    code: "SELECTOR_NO_MATCH",
    message: `${what} "${text}" matches nothing in ${path.basename(file)}: ${why}.`,
    remediation: `Available chains (${ns} ids): ${available.map((c) => `${c.chainId} (${c.type}, ${c.residues ?? "no numbering"})`).join("; ")}.${ns === "auth" ? " Use --label to read ids as label ids." : ""}`,
    details: { selector: text, namespace: ns, reason, available },
  });
}

/** Per-residue details and heavy-atom neighbours for a chain, residue or range, as a `moldesk.inspect` envelope. */
export async function inspectStructureFile(
  file: string,
  selectorText: string,
  options: InspectOptions = {},
): Promise<AnalysisEnvelope<InspectResult>> {
  const radius = options.radius ?? DEFAULT_INSPECT_RADIUS;
  if (!Number.isFinite(radius) || radius <= 0 || radius > MAX_INSPECT_RADIUS) {
    throw usage(`Invalid radius ${radius}.`);
  }
  const selector = parseSelector(selectorText, options.label ? "label" : "auth");
  const input = readStructureInput(file);
  const parsed = await parseStructure(input);
  const confidence = resolveConfidence(input, parsed, options);

  const selected: Array<{ c: number; r: number }> = [];
  parsed.chains.forEach((chain, c) =>
    chain.residues.forEach((residue, r) => {
      if (matches(selector, chain, residue)) selected.push({ c, r });
    }),
  );
  if (selected.length === 0) {
    throw selectorNoMatch("Selector", selectorText, selector, parsed, input.path);
  }

  // Uniform grid over all heavy atoms (cell = radius), so each lookup touches 27 cells.
  const { x, y, z, name, chain: atomChain, residue: atomResidue } = parsed.heavyAtoms;
  const cellOf = (v: number): number => Math.floor(v / radius);
  const cells = new Map<string, number[]>();
  const rangeOf = new Map<string, [number, number]>();
  for (let a = 0; a < x.length; a++) {
    const key = `${cellOf(x[a])},${cellOf(y[a])},${cellOf(z[a])}`;
    (cells.get(key) ?? cells.set(key, []).get(key)!).push(a);
    const owner = `${atomChain[a]}:${atomResidue[a]}`;
    const range = rangeOf.get(owner);
    if (range) range[1] = a + 1;
    else rangeOf.set(owner, [a, a + 1]);
  }

  const residues = selected.map(({ c, r }): InspectedResidue => {
    const chain = parsed.chains[c];
    const residue = chain.residues[r];
    const best = new Map<string, { c: number; r: number; d2: number; selected: string; neighbor: string }>();
    const [from, to] = rangeOf.get(`${c}:${r}`) ?? [0, 0];
    for (let a = from; a < to; a++) {
      const [cx, cy, cz] = [cellOf(x[a]), cellOf(y[a]), cellOf(z[a])];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            for (const b of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
              if (atomChain[b] === c && atomResidue[b] === r) continue;
              const d2 = (x[a] - x[b]) ** 2 + (y[a] - y[b]) ** 2 + (z[a] - z[b]) ** 2;
              if (d2 > (radius + RADIUS_TOLERANCE) ** 2) continue;
              const key = `${atomChain[b]}:${atomResidue[b]}`;
              const known = best.get(key);
              if (!known || d2 < known.d2 || (d2 === known.d2 && (name[a] < known.selected || (name[a] === known.selected && name[b] < known.neighbor)))) {
                best.set(key, { c: atomChain[b], r: atomResidue[b], d2, selected: name[a], neighbor: name[b] });
              }
            }
          }
    }
    const neighbors = [...best.values()]
      .map((n): NeighborResidue => {
        const other = parsed.chains[n.c];
        const o = other.residues[n.r];
        return {
          chainAuthId: other.authId,
          chainLabelId: other.labelId,
          ...residueId(o),
          name: o.name,
          distance: round(Math.sqrt(n.d2), 3),
          atoms: { selected: n.selected, neighbor: n.neighbor },
        };
      })
      .sort((p, q) => p.distance - q.distance || p.chainAuthId.localeCompare(q.chainAuthId) || p.authSeqId - q.authSeqId || (p.insertionCode ?? "").localeCompare(q.insertionCode ?? ""));
    return {
      chainAuthId: chain.authId,
      chainLabelId: chain.labelId,
      ...summarizeResidue(residue, confidence?.plddt(chain, residue) ?? null),
      atomCount: residue.atomCount,
      neighbors,
    };
  });

  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    kind: "moldesk.inspect",
    status: "ok",
    input: { path: input.path, format: input.format, sha256: input.sha256 },
    result: { selector: { text: selectorText, namespace: selector.namespace }, radius, residues },
    warnings: confidence ? [] : [NO_CONFIDENCE_WARNING],
    provenance: { moldeskVersion: VERSION, tool: { name: "molstar", version: MOLSTAR_VERSION } },
  };
}
