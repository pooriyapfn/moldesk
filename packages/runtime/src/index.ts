import { getHardwareInfo, type HardwareInfo } from "./hardware/index.js";
import { detectPython, type PythonInfo } from "./python/index.js";
import { detectDocker, type DockerInfo } from "./docker/index.js";

export interface SystemReport {
  hardware: HardwareInfo;
  python: PythonInfo;
  docker: DockerInfo;
}

export async function getSystemReport(): Promise<SystemReport> {
  const [python, docker] = await Promise.all([detectPython(), detectDocker()]);
  return {
    hardware: getHardwareInfo(),
    python,
    docker,
  };
}

export { getHardwareInfo } from "./hardware/index.js";
export { detectPython } from "./python/index.js";
export { detectDocker } from "./docker/index.js";
export { runCommand } from "./process/index.js";
export type { HardwareInfo, PythonInfo, DockerInfo };
