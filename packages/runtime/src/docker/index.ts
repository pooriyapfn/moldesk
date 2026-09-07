import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DockerInfo {
  installed: boolean;
  running: boolean;
  version?: string;
}

export async function detectDocker(): Promise<DockerInfo> {
  try {
    const { stdout } = await execFileAsync("docker", ["--version"]);
    const version = stdout.trim().replace(/^Docker version\s+/, "");
    try {
      await execFileAsync("docker", ["info"]);
      return { installed: true, running: true, version };
    } catch {
      return { installed: true, running: false, version };
    }
  } catch {
    return { installed: false, running: false };
  }
}
