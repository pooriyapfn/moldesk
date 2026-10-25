import { describe, expect, it } from "vitest";
import { lineChartLayout, niceTicks } from "./chart";

describe("niceTicks", () => {
  it.each([
    [0, 10, [0, 2, 4, 6, 8, 10]],
    [0, 1, [0, 0.2, 0.4, 0.6, 0.8, 1]],
    [3, 47, [10, 20, 30, 40]],
    [0, 0.37, [0, 0.1, 0.2, 0.3]],
    [5, 5, [5]],
  ])("covers %s to %s", (min, max, expected) => expect(niceTicks(min, max)).toEqual(expected));

  it("returns nothing for non-finite input", () => expect(niceTicks(NaN, 3)).toEqual([]));
});

describe("lineChartLayout", () => {
  const spec = { x: "i", y: "d" };

  it("builds one sorted series and a y axis that starts at zero", () => {
    const layout = lineChartLayout([{ i: 3, d: 2.5 }, { i: 1, d: 0 }, { i: 2, d: 1 }], spec);
    expect(layout.series).toEqual([{ name: "", points: [{ x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 2.5 }] }]);
    expect(layout.xDomain).toEqual([1, 3]);
    expect(layout.yDomain[0]).toBe(0);
    expect(layout.yDomain[1]).toBeGreaterThanOrEqual(2.5);
    expect(layout.skipped).toBe(0);
  });

  it("reads numbers from CSV strings and skips rows without finite values", () => {
    const layout = lineChartLayout([{ i: "1", d: "0.5" }, { i: "2", d: "" }, { i: "x", d: "1" }, { i: 4, d: null }, { d: 1 }], spec);
    expect(layout.series[0].points).toEqual([{ x: 1, y: 0.5 }]);
    expect(layout.skipped).toBe(4);
  });

  it("splits series by field", () => {
    const layout = lineChartLayout([{ i: 1, d: 1, c: "A" }, { i: 1, d: 2, c: "B" }, { i: 2, d: 3, c: "A" }], { ...spec, seriesField: "c" });
    expect(layout.series.map((s) => [s.name, s.points.length])).toEqual([["A", 2], ["B", 1]]);
  });

  it("ignores inherited and prototype fields", () => {
    const row = Object.create({ i: 1, d: 1 }) as Record<string, unknown>;
    expect(lineChartLayout([row], spec).series).toEqual([]);
  });

  it("copes with no data and a single point", () => {
    expect(lineChartLayout([], spec)).toMatchObject({ series: [], xDomain: [0, 1], yDomain: [0, 1] });
    const one = lineChartLayout([{ i: 7, d: 0 }], spec);
    expect(one.xDomain).toEqual([7, 8]);
    expect(one.yDomain[1]).toBeGreaterThan(0);
  });
});
