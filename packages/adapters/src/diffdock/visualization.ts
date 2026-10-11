import fs from "node:fs";
import path from "node:path";
import { MoldeskError } from "@moldesk/registry";
import type { ReportDescription } from "@moldesk/visualizer/contract";
import type { CollectedOutput, RunContext } from "../index.js";
import { ReportBuilder } from "../visualization.js";

const RECEPTOR_FORMATS: Record<string, "pdb" | "mmcif"> = { ".pdb": "pdb", ".cif": "mmcif", ".mmcif": "mmcif" };

function missingReceptor(message: string): MoldeskError {
  return new MoldeskError({
    code: "VISUALIZATION_RECEPTOR_MISSING",
    message,
    remediation: "The docking results are unaffected. A ligand shown without its receptor would misrepresent the result, so no report was created.",
  });
}

/**
 * Receptor + each ranked pose in one scene. DiffDock writes poses in the coordinate frame
 * of the receptor it was given, so no transform is applied; nothing is aligned. Rank and
 * confidence come from the adapter's own pose summary. `rank1.sdf` duplicates the top
 * `rank1_confidence*.sdf`, so only the ranked files become scenes. A missing receptor is an
 * error, never a ligand-only report.
 */
export function describeDiffDockVisualization(
  context: Pick<RunContext, "inputPath" | "companionInputs">,
  outputs: readonly CollectedOutput[],
): ReportDescription | undefined {
  const summaryOutput = outputs.find((o) => o.id === "poses_summary");
  const poseFiles = outputs.filter((o) => o.id === "ranked_poses");
  if (!summaryOutput || poseFiles.length === 0) return undefined;

  const receptorPath = context.companionInputs?.find((c) => c.id === "protein")?.path;
  if (!receptorPath) throw missingReceptor("The staged receptor for this docking run is not available.");
  const receptorFormat = RECEPTOR_FORMATS[path.extname(receptorPath).toLowerCase()];
  if (!receptorFormat) throw missingReceptor(`The receptor ${path.basename(receptorPath)} is not a PDB or mmCIF file.`);

  const summary = JSON.parse(fs.readFileSync(summaryOutput.path, "utf8")) as {
    complexName: string;
    poses: Array<{ rank: number; confidence: number; sdfFile: string }>;
  };
  const builder = new ReportBuilder();
  const receptor = builder.resource({ kind: "input", path: receptorPath }, receptorFormat, path.basename(receptorPath));

  for (const pose of [...summary.poses].sort((a, b) => a.rank - b.rank)) {
    const file = poseFiles.find(
      (o) => path.basename(o.path) === pose.sdfFile && path.basename(path.dirname(o.path)) === summary.complexName,
    );
    if (!file) {
      throw new MoldeskError({ code: "VISUALIZATION_POSE_MISSING", message: `Pose ${pose.rank} is in the summary but its file was not collected.`, remediation: "Use --no-visualize." });
    }
    builder.scene({
      id: `scene-${builder.sceneCount + 1}`,
      title: `Pose ${pose.rank} (confidence ${pose.confidence})`,
      rank: pose.rank,
      structures: [
        { id: "receptor", resourceId: receptor },
        { id: "pose", resourceId: builder.resource({ kind: "output", path: file.path }, "sdf", pose.sdfFile) },
      ],
      components: [
        { id: "receptor", structureId: "receptor", selection: { kind: "all" }, role: "receptor", label: "Receptor", representation: "cartoon" },
        { id: "pose", structureId: "pose", selection: { kind: "all" }, role: "ligand", label: "Ligand pose", representation: "sticks" },
      ],
    });
  }

  builder.table(
    "Poses",
    builder.resource({ kind: "output", path: summaryOutput.path }, "json", path.basename(summaryOutput.path)),
    [
      { field: "rank", label: "Rank" },
      { field: "confidence", label: "Confidence" },
      { field: "sdfFile", label: "File" },
      { field: "atomCount", label: "Atoms" },
    ],
    "poses",
  );
  return builder.build(`DiffDock — ${path.basename(context.inputPath)}`);
}
