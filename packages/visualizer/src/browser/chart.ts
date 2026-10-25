// Layout for the report's line charts: pure data in, plain numbers out, so it can be tested without a DOM.
// The viewer draws the result as SVG.

export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartSeries {
  name: string;
  points: ChartPoint[];
}

export interface LineChartLayout {
  series: ChartSeries[];
  xDomain: [number, number];
  yDomain: [number, number];
  xTicks: number[];
  yTicks: number[];
  /** Rows that had no finite x or y and were left out. */
  skipped: number;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

/** "Nice" tick values (1, 2, 5 x 10^n) covering [min, max]. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const rough = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= rough) ?? 10) * magnitude;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

export function lineChartLayout(
  rows: ReadonlyArray<Record<string, unknown>>,
  spec: { x: string; y: string; seriesField?: string },
): LineChartLayout {
  const bySeries = new Map<string, ChartPoint[]>();
  let skipped = 0;
  for (const row of rows) {
    const get = (field: string): unknown => (Object.hasOwn(row, field) ? row[field] : undefined);
    const x = toNumber(get(spec.x));
    const y = toNumber(get(spec.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      skipped++;
      continue;
    }
    const name = spec.seriesField === undefined ? "" : String(get(spec.seriesField) ?? "");
    (bySeries.get(name) ?? bySeries.set(name, []).get(name)!).push({ x, y });
  }
  const series = [...bySeries].map(([name, points]) => ({ name, points: points.sort((a, b) => a.x - b.x) }));
  const all = series.flatMap((s) => s.points);
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xMin = xs.length ? Math.min(...xs) : 0;
  const xMax = xs.length ? Math.max(...xs) : 1;
  // The y axis starts at 0 when every value is non-negative, so a flat line reads as "no deviation".
  const yMin = ys.length ? Math.min(0, ...ys) : 0;
  const yTicks = niceTicks(yMin, ys.length ? Math.max(...ys) : 1);
  return {
    series,
    xDomain: [xMin, xMax === xMin ? xMin + 1 : xMax],
    yDomain: [yMin, Math.max(yTicks.at(-1) ?? 1, ys.length ? Math.max(...ys) : 1, yMin + 1)],
    xTicks: niceTicks(xMin, xMax === xMin ? xMin + 1 : xMax),
    yTicks,
    skipped,
  };
}
