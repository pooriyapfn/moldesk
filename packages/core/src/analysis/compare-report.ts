// The overlay report for `moldesk compare --report`: both structures in one scene, B moved onto A,
// a per-residue deviation chart and the residues above a threshold highlighted. Everything is plain
// v1 report content (a scene transform, residue components, a JSON dataset and a line chart panel).
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { exportReport, REPORT_LIMITS, type ResidueRef, type SceneComponent, type ViewerBundle } from "@moldesk/visualizer";
import { MoldeskError } from "../errors.js";
import { asMoldeskError, publishReport, type PublishedReport } from "../visualization.js";
import type { CompareResult, MappedResidue } from "./compare.js";

export const DEFAULT_DEVIATION_THRESHOLD = 2;
const MAX_DEVIATION_THRESHOLD = 100;

const COLOR_A = "#4ea1ff";
const COLOR_B = "#ffa94d";
const COLOR_DEVIATION = "#ff3b30";

type Matrix = number[][];

/** Inverse of a rigid 4x4 (rotation + translation): R^T and -R^T t. */
export function invertRigid(m: Matrix): Matrix {
  const rt = [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[j][i]));
  const t = [0, 1, 2].map((i) => -[0, 1, 2].reduce((sum, j) => sum + rt[i][j] * m[j][3], 0));
  return [[...rt[0], t[0]], [...rt[1], t[1]], [...rt[2], t[2]], [0, 0, 0, 1]];
}

/** Row-major 4x4 to the 16 column-major values a report's `SceneStructure.transform` takes (Mol* Mat4). */
export function toColumnMajor(m: Matrix): number[] {
  return Array.from({ length: 16 }, (_, k) => m[k % 4][Math.floor(k / 4)]);
}

/**
 * US-align's matrix moves A onto B. The overlay keeps A where it is and moves B onto A, so B carries the
 * inverse of that matrix, in column-major order.
 */
export function overlayTransformForB(matrixAtoB: Matrix): number[] {
  return toColumnMajor(invertRigid(matrixAtoB));
}

const label = (r: MappedResidue): string => `${r.chainAuthId}:${r.authSeqId}${r.insertionCode ?? ""}`;

const ref = (r: MappedResidue): ResidueRef => ({
  chainNamespace: "auth",
  chainId: r.chainAuthId,
  residueNamespace: "auth",
  sequenceId: r.authSeqId,
  ...(r.insertionCode ? { insertionCode: r.insertionCode } : {}),
});

/** One row per aligned pair, in alignment order. */
export function deviationRows(result: Pick<CompareResult, "mapping">, threshold: number) {
  return result.mapping.map((pair, i) => ({
    index: i + 1,
    chainA: pair.a.chainAuthId,
    a: label(pair.a),
    nameA: pair.a.name,
    b: label(pair.b),
    nameB: pair.b.name,
    deviation: pair.distance,
    aboveThreshold: pair.distance > threshold,
  }));
}

function tooMany(side: string): MoldeskError {
  return new MoldeskError({
    code: "SCENE_TOO_LARGE",
    message: `More than ${REPORT_LIMITS.maxResidueRefs} residues of structure ${side} are above the deviation threshold, the limit of one report selection.`,
    remediation: "Raise --deviation-threshold.",
  });
}

export interface ComparisonReportOptions {
  outputPath: string;
  deviationThreshold?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to the installed viewer bundle. */
  bundle?: ViewerBundle;
}

export function checkDeviationThreshold(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_DEVIATION_THRESHOLD) {
    throw new MoldeskError({
      code: "INVALID_COMPARE_ARGS",
      message: `Invalid deviation threshold ${value}.`,
      remediation: `Use a number of Å greater than 0 and at most ${MAX_DEVIATION_THRESHOLD}.`,
    });
  }
  return value;
}

/** Builds and writes the overlay report for a finished comparison. */
export async function createComparisonReport(result: CompareResult, options: ComparisonReportOptions): Promise<PublishedReport & { deviationThreshold: number; residuesAboveThreshold: number }> {
  const threshold = checkDeviationThreshold(options.deviationThreshold ?? DEFAULT_DEVIATION_THRESHOLD);
  const bytes = (side: "a" | "b"): Buffer => {
    const input = result.inputs[side];
    const data = fs.readFileSync(input.path);
    if (createHash("sha256").update(data).digest("hex") !== input.sha256) {
      throw new MoldeskError({ code: "INPUT_CHANGED", message: `${path.basename(input.path)} changed while it was being compared.`, remediation: "Run the comparison again." });
    }
    return data;
  };
  const rows = deviationRows(result, threshold);
  const above = result.mapping.filter((p) => p.distance > threshold);
  if (above.length > REPORT_LIMITS.maxResidueRefs) throw tooMany("A");

  const chains = (side: "a" | "b") => ({ kind: "chains", namespace: "auth", ids: result.chains[side] }) as const;
  const nameA = path.basename(result.inputs.a.path);
  const nameB = path.basename(result.inputs.b.path);
  const components: SceneComponent[] = [
    { id: "a", structureId: "a", selection: chains("a"), label: `A: ${nameA}`, representation: "cartoon", color: COLOR_A },
    { id: "b", structureId: "b", selection: chains("b"), label: `B: ${nameB}`, representation: "cartoon", color: COLOR_B },
    ...(above.length > 0
      ? ([
          { id: "a-deviation", structureId: "a", selection: { kind: "residues", residues: above.map((p) => ref(p.a)) }, label: `A above ${threshold} Å`, representation: "sticks", color: COLOR_DEVIATION },
          { id: "b-deviation", structureId: "b", selection: { kind: "residues", residues: above.map((p) => ref(p.b)) }, label: `B above ${threshold} Å`, representation: "sticks", color: COLOR_DEVIATION },
        ] satisfies SceneComponent[])
      : []),
  ];

  const id = randomUUID();
  const dataset = new TextEncoder().encode(`${JSON.stringify({ rows })}\n`);
  let exported;
  try {
    exported = exportReport(
      {
        id,
        title: `${nameA} vs ${nameB}`,
        resources: [
          { id: "structure-a", label: nameA, format: result.inputs.a.format, bytes: bytes("a") },
          { id: "structure-b", label: nameB, format: result.inputs.b.format, bytes: bytes("b") },
          { id: "deviation", label: "deviation.json", format: "json", bytes: dataset },
        ],
        scenes: [
          {
            id: "overlay",
            title: `${nameB} moved onto ${nameA}`,
            structures: [
              { id: "a", resourceId: "structure-a" },
              { id: "b", resourceId: "structure-b", transform: overlayTransformForB(result.transform.matrix) },
            ],
            components,
          },
        ],
        panels: [
          { id: "structures", kind: "structure", sceneIds: ["overlay"] },
          {
            id: "deviation-chart",
            kind: "chart",
            title: `Deviation after superposition (residues above ${threshold} Å highlighted)`,
            dataset: { resourceId: "deviation", rowsKey: "rows" },
            chart: {
              type: "line",
              x: { field: "index", label: "Aligned residue" },
              y: { field: "deviation", label: "Deviation", unit: "Å" },
              ...(result.mode === "multimer" ? { seriesField: "chainA" } : {}),
            },
          },
        ],
        provenance: {},
      },
      options.bundle,
    );
  } catch (error) {
    throw asMoldeskError(error);
  }
  return { ...(await publishReport(exported, id, options)), deviationThreshold: threshold, residuesAboveThreshold: above.length };
}
