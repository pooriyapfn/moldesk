import { describe, expect, it } from "vitest";
import { detectNvidia, parseDriverCudaVersionXml } from "./index.js";
import type { CaptureFn } from "../process/index.js";

function stubCapture(
  handler: (cmd: string, args: string[]) => { code: number; stdout?: string; stderr?: string; timedOut?: boolean },
): CaptureFn {
  return async (command, args) => {
    const r = handler(command, args);
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.timedOut };
  };
}

const CSV_ROWS = "0, NVIDIA A100, 81920\n";

describe("parseDriverCudaVersionXml", () => {
  it("extracts the top-level cuda_version tag", () => {
    const xml = "<nvidia_smi_log><cuda_version>12.4</cuda_version><gpu><cuda_version>ignored</cuda_version></gpu></nvidia_smi_log>";
    expect(parseDriverCudaVersionXml(xml)).toBe("12.4");
  });

  it("returns undefined when the tag is absent", () => {
    expect(parseDriverCudaVersionXml("<nvidia_smi_log></nvidia_smi_log>")).toBeUndefined();
  });

  it("returns undefined for a 'Not Found' placeholder value", () => {
    expect(parseDriverCudaVersionXml("<cuda_version>Not Found</cuda_version>")).toBeUndefined();
  });

  it("never matches decorative table text", () => {
    const decorative = "+-----------------------------------------------------------------------------------+\n| CUDA Version: 12.4                                                                   |\n";
    expect(parseDriverCudaVersionXml(decorative)).toBeUndefined();
  });
});

describe("detectNvidia — driver CUDA (XML) vs toolkit CUDA (nvcc)", () => {
  it("reports driverCudaVersion from XML and cudaToolkitVersion from nvcc independently", async () => {
    const capture = stubCapture((cmd, args) => {
      if (cmd === "nvidia-smi" && args.join(" ").includes("memory.total")) return { code: 0, stdout: CSV_ROWS };
      if (cmd === "nvidia-smi" && args.includes("-x"))
        return { code: 0, stdout: "<nvidia_smi_log><cuda_version>12.6</cuda_version></nvidia_smi_log>" };
      if (cmd === "nvidia-smi") return { code: 0, stdout: "560.35.03\n" };
      if (cmd === "nvcc") return { code: 0, stdout: "Cuda compilation tools, release 12.1\n" };
      return { code: 1 };
    });
    const result = await detectNvidia(capture);
    expect(result.available).toBe(true);
    expect(result.driverCudaVersion).toBe("12.6");
    expect(result.cudaToolkitVersion).toBe("12.1");
  });

  it("leaves driverCudaVersion undefined when only the toolkit is present (no driver-only host regression)", async () => {
    const capture = stubCapture((cmd, args) => {
      if (cmd === "nvidia-smi" && args.join(" ").includes("memory.total")) return { code: 0, stdout: CSV_ROWS };
      if (cmd === "nvidia-smi" && args.includes("-x")) return { code: 1, stderr: "unsupported" };
      if (cmd === "nvidia-smi") return { code: 0, stdout: "560.35.03\n" };
      if (cmd === "nvcc") return { code: 0, stdout: "Cuda compilation tools, release 12.1\n" };
      return { code: 1 };
    });
    const result = await detectNvidia(capture);
    expect(result.driverCudaVersion).toBeUndefined();
    expect(result.cudaToolkitVersion).toBe("12.1");
  });

  it("reports driverCudaVersion when nvcc (toolkit) is entirely absent — the driver-only Docker-host case", async () => {
    const capture = stubCapture((cmd, args) => {
      if (cmd === "nvidia-smi" && args.join(" ").includes("memory.total")) return { code: 0, stdout: CSV_ROWS };
      if (cmd === "nvidia-smi" && args.includes("-x"))
        return { code: 0, stdout: "<nvidia_smi_log><cuda_version>12.6</cuda_version></nvidia_smi_log>" };
      if (cmd === "nvidia-smi") return { code: 0, stdout: "560.35.03\n" };
      if (cmd === "nvcc") return { code: 127, stderr: "command not found" };
      return { code: 1 };
    });
    const result = await detectNvidia(capture);
    expect(result.driverCudaVersion).toBe("12.6");
    expect(result.cudaToolkitVersion).toBeUndefined();
  });

  it("leaves both undefined when neither probe succeeds, without failing GPU detection", async () => {
    const capture = stubCapture((cmd, args) => {
      if (cmd === "nvidia-smi" && args.join(" ").includes("memory.total")) return { code: 0, stdout: CSV_ROWS };
      if (cmd === "nvidia-smi") return { code: 1, stderr: "unsupported" };
      if (cmd === "nvcc") return { code: 127, stderr: "command not found" };
      return { code: 1 };
    });
    const result = await detectNvidia(capture);
    expect(result.available).toBe(true);
    expect(result.driverCudaVersion).toBeUndefined();
    expect(result.cudaToolkitVersion).toBeUndefined();
  });
});
