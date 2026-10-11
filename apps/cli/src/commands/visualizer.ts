import { createInterface } from "node:readline/promises";
import path from "node:path";
import type { Command } from "commander";
import { applyReportUpdate, openInBrowser, prepareReportUpdate } from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

async function confirmUpdate(lines: string[]): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${lines.join("\n")}\n\nContinue? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

interface UpdateOptions {
  output?: string;
  open?: boolean;
  yes?: boolean;
  json?: boolean;
}

export function registerVisualizerCommand(program: Command): void {
  const visualizer = program.command("visualizer").description("Manage offline molecular reports");

  visualizer
    .command("update <report>")
    .description("Replace a report's viewer with the one installed with MoleculeDesk")
    .option("--output <file>", "save the updated report as a separate file instead of replacing the original")
    .option("--open", "open the report in your default browser afterwards")
    .option("--yes", "confirm without prompting")
    .option("--json", "print the result as JSON")
    .action(async (report: string, options: UpdateOptions) => {
      try {
        await update(report, options);
      } catch (error) {
        reportFailure(error, options.json);
      }
    });
}

async function update(report: string, options: UpdateOptions): Promise<void> {
  const emit = (value: Record<string, unknown>, text: string[], errText: string[] = []): void => {
    if (options.json) console.log(JSON.stringify(value, null, 2));
    else {
      for (const line of text) console.log(line);
      for (const line of errText) console.error(line);
    }
  };
  const openIfRequested = async (file: string): Promise<{ opened?: boolean; warnings: Array<{ code: string; message: string }> }> => {
    if (!options.open) return { warnings: [] };
    const outcome = await openInBrowser(file);
    return outcome.opened
      ? { opened: true, warnings: [] }
      : {
          opened: false,
          warnings: [{ code: "OPEN_FAILED", message: `Could not open a browser: ${outcome.error ?? "unknown error"}. The report is at ${file}.` }],
        };
  };

  const plan = await prepareReportUpdate(report, { outputPath: options.output });
  const target = plan.targetPath;

  if (plan.status === "unsupported") {
    emit(
      { status: "unsupported", path: target, reason: plan.reason },
      [],
      ["Your installed MoleculeDesk cannot update this report. Your report has not been changed."],
    );
    process.exitCode = 2;
    return;
  }

  if (plan.status === "noop" && options.output === undefined) {
    const { opened, warnings } = await openIfRequested(target);
    emit(
      { status: "up-to-date", path: target, viewerVersion: plan.toViewerVersion, bundleSha256: plan.toBundleSha256, ...(opened === undefined ? {} : { opened }), warnings },
      ["This report already uses your current viewer."],
      warnings.map((w) => `Warning: ${w.message}`),
    );
    return;
  }

  if (!options.yes) {
    if (options.json || !process.stdin.isTTY || !process.stdout.isTTY) {
      emit(
        { status: "confirmation-required", path: target, message: "Re-run with --yes to confirm." },
        [],
        ["Confirmation is required to update this report. Re-run with --yes to confirm."],
      );
      process.exitCode = 2;
      return;
    }
    const lines = [
      "Update this report’s viewer?",
      "",
      `Report: ${target}`,
      ...(plan.outputPath === undefined ? [] : [`Save as: ${plan.outputPath}`]),
      "",
      "Your structures and results will stay unchanged.",
      plan.outputPath === undefined
        ? "A backup of your current report will be saved."
        : "Your updated report will be saved as a separate file.",
    ];
    if (!(await confirmUpdate(lines))) {
      emit({ status: "cancelled", path: target }, ["Cancelled. Your report has not been changed."]);
      return;
    }
  }

  const result = await applyReportUpdate(plan);
  const { opened, warnings } = await openIfRequested(result.path);
  const text =
    result.backupPath !== undefined
      ? ["Viewer updated. Refresh your report to see the changes.", `Backup saved: ${result.backupPath}`]
      : [
          result.status === "updated" ? "Viewer updated." : "Report saved.",
          `Saved: ${path.resolve(result.path)}`,
        ];
  emit(
    {
      status: result.status,
      path: result.path,
      ...(result.backupPath === undefined ? {} : { backupPath: result.backupPath }),
      sha256: result.sha256,
      sizeBytes: result.sizeBytes,
      payloadSha256: result.payloadSha256,
      viewerVersion: result.viewerVersion,
      bundleSha256: result.bundleSha256,
      ...(opened === undefined ? {} : { opened }),
      warnings,
    },
    text,
    warnings.map((w) => `Warning: ${w.message}`),
  );
}
