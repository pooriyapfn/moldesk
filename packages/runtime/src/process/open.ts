import path from "node:path";
import { runCommand, type RunResult } from "./index.js";

export interface OpenResult {
  opened: boolean;
  error?: string;
}

/**
 * Opens a local file in the default browser. Structured executable + args, no shell,
 * so paths with spaces, quotes, `$()`, backticks, Unicode, or a leading dash are inert:
 * the path is made absolute first, so it can never be parsed as an option.
 */
export async function openInBrowser(
  filePath: string,
  deps: {
    platform?: NodeJS.Platform;
    run?: (command: string, args: string[]) => Promise<Pick<RunResult, "code" | "stderr">>;
  } = {},
): Promise<OpenResult> {
  const platform = deps.platform ?? process.platform;
  const executable = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined;
  if (!executable) return { opened: false, error: `Opening a browser is not supported on ${platform}.` };
  const target = path.resolve(filePath);
  const run = deps.run ?? ((command, args) => runCommand(command, args, { timeoutMs: 10_000 }));
  try {
    const result = await run(executable, [target]);
    if (result.code === 0) return { opened: true };
    return { opened: false, error: result.stderr.trim() || `${executable} exited with code ${result.code}` };
  } catch (error) {
    return { opened: false, error: error instanceof Error ? error.message : String(error) };
  }
}
