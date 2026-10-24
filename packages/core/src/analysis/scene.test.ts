import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeEnvelope, extractEnvelope, loadBundle, validateReport } from "@moldesk/visualizer";
import { createStandaloneReport } from "../visualization.js";
import { buildSceneComponents, parseSceneFile, PLDDT_BINS, readSceneFile, resolveViewRequest } from "./scene.js";

const FIXTURES = path.resolve(import.meta.dirname, "../../../visualizer/test/fixtures");
const CRN = path.join(FIXTURES, "1CRN.pdb");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-scene-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, content: string) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

const ids = (components: Awaited<ReturnType<typeof buildSceneComponents>>) => components.map((c) => c.id);

describe("buildSceneComponents: highlights", () => {
  it("keeps the default chain coloring as a base layer and adds a colored highlight on top", async () => {
    const components = await buildSceneComponents(CRN, { components: [{ selector: "A:40-60" }] });
    expect(ids(components)).toEqual(["base", "ligand", "ion", "highlight-1"]);
    expect(components[0]).toMatchObject({ selection: { kind: "all" }, representation: "cartoon" });
    expect(components[0].color).toBeUndefined();
    const highlight = components[3];
    expect(highlight).toMatchObject({ representation: "sticks", color: "#ff5500", label: "Highlight A:40-60" });
    // 1CRN has 46 residues, so only 40-46 exist.
    expect(highlight.selection).toMatchObject({ kind: "residues" });
    const refs = (highlight.selection as { residues: Array<{ sequenceId: number }> }).residues;
    expect(refs.map((r) => r.sequenceId)).toEqual([40, 41, 42, 43, 44, 45, 46]);
    expect(refs[0]).toEqual({ chainNamespace: "auth", chainId: "A", residueNamespace: "auth", sequenceId: 40 });
  });

  it("uses the given colors, representation and label, and cycles the palette otherwise", async () => {
    const components = await buildSceneComponents(CRN, {
      components: [
        { selector: "A:1", color: "#123abc", label: "N-term", representation: "surface" },
        { selector: "A:2" },
        { selector: "A:3" },
      ],
    });
    expect(components.slice(3).map((c) => [c.color, c.label, c.representation])).toEqual([
      ["#123abc", "N-term", "surface"],
      ["#ffd400", "Highlight A:2", "sticks"],
      ["#00c2ff", "Highlight A:3", "sticks"],
    ]);
  });

  it("selects a whole chain as a chain selection", async () => {
    const components = await buildSceneComponents(CRN, { components: [{ selector: "A" }] });
    expect(components.at(-1)!.selection).toEqual({ kind: "chains", namespace: "auth", ids: ["A"] });
  });

  it("keeps insertion codes and supports label ids", async () => {
    const vh = path.join(FIXTURES, "1IGT-VH.pdb");
    const [highlight] = (await buildSceneComponents(vh, { components: [{ selector: "B:100H" }] })).slice(-1);
    expect(highlight.selection).toMatchObject({ residues: [{ sequenceId: 100, insertionCode: "H" }] });

    const label = await buildSceneComponents(path.join(FIXTURES, "1AAY.pdb"), { label: true, components: [{ selector: "A:88" }] });
    expect(label.at(-1)!.selection).toMatchObject({ residues: [{ chainNamespace: "label", residueNamespace: "label", sequenceId: 88 }] });
  });

  it.each(["A:99", "Z", "A:60-70"])("fails with SELECTOR_NO_MATCH when %s matches nothing", async (selector) => {
    await expect(buildSceneComponents(CRN, { components: [{ selector }] })).rejects.toMatchObject({ code: "SELECTOR_NO_MATCH" });
  });

  it("lists the available chains and residues in the error", async () => {
    const error = await buildSceneComponents(CRN, { components: [{ selector: "A:60-70" }] }).catch((e) => e);
    expect(error.message).toBe('Highlight "A:60-70" matches nothing in 1CRN.pdb: chain "A" (auth ids) has protein residues 1-46, but no residues 60-70.');
    expect(error.details).toMatchObject({ reason: "no-residue", available: [{ chainId: "A", type: "protein", residueCount: 46, residues: "1-46" }] });
  });

  it("fails with INVALID_SELECTOR for bad syntax", async () => {
    await expect(buildSceneComponents(CRN, { components: [{ selector: "A:60-40" }] })).rejects.toMatchObject({ code: "INVALID_SELECTOR" });
  });

  it("refuses a pLDDT class larger than one report selection allows", async () => {
    const f = (v: number) => v.toFixed(3).padStart(8);
    const lines = ["A", "B"].flatMap((chain, c) =>
      Array.from({ length: 6000 }, (_, i) => `ATOM  ${String(c * 6000 + i + 1).padStart(5)} ${"CA".padEnd(4)} GLY ${chain}${String(i + 1).padStart(4)}    ${f((i % 100) * 3.8)}${f(Math.floor(i / 100) * 3.8)}${f(c * 50)}  1.00 95.00           C`),
    );
    const big = write("big.pdb", `${lines.join("\n")}\nEND\n`);
    await expect(buildSceneComponents(big, { colorBy: "plddt", bfactorIsPlddt: true, components: [] })).rejects.toMatchObject({ code: "SCENE_TOO_LARGE" });
  });
});

