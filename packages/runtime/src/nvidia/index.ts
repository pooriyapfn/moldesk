import type { CaptureFn } from "../process/index.js";

export interface NvidiaGpu {
  index: number;
  name: string;
  totalVramBytes?: number;
}

export interface NvidiaCapability {
  available: boolean;
  driverVersion?: string;
  /** Driver-reported max-supported CUDA version (from `nvidia-smi -q -x`), major.minor. */
  driverCudaVersion?: string;
  /** Locally installed CUDA toolkit version (from `nvcc --version`). Diagnostic only — never used in compatibility checks. */
  cudaToolkitVersion?: string;
  gpus: NvidiaGpu[];
  error?: string;
}

const PROBE_TIMEOUT_MS = 10_000;
const BYTES_PER_MIB = 1024 * 1024;

function splitCsvLines(output: string): string[][] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

function parseNonNegativeInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Extract the driver's max-supported CUDA version from `nvidia-smi -q -x` XML
 * output. `<cuda_version>` is a singular top-level tag (appears once, before
 * any per-GPU `<gpu>` repetition), so a first-match regex is unambiguous
 * without needing a full XML parser. Never parse the decorative ASCII table.
 */
export function parseDriverCudaVersionXml(xml: string): string | undefined {
  const match = xml.match(/<cuda_version>\s*([\d.]+)\s*<\/cuda_version>/i);
  if (!match) return undefined;
  const value = match[1];
  return value && value.toLowerCase() !== "not found" ? value : undefined;
}

function parseToolkitCudaVersion(nvccOutput: string): string | undefined {
  const match = nvccOutput.match(/release\s+(\d+\.\d+(?:\.\d+)?)/i);
  return match ? match[1] : undefined;
}

/**
 * Probe NVIDIA GPUs via `nvidia-smi` CSV output only (never the
 * decorative table). Any missing tool / error / unparsable output
 * becomes `{available:false}` rather than throwing.
 */
export async function detectNvidia(
  capture?: CaptureFn,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<NvidiaCapability> {
  let run: CaptureFn;
  if (capture) {
    run = capture;
  } else {
    const { defaultCapture } = await import("../process/index.js");
    run = defaultCapture;
  }

  const gpuResult = await run(
    "nvidia-smi",
    ["--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
    { timeoutMs },
  );
  if (gpuResult.timedOut) {
    return {
      available: false,
      gpus: [],
      error: `nvidia-smi timed out after ${timeoutMs}ms`,
    };
  }
  if (gpuResult.code !== 0) {
    const detail = `${gpuResult.stdout}\n${gpuResult.stderr}`.trim();
    return {
      available: false,
      gpus: [],
      error:
        detail.length > 0
          ? `nvidia-smi unavailable: ${detail.split("\n")[0]}`
          : "nvidia-smi not detected (no NVIDIA GPU or driver)",
    };
  }

  const rows = splitCsvLines(gpuResult.stdout);
  if (rows.length === 0) {
    return {
      available: false,
      gpus: [],
      error: "nvidia-smi returned no GPU rows",
    };
  }

  const gpus: NvidiaGpu[] = [];
  for (const cells of rows) {
    if (cells.length < 3) {
      return {
        available: false,
        gpus: [],
        error: `unrecognized nvidia-smi output: ${JSON.stringify(cells)}`,
      };
    }
    const [indexRaw, nameRaw, memoryRaw] = cells as [string, string, string];
    const index = parseNonNegativeInt(indexRaw);
    if (index === undefined || nameRaw.length === 0) {
      return {
        available: false,
        gpus: [],
        error: `unrecognized nvidia-smi output: ${JSON.stringify(cells)}`,
      };
    }
    const memoryMib = parseNonNegativeInt(memoryRaw);
    gpus.push({
      index,
      name: nameRaw,
      totalVramBytes:
        memoryMib === undefined ? undefined : memoryMib * BYTES_PER_MIB,
    });
  }

  // Driver/CUDA versions are best-effort; GPU presence decides availability.
  let driverVersion: string | undefined;
  let driverCudaVersion: string | undefined;
  let cudaToolkitVersion: string | undefined;
  const driverResult = await run(
    "nvidia-smi",
    ["--query-gpu=driver_version", "--format=csv,noheader,nounits"],
    { timeoutMs },
  );
  if (!driverResult.timedOut && driverResult.code === 0) {
    const first = driverResult.stdout.split("\n").map((l) => l.trim()).find(Boolean);
    if (first && first.toLowerCase() !== "[not supported]") driverVersion = first;
  }
  // Structured XML query for the driver's max-supported CUDA version — never
  // scrape the decorative `nvidia-smi` banner table.
  const cudaXmlResult = await run("nvidia-smi", ["-q", "-x"], { timeoutMs });
  if (!cudaXmlResult.timedOut && cudaXmlResult.code === 0) {
    driverCudaVersion = parseDriverCudaVersionXml(cudaXmlResult.stdout);
  }
  const toolkitResult = await run("nvcc", ["--version"], { timeoutMs });
  if (!toolkitResult.timedOut && toolkitResult.code === 0) {
    cudaToolkitVersion = parseToolkitCudaVersion(`${toolkitResult.stdout}\n${toolkitResult.stderr}`);
  }

  return { available: true, driverVersion, driverCudaVersion, cudaToolkitVersion, gpus };
}
