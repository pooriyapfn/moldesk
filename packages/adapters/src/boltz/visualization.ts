import path from "node:path";
import type { ReportDescription } from "@moldesk/visualizer/contract";
import type { CollectedOutput } from "../index.js";
import { ReportBuilder } from "../visualization.js";

const STRUCTURE = /^(.+)_model_(\d+)\.cif$/;

interface Prediction {
  path: string;
  dir: string;
  record: string;
  model: number;
}

/**
 * One scene per predicted structure. Boltz's `_model_<n>` is an identifier (it is not
 * ranked by confidence), so it only orders scenes deterministically; titles are
 * "Prediction 1…", and no `rank` is set. Confidence/affinity files are attached only by
 * exact name next to the structure — never by position in a sorted list.
 */
export function describeBoltzVisualization(
  inputPath: string,
  outputs: readonly CollectedOutput[],
): ReportDescription | undefined {
  const exact = (id: string) => new Map(outputs.filter((o) => o.id === id).map((o) => [o.path, o]));
  const confidence = exact("confidence");
  const affinity = exact("affinity");

  const predictions: Prediction[] = [];
  for (const output of outputs) {
    if (output.id !== "structures") continue;
    const match = STRUCTURE.exec(path.basename(output.path));
    if (!match) continue;
    predictions.push({ path: output.path, dir: path.dirname(output.path), record: match[1], model: Number(match[2]) });
  }
  if (predictions.length === 0) return undefined;
  predictions.sort((a, b) => a.dir.localeCompare(b.dir) || a.model - b.model);

  const records = new Set(predictions.map((p) => p.dir));
  const builder = new ReportBuilder();
  const positionInRecord = new Map<string, number>();
  const affinityDone = new Set<string>();

  for (const p of predictions) {
    const k = (positionInRecord.get(p.dir) ?? 0) + 1;
    positionInRecord.set(p.dir, k);
    const title = records.size > 1 ? `${p.record} — Prediction ${k}` : `Prediction ${k}`;
    const sceneId = `scene-${builder.sceneCount + 1}`;
    builder.scene({
      id: sceneId,
      title,
      structures: [
        { id: "structure-1", resourceId: builder.resource({ kind: "output", path: p.path }, "mmcif", path.basename(p.path)) },
      ],
    });

    const conf = confidence.get(path.join(p.dir, `confidence_${p.record}_model_${p.model}.json`));
    if (conf) builder.table(`Confidence — ${title}`, builder.resource({ kind: "output", path: conf.path }, "json", path.basename(conf.path)));

    const aff = affinity.get(path.join(p.dir, `affinity_${p.record}.json`));
    if (aff && !affinityDone.has(aff.path)) {
      affinityDone.add(aff.path);
      builder.table(`Affinity — ${p.record}`, builder.resource({ kind: "output", path: aff.path }, "json", path.basename(aff.path)));
    }
  }
  return builder.build(`Boltz — ${path.basename(inputPath)}`);
}