describe("buildSceneComponents: color by pLDDT", () => {
  it("refuses without a known pLDDT source", async () => {
    await expect(buildSceneComponents(CRN, { colorBy: "plddt", components: [] })).rejects.toMatchObject({ code: "PLDDT_UNAVAILABLE" });
  });

  it("bins residues into the four AlphaFold classes, each residue once", async () => {
    const components = await buildSceneComponents(CRN, { colorBy: "plddt", bfactorIsPlddt: true, components: [] });
    const bins = components.filter((c) => c.id.startsWith("plddt-"));
    expect(bins.length).toBeGreaterThan(0);
    for (const c of bins) expect(c.color).toBe(PLDDT_BINS.find((b) => b.id === c.id)!.color);
    const all = bins.flatMap((c) => (c.selection as { residues: Array<{ sequenceId: number }> }).residues.map((r) => r.sequenceId));
    expect(all.sort((a, b) => a - b)).toEqual(Array.from({ length: 46 }, (_, i) => i + 1));
    expect(ids(components).filter((id) => id === "base")).toEqual([]);
  });

  it("puts the class boundaries where AlphaFold does (90, 70, 50 go up)", async () => {
    const values = [95, 90, 89.99, 70, 69.99, 50, 49.99];
    const cif = fs.readFileSync(path.join(FIXTURES, "1CRN.cif"), "utf8") + `
loop_
_ma_qa_metric.id
_ma_qa_metric.name
_ma_qa_metric.mode
1 pLDDT local
#
loop_
_ma_qa_metric_local.ordinal_id
_ma_qa_metric_local.model_id
_ma_qa_metric_local.label_asym_id
_ma_qa_metric_local.label_seq_id
_ma_qa_metric_local.label_comp_id
_ma_qa_metric_local.metric_id
_ma_qa_metric_local.metric_value
${values.map((v, i) => `${i + 1} 1 A ${i + 1} X 1 ${v}`).join("\n")}
#
`;
    const components = await buildSceneComponents(write("m.cif", cif), { colorBy: "plddt", components: [] });
    const byBin = Object.fromEntries(
      components.filter((c) => c.id.startsWith("plddt-")).map((c) => [c.id, (c.selection as { residues: Array<{ sequenceId: number }> }).residues.map((r) => r.sequenceId)]),
    );
    expect(byBin).toEqual({
      "plddt-very-high": [1, 2],
      "plddt-confident": [3, 4],
      "plddt-low": [5, 6],
      "plddt-very-low": [7],
    });
  });
});

describe("scene files", () => {
  const valid = { structure: "p.pdb", colorBy: "chain", components: [{ selector: "A:1", color: "#ABCDEF", representation: "cartoon" }] };

  it("parses and normalizes", () => {
    expect(parseSceneFile(valid)).toEqual({ ...valid, components: [{ selector: "A:1", color: "#abcdef", representation: "cartoon" }] });
  });

  it.each([
    ["unknown key", { components: [], extra: 1 }],
    ["missing components", {}],
    ["bad color", { components: [{ selector: "A", color: "red" }] }],
    ["css injection color", { components: [{ selector: "A", color: "#fff;background:url(x)" }] }],
    ["bad colorBy", { colorBy: "rainbow", components: [] }],
    ["bad representation", { components: [{ selector: "A", representation: "spheres" }] }],
    ["selector not a string", { components: [{ selector: 5 }] }],
    ["unknown component key", { components: [{ selector: "A", selection: { kind: "all" } }] }],
    ["too many components", { components: Array.from({ length: 200 }, () => ({ selector: "A" })) }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseSceneFile(value)).toThrow(expect.objectContaining({ code: "INVALID_SCENE" }));
  });

  it("rejects __proto__ keys", () => {
    expect(() => parseSceneFile(JSON.parse('{"components":[],"__proto__":{"x":1}}'))).toThrow(expect.objectContaining({ code: "INVALID_SCENE" }));
  });

  it("resolves the structure inside the scene folder and refuses to leave it", () => {
    const file = write("s/scene.json", JSON.stringify(valid));
    expect(readSceneFile(file).structurePath).toBe(path.join(dir, "s", "p.pdb"));
    for (const structure of ["../p.pdb", "/etc/hosts", "a/../../p.pdb"]) {
      expect(() => readSceneFile(write("s/scene.json", JSON.stringify({ ...valid, structure })))).toThrow(expect.objectContaining({ code: "INVALID_SCENE" }));
    }
  });

  it("rejects missing, oversize and non-JSON scene files", () => {
    expect(() => readSceneFile(path.join(dir, "nope.json"))).toThrow(expect.objectContaining({ code: "INVALID_SCENE" }));
    expect(() => readSceneFile(write("bad.json", "{"))).toThrow(expect.objectContaining({ code: "INVALID_SCENE" }));
    expect(() => readSceneFile(write("big.json", " ".repeat(1024 * 1024 + 1)))).toThrow(expect.objectContaining({ code: "INVALID_SCENE" }));
  });
});

