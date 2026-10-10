import { describe, expect, it } from "vitest";
import { getAdapter } from "./index.js";
import { ReportBuilder } from "./visualization.js";

describe("adapter visualization hooks", () => {
  it.each(["boltz", "opendde", "bindcraft2", "diffdock"])("%s describes its structure outputs", (name) => {
    expect(typeof getAdapter(name)?.describeVisualization).toBe("function");
  });

  it.each(["proteinmpnn", "ligandmpnn"])(
    "%s produces sequences, not coordinates, so it has no automatic report",
    (name) => {
      expect(getAdapter(name)?.describeVisualization).toBeUndefined();
    },
  );
});

describe("ReportBuilder", () => {
  it("reuses one resource for the same file and puts the structure panel first", () => {
    const b = new ReportBuilder();
    const a = b.resource({ kind: "input", path: "/r.pdb" }, "pdb", "r.pdb");
    expect(b.resource({ kind: "input", path: "/r.pdb" }, "pdb", "r.pdb")).toBe(a);
    // Same path, different kind is a different source.
    expect(b.resource({ kind: "output", path: "/r.pdb" }, "pdb", "r.pdb")).not.toBe(a);
    b.scene({ id: "s1", title: "S", structures: [{ id: "x", resourceId: a }] });
    b.table("T", a);
    const d = b.build("Title");
    expect(d.panels.map((p) => p.kind)).toEqual(["structure", "table"]);
    expect(d.resources).toHaveLength(2);
  });

  it("builds a chart-only description without a structure panel", () => {
    const b = new ReportBuilder();
    b.table("T", b.resource({ kind: "output", path: "/a.json" }, "json", "a.json"), [], "rows");
    const d = b.build("t");
    expect(d.scenes).toEqual([]);
    expect(d.panels).toEqual([{ id: "table-1", kind: "table", title: "T", dataset: { resourceId: "r1", rowsKey: "rows" }, columns: [] }]);
  });
});
