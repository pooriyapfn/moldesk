import {
  costPerRun,
  getBenchmark,
  hardware,
  runsPerHour,
  type BenchmarkResult,
} from "@/lib/benchmarks";

const dash = "—";

function fmtSeconds(s: number | null): string {
  if (s === null) return dash;
  if (s < 120) return `${s} s`;
  return `${(s / 60).toFixed(1)} min`;
}

function fmtNum(n: number | null, unit: string, digits = 0): string {
  return n === null ? dash : `${n.toFixed(digits)} ${unit}`;
}

function fmtUsd(n: number | null): string {
  if (n === null) return dash;
  return n < 0.01 ? `<$0.01` : `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

function summary(displayName: string, runUnit: string, r: BenchmarkResult, gpu: string, price: number | null) {
  if (r.warmSeconds === null) return `${displayName} has not been benchmarked on ${gpu} yet.`;
  const perHour = runsPerHour(r.warmSeconds);
  const cost = costPerRun(r.warmSeconds, price);
  return (
    `On an ${gpu}, ${displayName} takes about ${fmtSeconds(r.warmSeconds)} per ${runUnit} once warm` +
    (r.coldSeconds !== null ? ` (${fmtSeconds(r.coldSeconds)} on the first run)` : "") +
    (perHour !== null ? `, roughly ${perHour} ${runUnit}s per GPU-hour` : "") +
    (cost !== null ? `, or about ${fmtUsd(cost)} per ${runUnit}` : "") +
    "."
  );
}

export function BenchmarkTable({ model }: { model: string }) {
  const bench = getBenchmark(model);
  if (!bench) return null;

  if (bench.results.length === 0) {
    return (
      <section aria-labelledby={`bench-${model}`} className="not-prose my-6">
        <h2 id={`bench-${model}`} className="mb-2 text-xl font-semibold">
          {bench.displayName} benchmarks
        </h2>
        <p className="rounded-md border border-border bg-white px-4 py-3 text-[14px] text-muted">
          Pace and cost numbers for {bench.displayName} on NVIDIA CUDA are being measured and will appear here.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`bench-${model}`} className="not-prose my-6">
      <h2 id={`bench-${model}`} className="mb-2 text-xl font-semibold">
        {bench.displayName} benchmarks: speed, VRAM and cost per {bench.runUnit}
      </h2>
      {bench.results.map((r) => {
        const hw = hardware[r.hardwareId];
        if (!hw) return null;
        const cold = costPerRun(r.coldSeconds, hw.pricePerHour);
        const warm = costPerRun(r.warmSeconds, hw.pricePerHour);
        const rows: Array<[string, string]> = [
          ["Time per run, first (cold)", fmtSeconds(r.coldSeconds)],
          ["Time per run, warm", fmtSeconds(r.warmSeconds)],
          [`${bench.runUnit[0].toUpperCase()}${bench.runUnit.slice(1)}s per GPU-hour`, fmtNum(runsPerHour(r.warmSeconds), "", 0).trim()],
          ["Cost per run, first (cold)", fmtUsd(cold)],
          ["Cost per run, warm", fmtUsd(warm)],
          ["Peak GPU memory", fmtNum(r.peakVramGiB, "GiB", 1)],
          ["Peak GPU utilization", fmtNum(r.peakGpuUtilPercent, "%")],
          ["Peak GPU power", fmtNum(r.peakPowerWatts, "W")],
          ["Install time", fmtSeconds(r.installSeconds)],
          ["Disk per install", fmtNum(r.diskGiB, "GiB")],
        ];
        return (
          <figure key={r.hardwareId} className="my-4">
            <p className="mb-3 text-[14px] text-muted">
              {summary(bench.displayName, bench.runUnit, r, hw.gpu, hw.pricePerHour)}
            </p>
            <div className="overflow-x-auto rounded-md border border-border bg-white">
              <table className="w-full border-collapse text-left text-[14px]">
                <caption className="border-b border-border px-4 py-2 text-left text-[13px] text-muted">
                  {bench.displayName} on {hw.gpu} ({hw.vramGiB} GiB), measured{" "}
                  <time dateTime={r.measuredAt}>{r.measuredAt}</time> with MoleculeDesk {r.moldeskCommit}
                </caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className="px-4 py-2 font-semibold">Metric</th>
                    <th scope="col" className="px-4 py-2 font-semibold">{hw.gpu}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([label, value]) => (
                    <tr key={label} className="border-b border-border last:border-0">
                      <th scope="row" className="px-4 py-2 font-normal text-muted">{label}</th>
                      <td className="px-4 py-2 tabular-nums">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <figcaption className="mt-2 space-y-1 text-[13px] text-muted">
              <p><strong className="text-foreground">Workload:</strong> {r.workload}. Median of {r.runs} run{r.runs === 1 ? "" : "s"}.</p>
              <p><strong className="text-foreground">Machine:</strong> {hw.host}; {hw.cpu}; driver {hw.driver}.</p>
              <p>
                <strong className="text-foreground">Cost:</strong>{" "}
                {hw.pricePerHour === null
                  ? "multiply the time per run by your provider's GPU-hour price (cost = seconds ÷ 3600 × price)."
                  : `at $${hw.pricePerHour.toFixed(2)}/GPU-hour${hw.priceSource ? ` (${hw.priceSource})` : ""}; excludes storage and idle time.`}
              </p>
              {r.notes ? <p>{r.notes}</p> : null}
            </figcaption>
          </figure>
        );
      })}
    </section>
  );
}