describe("resolveViewRequest", () => {
  it("returns no view for a plain request", () => {
    expect(resolveViewRequest({ file: "p.pdb" })).toEqual({ file: "p.pdb" });
  });

  it("builds components from flags, with one shared or one color per highlight", () => {
    const shared = resolveViewRequest({ file: "p.pdb", highlights: ["A:1", "B:2"], colors: ["#ff5500"] });
    expect(shared.view!.components.map((c) => c.color)).toEqual(["#ff5500", "#ff5500"]);
    const each = resolveViewRequest({ file: "p.pdb", highlights: ["A:1", "B:2"], colors: ["#111111", "#222222"] });
    expect(each.view!.components.map((c) => c.color)).toEqual(["#111111", "#222222"]);
    expect(resolveViewRequest({ file: "p.pdb", colorBy: "plddt" }).view).toMatchObject({ colorBy: "plddt", components: [] });
  });

  it("reads everything from a scene file, with the structure in it or on the command line", () => {
    const scene = write("s/scene.json", JSON.stringify({ structure: "p.pdb", components: [{ selector: "A:1" }] }));
    expect(resolveViewRequest({ scene })).toMatchObject({ file: path.join(dir, "s", "p.pdb"), view: { components: [{ selector: "A:1" }] } });
    const noStructure = write("s/other.json", JSON.stringify({ components: [] }));
    expect(resolveViewRequest({ scene: noStructure, file: "x.pdb" }).file).toBe("x.pdb");
  });

  it.each([
    ["no file", { highlights: ["A"] }],
    ["--color without --highlight", { file: "p.pdb", colors: ["#ff5500"] }],
    ["wrong number of colors", { file: "p.pdb", highlights: ["A", "B", "C"], colors: ["#111111", "#222222"] }],
    ["a bad color", { file: "p.pdb", highlights: ["A"], colors: ["orange"] }],
    ["a bad --color-by", { file: "p.pdb", colorBy: "rainbow" }],
  ])("rejects %s", (_name, request) => {
    expect(() => resolveViewRequest(request)).toThrow(expect.objectContaining({ code: expect.stringMatching(/INVALID_VIEW_INPUT|INVALID_SCENE/) }));
  });

  it("rejects mixing --scene with flags, or two structures", () => {
    const scene = write("s/scene.json", JSON.stringify({ structure: "p.pdb", components: [] }));
    expect(() => resolveViewRequest({ scene, highlights: ["A"] })).toThrow(expect.objectContaining({ code: "INVALID_VIEW_INPUT" }));
    expect(() => resolveViewRequest({ scene, file: "x.pdb" })).toThrow(expect.objectContaining({ code: "INVALID_VIEW_INPUT" }));
    expect(() => resolveViewRequest({ scene: write("n.json", '{"components":[]}') })).toThrow(expect.objectContaining({ code: "INVALID_VIEW_INPUT" }));
  });
});

describe("reports with highlights stay readable by every v1 viewer", () => {
  it("keeps schemaVersion 1 / envelopeVersion 1 and round-trips through the contract validator", async () => {
    const result = await createStandaloneReport(CRN, {
      outputPath: path.join(dir, "r.html"),
      view: { colorBy: "plddt", bfactorIsPlddt: true, components: [{ selector: "A:10-20", color: "#ff5500" }, { selector: "A" }] },
    });
    const envelope = extractEnvelope(fs.readFileSync(result.path, "utf8"));
    const bundle = loadBundle();
    expect(envelope.envelopeVersion).toBe(1);
    expect(bundle.metadata.compatible).toEqual({ envelopeVersions: [1], schemaVersions: [1] });
    const report = validateReport(decodeEnvelope(envelope));
    expect(report.schemaVersion).toBe(1);
    const components = report.scenes[0].components!;
    expect(components.at(-2)).toMatchObject({ id: "highlight-1", color: "#ff5500", representation: "sticks" });
    expect(components.at(-1)!.selection).toEqual({ kind: "chains", namespace: "auth", ids: ["A"] });
    expect(components.some((c) => c.id.startsWith("plddt-"))).toBe(true);
  });

  it("a highlight that matches nothing writes no report", async () => {
    const out = path.join(dir, "none.html");
    await expect(createStandaloneReport(CRN, { outputPath: out, view: { components: [{ selector: "A:999" }] } })).rejects.toMatchObject({ code: "SELECTOR_NO_MATCH" });
    expect(fs.existsSync(out)).toBe(false);
  });
});
