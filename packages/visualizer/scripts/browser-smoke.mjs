// Real-browser acceptance check for portable, offline report rendering.
// Drives the locally installed Chrome (never downloads a browser).
// Exit codes: 0 pass, 1 fail, 2 skipped (no Chrome) — a skip is NOT verification.
import { chromium } from "playwright-core";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyUpdate, exportReport, loadBundle, planUpdate } from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "../test/fixtures");
const bytes = (name) => new Uint8Array(readFileSync(path.join(fixtures, name)));

const CRAMBIN = "TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN";
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${message}`);
  if (!ok) failures.push(message);
};

// Runs before any page script: records every attempt at network-capable APIs and never forwards it.
const INIT_SCRIPT = () => {
  const attempts = [];
  const csp = [];
  Object.defineProperty(window, "__netAttempts", { value: attempts });
  Object.defineProperty(window, "__cspViolations", { value: csp });
  const note = (api, arg) => attempts.push(`${api}: ${String(arg).slice(0, 200)}`);
  const trap = (obj, name, label = name) => {
    const original = obj?.[name];
    if (typeof original !== "function") return;
    obj[name] = function (...args) {
      note(label, args[0]);
      throw new Error(`${label} is disabled in offline reports`);
    };
  };
  trap(window, "fetch");
  trap(navigator, "sendBeacon");
  {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      note("XMLHttpRequest.open", `${method} ${url}`);
      throw new Error("XMLHttpRequest is disabled in offline reports");
    };
    void open;
  }
  trap(XMLHttpRequest.prototype, "send", "XMLHttpRequest.send");
  for (const name of ["WebSocket", "EventSource", "SharedWorker"]) {
    if (window[name]) {
      window[name] = function (url) {
        note(name, url);
        throw new Error(`${name} is disabled in offline reports`);
      };
    }
  }
  const RealWorker = window.Worker;
  if (RealWorker) {
    window.Worker = function (url, ...rest) {
      if (!String(url).startsWith("blob:")) note("Worker", url);
      return new RealWorker(url, ...rest);
    };
  }
  if (navigator.serviceWorker) trap(navigator.serviceWorker, "register", "serviceWorker.register");
  for (const [proto, prop] of [
    [HTMLImageElement.prototype, "src"],
    [HTMLScriptElement.prototype, "src"],
    [HTMLLinkElement.prototype, "href"],
    [HTMLIFrameElement.prototype, "src"],
  ]) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(proto, prop, {
      ...d,
      set(v) {
        if (!/^(data:|blob:)/.test(String(v))) note(`${proto.constructor.name}.${prop}`, v);
        d.set.call(this, v);
      },
    });
  }
  document.addEventListener("securitypolicyviolation", (e) => csp.push(`${e.violatedDirective}: ${e.blockedURI}`));
};

const RES = ".md-res:not(.md-res-missing)";
/** Letters of every modeled residue, row after row, as shown in MoleculeDesk's own sequence strip. */
const sequenceText = (page) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((s) => s.textContent).join(""), RES);
/** One entry per chain row: label, all letters, how many are marked missing, and the color of the first modeled letter. */
const sequenceRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".md-seq-row")].map((row) => {
      const res = [...row.querySelectorAll(".md-res")];
      const first = res.find((r) => !r.classList.contains("md-res-missing"));
      return {
        label: row.querySelector(".md-seq-chain").textContent,
        letters: res.map((r) => r.textContent).join(""),
        missing: res.filter((r) => r.classList.contains("md-res-missing")).map((r) => r.textContent).join(""),
        color: first ? getComputedStyle(first).color : "",
      };
    }),
  );

function buildReports(workDir) {
  const bundle = loadBundle();
  const csv = new TextEncoder().encode("model,score,note\nA,0.91,\"first, best\"\nB,0.42,second\n");
  const good = exportReport(
    {
      title: "Smoke report",
      resources: [
        { id: "crn", label: "1CRN.pdb", format: "pdb", bytes: bytes("1CRN.pdb") },
        { id: "bna", label: "1BNA.cif", format: "mmcif", bytes: bytes("1BNA.cif") },
        { id: "scores", label: "scores.csv", format: "csv", bytes: csv },
      ],
      scenes: [
        { id: "s1", title: "Crambin", structures: [{ id: "a", resourceId: "crn" }] },
        { id: "s2", title: "B-DNA", structures: [{ id: "b", resourceId: "bna" }] },
      ],
      panels: [
        { id: "p1", kind: "structure", sceneIds: ["s1", "s2"] },
        { id: "p2", kind: "table", title: "Scores", dataset: { resourceId: "scores" }, columns: [
          { field: "model", label: "Model" },
          { field: "score", label: "Score" },
          { field: "note", label: "Note" },
        ] },
      ],
      provenance: {},
    },
    bundle,
  );
  const evilTitle = '</script><script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">';
  const evil = exportReport(
    {
      title: evilTitle,
      resources: [
        {
          id: "crn",
          label: evilTitle,
          format: "pdb",
          bytes: new TextEncoder().encode(`REMARK ${evilTitle}\n` + readFileSync(path.join(fixtures, "1CRN.pdb"), "utf8")),
        },
      ],
      scenes: [{ id: "s1", title: evilTitle, structures: [{ id: "a", resourceId: "crn" }] }],
      panels: [],
      provenance: {},
    },
    bundle,
  );
  // Same shape the DiffDock adapter produces: shared receptor + one SDF pose per scene.
  const dockingComponents = [
    { id: "receptor", structureId: "receptor", selection: { kind: "all" }, role: "receptor", label: "Receptor", representation: "cartoon" },
    { id: "pose", structureId: "pose", selection: { kind: "all" }, role: "ligand", label: "Ligand pose", representation: "sticks" },
  ];
  const docking = exportReport(
    {
      title: "Docking smoke",
      resources: [
        { id: "rec", label: "1CRN.pdb", format: "pdb", bytes: bytes("1CRN.pdb") },
        { id: "p1", label: "rank1.sdf", format: "sdf", bytes: bytes("pose1.sdf") },
        { id: "p2", label: "rank2.sdf", format: "sdf", bytes: bytes("pose2.sdf") },
        { id: "sum", label: "poses_summary.json", format: "json", bytes: bytes("poses_summary.json") },
      ],
      scenes: [
        { id: "scene-1", title: "Pose 1 (confidence 0.85)", rank: 1, structures: [{ id: "receptor", resourceId: "rec" }, { id: "pose", resourceId: "p1" }], components: dockingComponents },
        { id: "scene-2", title: "Pose 2 (confidence -1.23)", rank: 2, structures: [{ id: "receptor", resourceId: "rec" }, { id: "pose", resourceId: "p2" }], components: dockingComponents },
      ],
      panels: [
        { id: "structures", kind: "structure", sceneIds: ["scene-1", "scene-2"] },
        { id: "poses", kind: "table", title: "Poses", dataset: { resourceId: "sum", rowsKey: "poses" }, columns: [{ field: "rank", label: "Rank" }, { field: "confidence", label: "Confidence" }] },
      ],
      provenance: {},
    },
    bundle,
  );
  const sourceDir = path.join(workDir, "source dir with 'quote");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "report.html"), good.html);
  writeFileSync(path.join(sourceDir, "evil.html"), evil.html);
  writeFileSync(path.join(sourceDir, "docking.html"), docking.html);
  // Move away from the "creator" location; nothing else may be needed to open it.
  const moved = path.join(workDir, "moved elsewhere 'it's");
  mkdirSync(moved, { recursive: true });
  cpSync(path.join(sourceDir, "report.html"), path.join(moved, "report.html"));
  cpSync(path.join(sourceDir, "evil.html"), path.join(moved, "evil.html"));
  cpSync(path.join(sourceDir, "docking.html"), path.join(moved, "docking.html"));
  rmSync(sourceDir, { recursive: true, force: true });
  return { good: path.join(moved, "report.html"), evil: path.join(moved, "evil.html"), docking: path.join(moved, "docking.html"), moved };
}

async function openWithProbes(browser, url, { offline }) {
  const context = await browser.newContext({ offline, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await context.addInitScript(INIT_SCRIPT);
  const requests = [];
  context.on("request", (r) => requests.push(r.url()));
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));
  const cdp = await context.newCDPSession(page);
  const cdpEvents = [];
  // Network only. Enabling the Log domain as well makes Chrome drop the PNG download that
  // follows a sequence click (observed on Chrome 154); CSP problems are still caught by the
  // securitypolicyviolation listener, console messages, and Network.loadingFailed below.
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => cdpEvents.push(`request ${e.request.url}`));
  cdp.on("Network.webSocketCreated", (e) => cdpEvents.push(`websocket ${e.url}`));
  cdp.on("Network.eventSourceMessageReceived", () => cdpEvents.push("eventsource"));
  cdp.on("Network.loadingFailed", (e) => e.blockedReason && cdpEvents.push(`blocked(${e.blockedReason})`));
  await page.goto(url);
  return { context, page, requests, cdpEvents, consoleLines };
}

async function assertNoNetwork(label, probe, reportUrl) {
  const { page, requests, cdpEvents, consoleLines } = probe;
  const attempts = await page.evaluate(() => [...window.__netAttempts]);
  const csp = await page.evaluate(() => [...window.__cspViolations]);
  const external = (list) => list.filter((u) => u !== reportUrl && !u.startsWith("data:") && !u.startsWith("blob:"));
  const cdpExternal = cdpEvents.filter((e) => !(e.startsWith("request ") && !external([e.slice(8)]).length));
  check(attempts.length === 0, `${label}: no network API attempts ${JSON.stringify(attempts)}`);
  check(csp.length === 0, `${label}: no CSP violations ${JSON.stringify(csp)}`);
  check(external(requests).length === 0, `${label}: only the report itself was requested ${JSON.stringify(external(requests))}`);
  check(cdpExternal.length === 0, `${label}: no CDP network/websocket/blocked events ${JSON.stringify(cdpExternal)}`);
  const cspConsole = consoleLines.filter((l) => /Content Security Policy|Refused to/i.test(l));
  check(cspConsole.length === 0, `${label}: no CSP console errors ${JSON.stringify(cspConsole)}`);
}

async function exerciseGood(browser, file, { offline, label }) {
  const tag = label ?? (offline ? "offline" : "online");
  const url = pathToFileURL(file).href;
  const probe = await openWithProbes(browser, url, { offline });
  const { page } = probe;
  try {
    await page.waitForSelector("canvas", { timeout: 30000 });
    check(true, `${tag}: canvas rendered from file: after move`);
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length >= 46, RES, { timeout: 30000 });
    const letters = await sequenceText(page);
    check(letters.startsWith(CRAMBIN), `${tag}: sequence letters match crambin (${letters.slice(0, 50)})`);
    const rows = await sequenceRows(page);
    check(rows.length === 1 && rows[0].color !== "" && rows[0].color !== "rgb(232, 234, 237)", `${tag}: sequence letters carry the structure color (${rows[0]?.color})`);
    check(
      (await page.locator(".md-seq-group").first().locator(".md-res").count()) === 10 && (await page.locator(".md-seq-group").first().getAttribute("data-count")) === "10",
      `${tag}: sequence is grouped in blocks of ten with a position number`,
    );
    const box = await page.getByTestId("viewport").boundingBox();
    check(box && box.x === 0 && box.y === 0 && box.width === 1280 && box.height === 900, `${tag}: the 3D view fills the whole window (${JSON.stringify(box)})`);
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(dark === "rgb(0, 0, 0)", `${tag}: black background (${dark})`);
    const glass = await page.evaluate(() => {
      const t = getComputedStyle(document.querySelector(".md-toolbox"));
      return { blur: t.backdropFilter || t.webkitBackdropFilter, radius: t.borderRadius, bg: t.backgroundColor };
    });
    check(/blur/.test(glass.blur) && parseFloat(glass.radius) >= 12 && /rgba\(.*0\.\d+\)/.test(glass.bg), `${tag}: toolbox is a rounded, blurred, translucent overlay (${JSON.stringify(glass)})`);
    const links = await page.locator(".md-footer a").evaluateAll((as) => as.map((a) => [a.textContent, a.href]));
    check(
      JSON.stringify(links) === JSON.stringify([["Website", "https://moleculedesk.com/"], ["Docs", "https://www.moleculedesk.com/docs"], ["GitHub", "https://github.com/pooriyapfn/moldesk"]]),
      `${tag}: footer links to the MoleculeDesk website, docs and GitHub (${JSON.stringify(links)})`,
    );
    check((await page.locator(".md-footer").textContent()).startsWith("MoleculeDesk"), `${tag}: footer is MoleculeDesk-branded`);
    await page.getByRole("button", { name: "About" }).click();
    const about = await page.locator(".md-about").textContent();
    check(/Mol\* \d+\.\d+\.\d+ \(MIT License/.test(about), `${tag}: About shows the Mol* credit and license (${about.slice(0, 80)})`);
    await page.getByRole("button", { name: "About" }).click();

    const residue = page.locator(RES).nth(10);
    const canvas = page.locator('[data-testid="viewport"] canvas').first();
    await page.mouse.move(640, 700);
    await page.waitForTimeout(500);
    const before = await canvas.screenshot();
    await residue.hover();
    await page.waitForFunction(() => document.querySelector('[data-testid="residue-info"]')?.textContent.trim().length > 0, null, { timeout: 5000 });
    check((await page.getByTestId("residue-info").textContent()).startsWith("SER 11"), `${tag}: hovering a sequence residue names it (${await page.getByTestId("residue-info").textContent()})`);
    await page.waitForTimeout(500);
    const after = await canvas.screenshot();
    check(!before.equals(after), `${tag}: hovering a sequence residue highlights it in the 3D view`);
    await residue.click();
    // Clicking focuses the residue with a camera animation; let it settle before exporting.
    await page.waitForTimeout(2000);

    const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
    downloadPromise.catch(() => {});
    await page.getByRole("button", { name: "Save image" }).click({ timeout: 10000 });
    const download = await downloadPromise;
    const png = path.join(os.tmpdir(), `moldesk-smoke-${process.pid}-${tag}.png`);
    await download.saveAs(png);
    const header = readFileSync(png).subarray(0, 8).toString("hex");
    check(header === "89504e470d0a1a0a" && statSync(png).size > 8000, `${tag}: PNG export is a non-trivial image (${statSync(png).size} bytes)`);
    rmSync(png, { force: true });

    await page.getByLabel("Scene").selectOption("s2");
    await page.waitForFunction(
      (sel) => [...document.querySelectorAll(sel)].map((s) => s.textContent).join("").includes("CGCGAATTCGCG"),
      RES,
      { timeout: 30000 },
    );
    check(true, `${tag}: scene switch loads the DNA sequence`);

    await page.getByRole("button", { name: "Results" }).click();
    const cells = await page.locator("table tbody tr").count();
    check(cells === 2, `${tag}: table panel renders 2 rows`);
    check((await page.locator("table tbody tr").first().textContent()).includes("first, best"), `${tag}: quoted CSV cell parsed`);

    await page.getByRole("button", { name: "Update viewer" }).click();
    await page.getByRole("dialog").waitFor();
    const command = await page.getByTestId("update-command").textContent();
    const expectedPath = file.replace(/'/g, `'\\''`);
    check(command === `moldesk visualizer update '${expectedPath}'`, `${tag}: update modal shows a safely quoted command for the moved path (${command})`);
    check((await page.getByRole("dialog").textContent()).includes("Use your installed MoleculeDesk to update this report."), `${tag}: update modal text`);
    await page.getByRole("button", { name: "Copy command" }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent, null, { timeout: 10000 });
    check((await page.getByRole("status").textContent()).length > 0, `${tag}: copy gives feedback (clipboard or manual fallback)`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await assertNoNetwork(tag, probe, url);
  } catch (error) {
    check(false, `${tag}: ${error.message}`);
    console.log("  attempts:", JSON.stringify(await page.evaluate(() => [...window.__netAttempts]).catch(() => "n/a")), "csp:", JSON.stringify(await page.evaluate(() => [...window.__cspViolations]).catch(() => "n/a")), "cdp:", JSON.stringify(probe.cdpEvents.slice(-5).map((e) => e.slice(0, 120))));
    console.log("  page alerts:", JSON.stringify(await page.getByRole("alert").allTextContents().catch(() => [])));
    console.log(probe.consoleLines.filter((l) => !/GL Driver/.test(l)).slice(-15).join("\n"));
  } finally {
    await probe.context.close();
  }
}

