// Measures exporter time, artifact size, time to first structure, scene-switch time and
// JS heap in real Chrome. Numbers are only meaningful with the hardware/browser printed
// at the top; software WebGL (SwiftShader) makes rendering timings pessimistic.
import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportReport, loadBundle } from "../dist/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures");
const bytes = (n) => new Uint8Array(readFileSync(path.join(fixtures, n)));
const bundle = loadBundle();
const ms = (t) => `${t.toFixed(0)} ms`;
const mib = (n) => `${(n / 1024 / 1024).toFixed(2)} MiB`;

const docking = (poses) => {
  const comps = [
    { id: "receptor", structureId: "receptor", selection: { kind: "all" }, role: "receptor", representation: "cartoon" },
    { id: "pose", structureId: "pose", selection: { kind: "all" }, role: "ligand", representation: "sticks" },
  ];
  const resources = [{ id: "rec", label: "1CRN.pdb", format: "pdb", bytes: bytes("1CRN.pdb") }];
  const scenes = [];
  for (let i = 1; i <= poses; i++) {
    resources.push({ id: `p${i}`, label: `rank${i}.sdf`, format: "sdf", bytes: bytes(i % 2 ? "pose1.sdf" : "pose2.sdf") });
    scenes.push({ id: `scene-${i}`, title: `Pose ${i}`, rank: i, structures: [{ id: "receptor", resourceId: "rec" }, { id: "pose", resourceId: `p${i}` }], components: comps });
  }
  return { title: `Docking, ${poses} poses`, resources, scenes, panels: [{ id: "s", kind: "structure", sceneIds: scenes.map((s) => s.id) }], provenance: {} };
};
const campaign = (n, file, format) => {
  const resources = [];
  const scenes = [];
  for (let i = 1; i <= n; i++) {
    resources.push({ id: `d${i}`, label: `design_${i}`, format, bytes: bytes(file) });
    scenes.push({ id: `scene-${i}`, title: `Design ${i}`, structures: [{ id: "a", resourceId: `d${i}` }] });
  }
  return { title: `Campaign, ${n} designs`, resources, scenes, panels: [{ id: "s", kind: "structure", sceneIds: scenes.map((s) => s.id) }], provenance: {} };
};
const single = (title, file, format) => campaign(1, file, format) && { ...campaign(1, file, format), title };

const CASES = [
  ["Small protein (crambin, 46 res, PDB)", single("crambin", "1CRN.pdb", "pdb")],
  ["Protein–DNA complex (1AAY, PDB)", single("1AAY", "1AAY.pdb", "pdb")],
  ["Receptor + 20 SDF poses", docking(20)],
  ["Campaign: 30 × protein–DNA complex", campaign(30, "1AAY.pdb", "pdb")],
];

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-precise-memory-info"],
});
console.log(`Hardware: ${os.cpus()[0].model} × ${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB RAM, ${process.platform}/${process.arch}`);
console.log(`Node ${process.version}, Chrome ${browser.version()} (headless, software WebGL)`);
console.log(`Viewer ${bundle.metadata.viewerVersion}, Mol* ${bundle.metadata.molstarVersion}\n`);
console.log("| Case | Export (median of 5) | Report size | First structure | Scene switch | JS heap after load | JS heap after 3 switches |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");

const dir = mkdtempSync(path.join(os.tmpdir(), "moldesk-measure-"));
try {
  for (const [name, input] of CASES) {
    const times = [];
    let exported;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      exported = exportReport(input, bundle);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const file = path.join(dir, "r.html");
    writeFileSync(file, exported.html);

    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const cdp = await page.context().newCDPSession(page);
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const { metrics } = await cdp.send("Performance.getMetrics");
      return metrics.find((m) => m.name === "JSHeapUsedSize").value;
    };
    await cdp.send("Performance.enable");
    const loaded = (id) =>
      page.waitForFunction((s) => document.querySelector('[data-testid="viewport"]')?.getAttribute("data-loaded-scene") === s, id, { timeout: 120000 });
    const t0 = performance.now();
    await page.goto(pathToFileURL(file).href);
    await loaded("scene-1");
    const first = performance.now() - t0;
    await page.waitForTimeout(500);
    const heapLoaded = await heap();

    let switchMs = "n/a";
    let heapSwitched = "n/a";
    if (input.scenes.length > 1) {
      const lastSwitch = [];
      for (const id of ["scene-2", "scene-3", "scene-1"].slice(0, Math.min(3, input.scenes.length))) {
        const t = performance.now();
        await page.getByLabel("Scene").selectOption(id);
        await loaded(id);
        lastSwitch.push(performance.now() - t);
      }
      lastSwitch.sort((a, b) => a - b);
      switchMs = ms(lastSwitch[Math.floor(lastSwitch.length / 2)]);
      await page.waitForTimeout(500);
      heapSwitched = mib(await heap());
    }
    console.log(`| ${name} | ${ms(times[2])} | ${mib(statSync(file).size)} | ${ms(first)} | ${switchMs} | ${mib(heapLoaded)} | ${heapSwitched} |`);
    await page.context().close();
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
