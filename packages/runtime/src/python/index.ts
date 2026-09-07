import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PythonInfo {
  found: boolean;
  version?: string;
  path?: string;
}

export async function detectPython(): Promise<PythonInfo> {
  for (const cmd of ["python3", "python"]) {
    try {
      const { stdout } = await execFileAsync(cmd, ["--version"]);
      const { stdout: pathOut } = await execFileAsync("which", [cmd]);
      return {
        found: true,
        version: stdout.trim().replace(/^Python\s+/, ""),
        path: pathOut.trim(),
      };
    } catch {
      continue;
    }
  }
  return { found: false };
}