async function exerciseDocking(browser, file) {
  const url = pathToFileURL(file).href;
  const probe = await openWithProbes(browser, url, { offline: true });
  const { page } = probe;
  const loaded = (scene) =>
    page.waitForFunction(
      (id) => {
        const v = document.querySelector('[data-testid="viewport"]');
        return v?.getAttribute("data-loaded-scene") === id && v.getAttribute("data-structure-count") === "2";
      },
      scene,
      { timeout: 30000 },
    );
  try {
    await loaded("scene-1");
    check(true, "docking: receptor + pose loaded together as two structures");
    const sequence = () => sequenceText(page);
    check((await sequence()).startsWith(CRAMBIN), "docking: receptor sequence is shown");
    check((await page.getByRole("alert").count()) === 0, "docking: no viewer errors for the SDF pose");
    await page.getByLabel("Scene").selectOption("scene-2");
    await loaded("scene-2");
    check((await sequence()).startsWith(CRAMBIN), "docking: switching to pose 2 keeps the receptor");
    check((await page.getByRole("alert").count()) === 0, "docking: no viewer errors after scene switch");
    await page.getByRole("button", { name: "Results" }).click();
    check((await page.locator("table tbody tr").count()) === 2, "docking: poses table reads the rows array from the JSON summary");
    const shot = await page.locator('[data-testid="viewport"] canvas').first().screenshot();
    check(shot.length > 8000, `docking: viewport is not blank (${shot.length} bytes)`);
    await assertNoNetwork("docking", probe, url);
  } catch (error) {
    check(false, `docking: ${error.message}`);
    console.log("  page alerts:", JSON.stringify(await page.getByRole("alert").allTextContents().catch(() => [])));
  } finally {
    await probe.context.close();
  }
}

