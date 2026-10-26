// Stacked bars: how much of each Runpod run is fixed setup and how much is generation.
// Numbers come from the measured runs on the RFD4-Proteina model page (2026-10-26).

type Bar = { label: string; gpu: string; setup: number; generation: number; cost: string };

const bars: Bar[] = [
  { label: "1 design, monomer (run 1)", gpu: "RTX 6000 Ada, $0.99/h", setup: 149, generation: 13, cost: "$0.045" },
  { label: "4 designs, PD-L1 (run 1)", gpu: "L40S, $1.09/h", setup: 250, generation: 58, cost: "$0.093" },
  { label: "8 designs, PD-L1 (single run)", gpu: "L40S, $1.09/h", setup: 184, generation: 118, cost: "$0.092" },
];

const SETUP = "#9aa5a0";
const GENERATION = "#2f7d68";

export function RunTimeChart() {
  const max = 340;
  const left = 190;
  const width = 640;
  const plot = width - left - 70;
  const rowH = 54;
  const height = bars.length * rowH + 52;
  const x = (s: number) => (s / max) * plot;
  const summary = bars
    .map((b) => `${b.label} on ${b.gpu}: ${b.setup} s setup plus ${b.generation} s generation, ${b.cost}`)
    .join("; ");

  return (
    <figure className="not-prose my-6">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Time per run split into setup and generation. ${summary}.`} className="w-full rounded-md border border-border bg-white">
        {[0, 100, 200, 300].map((t) => (
          <g key={t}>
            <line x1={left + x(t)} x2={left + x(t)} y1={14} y2={height - 34} stroke="#dce3e0" strokeWidth="1" />
            <text x={left + x(t)} y={height - 16} textAnchor="middle" fontSize="11" fill="#5c6964">{t} s</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const y = 22 + i * rowH;
          return (
            <g key={b.label}>
              <text x={left - 10} y={y + 11} textAnchor="end" fontSize="12" fill="#111816">{b.label}</text>
              <text x={left - 10} y={y + 26} textAnchor="end" fontSize="11" fill="#5c6964">{b.gpu}</text>
              <rect x={left} y={y} width={x(b.setup)} height={24} fill={SETUP} rx="2" />
              <rect x={left + x(b.setup)} y={y} width={Math.max(x(b.generation), 2)} height={24} fill={GENERATION} rx="2" />
              <text x={left + x(b.setup + b.generation) + 8} y={y + 16} fontSize="12" fill="#111816">
                {b.setup + b.generation} s · {b.cost}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
        <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SETUP }} />Setup: Pod start, install, 1.7 GB weights, model load, download</span>
        <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: GENERATION }} />Generating the designs</span>
      </figcaption>
    </figure>
  );
}
