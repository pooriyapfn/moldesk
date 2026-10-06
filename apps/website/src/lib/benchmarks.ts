// Single source of truth for every benchmark shown in the docs. Update numbers
// here only; <BenchmarkTable /> and the /docs/benchmarks overview read from it.

export type BenchmarkHardware = {
  id: string;
  gpu: string;
  vramGiB: number;
  driver: string;
  cpu: string;
  host: string;
  /** USD per GPU-hour. null until a verified rate is recorded; cost cells then show "—". */
  pricePerHour: number | null;
  priceSource?: string;
};

export type BenchmarkResult = {
  hardwareId: string;
  /** What was run, in plain words, so readers can judge whether it matches their job. */
  workload: string;
  /** First run after install (includes one-time cache/compile work). */
  coldSeconds: number | null;
  /** Median of repeated runs after warm-up. */
  warmSeconds: number | null;
  runs: number;
  peakVramGiB: number | null;
  peakGpuUtilPercent: number | null;
  peakPowerWatts: number | null;
  installSeconds: number | null;
  diskGiB: number | null;
  /** ISO date (YYYY-MM-DD) of the measurement. */
  measuredAt: string;
  moldeskCommit: string;
  notes?: string;
};

export type ModelBenchmark = {
  model: string;
  displayName: string;
  /** Unit one "run" is billed in, e.g. "prediction", "design batch". */
  runUnit: string;
  results: BenchmarkResult[];
};

export const hardware: Record<string, BenchmarkHardware> = {
  "rtx3090-runpod": {
    id: "rtx3090-runpod",
    gpu: "NVIDIA GeForce RTX 3090",
    vramGiB: 24,
    driver: "580.126.20",
    cpu: "AMD EPYC 7H12 (32 vCPU allocated)",
    host: "RunPod GPU pod, Linux x64, 125 GiB RAM",
    pricePerHour: 0.5,
    priceSource: "RunPod Secure Cloud, EU-CZ-1, compute only; storage adds about $0.02/hr",
  },
};

export const benchmarks: ModelBenchmark[] = [
  {
    model: "boltz",
    displayName: "Boltz-2",
    runUnit: "prediction",
    results: [
      {
        hardwareId: "rtx3090-runpod",
        workload: "Single protein chain, 115 residues, no MSA (examples/boltz/protein.yaml), 1 sample",
        coldSeconds: 139,
        warmSeconds: 85,
        runs: 3,
        peakVramGiB: 2.6,
        peakGpuUtilPercent: 60,
        peakPowerWatts: 163,
        installSeconds: null,
        diskGiB: 17,
        measuredAt: "2026-10-06",
        moldeskCommit: "9b24d51",
        notes: "Warm time is the mean of runs 2 and 3 (86 s and 84 s). Very first run ever also downloads the CCD data (~198 s total).",
      },
    ],
  },
  { model: "proteinmpnn", displayName: "ProteinMPNN", runUnit: "design batch", results: [] },
  { model: "ligandmpnn", displayName: "LigandMPNN", runUnit: "design batch", results: [] },
  { model: "diffdock", displayName: "DiffDock-L", runUnit: "docking job", results: [] },
  { model: "opendde", displayName: "OpenDDE Preview", runUnit: "prediction", results: [] },
  { model: "bindcraft2", displayName: "BindCraft2", runUnit: "design campaign", results: [] },
];

export function getBenchmark(model: string): ModelBenchmark | undefined {
  return benchmarks.find((b) => b.model === model);
}

export function costPerRun(seconds: number | null, pricePerHour: number | null): number | null {
  if (seconds === null || pricePerHour === null) return null;
  return (seconds / 3600) * pricePerHour;
}

/** Runs per GPU-hour at the warm rate. */
export function runsPerHour(warmSeconds: number | null): number | null {
  return warmSeconds === null ? null : Math.floor(3600 / warmSeconds);
}
