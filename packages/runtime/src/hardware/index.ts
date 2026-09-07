import os from "node:os";

export interface HardwareInfo {
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryGb: number;
  isAppleSilicon: boolean;
}

export function getHardwareInfo(): HardwareInfo {
  const cpus = os.cpus();
  const arch = os.arch();
  const platform = os.platform();

  return {
    platform,
    arch,
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCores: cpus.length,
    totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    isAppleSilicon: platform === "darwin" && arch === "arm64",
  };
}
