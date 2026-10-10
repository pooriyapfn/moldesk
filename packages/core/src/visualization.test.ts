import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractEnvelope, decodeEnvelope, loadBundle, type ViewerBundle } from "@moldesk/visualizer";
import { applyReportUpdate, createStandaloneReport, prepareReportUpdate } from "./visualization.js";

const PDB = "ATOM      1  N   ALA A   1      11.104  13.207   2.100  1.00 20.00           N\nEND\n";
const CIF = "data_x\nloop_\n_atom_site.group_PDB\n_atom_site.id\nATOM 1\n";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-view-"));
  env = { ...process.env, MOLDESK_HOME: path.join(dir, "home") };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, content: string | Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

describe("createStandaloneReport", () => {
  it("creates a report under the cache by default, preserving the original bytes", async () => {
    const result = await createStandaloneReport(write("p.pdb", PDB), { env });
    expect(result.path.startsWith(path.join(dir, "home", "cache", "visualizations"))).toBe(true);
    expect(result.path.endsWith("viewer.html")).toBe(true);
    expect(result.fileUrl).toBe(new URL(`file://${encodeURI(result.path)}`).href);
    const report = decodeEnvelope(extractEnvelope(fs.readFileSync(result.path, "utf8")));
    expect(Buffer.from(report.resources[0].data, "base64").toString()).toBe(PDB);
    expect(report.scenes).toHaveLength(1);
    expect(result.format).toBe("pdb");
  });

  it("accepts .cif and .mmcif as macromolecular mmCIF", async () => {
    for (const [i, ext] of [".cif", ".mmcif", ".CIF"].entries()) {
      const r = await createStandaloneReport(write(`s${i}${ext}`, CIF), { env, outputPath: path.join(dir, `out${i}.html`) });
      expect(r.format).toBe("mmcif");
    }
  });

  it("writes to --output, creating parents, and refuses to overwrite", async () => {
    const out = path.join(dir, "nested", "report.html");
    await createStandaloneReport(write("p.pdb", PDB), { env, outputPath: out });
    expect(fs.existsSync(out)).toBe(true);
    await expect(createStandaloneReport(write("q.pdb", PDB), { env, outputPath: out })).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    await expect(createStandaloneReport(write("q.pdb", PDB), { env, outputPath: dir })).rejects.toMatchObject({ code: "INVALID_VIEW_INPUT" });
  });

  it.each([
    ["URL", () => "https://example.com/a.pdb"],
    ["missing file", () => path.join(dir, "nope.pdb")],
    ["directory", () => { fs.mkdirSync(path.join(dir, "d.pdb")); return path.join(dir, "d.pdb"); }],
    ["unsupported extension", () => write("a.txt", PDB)],
    ["empty file", () => write("e.pdb", "")],
    ["binary file", () => write("b.pdb", Buffer.from([0x41, 0, 0x54, 0x4f, 0x4d]))],
    ["PDB without atoms", () => write("n.pdb", "HEADER only\nREMARK nothing\n")],
    ["CIF without atom_site", () => write("n.cif", "data_x\n_cell.length_a 1\n")],
  ])("rejects %s before exporting", async (_name, make) => {
    const input = make();
    await expect(createStandaloneReport(input, { env })).rejects.toMatchObject({ code: "INVALID_VIEW_INPUT" });
    expect(fs.existsSync(path.join(dir, "home", "cache", "visualizations"))).toBe(false);
  });

  it("is cancelled before writing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createStandaloneReport(write("p.pdb", PDB), { env, signal: controller.signal })).rejects.toMatchObject({ code: "VIEW_CANCELLED" });
    expect(fs.existsSync(path.join(dir, "home"))).toBe(false);
  });
});

describe("report update", () => {
  const otherBundle = (): ViewerBundle => {
    const real = loadBundle();
    return { ...real, js: `${real.js}\n/* other build */`, metadata: { ...real.metadata, viewerVersion: "9.9.9", bundleSha256: "f".repeat(64) } };
  };
  const make = async () => (await createStandaloneReport(write("p.pdb", PDB), { env, outputPath: path.join(dir, "r.html") })).path;

  it("is a no-op for a freshly generated report", async () => {
    expect((await prepareReportUpdate(await make())).status).toBe("noop");
  });

  it("replaces in place with a backup when the installed bundle differs", async () => {
    const file = await make();
    const before = fs.readFileSync(file);
    const plan = await prepareReportUpdate(file, { bundle: otherBundle() });
    expect(plan.status).toBe("replace");
    const result = await applyReportUpdate(plan);
    expect(fs.readFileSync(result.backupPath!).equals(before)).toBe(true);
    expect(extractEnvelope(fs.readFileSync(file, "utf8")).viewer.version).toBe("9.9.9");
  });

  it("maps failures to typed MoldeskErrors without touching the file", async () => {
    const file = await make();
    const before = fs.readFileSync(file);
    await expect(prepareReportUpdate(file, { outputPath: file })).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    await expect(prepareReportUpdate("https://x.test/r.html")).rejects.toMatchObject({ code: "INVALID_REPORT" });
    await expect(prepareReportUpdate(write("plain.html", "<html></html>"))).rejects.toMatchObject({ code: "INVALID_REPORT" });
    const plan = await prepareReportUpdate(file, { bundle: otherBundle() });
    fs.appendFileSync(file, "<!-- changed -->");
    await expect(applyReportUpdate(plan)).rejects.toMatchObject({ code: "REPORT_CONFLICT" });
    expect(fs.readFileSync(file, "utf8").endsWith("<!-- changed -->")).toBe(true);
    void before;
  });
});