/** Scientific edge cases from real structures: each opens offline, loads one scene, stays network-silent. */
function edgeReport(workDir, name, format) {
  const out = exportReport(
    {
      title: name,
      resources: [{ id: "s", label: name, format, bytes: bytes(name) }],
      scenes: [{ id: "scene-1", title: name, structures: [{ id: "a", resourceId: "s" }] }],
      panels: [],
      provenance: {},
    },
    loadBundle(),
  );
  const file = path.join(workDir, `edge-${name}.html`);
  writeFileSync(file, out.html);
  return file;
}

/** 1-based position of the first CA whose residue carries an insertion code, and its label (e.g. "52A"). */
function firstInsertionResidue(pdbName) {
  let ordinal = 0;
  const seen = new Set();
  for (const line of readFileSync(path.join(fixtures, pdbName), "utf8").split("\n")) {
    if (!line.startsWith("ATOM  ")) continue;
    const key = line.slice(21, 27);
    if (seen.has(key)) continue;
    seen.add(key);
    ordinal++;
    if (line[26] !== " ") return { ordinal, label: line.slice(22, 27).trim() };
  }
  return undefined;
}

const EDGE_CASES = [
  {
    name: "1AAY.pdb",
    describe: "protein-DNA complex with missing residues",
    async verify(page) {
      const rows = await sequenceRows(page);
      const dna = rows.filter((r) => /^[ACGT]{8,}$/.test(r.letters));
      check(dna.length === 2, `protein–DNA: both DNA strands get a sequence row (${rows.map((r) => r.label + ":" + r.letters.length).join(" ")})`);
      const protein = rows.find((r) => r.letters.startsWith("MERPYACPVESCDRRFSRSDELTRHIRIHTGQKPFQCRICMRNFSRSDHLTTHIRTHTGEKPF"));
      check(!!protein, "protein–DNA: the complete zinc-finger protein sequence is shown, in SEQRES order");
      check(protein && protein.missing.length === 5, `missing residues: not-modeled positions stay in sequence position, dimmed (${protein?.missing})`);
      const first = await page.locator(".md-seq-row").nth(rows.indexOf(protein)).locator(".md-res").evaluateAll((rs) => rs.slice(0, 3).map((r) => r.classList.contains("md-res-missing")));
      check(JSON.stringify(first) === "[true,true,false]", `missing residues: the first two are the unmodeled ones (${first})`);
      check(new Set(rows.map((r) => r.color)).size >= 2, `protein–DNA: protein and DNA letters have different structure colors (${[...new Set(rows.map((r) => r.color))].join(" ")})`);
    },
  },
  {
    name: "1D3Z-3models.pdb",
    describe: "multi-model NMR file",
    async verify(page) {
      const note = await page.getByText(/This file has 3 models; showing model 1\./).count();
      check(note === 1, "NMR: multiple models are labeled, not silently treated as separate predictions");
    },
  },
  {
    name: "1IGT-VH.pdb",
    describe: "antibody domain with insertion codes",
    async verify(page) {
      const target = firstInsertionResidue("1IGT-VH.pdb");
      await page.locator(`.md-res[data-i="${target.ordinal - 1}"]`).first().hover();
      const info = await page.getByTestId("residue-info").textContent();
      const number = target.label.replace(/[A-Za-z]+$/, "");
      const code = target.label.slice(number.length);
      check(new RegExp(`\\[auth ${number}\\]${code}`).test(info), `insertion codes: hovering sequence index ${target.ordinal - 1} identifies residue ${target.label} (${info.trim().slice(0, 80)})`);
    },
  },
  {
    name: "3HZ7.pdb",
    describe: "selenomethionine (modified residues)",
    async verify(page) {
      // 3HZ7 chain A: selenomethionine (MSE) at 1, 48, 52 and a modified cysteine (CSS) at 11.
      // Preserved and identified as themselves, not dropped or shown as unknown.
      const at = (n) => page.locator(`.md-res[data-seqid="${n}"]`).first().getAttribute("data-comp");
      const shown = { 1: await at(1), 11: await at(11), 48: await at(48), 52: await at(52) };
      check(
        shown[1] === "MSE" && shown[48] === "MSE" && shown[52] === "MSE" && shown[11] === "CSS",
        `modified residues: MSE and CSS are preserved and identified (1:${shown[1]} 11:${shown[11]} 48:${shown[48]} 52:${shown[52]})`,
      );
      check((await page.locator(".md-res-mod").count()) >= 4, "modified residues: marked as modified in the sequence strip");
    },
  },
  {
    name: "HEM-only.pdb",
    describe: "ligand-only structure",
    async verify(page) {
      check((await page.getByText("No polymer sequence in this structure.").count()) === 1, "ligand-only: clear 'No polymer sequence' state");
      check((await page.locator(".md-seq").count()) === 0, "ligand-only: no empty sequence strip");
    },
  },
];

