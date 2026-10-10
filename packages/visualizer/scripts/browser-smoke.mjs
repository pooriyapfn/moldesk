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
  const sourceDir = path.join(workDir, "source dir with 'quote");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "report.html"), good.html);
  writeFileSync(path.join(sourceDir, "evil.html"), evil.html);
  // Move away from the "creator" location; nothing else may be needed to open it.
  const moved = path.join(workDir, "moved elsewhere 'it's");
  mkdirSync(moved, { recursive: true });
  cpSync(path.join(sourceDir, "report.html"), path.join(moved, "report.html"));
  cpSync(path.join(sourceDir, "evil.html"), path.join(moved, "evil.html"));
  rmSync(sourceDir, { recursive: true, force: true });
  return { good: path.join(moved, "report.html"), evil: path.join(moved, "evil.html"), moved };
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
    await page.waitForFunction(() => document.querySelectorAll(".msp-sequence-wrapper span.msp-sequence-present").length >= 46, null, { timeout: 30000 });
    const letters = await page.evaluate(() =>
      [...document.querySelectorAll(".msp-sequence-wrapper span.msp-sequence-present")].map((s) => s.textContent.replace(/\u200b/g, "")).join(""),
    );
    check(letters.startsWith(CRAMBIN), `${tag}: sequence letters match crambin (${letters.slice(0, 50)})`);

    const residue = page.locator(".msp-sequence-wrapper span.msp-sequence-present").nth(10);
    await residue.hover();
    const hovered = await page
      .waitForSelector(".msp-highlight-info", { timeout: 5000 })
      .then(() => true, () => false);
    check(hovered, `${tag}: hovering a sequence residue highlights it in the viewer`);
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
      () => [...document.querySelectorAll(".msp-sequence-wrapper span.msp-sequence-present")].map((s) => s.textContent.replace(/\u200b/g, "")).join("").includes("CGCGAATTCGCG"),
      null,
      { timeout: 30000 },
    );
    check(true, `${tag}: scene switch loads the DNA sequence`);

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
  const { good, evil } = buildReports(workDir);
  await exerciseGood(browser, good, { offline: false });
  await exerciseGood(browser, good, { offline: true });
  await exerciseUpdated(browser, good);
  await exerciseEvil(browser, evil);
  await exerciseNoWebgl(good);
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nAll browser checks passed");
process.exit(failures.length ? 1 : 0);
