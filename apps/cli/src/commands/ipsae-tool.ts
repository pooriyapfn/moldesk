import { installIpsae, planIpsaeInstall, uninstallIpsae } from "@moldesk/core";
import { confirm } from "../utils/confirm.js";
import { reportFailure } from "../utils/report-errors.js";

export async function installIpsaeTool(options: { yes?: boolean; json?: boolean; reinstall?: boolean }): Promise<void> {
  try {
    const plan = await planIpsaeInstall();
    if (!plan.alreadyInstalled || options.reinstall) {
      const message = `Install ipSAE ${plan.revision} from ${plan.source.url}, managed Python and hash-pinned NumPy in ~/.moldesk/tools. Known downloads ~${Math.ceil(plan.knownDownloadBytes / 1e6)} MB plus managed Python (size unknown).`;
      if (!options.json) console.log(message);
      if (!options.yes && (options.json || !process.stdin.isTTY || !await confirm("Download and install ipSAE?"))) {
        if (options.json) console.log(JSON.stringify({ tool: "ipsae", status: "confirmation-required", plan, message }));
        else console.error("Re-run with --yes after approving the download.");
        process.exitCode = 1; return;
      }
    }
    const result = await installIpsae({ reinstall: options.reinstall, onProgress: options.json ? undefined : (p) => { if (p.step !== "asset") console.error(p.message); } });
    if (options.json) console.log(JSON.stringify({ tool: "ipsae", status: result.status, installation: result.installation.receipt }, null, 2));
    else console.log(`ipSAE: ${result.status}.`);
  } catch (error) { reportFailure(error, options.json); }
}
export async function uninstallIpsaeTool(options: { json?: boolean }): Promise<void> {
  try {
    const status = await uninstallIpsae() ? "uninstalled" : "not-installed";
    if (options.json) console.log(JSON.stringify({ tool: "ipsae", status }));
    else console.log(`ipSAE: ${status}.`);
  } catch (error) { reportFailure(error, options.json); }
}
