import type {
  ModelManifestV1,
  RuntimeKind,
  RuntimeSpec,
} from "@moldesk/registry";
import type { SystemReport } from "@moldesk/runtime";

export type CompatibilityStatus = "compatible" | "warning" | "unsupported";

export interface CompatibilityReason {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  remediation?: string;
}

export interface RuntimeCompatibility {
  kind: RuntimeKind;
  status: CompatibilityStatus;
  reasons: CompatibilityReason[];
}

export interface CompatibilityResult {
  status: CompatibilityStatus;
  selectedRuntime?: RuntimeKind;
  reasons: CompatibilityReason[];
  /** Per-candidate breakdown, one entry per evaluated runtime, manifest order. */
  runtimes: RuntimeCompatibility[];
}

export interface CompatibilityOptions {
  requestedRuntime?: RuntimeKind;
}

const BYTES_PER_GB = 1024 ** 3;

/** Managed-python runtimes support these OS/arch pairs via pinned uv bootstrap. */
const MANAGED_PYTHON_PLATFORMS = new Set(["darwin-arm64", "linux-x64"]);

/** Managed-python (uv-bootstrapped) interpreter versions Step 2 preflight can vouch for. */
const SUPPORTED_MANAGED_PYTHON_VERSIONS = new Set(["3.10", "3.11", "3.12"]);

