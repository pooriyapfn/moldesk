import path from "node:path";
import type { ReportDescription } from "@moldesk/visualizer/contract";
import type { CollectedOutput } from "../index.js";
import { ReportBuilder } from "../visualization.js";

const STRUCTURE = /^(.+)_sample_(\d+)\.cif$/;
const SEED_DIR = /^seed_(\d+)$/;

interface Prediction {
  path: string;
  dir: string;
  job: string;
  seed: number;
  sample: number;
}

/**
 * One scene per (job, seed, sample) mmCIF. The adapter-written `.pdb` files are the same
 * prediction in another format, so they are never scenes. Summary confidence is matched
 * by exact job/seed/sample file name; the per-atom `full_data` files are not shown.
 */
export function describeOpenDdeVisualization(
  inputPath: string,
  outputs: readonly CollectedOutput[],
): ReportDescription | undefined {
  const summaries = new Map(outputs.filter((o) => o.id === "confidence").map((o) => [o.path, o]));

  const predictions: Prediction[] = [];
  for (const output of outputs) {
    if (output.id !== "structures") continue;
    const name = STRUCTURE.exec(path.basename(output.path));
    const dir = path.dirname(output.path);
    const seed = SEED_DIR.exec(path.basename(path.dirname(dir)));
    if (!name || !seed) continue;
    predictions.push({
      path: output.path,
      dir,
      job: name[1],
      seed: Number(seed[1]),
      sample: Number(name[2]),
    });
  }
  if (predictions.length === 0) return undefined;
  predictions.sort((a, b) => a.job.localeCompare(b.job) || a.seed - b.seed || a.sample - b.sample);

  const jobs = new Set(predictions.map((p) => p.job));
  const builder = new ReportBuilder();
  const positionInJob = new Map<string, number>();

  for (const p of predictions) {
    const k = (positionInJob.get(p.job) ?? 0) + 1;
    positionInJob.set(p.job, k);
    const label = `Prediction ${k} (seed ${p.seed}, sample ${p.sample})`;
    const title = jobs.size > 1 ? `${p.job} — ${label}` : label;
    builder.scene({
      id: `scene-${builder.sceneCount + 1}`,
      title,
      structures: [
        { id: "structure-1", resourceId: builder.resource({ kind: "output", path: p.path }, "mmcif", path.basename(p.path)) },
      ],
    });
    const summary = summaries.get(path.join(p.dir, `${p.job}_summary_confidence_sample_${p.sample}.json`));
    if (summary) {
      builder.table(`Confidence — ${title}`, builder.resource({ kind: "output", path: summary.path }, "json", path.basename(summary.path)));
    }
  }
  return builder.build(`OpenDDE — ${path.basename(inputPath)}`);
}