async function exerciseEdgeCases(browser, workDir) {
  for (const edge of EDGE_CASES) {
    const file = edgeReport(workDir, edge.name, "pdb");
    const url = pathToFileURL(file).href;
    const probe = await openWithProbes(browser, url, { offline: true });
    const { page } = probe;
    const label = edge.describe;
    try {
      await page.waitForFunction(() => document.querySelector('[data-testid="viewport"]')?.getAttribute("data-loaded-scene") === "scene-1", null, { timeout: 45000 });
      await page.waitForTimeout(800);
      check((await page.getByRole("alert").count()) === 0, `${label}: opens without viewer errors`);
      await edge.verify(page);
      await assertNoNetwork(label, probe, url);
    } catch (error) {
      check(false, `${label}: ${error.message}`);
      console.log("  page alerts:", JSON.stringify(await page.getByRole("alert").allTextContents().catch(() => [])));
    } finally {
      await probe.context.close();
    }
  }
}

async function exerciseEvil(browser, file) {
  const url = pathToFileURL(file).href;
  const probe = await openWithProbes(browser, url, { offline: false });
  try {
    await page_waitReady(probe.page);
    const pwned = await probe.page.evaluate(() => window.__pwned);
    check(pwned === undefined, "hostile report: injected script did not run");
    const title = await probe.page.title();
    check(title.includes("</script>"), "hostile report: title shown as text");
    await assertNoNetwork("hostile report", probe, url);
  } catch (error) {
    check(false, `hostile report: ${error.message}`);
  } finally {
    await probe.context.close();
  }
}
const page_waitReady = (page) => page.waitForSelector("canvas", { timeout: 30000 });

