// US-align as a managed tool. Same safety model as model installs: a pinned, SHA-256-verified source
// download, a staged build, verification, and an atomic promote with rollback. The compiler is the
// user's own; there is no prebuilt binary and no fallback when the tool is missing.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AssetSpec } from "@moldesk/registry";
import {
  cacheAsset,
  getMoldeskPaths,
  materializeAsset,
  runCommand,
  temporaryInstallDir,
  type InstallCommandRunner,
  type InstallProgress,
  type AssetFetch,
  type MoldeskPaths,
} from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import { withModelLock } from "../installation.js";

export const USALIGN_VERSION = "20260527";
/** Release tag 20260527 of https://github.com/pylelab/USalign. */
const USALIGN_COMMIT = "177cc8a2bbd3e2a6e9c5faaaa4ff5dfa1e6048f7";

export const USALIGN_CITATION = [
  "Zhang C, Freddolino L, Zhang Y (2026) Nat Protoc 21, 517-541.",
  "Zhang C, Shine M, Pyle AM, Zhang Y (2022) Nat Methods 19(9), 1109-1115.",
  "Zhang C, Pyle AM (2022) iScience 25(10), 105218.",
];

/** The pinned source. GitHub archives are content-addressed here by SHA-256: if GitHub ever serves different bytes, install fails closed. */
export const USALIGN_SOURCE: AssetSpec = {
  id: "usalign-source",
  url: `https://codeload.github.com/pylelab/USalign/tar.gz/${USALIGN_COMMIT}`,
  source: "https://github.com/pylelab/USalign",
  license: "Permissive (HPND-style): use, copy, modify and distribute with the notices and references kept",
  sha256: "c0ed4ad81b4ebf7241b6103d2df83079f489653fa5644342f1b12d1b465a109a",
  sizeBytes: 263_246,
  archive: "tar.gz",
  target: "source",
};

/** Upstream's own build line (`make`): `g++ -O3 -ffast-math`. `-static` is left out, as upstream advises for macOS. */
const BUILD_ARGS = ["-O3", "-ffast-math"];
const COMPILERS = ["c++", "g++", "clang++"];
const BUILD_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

/** The shipped PDB1.pdb / PDB2.pdb pair, aligned on this machine, must give the values US-align reports. */
const SELF_TEST = { tm1: 0.4265, tm2: 0.6163, length1: 250, length2: 166, aligned: 119, tolerance: 0.005 };

export interface Compiler {
  command: string;
  version: string;
}

export interface UsalignReceipt {
  schemaVersion: 1;
  tool: "usalign";
  version: string;
  commit: string;
  source: { url: string; sha256: string };
  compiler: Compiler;
  binary: { path: string; sha256: string };
  platform: string;
  arch: string;
  installedAt: string;
  license: string;
  citation: string[];
}

export interface UsalignInstallation {
  executable: string;
  version: string;
  receipt: UsalignReceipt;
}

export interface UsalignStatus {
  installed: boolean;
  installation?: UsalignInstallation;
  /** Why an installed copy cannot be used. */
  problem?: string;
  compiler: Compiler | null;
}

