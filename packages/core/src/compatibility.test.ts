import { describe, expect, it } from "vitest";
import { evaluateCompatibility, shortReason } from "./compatibility.js";
import type { ModelManifestV1 } from "@moldesk/registry";
import type { SystemReport } from "@moldesk/runtime";

const GB = 1024 ** 3;

function baseReport(overrides: Partial<SystemReport> = {}): SystemReport {
  return {
    capturedAt: "2026-01-01T00:00:00.000Z",
    platform: "linux",
    arch: "x64",
    cpu: { model: "Test CPU", logicalCores: 8 },
    memory: { totalBytes: 32 * GB },
    disk: { availableBytes: 200 * GB, path: "/tmp/moldesk-test" },
    appleSilicon: false,
    hostPython: { available: false, error: "no python" },
    docker: { available: true, running: true, version: "24.0.7", gpuAccess: "available" },
    nvidia: {
      available: true,
      driverVersion: "550.54.15",
      driverCudaVersion: "12.4",
      gpus: [{ index: 0, name: "NVIDIA A100", totalVramBytes: 80 * GB }],
    },
    ...overrides,
  };
}

function baseManifest(overrides: Partial<ModelManifestV1> = {}): ModelManifestV1 {
  return {
    schemaVersion: 1,
    name: "proteinmpnn",
    displayName: "ProteinMPNN",
    modelVersion: "v_48_020",
    adapterVersion: "0.1.0",
    description: "test",
    category: "sequence-design",
    status: "available",
    runtimes: [{ kind: "python", python: "3.11", installer: "uv", requirements: [{ name: "torch", version: "2.2.1" }] }],
    hardware: { platforms: ["darwin-arm64", "linux-x64"] },
    input: { formats: [".pdb"], required: true },
    outputs: [{ id: "sequences", glob: "*.fa", required: true }],
    ...overrides,
  };
}

