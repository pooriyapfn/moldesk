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
  /** Model is not released yet; show "coming soon" instead of "being measured". */
  comingSoon?: boolean;
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
  "a40-runpod": {
    id: "a40-runpod",
    gpu: "NVIDIA A40",
    vramGiB: 46,
    driver: "570.211.01",
    cpu: "Intel Xeon Gold 6342 (96 logical cores visible)",
    host: "RunPod GPU pod, Linux x64",
    pricePerHour: 0.59,
    priceSource: "RunPod billing explorer, 2026-10-11, total per hour for one A40",
  },
  "rtx6000ada-runpod": {
    id: "rtx6000ada-runpod",
    gpu: "NVIDIA RTX 6000 Ada Generation",
    vramGiB: 48,
    driver: "595.91.07",
    cpu: "not recorded",
    host: "RunPod GPU pod started by `moldesk run --compute runpod` (ephemeral), Linux x64, US-WA-1",
    pricePerHour: 0.99,
    priceSource: "RunPod catalog price shown in the quote on 2026-10-26, compute only",
  },
  "l40s-runpod": {
    id: "l40s-runpod",
    gpu: "NVIDIA L40S",
    vramGiB: 45,
    driver: "595.91.07",
    cpu: "not recorded",
    host: "RunPod GPU pod started by `moldesk run --compute runpod` (ephemeral), Linux x64, EU-NL-1",
    pricePerHour: 1.09,
    priceSource: "RunPod catalog price shown in the quote on 2026-10-26, compute only",
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
  {
    model: "proteinmpnn",
    displayName: "ProteinMPNN",
    runUnit: "design batch",
    results: [
      {
        hardwareId: "rtx3090-runpod",
        workload: "One 20-residue chain (examples/diffdock/protein.pdb), default sampling, 1 sequence",
        coldSeconds: 16,
        warmSeconds: 8,
        runs: 3,
        peakVramGiB: 0.4,
        peakGpuUtilPercent: 9,
        peakPowerWatts: 108,
        installSeconds: 365,
        diskGiB: 6.0,
        measuredAt: "2026-10-06",
        moldeskCommit: "57776a4",
        notes: "Warm time is the mean of runs 2 and 3 (7.9 s and 8.1 s). Install time includes downloading PyTorch with an empty package cache. Peak GPU power is near the idle-to-light-load range because the job is tiny.",
      },
    ],
  },
  {
    model: "ligandmpnn",
    displayName: "LigandMPNN",
    runUnit: "design batch",
    results: [
      {
        hardwareId: "rtx3090-runpod",
        workload: "One 20-residue chain (examples/diffdock/protein.pdb), default sampling, 1 sequence",
        coldSeconds: 15,
        warmSeconds: 10,
        runs: 3,
        peakVramGiB: 0.4,
        peakGpuUtilPercent: 10,
        peakPowerWatts: 108,
        installSeconds: 59,
        diskGiB: 6.5,
        measuredAt: "2026-10-06",
        moldeskCommit: "57776a4",
        notes: "Warm time is the mean of runs 2 and 3 (9.7 s and 9.9 s). Install time is with PyTorch already in the package cache; expect several minutes on a first install.",
      },
    ],
  },
  {
    model: "diffdock",
    displayName: "DiffDock-L",
    runUnit: "docking job",
    results: [
      {
        hardwareId: "a40-runpod",
        workload: "Adenosine A2A receptor (PDB 5MZP chain A, ligands and waters removed) + caffeine SMILES, default sampling, 10 ranked poses",
        coldSeconds: 63,
        warmSeconds: 69,
        runs: 2,
        peakVramGiB: 8.3,
        peakGpuUtilPercent: null,
        peakPowerWatts: null,
        installSeconds: 600,
        diskGiB: null,
        measuredAt: "2026-10-11",
        moldeskCommit: "a4ee635",
        notes: "Only one run per job, so these are single measurements, not medians. The 63 s cold figure is the first run after install (examples/diffdock Trp-cage + aspirin); the 69 s figure is the A2A + caffeine job above. VRAM is whole-GPU memory used during the A2A run; average board power was about 113 W. Install is about 10 minutes, including the one-time diffusion lookup-table cache.",
      },
    ],
  },
  {
    model: "opendde",
    displayName: "OpenDDE Preview",
    runUnit: "prediction",
    results: [
      {
        hardwareId: "rtx3090-runpod",
        workload: "9-residue peptide ACDEFGHIK (examples/opendde/tiny.json), default settings: 1 sample, 200 steps, 10 cycles, no MSA",
        coldSeconds: 88,
        warmSeconds: 57,
        runs: 3,
        peakVramGiB: 5.6,
        peakGpuUtilPercent: 28,
        peakPowerWatts: 124,
        installSeconds: null,
        diskGiB: 12,
        measuredAt: "2026-10-06",
        moldeskCommit: "57776a4",
        notes: "Warm time is the mean of runs 2 and 3 (57.4 s and 57.7 s). Larger complexes need more time and memory than this smoke-test input.",
      },
    ],
  },
  {
    model: "rfd4-proteina",
    displayName: "RFD4-Proteina",
    runUnit: "run",
    results: [
      {
        hardwareId: "rtx6000ada-runpod",
        workload: "One unconditioned 100-residue monomer (examples/rfd4-proteina/monomer.yaml), 1 design, recycle=thinking_low, seed 42, run with `--compute runpod --cache-policy ephemeral`",
        coldSeconds: 162,
        warmSeconds: 163,
        runs: 3,
        peakVramGiB: 2.3,
        peakGpuUtilPercent: null,
        peakPowerWatts: null,
        installSeconds: null,
        diskGiB: 17.5,
        measuredAt: "2026-10-26",
        moldeskCommit: "fc3282b (uncommitted working tree)",
        notes:
          "Cloud ephemeral runs rebuild the environment every time, so there is no true warm state: each time is the whole run from provisioning the Pod to results on your machine (162 s, 155 s, 171 s; the warm figure is the mean of runs 2 and 3). It covers installing the pinned PyTorch 2.14 CUDA 12.6 environment (167 packages), downloading the 1.74 GB weights, loading the model and generating; generation itself took 11-13 s for one design. Install time is not measured separately. Disk is the peak growth of the Pod's disk (17.7 GiB used at peak, 40 GiB provisioned). Four designs in one run (numReplicates=4) took 175 s on the same GPU type (US-IL-1), about 13 s more than one design, so the fixed setup dominates short jobs. Same seed gave identical coordinates in two runs. Peak GPU memory comes from the worker's probe; utilization and power are not recorded in cloud runs. Larger targets and longer designs need more time and memory than this smoke-test input.",
      },
      {
        hardwareId: "l40s-runpod",
        workload: "PD-L1 binder (examples/rfd4-proteina/pdl1-binder/binder.yaml, upstream's example: 5O45 chain A residues 17-131, three hotspots), 4 designs in one batch (numReplicates=4, batchSize=4), default recycling, seed 42, run with `--compute runpod --cache-policy ephemeral`",
        coldSeconds: 308,
        warmSeconds: 243,
        runs: 3,
        peakVramGiB: 4.3,
        peakGpuUtilPercent: null,
        peakPowerWatts: null,
        installSeconds: null,
        diskGiB: 17.5,
        measuredAt: "2026-10-26",
        moldeskCommit: "fc3282b (uncommitted working tree)",
        notes:
          "One run makes four designs, so the cost per design is about a quarter of the cost per run: roughly $0.02 per design ($0.09 for the first run, $0.07 after). Runs took 308 s, 239 s and 248 s; the warm figure is the mean of runs 2 and 3, and every run installs the environment from scratch. Generating the four designs took about 1 minute of that. All three runs produced identical coordinates for all four designs. Eight designs in one batch (numReplicates=8, batchSize=8, the setting in upstream's cookbook) took 302 s on an L40S in EUR-IS-2 (about $0.09, or $0.012 per design), with generation taking 118 s and peak GPU memory 7.1 GiB; that was a single run. Peak GPU memory is from the worker's probe; this target (115 residues plus a 50-120 residue binder) is still small, so larger complexes need more.",
      },
    ],
  },
  {
    model: "bindcraft2",
    displayName: "BindCraft2",
    runUnit: "design campaign",
    results: [
      {
        hardwareId: "rtx3090-runpod",
        workload: "Bounded campaign (examples/bindcraft2/campaign.json): 50-residue binder against a short peptide target, 1 trajectory, 1 final design, seed 101",
        coldSeconds: 152,
        warmSeconds: 230,
        runs: 3,
        peakVramGiB: 4.5,
        peakGpuUtilPercent: 100,
        peakPowerWatts: 303,
        installSeconds: null,
        diskGiB: 13,
        measuredAt: "2026-10-06",
        moldeskCommit: "57776a4",
        notes: "Runs took 152 s, 232 s and 229 s: design search is stochastic, so time varies run to run and there is no cold-start penalty. The 'warm' figure is the mean of runs 2 and 3. Real campaigns with more trajectories scale roughly linearly with trajectory count.",
      },
      {
        hardwareId: "a40-runpod",
        workload: "GFP binder (PDB 1EMA chain A, 225 residues), binder length 60-80, 1 final design, up to 8 trajectories, seed 42",
        coldSeconds: null,
        warmSeconds: 1804,
        runs: 1,
        peakVramGiB: 17.1,
        peakGpuUtilPercent: null,
        peakPowerWatts: null,
        installSeconds: 600,
        diskGiB: null,
        measuredAt: "2026-10-11",
        moldeskCommit: "a4ee635",
        notes: "Single measurement: the campaign stopped after 2 trajectories with 1 accepted design. A first identical attempt aborted in trajectory 2 with a JAX CUDA error after about 21 minutes; the retry completed. VRAM is whole-GPU memory used; average board power was about 238 W. Time depends on trajectory count and target size.",
      },
    ],
  },
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
