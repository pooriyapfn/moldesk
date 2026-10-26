import path from "node:path";
import type { ReportDescription } from "@moldesk/visualizer/contract";
import type { CollectedOutput } from "../index.js";
import { ReportBuilder } from "../visualization.js";
import type { ParsedSpec } from "./spec.js";

const SUFFIX = "_generated.cif";

/**
 * One scene per generated structure, in spec order then replicate order. Replicate numbers are
 * identifiers from the file name (`<design>_<i>`), not a quality ranking, so no `rank` is set.
 * Chains are not guessed to be "binder" or "target": the generated CIF carries upstream's own
 * per-atom annotations, and the report shows the structure as written.
 */
export function describeRfd4ProteinaVisualization(
  inputPath: string,
  spec: ParsedSpec,
  outputs: readonly CollectedOutput[],
): ReportDescription | undefined {
  const designOrder = new Map(spec.designs.map((design, index) => [design.name, index]));
  const structures = outputs
    .filter((output) => output.id === "generated_structures")
    .map((output) => {
      const id = path.basename(output.path).slice(0, -SUFFIX.length);
      const cut = id.lastIndexOf("_");
      const design = id.slice(0, cut);
      const replicate = Number(id.slice(cut + 1));
      return { output, design, replicate };
    })
    .filter((entry) => designOrder.has(entry.design) && Number.isInteger(entry.replicate) && entry.replicate >= 0)
    .sort((a, b) => designOrder.get(a.design)! - designOrder.get(b.design)! || a.replicate - b.replicate);
  if (structures.length === 0) return undefined;

  const single = structures.length === 1;
  const builder = new ReportBuilder();
  for (const { output, design, replicate } of structures) {
    builder.scene({
      id: `scene-${builder.sceneCount + 1}`,
      title: single ? design : `${design} · replicate ${replicate + 1}`,
      structures: [{ id: "structure-1", resourceId: builder.resource({ kind: "output", path: output.path }, "mmcif", path.basename(output.path)) }],
    });
  }
  return builder.build(`RFD4-Proteina — ${path.basename(inputPath)}`);
}