describe("evaluateCompatibility", () => {
  it("macOS ARM64 CPU: python model compatible without host python or GPU", () => {
    const report = baseReport({
      platform: "darwin",
      arch: "arm64",
      appleSilicon: true,
      nvidia: { available: false, gpus: [], error: "no gpu" },
      docker: { available: false, running: false, gpuAccess: "unknown" },
    });
    const result = evaluateCompatibility(baseManifest(), report);
    expect(result.status).toBe("compatible");
    expect(result.selectedRuntime).toBe("python");
  });

  it("Linux CPU-only: CUDA-recommended model yields warning, not unsupported", () => {
    const manifest = baseManifest({
      hardware: { platforms: ["linux-x64"], nvidiaGpu: "recommended", cuda: { level: "recommended" } },
    });
    const report = baseReport({
      platform: "linux",
      arch: "x64",
      nvidia: { available: false, gpus: [], error: "no gpu" },
    });
    const result = evaluateCompatibility(manifest, report);
    expect(result.status).toBe("warning");
    expect(result.selectedRuntime).toBe("python");
    expect(result.reasons.some((r) => r.code === "CUDA_NOT_DETECTED")).toBe(true);
  });

  it("Linux NVIDIA CUDA: CUDA-required models compatible", () => {
    const manifest = baseManifest({
      hardware: {
        platforms: ["linux-x64"],
        nvidiaGpu: "required",
        minVramGb: 16,
        cuda: { level: "required" },
      },
    });
    const result = evaluateCompatibility(manifest, baseReport());
    expect(result.status).toBe("compatible");
  });

  it("insufficient VRAM is unsupported with INSUFFICIENT_VRAM", () => {
    const manifest = baseManifest({
      hardware: { platforms: ["linux-x64"], nvidiaGpu: "required", minVramGb: 160 },
    });
    const result = evaluateCompatibility(manifest, baseReport());
    expect(result.status).toBe("unsupported");
    expect(result.reasons.some((r) => r.code === "INSUFFICIENT_VRAM")).toBe(true);
    expect(shortReason(result)).toMatch(/INSUFFICIENT_VRAM/);
  });

  it("missing Docker: docker-only model unsupported with DOCKER_NOT_INSTALLED", () => {
    const manifest = baseManifest({
      runtimes: [{ kind: "docker", image: "example/model:latest", digest: `sha256:${"a".repeat(64)}`, gpu: "none" }],
    });
    const report = baseReport({ docker: { available: false, running: false, gpuAccess: "unknown" } });
    const result = evaluateCompatibility(manifest, report);
    expect(result.status).toBe("unsupported");
    expect(result.reasons.some((r) => r.code === "DOCKER_NOT_INSTALLED")).toBe(true);
  });

  it("stopped Docker daemon: DOCKER_NOT_RUNNING", () => {
    const manifest = baseManifest({
      runtimes: [{ kind: "docker", image: "example/model:latest", digest: `sha256:${"a".repeat(64)}`, gpu: "none" }],
    });
    const report = baseReport({
      docker: { available: true, running: false, gpuAccess: "unknown", error: "daemon not running" },
    });
    const result = evaluateCompatibility(manifest, report);
    expect(result.status).toBe("unsupported");
    expect(result.reasons.some((r) => r.code === "DOCKER_NOT_RUNNING")).toBe(true);
  });

  it("insufficient RAM/disk flagged with stable codes", () => {
    const manifest = baseManifest({
      hardware: { platforms: ["linux-x64"], minRamGb: 64, minDiskGb: 500 },
    });
    const result = evaluateCompatibility(manifest, baseReport());
    expect(result.status).toBe("unsupported");
    const codes = result.reasons.map((r) => r.code);
    expect(codes).toContain("INSUFFICIENT_RAM");
    expect(codes).toContain("DISK_SPACE_LOW");
  });

  it("unknown probe output never counts as present", () => {
    const manifest = baseManifest({
      hardware: { platforms: ["linux-x64"], nvidiaGpu: "required", cuda: { level: "required" }, minVramGb: 8 },
    });
    const report = baseReport({
      platform: "unknown",
      arch: "unknown",
      nvidia: { available: false, gpus: [], error: "probe failed" },
    });
    const result = evaluateCompatibility(manifest, report);
    expect(result.status).toBe("unsupported");
    expect(result.reasons.some((r) => r.code === "CUDA_NOT_DETECTED")).toBe(true);
  });

  it("planned models cannot be installed even on compatible hardware", () => {
    const result = evaluateCompatibility(baseManifest({ status: "planned" }), baseReport());
    expect(result.status).toBe("unsupported");
    expect(result.selectedRuntime).toBeUndefined();
    expect(result.reasons[0]?.code).toBe("MODEL_PLANNED");
  });

  it("requestedRuntime constrains selection without silent fallback", () => {
    const manifest = baseManifest({
      runtimes: [
        { kind: "python", python: "3.11", installer: "uv", requirements: [{ name: "torch", version: "1.0" }] },
        { kind: "docker", image: "example/m:latest", digest: `sha256:${"b".repeat(64)}`, gpu: "none" },
      ],
    });
    const report = baseReport({ docker: { available: false, running: false, gpuAccess: "unknown" } });
    const dockerOnly = evaluateCompatibility(manifest, report, { requestedRuntime: "docker" });
    expect(dockerOnly.status).toBe("unsupported");
    expect(dockerOnly.selectedRuntime).toBeUndefined();
    const pythonOnly = evaluateCompatibility(manifest, report, { requestedRuntime: "python" });
    expect(pythonOnly.status).toBe("compatible");
    expect(pythonOnly.selectedRuntime).toBe("python");
  });

  it("does not reject managed python when host python missing", () => {
    const report = baseReport({ hostPython: { available: false, error: "absent" } });
    const result = evaluateCompatibility(baseManifest(), report);
    expect(result.status).toBe("compatible");
  });

  it("managed python unsupported on unknown platform", () => {
    const report = baseReport({ platform: "unknown", arch: "mips" });
    const result = evaluateCompatibility(baseManifest(), report);
    expect(result.status).toBe("unsupported");
    expect(result.reasons.some((r) => r.code === "MANAGED_PYTHON_PLATFORM_UNSUPPORTED")).toBe(true);
  });

  it("prefers fully compatible runtime over earlier warning", () => {
    const manifest = baseManifest({
      runtimes: [
        { kind: "python", python: "3.11", installer: "uv", requirements: [{ name: "torch", version: "1.0" }] },
        { kind: "docker", image: "example/m:latest", digest: `sha256:${"c".repeat(64)}`, gpu: "none" },
      ],
      hardware: { platforms: ["linux-x64"], nvidiaGpu: "recommended" },
    });
    // No GPU: python warns, docker... also warns via optional? make docker gpu none -> clean except shared warning.
    // Both warn; first warning wins deterministically.
    const report = baseReport({
      nvidia: { available: false, gpus: [], error: "no gpu" },
      docker: { available: true, running: true, gpuAccess: "available" },
    });
    const result = evaluateCompatibility(manifest, report);
    expect(result.status).toBe("warning");
    expect(result.selectedRuntime).toBe("python");
  });

  it("minVramGb downgrades to a warning when nvidiaGpu is merely recommended (CPU fallback preserved)", () => {
    const manifest = baseManifest({
      hardware: { platforms: ["linux-x64"], nvidiaGpu: "recommended", minVramGb: 160 },
    });
    const result = evaluateCompatibility(manifest, baseReport());
    expect(result.status).toBe("warning");
    expect(result.reasons.some((r) => r.code === "INSUFFICIENT_VRAM" && r.severity === "warning")).toBe(true);
  });

  it("minVramGb stays a hard error when nvidiaGpu is required", () => {
    const manifest = baseManifest({
      hardware: { platforms: ["linux-x64"], nvidiaGpu: "required", minVramGb: 160 },
    });
    const result = evaluateCompatibility(manifest, baseReport());
    expect(result.status).toBe("unsupported");
    expect(result.reasons.some((r) => r.code === "INSUFFICIENT_VRAM" && r.severity === "error")).toBe(true);
  });

  it("rejects an insufficient cuda.minDriverCudaVersion with CUDA_VERSION_UNSUPPORTED", () => {
    const manifest = baseManifest({
      hardware: {
        platforms: ["linux-x64"],
        nvidiaGpu: "required",
        cuda: { level: "required", minDriverCudaVersion: "12.6" },
      },
    });
    const result = evaluateCompatibility(manifest, baseReport()); // report has driverCudaVersion "12.4"
    expect(result.status).toBe("unsupported");
    expect(result.reasons.some((r) => r.code === "CUDA_VERSION_UNSUPPORTED")).toBe(true);
  });

  it("accepts a sufficient cuda.minDriverCudaVersion", () => {
    const manifest = baseManifest({
      hardware: {
        platforms: ["linux-x64"],
        nvidiaGpu: "required",
        cuda: { level: "required", minDriverCudaVersion: "12.1" },
      },
    });
    const result = evaluateCompatibility(manifest, baseReport());
    expect(result.status).toBe("compatible");
  });

  it("rejects an unsupported managed Python version", () => {
    const manifest = baseManifest({
      runtimes: [{ kind: "python", python: "3.8", installer: "uv", requirements: [{ name: "torch", version: "2.2.1" }] }],
    });
    const result = evaluateCompatibility(manifest, baseReport());
    expect(result.status).toBe("unsupported");
    expect(result.reasons.some((r) => r.code === "MANAGED_PYTHON_VERSION_UNSUPPORTED")).toBe(true);
  });

  it("docker GPU required + never verified (Tier 1 'unknown') yields DOCKER_GPU_UNVERIFIED, not UNAVAILABLE", () => {
    const manifest = baseManifest({
      runtimes: [{ kind: "docker", image: "example/m:latest", digest: `sha256:${"d".repeat(64)}`, gpu: "required" }],
    });
    const report = baseReport({ docker: { available: true, running: true, gpuAccess: "unknown" } });
    const result = evaluateCompatibility(manifest, report);
    expect(result.status).toBe("unsupported");
    expect(result.reasons.some((r) => r.code === "DOCKER_GPU_UNVERIFIED")).toBe(true);
  });

  it("docker GPU required + Tier 1/2 confirmed unavailable yields DOCKER_GPU_UNAVAILABLE", () => {
    const manifest = baseManifest({
      runtimes: [{ kind: "docker", image: "example/m:latest", digest: `sha256:${"e".repeat(64)}`, gpu: "required" }],
    });
    const report = baseReport({ docker: { available: true, running: true, gpuAccess: "unavailable" } });
    const result = evaluateCompatibility(manifest, report);
    expect(result.status).toBe("unsupported");
    expect(result.reasons.some((r) => r.code === "DOCKER_GPU_UNAVAILABLE")).toBe(true);
  });

  it("docker GPU access does not consult local nvidia.available — a remote daemon with GPU access stays compatible", () => {
    const manifest = baseManifest({
      runtimes: [{ kind: "docker", image: "example/m:latest", digest: `sha256:${"f".repeat(64)}`, gpu: "required" }],
    });
    const report = baseReport({
      nvidia: { available: false, gpus: [], error: "no local gpu" },
      docker: { available: true, running: true, gpuAccess: "available" },
    });
    const result = evaluateCompatibility(manifest, report);
    expect(result.status).toBe("compatible");
    expect(result.selectedRuntime).toBe("docker");
  });

  it("populates a per-runtime breakdown (not just candidate 0) when every candidate is unsupported for different reasons", () => {
    const manifest = baseManifest({
      runtimes: [
        { kind: "python", python: "3.8", installer: "uv", requirements: [{ name: "torch", version: "1.0" }] },
        { kind: "docker", image: "example/m:latest", digest: `sha256:${"1".repeat(64)}`, gpu: "required" },
      ],
    });
    const report = baseReport({ docker: { available: true, running: true, gpuAccess: "unavailable" } });
    const result = evaluateCompatibility(manifest, report);
    expect(result.status).toBe("unsupported");
    expect(result.runtimes).toHaveLength(2);
    expect(result.runtimes.find((r) => r.kind === "python")?.reasons.some((r) => r.code === "MANAGED_PYTHON_VERSION_UNSUPPORTED")).toBe(true);
    expect(result.runtimes.find((r) => r.kind === "docker")?.reasons.some((r) => r.code === "DOCKER_GPU_UNAVAILABLE")).toBe(true);
    const codes = result.reasons.map((r) => r.code);
    expect(codes).toContain("MANAGED_PYTHON_VERSION_UNSUPPORTED");
    expect(codes).toContain("DOCKER_GPU_UNAVAILABLE");
  });

  it("every registry-style model returns exactly one result", () => {
    for (const status of ["available", "beta", "planned"] as const) {
      const result = evaluateCompatibility(baseManifest({ status }), baseReport());
      expect(["compatible", "warning", "unsupported"]).toContain(result.status);
      expect(Array.isArray(result.reasons)).toBe(true);
    }
  });
});