function fail(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

export function usalignDir(paths: MoldeskPaths = getMoldeskPaths()): string {
  return path.join(paths.tools, "usalign", USALIGN_VERSION);
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** First C++ compiler on PATH that answers `--version`. */
export async function detectCompiler(runner: InstallCommandRunner = runCommand): Promise<Compiler | null> {
  for (const command of COMPILERS) {
    const result = await runner(command, ["--version"], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined);
    if (result && result.code === 0) return { command, version: (result.stdout || result.stderr).split("\n")[0].trim() };
  }
  return null;
}

/** The compiler, or COMPILER_NOT_FOUND with a remediation for this platform. */
export async function requireCompiler(runner: InstallCommandRunner = runCommand): Promise<Compiler> {
  const compiler = await detectCompiler(runner);
  if (compiler) return compiler;
  throw fail(
    "COMPILER_NOT_FOUND",
    "No C++ compiler found (tried c++, g++, clang++), which is needed to build US-align.",
    process.platform === "darwin" ? "Install the Xcode command line tools: `xcode-select --install`." : "Install a C++ compiler, for example `sudo apt install g++`.",
  );
}

/** Reads and checks the receipt; the binary must still match the hash recorded at install time. */
function readInstallation(paths: MoldeskPaths): { installation?: UsalignInstallation; problem?: string } {
  const dir = usalignDir(paths);
  const receiptPath = path.join(dir, "installation.json");
  if (!fs.existsSync(receiptPath)) return {};
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as UsalignReceipt;
    const executable = path.join(dir, "bin", "USalign");
    if (receipt.tool !== "usalign" || receipt.version !== USALIGN_VERSION || receipt.binary?.path !== "bin/USalign") {
      return { problem: "the installation record does not match this MoleculeDesk release" };
    }
    if (!fs.existsSync(executable)) return { problem: "the USalign binary is missing" };
    if (sha256File(executable) !== receipt.binary.sha256) return { problem: "the USalign binary changed after installation" };
    return { installation: { executable, version: receipt.version, receipt } };
  } catch {
    return { problem: "the installation record is unreadable" };
  }
}

export async function getUsalignStatus(options: { paths?: MoldeskPaths; runner?: InstallCommandRunner } = {}): Promise<UsalignStatus> {
  const found = readInstallation(options.paths ?? getMoldeskPaths());
  return { installed: found.installation !== undefined, ...found, compiler: await detectCompiler(options.runner) };
}

/** The installed, verified binary, or an error that says what to run. No fallback to another aligner. */
export function requireUsalign(paths: MoldeskPaths = getMoldeskPaths()): UsalignInstallation {
  const { installation, problem } = readInstallation(paths);
  if (installation) return installation;
  throw fail(
    problem ? "USALIGN_DAMAGED" : "USALIGN_NOT_INSTALLED",
    problem ? `US-align is installed but unusable: ${problem}.` : "US-align is not installed.",
    problem ? "Run `moldesk install usalign --reinstall --yes`." : "Run `moldesk install usalign` (it downloads the pinned source and builds it with your C++ compiler).",
  );
}

export interface UsalignInstallPlan {
  alreadyInstalled: boolean;
  version: string;
  downloadBytes: number;
  source: { url: string; sha256: string };
  compiler: Compiler | null;
}

export async function planUsalignInstall(options: { paths?: MoldeskPaths; runner?: InstallCommandRunner } = {}): Promise<UsalignInstallPlan> {
  const paths = options.paths ?? getMoldeskPaths();
  return {
    alreadyInstalled: readInstallation(paths).installation !== undefined,
    version: USALIGN_VERSION,
    downloadBytes: USALIGN_SOURCE.sizeBytes ?? 0,
    source: { url: USALIGN_SOURCE.url, sha256: USALIGN_SOURCE.sha256 },
    compiler: await detectCompiler(options.runner),
  };
}

export interface UsalignInstallOptions {
  paths?: MoldeskPaths;
  runner?: InstallCommandRunner;
  fetch?: AssetFetch;
  reinstall?: boolean;
  onProgress?: (progress: InstallProgress) => void;
}

export async function installUsalign(options: UsalignInstallOptions = {}): Promise<{ status: "installed" | "already-installed" | "reinstalled"; installation: UsalignInstallation }> {
  const paths = options.paths ?? getMoldeskPaths();
  const runner = options.runner ?? runCommand;
  const targetDir = usalignDir(paths);
  return withModelLock(paths, `usalign-${USALIGN_VERSION}`, async () => {
    const existing = readInstallation(paths).installation;
    if (existing && !options.reinstall) return { status: "already-installed", installation: existing };

    const compiler = await requireCompiler(runner);

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    const staging = temporaryInstallDir(targetDir);
    const backup = `${targetDir}.backup-${randomUUID()}`;
    let promoted = false;
    let backedUp = false;
    try {
      fs.mkdirSync(path.join(staging, "bin"), { recursive: true });
      const object = await cacheAsset(USALIGN_SOURCE, paths, { fetch: options.fetch, onProgress: options.onProgress });
      await materializeAsset(USALIGN_SOURCE, object, staging);
      const sourceRoot = path.join(staging, USALIGN_SOURCE.target);
      const entries = fs.readdirSync(sourceRoot);
      const srcDir = path.join(sourceRoot, `USalign-${USALIGN_COMMIT}`);
      if (entries.length !== 1 || !fs.statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) {
        throw fail("USALIGN_SOURCE_UNEXPECTED", "The US-align source archive does not have the expected layout.", "Report this; do not retry.");
      }

      options.onProgress?.({ step: "build", message: `Building US-align with ${compiler.command}` });
      const binary = path.join(staging, "bin", "USalign");
      const build = await runner(compiler.command, [...BUILD_ARGS, "-o", binary, path.join(srcDir, "USalign.cpp"), "-lm"], { cwd: srcDir, timeoutMs: BUILD_TIMEOUT_MS });
      if (build.code !== 0 || build.timedOut || !fs.existsSync(binary)) {
        const tail = (build.stderr || build.stdout).trim().split("\n").slice(-12).join("\n");
        throw fail(
          "USALIGN_BUILD_FAILED",
          `Building US-align with ${compiler.command} failed${build.timedOut ? " (timed out)" : ` (exit ${build.code})`}.${tail ? `\n${tail}` : ""}`,
          "Check that the compiler supports C++11 (g++ 4.8.5+ or clang++ 12+).",
        );
      }

      options.onProgress?.({ step: "verify", message: "Verifying US-align" });
      await verifyBinary(binary, srcDir, runner);

      fs.copyFileSync(path.join(srcDir, "LICENSE"), path.join(staging, "LICENSE"));
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      const receipt: UsalignReceipt = {
        schemaVersion: 1,
        tool: "usalign",
        version: USALIGN_VERSION,
        commit: USALIGN_COMMIT,
        source: { url: USALIGN_SOURCE.url, sha256: USALIGN_SOURCE.sha256 },
        compiler,
        binary: { path: "bin/USalign", sha256: sha256File(binary) },
        platform: process.platform,
        arch: process.arch,
        installedAt: new Date().toISOString(),
        license: USALIGN_SOURCE.license ?? "",
        citation: USALIGN_CITATION,
      };
      fs.writeFileSync(path.join(staging, "installation.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

      if (fs.existsSync(targetDir)) {
        fs.renameSync(targetDir, backup);
        backedUp = true;
      }
      fs.renameSync(staging, targetDir);
      promoted = true;
      if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
      return {
        status: existing ? "reinstalled" : "installed",
        installation: { executable: path.join(targetDir, "bin", "USalign"), version: USALIGN_VERSION, receipt },
      };
    } catch (error) {
      if (promoted) fs.rmSync(targetDir, { recursive: true, force: true });
      if (backedUp && fs.existsSync(backup)) fs.renameSync(backup, targetDir);
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  });
}

/** The banner must name the pinned version, and the shipped sample pair must align as upstream reports. */
async function verifyBinary(binary: string, srcDir: string, runner: InstallCommandRunner): Promise<void> {
  // `-v` prints the banner on stdout and exits 1, so only the text is checked.
  const version = await runner(binary, ["-v"], { timeoutMs: PROBE_TIMEOUT_MS });
  if (!`${version.stdout}${version.stderr}`.includes(`Version ${USALIGN_VERSION}`)) {
    throw fail("USALIGN_VERIFY_FAILED", `The built binary does not report version ${USALIGN_VERSION}.`, "Run `moldesk install usalign --reinstall --yes`.");
  }
  const sample = await runner(binary, [path.join(srcDir, "PDB1.pdb"), path.join(srcDir, "PDB2.pdb"), "-outfmt", "2"], { timeoutMs: PROBE_TIMEOUT_MS });
  // Columns of `-outfmt 2`: names, TM1, TM2, RMSD, ID1, ID2, IDali, L1, L2, Lali.
  const row = sample.stdout.split("\n").find((line) => line.includes("PDB1.pdb"))?.split("\t").map(Number);
  const t = SELF_TEST;
  if (
    !row ||
    Math.abs(row[2] - t.tm1) > t.tolerance ||
    Math.abs(row[3] - t.tm2) > t.tolerance ||
    row[8] !== t.length1 ||
    row[9] !== t.length2 ||
    row[10] !== t.aligned
  ) {
    throw fail(
      "USALIGN_VERIFY_FAILED",
      `The built US-align gave an unexpected result on its sample structures (${row ? `TM ${row[2]} / ${row[3]}` : "no result"}).`,
      "Run `moldesk install usalign --reinstall --yes`; if it persists, report it with your compiler version.",
    );
  }
}

export async function uninstallUsalign(options: { paths?: MoldeskPaths } = {}): Promise<boolean> {
  const paths = options.paths ?? getMoldeskPaths();
  const dir = usalignDir(paths);
  return withModelLock(paths, `usalign-${USALIGN_VERSION}`, async () => {
    if (!fs.existsSync(dir)) return false;
    const trash = `${dir}.removing-${randomUUID()}`;
    fs.renameSync(dir, trash);
    fs.rmSync(trash, { recursive: true, force: true });
    return true;
  });
}
