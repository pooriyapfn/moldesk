import fs from "node:fs";
import path from "node:path";
import { MoldeskError } from "@moldesk/registry";
import { csvRecords, parseCsv } from "@moldesk/visualizer/csv";
import { REPORT_LIMITS, type ReportDescription } from "@moldesk/visualizer/contract";
import type { CollectedOutput } from "../index.js";
import { ReportBuilder } from "../visualization.js";

function readBounded(file: string): string {
  if (fs.statSync(file).size > REPORT_LIMITS.maxResourceBytes) {
    throw new MoldeskError({ code: "VISUALIZATION_SOURCE_TOO_LARGE", message: `${path.basename(file)} is too large to show.`, remediation: "Use --no-visualize." });
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * The accepted structure for a ranked design is `<design>.cif`, or `<design>_*.cif` other
 * than `<design>_monomer.cif` — the same rule the adapter's result probe enforces. Never
 * guessed: more than one candidate is an error.
 */
function structureFor(design: string, accepted: readonly CollectedOutput[]): CollectedOutput {
  const exact = accepted.find((o) => path.basename(o.path) === `${design}.cif`);
  if (exact) return exact;
  const candidates = accepted.filter((o) => {
    const name = path.basename(o.path);
    return name.startsWith(`${design}_`) && name.endsWith(".cif") && name !== `${design}_monomer.cif`;
  });
  if (candidates.length !== 1) {
    throw new MoldeskError({
      code: "VISUALIZATION_AMBIGUOUS_STRUCTURE",
      message: `${candidates.length === 0 ? "No" : "More than one"} accepted structure matches design "${design}".`,
      remediation: "Use --no-visualize.",
    });
  }
  return candidates[0]!;
}

/**
 * Accepted/ranked designs first (rank taken from the ranked table, never invented), then
 * refolded structures, then raw trajectories. A lower tier is included only as a whole and
 * only if every scene fits the report limit, so no tier is ever cut off partway.
 */
export function describeBindCraft2Visualization(
  inputPath: string,
  outputs: readonly CollectedOutput[],
): ReportDescription | undefined {
  const of = (id: string) => outputs.filter((o) => o.id === id).sort((a, b) => a.path.localeCompare(b.path));
  const ranked = of("ranked")[0];
  const accepted = of("accepted_structures");
  const refolded = of("refolded_structures");
  const trajectories = of("trajectory_structures");
  if (accepted.length + refolded.length + trajectories.length === 0) return undefined;

  const builder = new ReportBuilder();
  const cif = (o: CollectedOutput) => builder.resource({ kind: "output", path: o.path }, "mmcif", path.basename(o.path));
  const addScene = (title: string, o: CollectedOutput, rank?: number) =>
    builder.scene({
      id: `scene-${builder.sceneCount + 1}`,
      title,
      ...(rank === undefined ? {} : { rank }),
      structures: [{ id: "structure-1", resourceId: cif(o) }],
    });

  if (ranked) {
    const rows = csvRecords(parseCsv(readBounded(ranked.path)));
    const ordered = rows
      .map((row) => ({ design: row["design"], rank: Number(row["rank"]) }))
      .sort((a, b) => a.rank - b.rank);
    for (const { design, rank } of ordered) {
      if (!design || !Number.isInteger(rank) || rank < 1) {
        throw new MoldeskError({ code: "INVALID_REPORT", message: "The ranked table has an invalid design or rank.", remediation: "Use --no-visualize." });
      }
      addScene(`#${rank} · ${design}`, structureFor(design, accepted), rank);
    }
  }

  const room = () => REPORT_LIMITS.maxScenes - builder.sceneCount;
  if (refolded.length <= room()) for (const o of refolded) addScene(`Refolded · ${path.basename(o.path, ".cif")}`, o);
  if (trajectories.length <= room()) {
    for (const o of trajectories) addScene(`Trajectory · ${path.basename(path.dirname(o.path))} / ${path.basename(o.path, ".cif")}`, o);
  }

  const table = (title: string, id: string) => {
    const o = of(id)[0];
    if (o) builder.table(title, builder.resource({ kind: "output", path: o.path }, "csv", path.basename(o.path)));
  };
  table("Ranked designs", "ranked");
  table("Refolded designs", "refolded");
  table("Trajectories", "trajectories");
  return builder.build(`BindCraft2 — ${path.basename(inputPath)}`);
}
