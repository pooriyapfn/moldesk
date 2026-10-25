import { installUsalign, planUsalignInstall, requireCompiler, uninstallUsalign } from "@moldesk/core";
import { confirm } from "../utils/confirm.js";
import { reportFailure } from "../utils/report-errors.js";

/** `moldesk install|uninstall <name>` also manage this tool, which is not a model. */
export const USALIGN_TOOL = "usalign";

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`;
}

export async function installUsalignTool(options: { yes?: boolean; json?: boolean; reinstall?: boolean }): Promise<void> {
  try {
    const plan = await planUsalignInstall();
    const payload = { tool: USALIGN_TOOL, version: plan.version, source: plan.source, downloadBytes: plan.downloadBytes, compiler: plan.compiler };
    if (plan.alreadyInstalled && !options.reinstall) {
      const result = await installUsalign();
      if (options.json) console.log(JSON.stringify({ ...payload, status: result.status, installation: result.installation.receipt }, null, 2));
      else console.log(`US-align ${plan.version}: already installed.`);
      return;
    }
    await requireCompiler(); // fail before asking anything we could not finish

    if (!options.json) {
      console.log(`Installation plan for US-align ${plan.version}:`);
      console.log(`  1. Download the pinned source (${formatBytes(plan.downloadBytes)}) from ${plan.source.url}`);
      console.log(`  2. Check it against SHA-256 ${plan.source.sha256}`);
      console.log(`  3. Build it with ${plan.compiler?.command} (${plan.compiler?.version})`);
      console.log("  4. Verify the binary on its sample structures, then install it atomically");
    }
    // Compiling downloaded code always needs a yes, however small the download is.
    if (!options.yes) {
      if (options.json || !process.stdin.isTTY) {
        const message = "Installing US-align downloads source code and builds it with your compiler. Re-run with --yes.";
        if (options.json) console.log(JSON.stringify({ ...payload, status: "confirmation-required", message }, null, 2));
        else console.error(message);
        process.exitCode = 1;
        return;
      }
      if (!(await confirm("Download and build US-align?"))) {
        if (options.json) console.log(JSON.stringify({ ...payload, status: "cancelled" }, null, 2));
        else console.log("Installation cancelled. Re-run with --yes for non-interactive use.");
        return;
      }
    }

    let announcedDownload = false;
    const result = await installUsalign({
      reinstall: options.reinstall,
      onProgress: options.json
        ? undefined
        : (progress) => {
            if (progress.step === "asset" && announcedDownload) return;
            announcedDownload ||= progress.step === "asset";
            console.log(`  [${progress.step}] ${progress.message}`);
          },
    });
    if (options.json) console.log(JSON.stringify({ ...payload, status: result.status, installation: result.installation.receipt }, null, 2));
    else console.log(`US-align ${plan.version}: ${result.status}.`);
  } catch (error) {
    reportFailure(error, options.json);
  }
}

export async function uninstallUsalignTool(options: { json?: boolean }): Promise<void> {
  try {
    const removed = await uninstallUsalign();
    if (options.json) console.log(JSON.stringify({ tool: USALIGN_TOOL, status: removed ? "uninstalled" : "not-installed" }, null, 2));
    else console.log(removed ? "US-align: uninstalled." : "US-align is not installed.");
  } catch (error) {
    reportFailure(error, options.json);
  }
}
