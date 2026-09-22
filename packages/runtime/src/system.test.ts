import { describe, expect, it } from "vitest";
import { detectPython } from "./python/index.js";
import { detectDocker } from "./docker/index.js";
import { detectNvidia } from "./nvidia/index.js";
import { getDiskInfo } from "./hardware/index.js";
import { collectSystemReport } from "./system.js";
import type { CaptureFn } from "./process/index.js";

function stubCapture(
  handler: (cmd: string, args: string[]) => { code: number; stdout?: string; stderr?: string; timedOut?: boolean },
): CaptureFn {
  return async (command, args) => {
    const r = handler(command, args);
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.timedOut };
  };
}

describe("python probe", () => {
  it("reports version + path when python3 exists", async () => {
    const capture = stubCapture((cmd, args) => {
      if (cmd === "python3" && args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n" };
      if (cmd === "which") return { code: 0, stdout: "/opt/homebrew/bin/python3\n" };
      return { code: 1 };
    });
    const result = await detectPython(capture);
    expect(result).toMatchObject({ available: true, version: "3.11.9", path: "/opt/homebrew/bin/python3" });
  });

  it("degrades to unavailable when no interpreter on PATH", async () => {
    const capture = stubCapture(() => ({ code: 127, stderr: "not found" }));
    const result = await detectPython(capture);
    expect(result.available).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("reports timeout instead of throwing", async () => {
    const capture = stubCapture(() => ({ code: 0, timedOut: true }));
    const result = await detectPython(capture);
    expect(result.available).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });
});

describe("docker probe", () => {
  it("separates installed/running from gpu access", async () => {
    const capture = stubCapture((cmd, args) => {
      if (cmd === "docker" && args[0] === "--version")
        return { code: 0, stdout: "Docker version 24.0.7, build abc\n" };
      if (cmd === "docker" && args[0] === "info") return { code: 0, stdout: "Server Version: 24\n" };
      return { code: 1 };
    });
    const result = await detectDocker(capture);
    expect(result).toMatchObject({ available: true, running: true, gpuAccess: "unknown" });
  });

  it("reports stopped daemon without crashing", async () => {
    const capture = stubCapture((cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "Docker version 24.0.7\n" };
      return { code: 1, stderr: "Cannot connect to the Docker daemon" };
    });
    const result = await detectDocker(capture);
    expect(result).toMatchObject({ available: true, running: false });
    expect(result.error).toMatch(/daemon not running/);
  });

  it("reports missing docker", async () => {
    const capture = stubCapture(() => ({ code: 127, stderr: "command not found" }));
    const result = await detectDocker(capture);
    expect(result).toMatchObject({ available: false, running: false, gpuAccess: "unknown" });
  });
});

describe("nvidia probe", () => {
  it("parses CSV query output only", async () => {
    const capture = stubCapture((cmd, args) => {
      if (cmd === "nvidia-smi" && args.join(" ").includes("memory.total"))
        return { code: 0, stdout: "0, NVIDIA A100, 81920\n1, NVIDIA A100, 81920\n" };
      if (cmd === "nvidia-smi" && args.includes("-x"))
        return { code: 0, stdout: "<nvidia_smi_log><cuda_version>12.4</cuda_version></nvidia_smi_log>\n" };
      if (cmd === "nvidia-smi") return { code: 0, stdout: "550.54.15\n" };
      if (cmd === "nvcc") return { code: 0, stdout: "Cuda compilation tools, release 12.4\n" };
      return { code: 1 };
    });
    const result = await detectNvidia(capture);
    expect(result.available).toBe(true);
    expect(result.gpus).toHaveLength(2);
    expect(result.gpus[0]?.totalVramBytes).toBe(81920 * 1024 * 1024);
    expect(result.driverCudaVersion).toBe("12.4");
    expect(result.cudaToolkitVersion).toBe("12.4");
  });

  it("treats missing nvidia-smi as unavailable", async () => {
    const capture = stubCapture(() => ({ code: 127, stderr: "not found" }));
    const result = await detectNvidia(capture);
    expect(result).toMatchObject({ available: false, gpus: [] });
  });

  it("treats unknown/decorative output as unavailable, not a crash", async () => {
    const capture = stubCapture(() => ({
      code: 0,
      stdout: "+-----+-------+\n| GPU | MEM |\n+-----+-------+\n",
    }));
    const result = await detectNvidia(capture);
    expect(result.available).toBe(false);
    expect(result.error).toMatch(/unrecognized nvidia-smi output/);
  });
});

describe("disk probe", () => {
  it("queries MOLDESK_HOME nearest parent", async () => {
    const disk = await getDiskInfo({ MOLDESK_HOME: "/tmp/moldesk-test-home-no-such-dir-xyz/sub" }, async () => ({
      availableBytes: 42 * 1024 ** 3,
    }));
    expect(disk.availableBytes).toBe(42 * 1024 ** 3);
    expect(disk.path.length).toBeGreaterThan(0);
  });

  it("falls back to 0 bytes on probe failure, flagged as probeFailed (not a real zero)", async () => {
    const disk = await getDiskInfo({ MOLDESK_HOME: "/tmp" }, async () => null);
    expect(disk.availableBytes).toBe(0);
    expect(disk.probeFailed).toBe(true);
    expect(disk.probeError).toBeTruthy();
  });
});

describe("collectSystemReport", () => {
  it("assembles one report with injected results (no real GPU/Docker)", async () => {
    const capture = stubCapture((cmd, args) => {
      if (cmd === "python3") return { code: 0, stdout: "Python 3.11.0\n" };
      if (cmd === "which") return { code: 0, stdout: "/usr/bin/python3\n" };
      if (cmd === "docker") return { code: 127, stderr: "no docker" };
      if (cmd === "nvidia-smi") return { code: 127, stderr: "no gpu" };
      void args;
      return { code: 1 };
    });
    const report = await collectSystemReport(
      { capture, statfs: async () => ({ availableBytes: 100 * 1024 ** 3 }) },
      { MOLDESK_HOME: "/tmp/moldesk-report-test" },
    );
    expect(typeof report.capturedAt).toBe("string");
    expect(report.hostPython.available).toBe(true);
    expect(report.docker.available).toBe(false);
    expect(report.nvidia.available).toBe(false);
    expect(report.disk.availableBytes).toBe(100 * 1024 ** 3);
    expect(["darwin", "linux", "win32", "unknown"]).toContain(report.platform);
  });
});