/** Parse a `major.minor[.patch]` version string. Not a semver parser — just the two leading numeric components used for a floor comparison. */
function parseMajorMinor(version: string): { major: number; minor: number } | undefined {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** `detected >= required` as a major.minor floor — NOT a semver range comparison. */
function isCudaVersionSufficient(
  detected: { major: number; minor: number },
  required: { major: number; minor: number },
): boolean {
  if (detected.major !== required.major) return detected.major > required.major;
  return detected.minor >= required.minor;
}

function dedupeReasons(reasons: CompatibilityReason[]): CompatibilityReason[] {
  const seen = new Map<string, CompatibilityReason>();
  for (const reason of reasons) {
    const key = `${reason.code}::${reason.message}`;
    if (!seen.has(key)) seen.set(key, reason);
  }
  return [...seen.values()];
}

function currentPlatformId(report: SystemReport): string {
  const arch = report.arch === "x86_64" ? "x64" : report.arch;
  if (report.platform === "unknown") return "unknown";
  return `${report.platform}-${arch}`;
}

function gb(bytes: number): number {
  return bytes / BYTES_PER_GB;
}

function maxVramBytes(report: SystemReport): number | undefined {
  let max: number | undefined;
  for (const gpu of report.nvidia.gpus) {
    if (typeof gpu.totalVramBytes !== "number") continue;
    max = max === undefined ? gpu.totalVramBytes : Math.max(max, gpu.totalVramBytes);
  }
  return max;
}

interface RuntimeEvaluation {
  errors: CompatibilityReason[];
  warnings: CompatibilityReason[];
}

function evaluateSharedHardware(
  manifest: ModelManifestV1,
  report: SystemReport,
  currentId: string,
): RuntimeEvaluation {
  const errors: CompatibilityReason[] = [];
  const warnings: CompatibilityReason[] = [];
  const hw = manifest.hardware;

  if (hw.platforms && hw.platforms.length > 0 && !hw.platforms.includes(currentId as never)) {
    errors.push({
      code: "PLATFORM_UNSUPPORTED",
      severity: "error",
      message: `platform ${currentId} not in manifest platforms (${hw.platforms.join(", ")})`,
      remediation: `Use one of: ${hw.platforms.join(", ")}.`,
    });
  }

  if (typeof hw.minRamGb === "number") {
    const totalGb = gb(report.memory.totalBytes);
    if (!(totalGb >= hw.minRamGb)) {
      errors.push({
        code: "INSUFFICIENT_RAM",
        severity: "error",
        message: `requires >= ${hw.minRamGb} GB RAM, detected ${totalGb.toFixed(1)} GB`,
        remediation: "Free memory or use a machine with more RAM.",
      });
    }
  }

  if (typeof hw.minDiskGb === "number") {
    if (report.disk.probeFailed) {
      warnings.push({
        code: "DISK_SPACE_UNKNOWN",
        severity: "warning",
        message: `requires >= ${hw.minDiskGb} GB free at ${report.disk.path}, but disk space could not be determined${report.disk.probeError ? ` (${report.disk.probeError})` : ""}`,
        remediation: `Verify free disk space at ${report.disk.path} manually.`,
      });
    } else {
      const availGb = gb(report.disk.availableBytes);
      if (!(availGb >= hw.minDiskGb)) {
        errors.push({
          code: "DISK_SPACE_LOW",
          severity: "error",
          message: `requires >= ${hw.minDiskGb} GB free at ${report.disk.path}, detected ${availGb.toFixed(1)} GB`,
          remediation: `Free disk space at ${report.disk.path}.`,
        });
      }
    }
  }

  const gpuLevel = hw.nvidiaGpu ?? "unsupported";
  if (gpuLevel === "required" && !report.nvidia.available) {
    errors.push({
      code: "NVIDIA_GPU_REQUIRED",
      severity: "error",
      message: "model requires an NVIDIA GPU but none was detected",
      remediation: "Run on a Linux host with an NVIDIA GPU + driver, or pick a CPU-compatible model.",
    });
  } else if (gpuLevel === "recommended" && !report.nvidia.available) {
    warnings.push({
      code: "NVIDIA_GPU_RECOMMENDED",
      severity: "warning",
      message: "NVIDIA GPU recommended but none detected; CPU execution will be slow",
      remediation: "For full speed, use a CUDA host.",
    });
  }

  if (typeof hw.minVramGb === "number") {
    // Schema requires nvidiaGpu whenever minVramGb is set (superRefine), so
    // gpuLevel here is never the ambiguous "no signal" case.
    const vramSeverity: "error" | "warning" = gpuLevel === "required" ? "error" : "warning";
    const vramList = vramSeverity === "error" ? errors : warnings;
    const verb = vramSeverity === "error" ? "requires" : "recommends";
    if (!report.nvidia.available) {
      vramList.push({
        code: "INSUFFICIENT_VRAM",
        severity: vramSeverity,
        message: `${verb} >= ${hw.minVramGb} GB VRAM but no NVIDIA GPU was detected`,
        remediation: "Use a GPU host with enough VRAM.",
      });
    } else {
      const maxVram = maxVramBytes(report);
      if (maxVram === undefined) {
        vramList.push({
          code: "INSUFFICIENT_VRAM",
          severity: vramSeverity,
          message: `${verb} >= ${hw.minVramGb} GB VRAM but VRAM could not be determined`,
          remediation: "Verify nvidia-smi reports memory.total for each GPU.",
        });
      } else if (!(gb(maxVram) >= hw.minVramGb)) {
        vramList.push({
          code: "INSUFFICIENT_VRAM",
          severity: vramSeverity,
          message: `${verb} >= ${hw.minVramGb} GB VRAM, detected max ${gb(maxVram).toFixed(1)} GB`,
          remediation: "Use a GPU with more VRAM.",
        });
      }
    }
  }

  const cudaLevel = hw.cuda?.level;
  if (cudaLevel === "required" && (!report.nvidia.available || !report.nvidia.driverCudaVersion)) {
    errors.push({
      code: "CUDA_NOT_DETECTED",
      severity: "error",
      message: "model requires CUDA but no CUDA version was detected",
      remediation: "Install a CUDA-capable driver/toolkit or use a CUDA host.",
    });
  } else if (cudaLevel === "recommended" && (!report.nvidia.available || !report.nvidia.driverCudaVersion)) {
    warnings.push({
      code: "CUDA_NOT_DETECTED",
      severity: "warning",
      message: "CUDA recommended but not detected; CPU execution will be slow",
      remediation: "For full speed, use a CUDA host.",
    });
  } else if (cudaLevel && report.nvidia.driverCudaVersion && hw.cuda?.minDriverCudaVersion) {
    const detected = parseMajorMinor(report.nvidia.driverCudaVersion);
    const required = parseMajorMinor(hw.cuda.minDriverCudaVersion);
    if (detected && required && !isCudaVersionSufficient(detected, required)) {
      const severity = cudaLevel === "required" ? "error" : "warning";
      (severity === "error" ? errors : warnings).push({
        code: "CUDA_VERSION_UNSUPPORTED",
        severity,
        message: `requires driver CUDA >= ${hw.cuda.minDriverCudaVersion}, detected ${report.nvidia.driverCudaVersion}`,
        remediation: "Update the NVIDIA driver to one supporting a newer CUDA version.",
      });
    }
  }

  return { errors, warnings };
}

function evaluateRuntime(
  runtime: RuntimeSpec,
  manifest: ModelManifestV1,
  report: SystemReport,
  currentId: string,
): RuntimeEvaluation {
  const shared = evaluateSharedHardware(manifest, report, currentId);
  const errors = [...shared.errors];
  const warnings = [...shared.warnings];

  if (runtime.kind === "python") {
    // Host Python is diagnostic only; evaluate managed uv bootstrap instead.
    if (!MANAGED_PYTHON_PLATFORMS.has(currentId)) {
      errors.push({
        code: "MANAGED_PYTHON_PLATFORM_UNSUPPORTED",
        severity: "error",
        message: `managed Python ${runtime.python} via uv is not supported on ${currentId}`,
        remediation: "Use darwin-arm64 or linux-x64, or pick the docker runtime if offered.",
      });
    }
    if (!SUPPORTED_MANAGED_PYTHON_VERSIONS.has(runtime.python)) {
      errors.push({
        code: "MANAGED_PYTHON_VERSION_UNSUPPORTED",
        severity: "error",
        message: `managed Python ${runtime.python} is not a supported managed-uv version`,
        remediation: `Use a manifest requesting one of: ${[...SUPPORTED_MANAGED_PYTHON_VERSIONS].join(", ")}, or pick the docker runtime if offered.`,
      });
    }
    return { errors, warnings };
  }

  // Docker runtime.
  if (!report.docker.available) {
    errors.push({
      code: "DOCKER_NOT_INSTALLED",
      severity: "error",
      message: "docker runtime requires Docker but it is not installed",
      remediation: "Install Docker Desktop (macOS) or Docker Engine (Linux).",
    });
    return { errors, warnings };
  }
  if (!report.docker.running) {
    errors.push({
      code: "DOCKER_NOT_RUNNING",
      severity: "error",
      message: `docker runtime requires a running daemon${report.docker.error ? `: ${report.docker.error}` : ""}`,
      remediation: "Start Docker (e.g. `open -a Docker` or `sudo systemctl start docker`).",
    });
    return { errors, warnings };
  }
  // Docker GPU access is Tier-2-authoritative: a remote Docker daemon may
  // have GPU access the local host doesn't (and vice versa), so this
  // deliberately never consults `report.nvidia.available` — only
  // `report.docker.gpuAccess` (Tier 1 `docker info`, or an injected Tier 2
  // `docker run --gpus all ... nvidia-smi` result) decides.
  if (runtime.gpu === "required") {
    if (report.docker.gpuAccess === "unavailable") {
      errors.push({
        code: "DOCKER_GPU_UNAVAILABLE",
        severity: "error",
        message: "docker GPU access is confirmed unavailable on the target daemon",
        remediation: "Install/enable the NVIDIA container runtime on the Docker host, or verify GPU access manually.",
      });
    } else if (report.docker.gpuAccess === "unknown") {
      errors.push({
        code: "DOCKER_GPU_UNVERIFIED",
        severity: "error",
        message: "docker GPU access has not been verified",
        remediation: "Run `moldesk install <model>` interactively to verify GPU access, or pass --yes to confirm the verification image download.",
      });
    }
  } else if (runtime.gpu === "optional") {
    if (report.docker.gpuAccess === "unavailable") {
      warnings.push({
        code: "DOCKER_GPU_UNAVAILABLE",
        severity: "warning",
        message: "Docker GPU access unavailable; CPU execution will be slow",
        remediation: "Install nvidia-container-toolkit for GPU acceleration.",
      });
    } else if (report.docker.gpuAccess === "unknown") {
      warnings.push({
        code: "DOCKER_GPU_UNVERIFIED",
        severity: "warning",
        message: "Docker GPU access not verified; GPU use is uncertain",
        remediation: "Verify GPU access before expecting acceleration.",
      });
    }
  }
  return { errors, warnings };
}

/**
 * Pure compatibility evaluator shared by `doctor`, `list`, and `install`.
 * Never probes, never writes; all machine facts come from `report`.
 */
export function evaluateCompatibility(
  manifest: ModelManifestV1,
  report: SystemReport,
  options: CompatibilityOptions = {},
): CompatibilityResult {
  if (manifest.status === "planned") {
    return {
      status: "unsupported",
      runtimes: [],
      reasons: [
        {
          code: "MODEL_PLANNED",
          severity: "error",
          message: `model "${manifest.name}" is planned and cannot be installed yet`,
          remediation: "Pick a model with status available or beta.",
        },
      ],
    };
  }

  const currentId = currentPlatformId(report);
  const candidates = options.requestedRuntime
    ? manifest.runtimes.filter((r) => r.kind === options.requestedRuntime)
    : [...manifest.runtimes];

  if (options.requestedRuntime && candidates.length === 0) {
    return {
      status: "unsupported",
      runtimes: [],
      reasons: [
        {
          code: "RUNTIME_NOT_AVAILABLE",
          severity: "error",
          message: `model "${manifest.name}" offers no ${options.requestedRuntime} runtime`,
          remediation: `Omit --runtime or choose one of: ${manifest.runtimes.map((r) => r.kind).join(", ")}.`,
        },
      ],
    };
  }

  if (candidates.length === 0) {
    return {
      status: "unsupported",
      runtimes: [],
      reasons: [
        {
          code: "NO_RUNTIMES_DECLARED",
          severity: "error",
          message: `model "${manifest.name}" declares no runtimes`,
          remediation: "Report this manifest bug to the registry maintainers.",
        },
      ],
    };
  }

  // Evaluate every candidate — a manifest offering multiple runtimes should
  // never have its non-selected candidates' diagnostics silently discarded,
  // even when none of them end up compatible.
  const runtimes: RuntimeCompatibility[] = candidates.map((runtime) => {
    const { errors, warnings } = evaluateRuntime(runtime, manifest, report, currentId);
    const status: CompatibilityStatus =
      errors.length > 0 ? "unsupported" : warnings.length > 0 ? "warning" : "compatible";
    return { kind: runtime.kind, status, reasons: [...errors, ...warnings] };
  });

  const clean = runtimes.find((r) => r.status === "compatible");
  if (clean) {
    return { status: "compatible", selectedRuntime: clean.kind, reasons: [], runtimes };
  }

  const warned = runtimes.find((r) => r.status === "warning");
  if (warned) {
    return { status: "warning", selectedRuntime: warned.kind, reasons: warned.reasons, runtimes };
  }

  return {
    status: "unsupported",
    reasons: dedupeReasons(runtimes.flatMap((r) => r.reasons)),
    runtimes,
  };
}

/** Shortest important reason for one-line `list` rendering. */
export function shortReason(result: CompatibilityResult): string {
  const first = result.reasons.find((r) => r.severity === "error")
    ?? result.reasons.find((r) => r.severity === "warning")
    ?? result.reasons[0];
  return first ? `${first.code}: ${first.message}` : "";
}