async function exerciseNoWebgl(file) {
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu", "--disable-3d-apis", "--disable-webgl", "--disable-webgl2"] });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href);
    await page.getByRole("alert").waitFor({ timeout: 15000 });
    check((await page.getByRole("alert").first().textContent()).includes("WebGL"), "no-WebGL: readable message; rest of report stays usable");
    await page.getByRole("button", { name: "Update viewer" }).click();
    check(await page.getByRole("dialog").isVisible(), "no-WebGL: update modal still works");
  } catch (error) {
    check(false, `no-WebGL: ${error.message}`);
  } finally {
    await browser?.close();
  }
}

/** update -> reopen: a report replaced by the local updater must render offline under the same CSP. */
async function exerciseUpdated(browser, file) {
  const stale = path.join(path.dirname(file), "stale.html");
  writeFileSync(stale, readFileSync(file, "utf8").replace("<body>", "<body><!-- older viewer -->"));
  const plan = await planUpdate(stale);
  check(plan.status === "replace", "update: a stale report is planned for replacement");
  await applyUpdate(plan);
  await exerciseGood(browser, stale, { offline: true, label: "updated" });
}

const workDir = mkdtempSync(path.join(os.tmpdir(), "moldesk-smoke-"));
let browser;
try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"],
  });
} catch (error) {
  console.log(`SKIPPED: could not launch an installed Chrome (${error.message.split("\n")[0]}). A skip is not verification.`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(2);
}
try {
  console.log(`Browser: Chrome ${browser.version()} on ${process.platform}/${process.arch}`);
  const { good, evil, docking } = buildReports(workDir);
  await exerciseGood(browser, good, { offline: false });
  await exerciseGood(browser, good, { offline: true });
  await exerciseDocking(browser, docking);
  await exerciseEdgeCases(browser, workDir);
  await exerciseUpdated(browser, good);
  await exerciseEvil(browser, evil);
  await exerciseNoWebgl(good);
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nAll browser checks passed");
process.exit(failures.length ? 1 : 0);
