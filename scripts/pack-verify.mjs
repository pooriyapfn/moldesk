// Step 1 packaging gate: packs every published workspace package, installs those
// tarballs into an unrelated temporary project, and runs the installed CLI binary.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-pack-verify-"));
const packDir = path.join(tmp, "packs");
const installDir = path.join(tmp, "installed-project");
const unrelatedCwd = path.join(tmp, "unrelated-working-directory");

try {
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(unrelatedCwd, { recursive: true });

  execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit" });

  const packageDirs = [
    "packages/registry",
    "packages/runtime",
    "packages/visualizer",
    "packages/adapters",
    "packages/core",
    "apps/cli",
  ];
  for (const packageDir of packageDirs) {
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: path.join(repoRoot, packageDir),
      stdio: "inherit",
    });
  }

  const tarballs = fs
    .readdirSync(packDir)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => path.join(packDir, name));
  if (tarballs.length !== packageDirs.length) {
    throw new Error(`Expected ${packageDirs.length} package tarballs; found ${tarballs.length}.`);
  }

  fs.writeFileSync(
    path.join(installDir, "package.json"),
    `${JSON.stringify({ name: "moldesk-pack-verification", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
    { cwd: installDir, stdio: "inherit" },
  );
  // The workflow store opens better-sqlite3, whose install script fetches/builds its native
  // binary. The tarball install above skips scripts, so rebuild just that dependency.
  execFileSync("npm", ["rebuild", "better-sqlite3"], { cwd: installDir, stdio: "inherit" });

  const installedRegistryModels = path.join(
    installDir,
    "node_modules",
    "@moldesk",
    "registry",
    "dist",
    "models",
  );
  const manifests = fs
    .readdirSync(installedRegistryModels, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expected = ["bindcraft2", "boltz", "diffdock", "ligandmpnn", "opendde", "proteinmpnn", "rfd4-proteina"];
  if (manifests.join(",") !== expected.join(",")) {
    throw new Error(`Expected installed registry manifests ${expected.join(",")}; found ${manifests.join(",")}.`);
  }

  const cliBin = path.join(
    installDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "moldesk.cmd" : "moldesk",
  );
  const output = execFileSync(cliBin, ["list"], { cwd: unrelatedCwd, encoding: "utf-8" });
  for (const name of expected) {
    if (!output.includes(name)) {
      throw new Error(`Installed moldesk list is missing model "${name}". Output:\n${output}`);
    }
  }

  const installedCore = path.join(installDir, "node_modules", "@moldesk", "core");
  for (const file of ["validate.py", "self-test.py", "LICENSE"]) {
    if (!fs.existsSync(path.join(installedCore, "resources", "ipsae", file))) throw new Error(`Missing packaged ipSAE resource: ${file}`);
  }
  const interfaceSchema = JSON.parse(execFileSync(cliBin, ["schema", "moldesk.interface"], { cwd: unrelatedCwd, encoding: "utf8" }));
  if (!interfaceSchema.properties.result.properties.scores) throw new Error("Missing packaged interface schema");

  // The viewer bundle must ship inside the package and nothing browser-source-only may leak.
  const installedVisualizer = path.join(installDir, "node_modules", "@moldesk", "visualizer");
  for (const asset of ["viewer.js", "viewer.css", "bundle.json", "THIRD_PARTY_NOTICES.txt", "MOLSTAR_LICENSE.txt"]) {
    if (!fs.existsSync(path.join(installedVisualizer, "dist", "assets", asset))) {
      throw new Error(`Installed @moldesk/visualizer is missing dist/assets/${asset}.`);
    }
  }
  for (const leaked of ["src", "scripts", "test", "tsconfig.browser.json"]) {
    if (fs.existsSync(path.join(installedVisualizer, leaked))) {
      throw new Error(`Installed @moldesk/visualizer unexpectedly ships ${leaked}.`);
    }
  }

  // Generate a report with the installed CLI from an unrelated cwd (no repo/node_modules assumptions).
  const env = { ...process.env, MOLDESK_HOME: path.join(tmp, "moldesk-home") };
  const structure = path.join(unrelatedCwd, "tiny protein.pdb");
  fs.writeFileSync(
    structure,
    "ATOM      1  N   ALA A   1      11.104  13.207   2.100  1.00 20.00           N\nEND\n",
  );
  const reportPath = path.join(unrelatedCwd, "report.html");
  const viewJson = JSON.parse(
    execFileSync(cliBin, ["view", structure, "--output", reportPath, "--json"], {
      cwd: unrelatedCwd,
      env,
      encoding: "utf-8",
    }),
  );
  if (viewJson.status !== "created" || viewJson.path !== reportPath || !fs.existsSync(reportPath)) {
    throw new Error(`moldesk view did not create the report: ${JSON.stringify(viewJson)}`);
  }
  const reportHtml = fs.readFileSync(reportPath, "utf-8");
  if (!reportHtml.includes('id="moldesk-report"') || /<(script|link)[^>]+(src|href)=["']https?:/i.test(reportHtml)) {
    throw new Error("Generated report is not a self-contained MoleculeDesk report.");
  }

  const run = (args) =>
    JSON.parse(execFileSync(cliBin, args, { cwd: unrelatedCwd, env, encoding: "utf-8" }));

  // Structure analysis runs Mol* in Node, so its runtime dependencies must be installed too.
  const analysis = run(["analyze", structure, "--json"]);
  if (analysis.kind !== "moldesk.analysis" || analysis.result.chains[0]?.sequence !== "A") {
    throw new Error(`Installed moldesk analyze returned an unexpected result: ${JSON.stringify(analysis)}`);
  }

  // Workflow planning opens the durable plan store, so the packaged better-sqlite3 native binary
  // must load from the isolated install. Run the CPU example from the unrelated cwd.
  const workflowFile = path.join(unrelatedCwd, "verify-workflow.yaml");
  fs.writeFileSync(
    workflowFile,
    [
      "apiVersion: moldesk.ai/v1alpha1",
      "kind: Workflow",
      "metadata:",
      "  name: pack-verify",
      "  version: 0.1.0",
      "spec:",
      "  inputs:",
      "    structure:",
      "      type: structure_file",
      "      required: true",
      "  execution:",
      "    backend: local",
      "    cache: true",
      "    max_parallel: 1",
      "  steps:",
      "    - id: import",
      "      uses: moldesk/import-structure@1",
      "      with:",
      "        file: ${inputs.structure}",
      "      outputs:",
      "        structure: protein_structure",
      "    - id: analyze",
      "      uses: moldesk/structure-analysis@1",
      "      needs: [import]",
      "      with:",
      "        structure: ${steps.import.outputs.structure}",
      "      outputs:",
      "        report: json",
      "",
    ].join("\n"),
  );
  const plan = run(["workflow", "plan", workflowFile, "--input", `structure=${structure}`, "--json"]);
  if (
    plan.status !== "ok" ||
    !plan.planId ||
    plan.steps.map((step) => step.id).join(",") !== "import,analyze" ||
    plan.edges.length !== 1
  ) {
    throw new Error(`Installed moldesk workflow plan returned an unexpected result: ${JSON.stringify(plan)}`);
  }

  // Studio must serve its page and API from the packed CLI without a repo checkout.
  const studio = spawn(cliBin, ["studio", "--workspace", unrelatedCwd, "--no-open", "--json"], {
    cwd: unrelatedCwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const studioInfo = await new Promise((resolve, reject) => {
      const lines = readline.createInterface({ input: studio.stdout });
      let buffer = "";
      lines.on("line", (line) => {
        buffer += `${buffer ? "\n" : ""}${line}`;
        try {
          const value = JSON.parse(buffer);
          lines.close();
          resolve(value);
        } catch {
          // The JSON block is pretty-printed across several lines; keep reading.
        }
      });
      studio.once("exit", (code) => reject(new Error(`Studio exited before printing its URL (${code}).`)));
    });
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(studioInfo.url ?? "")) {
      throw new Error(`Studio returned an unexpected URL: ${studioInfo.url}`);
    }
    const page = await (await fetch(studioInfo.url)).text();
    const session = /const SESSION = "([a-f0-9]+)";/.exec(page)?.[1];
    if (!page.includes("MoleDesk Studio") || !session) {
      throw new Error("Packed Studio page is missing its page or session.");
    }
    const rejected = await fetch(`${studioInfo.url}/api/workspace`);
    if (rejected.status !== 403) throw new Error("Studio API accepted a request without its session.");
    const workspace = await (
      await fetch(`${studioInfo.url}/api/workspace`, { headers: { "x-studio-session": session } })
    ).json();
    if (!workspace.files?.some((file) => file.path === "verify-workflow.yaml")) {
      throw new Error(`Packed Studio did not list the workspace workflow: ${JSON.stringify(workspace)}`);
    }
    // Studio must never create approvals: a run request without a terminal approvalId is refused.
    const noApproval = await fetch(`${studioInfo.url}/api/runs`, {
      method: "POST",
      headers: { "x-studio-session": session, origin: studioInfo.url, "content-type": "application/json" },
      body: JSON.stringify({ planId: "0".repeat(64) }),
    });
    if (noApproval.status < 400 || noApproval.status >= 500) {
      throw new Error(`Packed Studio did not reject a run without an approvalId (HTTP ${noApproval.status}).`);
    }
  } finally {
    studio.kill("SIGTERM");
    await new Promise((resolve) => {
      if (studio.exitCode !== null || studio.signalCode !== null) resolve();
      else studio.once("exit", resolve);
    });
  }

  // Update lifecycle with the installed CLI: unchanged report is up to date; a stale one is
  // replaced with a backup, and the embedded data is byte-identical afterwards.
  const payloadOf = (html) => /"payload":"([^"]+)"/.exec(html)?.[1];
  if (run(["visualizer", "update", reportPath, "--json"]).status !== "up-to-date") {
    throw new Error("A freshly generated report should already be up to date.");
  }
  fs.writeFileSync(reportPath, reportHtml.replace("<body>", "<body><!-- stale viewer -->"));
  const updated = run(["visualizer", "update", reportPath, "--yes", "--json"]);
  const updatedHtml = fs.readFileSync(reportPath, "utf-8");
  if (
    updated.status !== "updated" ||
    !updated.backupPath ||
    !fs.readFileSync(updated.backupPath, "utf-8").includes("stale viewer") ||
    updatedHtml.includes("stale viewer") ||
    payloadOf(updatedHtml) !== payloadOf(reportHtml)
  ) {
    throw new Error(`moldesk visualizer update did not behave as specified: ${JSON.stringify(updated)}`);
  }

  console.log(`Installed package manifests OK: ${manifests.join(", ")}`);
  console.log("Installed moldesk view generated a self-contained report from an unrelated cwd.");
  console.log("Installed moldesk CLI works from an unrelated cwd.");
  console.log("pack:verify passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
