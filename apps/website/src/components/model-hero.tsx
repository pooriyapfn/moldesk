import { CommandTabs, type CommandTab } from "@/components/command-tabs";
import { fmtSeconds, fmtUsd } from "@/components/benchmark-table";
import { costPerRun, getBenchmark, hardware, runsPerHour } from "@/lib/benchmarks";
import { AGENT_INSTALL, CLI_INSTALL, REPO_URL, models } from "@/lib/models";

type Stat = { value: string; label: string; detail: string };

function shortGpu(gpu: string): string {
  return gpu.replace(/^NVIDIA (GeForce )?/, "");
}

function stats(model: string): Stat[] {
  const bench = getBenchmark(model);
  const info = models[model];
  const result = bench?.results.find((r) => r.warmSeconds !== null);
  if (!bench || !result) return [];
  const hw = hardware[result.hardwareId];
  if (!hw) return [];

  const gpu = shortGpu(hw.gpu);
  const out: Stat[] = [
    { value: fmtSeconds(result.warmSeconds), label: `per ${bench.runUnit}`, detail: `NVIDIA ${gpu}` },
  ];
  const cost = costPerRun(result.warmSeconds, hw.pricePerHour);
  if (cost !== null && hw.pricePerHour !== null) {
    out.push({ value: fmtUsd(cost), label: `per ${bench.runUnit}`, detail: `${gpu} at $${hw.pricePerHour.toFixed(2)}/hour` });
  }
  if (info?.appleSiliconRun) {
    out.push({ value: fmtSeconds(info.appleSiliconRun.seconds), label: "on a Mac", detail: info.appleSiliconRun.label });
  } else if (result.peakVramGiB !== null) {
    out.push({ value: `${result.peakVramGiB.toFixed(1)} GiB`, label: "peak GPU memory", detail: `${gpu}, test input` });
  }
  const perHour = runsPerHour(result.warmSeconds);
  if (perHour !== null) {
    out.push({ value: String(perHour), label: `${bench.runUnit}s per GPU-hour`, detail: gpu });
  }
  return out;
}

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "ok" | "muted" }) {
  const cls =
    tone === "ok"
      ? "border-accent/40 bg-accent-soft text-foreground"
      : tone === "muted"
        ? "border-border text-muted"
        : "border-border bg-white text-foreground";
  return <span className={`rounded-full border px-2.5 py-[3px] font-mono text-[11px] ${cls}`}>{children}</span>;
}

export function ModelHero({ model }: { model: string }) {
  const info = models[model];
  if (!info) return null;
  const soon = info.status === "soon";
  const tiles = soon ? [] : stats(model);

  const tabs: CommandTab[] = [];
  if (info.install) tabs.push({ label: "Install", command: info.install });
  if (info.run) tabs.push({ label: "Run", command: info.run });
  if (!soon) tabs.push({ label: "Agent", command: AGENT_INSTALL });

  return (
    <section aria-label={`${info.displayName} quick start`} className="not-prose mb-10 mt-2">
      <p className="mb-4 text-[18px] leading-[1.5] text-foreground">{info.tagline}</p>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {info.status === "beta" ? <Chip tone="muted">Beta</Chip> : null}
        {soon ? <Chip tone="muted">Coming soon</Chip> : null}
        {info.appleSilicon ? <Chip tone="ok">✓ Apple Silicon</Chip> : null}
        {info.nvidiaCuda ? <Chip tone="ok">✓ NVIDIA CUDA</Chip> : null}
        <Chip>{info.license}</Chip>
        <a href={info.upstream} className="font-mono text-[11px] text-muted underline decoration-border underline-offset-4 hover:text-accent">
          upstream ↗
        </a>
      </div>

      {soon ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-[14px] text-muted">
          <code className="font-mono text-[15px] text-muted line-through decoration-border">
            moldesk install {info.slug}
          </code>
          <p className="mt-2">
            Not installable yet.{" "}
            <a href={REPO_URL} className="text-accent underline decoration-border underline-offset-4">
              Watch the repository
            </a>{" "}
            to hear when it ships.
          </p>
        </div>
      ) : (
        <>
          <CommandTabs tabs={tabs} model={info.slug} />
          <p className="mt-2.5 text-[13px] text-muted">
            New to MoleculeDesk? Get the CLI first:{" "}
            <code className="font-mono text-[12px] text-foreground">{CLI_INSTALL}</code>
          </p>
        </>
      )}

      {tiles.length > 0 ? (
        <div className="mt-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {tiles.map((t) => (
              <div key={t.label + t.detail} className="rounded-lg border border-border bg-white px-4 py-3">
                <div className="text-[24px] font-semibold tabular-nums leading-tight text-foreground">{t.value}</div>
                <div className="text-[13px] text-foreground">{t.label}</div>
                <div className="mt-1 text-[12px] leading-snug text-muted">{t.detail}</div>
              </div>
            ))}
          </div>
          <a href={`#bench-${info.slug}`} className="mt-2 inline-block text-[13px] text-accent hover:text-accent-hover">
            How we measured ↓
          </a>
        </div>
      ) : null}
    </section>
  );
}
