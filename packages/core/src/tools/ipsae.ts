import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetSpec } from "@moldesk/registry";
import { cacheAsset, getMoldeskPaths, managedUvDownloadBytes, prepareManagedPython, runCommand, temporaryInstallDir,
  type AssetFetch, type InstallCommandRunner, type InstallProgress, type MoldeskPaths } from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import { sha256File } from "../hash.js";
import { withModelLock } from "../installation.js";
import { parseIpsaeOutput } from "../analysis/ipsae-output.js";

export const IPSAE_REVISION = "6174cf9e71cb1bd660cc805856a18c4871a6dec3";
export const IPSAE_SOURCE: AssetSpec = {
  id: "ipsae-source", url: `https://raw.githubusercontent.com/DunbrackLab/IPSAE/${IPSAE_REVISION}/ipsae.py`,
  source: "https://github.com/DunbrackLab/IPSAE", license: "MIT", target: "ipsae.py",
  sha256: "10cf9b08c68c91e06cb28526cf2026f47a3980c9048fd3226d13e3304eaf1c27", sizeBytes: 45140,
};
// PyPI release metadata for NumPy 2.2.6, cp311 wheels. All dependencies (NumPy has none) are hash-pinned.
export const IPSAE_REQUIREMENTS = `numpy==2.2.6 \\
    --hash=sha256:c820a93b0255bc360f53eca31a0e676fd1101f673dda8da93454a12e23fc5f7a \\
    --hash=sha256:3d70692235e759f260c3d837193090014aebdf026dfd167834bcba43e30c2a42 \\
    --hash=sha256:ba10f8411898fc418a521833e014a77d3ca01c15b0c6cdcce6a0d2897e6dbbdf\n`;
export const IPSAE_RESOURCES = fileURLToPath(new URL("../../resources/ipsae/", import.meta.url));
export const IPSAE_PYTHON = "3.11.13";
export interface IpsaeReceipt {
  schemaVersion: 1; tool: "ipsae"; revision: string; sourceSha256: string; sourceUrl: string;
  platform: string; installedAt: string; pythonVersion: string; numpyVersion: "2.2.6"; license: "MIT";
  files: Record<string, string>; pythonSha256: string;
}
export interface IpsaeInstallation { dir: string; executable: string; source: string; receipt: IpsaeReceipt }
export interface IpsaeInstallOptions { paths?: MoldeskPaths; runner?: InstallCommandRunner; fetch?: AssetFetch; reinstall?: boolean; onProgress?: (p: InstallProgress) => void }
export function ipsaeDir(paths = getMoldeskPaths()): string { return path.join(paths.tools, "ipsae", IPSAE_REVISION); }
function fail(code: string, message: string): MoldeskError {
  return new MoldeskError({ code, message, remediation: "Run `moldesk install ipsae --reinstall --yes`." });
}

function installedFiles(dir: string, prefix = ""): string[] {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(prefix, entry.name);
    if (entry.name === "__pycache__" || name === "installation.json") return [];
    if (entry.isDirectory()) return installedFiles(dir, name);
    if (entry.isSymbolicLink()) {
      if (name === ".venv/lib64" && fs.readlinkSync(path.join(dir, name)) === "lib") return [];
      if (!/^\.venv\/bin\/python(3(\.11)?)?$/.test(name)) throw fail("IPSAE_DAMAGED", `Unexpected symlink: ${name}`);
      return [];
    }
    return [name];
  }).sort();
}
async function inventory(dir: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of installedFiles(dir)) hashes[file] = await sha256File(path.join(dir, file));
  return hashes;
}
export async function requireIpsae(paths = getMoldeskPaths()): Promise<IpsaeInstallation> {
  const dir = ipsaeDir(paths);
  if (!fs.existsSync(dir)) throw fail("IPSAE_NOT_INSTALLED", "ipSAE is not installed; evaluation never installs tools.");
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, "installation.json"), "utf8")) as IpsaeReceipt;
    const executable = path.join(dir, ".venv/bin/python");
    if (r.schemaVersion !== 1 || r.tool !== "ipsae" || r.revision !== IPSAE_REVISION || r.sourceSha256 !== IPSAE_SOURCE.sha256 ||
        r.sourceUrl !== IPSAE_SOURCE.url || r.numpyVersion !== "2.2.6" || r.platform !== `${process.platform}-${process.arch}` ||
        r.files["ipsae.py"] !== IPSAE_SOURCE.sha256 || r.pythonSha256 !== await sha256File(executable) ||
        JSON.stringify(r.files) !== JSON.stringify(await inventory(dir))) throw new Error("receipt/source/environment mismatch");
    for (const file of ["validate.py", "self-test.py", "LICENSE"]) {
      if (r.files[file] !== await sha256File(path.join(IPSAE_RESOURCES, file))) throw new Error(`changed ${file}`);
    }
    return { dir, executable, source: path.join(dir, "ipsae.py"), receipt: r };
  } catch (error) {
    throw fail("IPSAE_DAMAGED", `ipSAE is unusable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
export async function getIpsaeStatus(options: { paths?: MoldeskPaths } = {}): Promise<{ installed: boolean; installation?: IpsaeInstallation; problem?: string }> {
  try { return { installed: true, installation: await requireIpsae(options.paths) }; }
  catch (error) { return { installed: false, ...(error instanceof MoldeskError && error.code === "IPSAE_NOT_INSTALLED" ? {} : { problem: String(error) }) }; }
}
export async function planIpsaeInstall(options: { paths?: MoldeskPaths } = {}) {
  const platform = `${process.platform}-${process.arch}`;
  if (!["darwin-arm64", "linux-x64"].includes(platform)) throw fail("IPSAE_PLATFORM_UNSUPPORTED", `ipSAE does not support ${platform}.`);
  return { alreadyInstalled: (await getIpsaeStatus(options)).installed, revision: IPSAE_REVISION, source: IPSAE_SOURCE,
    // Managed Python bytes depend on uv's distribution. This is a known-byte subtotal, not a total quote.
    knownDownloadBytes: IPSAE_SOURCE.sizeBytes! + managedUvDownloadBytes(options.paths) + (process.platform === "darwin" ? 14_406_743 : 16_821_570), pythonDownloadBytes: null };
}
export async function installIpsae(options: IpsaeInstallOptions = {}): Promise<{ status: "installed" | "already-installed" | "reinstalled"; installation: IpsaeInstallation }> {
  const paths = options.paths ?? getMoldeskPaths();
  const runner = options.runner ?? runCommand;
  await planIpsaeInstall({ paths });
  return withModelLock(paths, `ipsae-${IPSAE_REVISION}`, async () => {
    const existing = (await getIpsaeStatus({ paths })).installation;
    if (existing && !options.reinstall) return { status: "already-installed", installation: existing };
    const target = ipsaeDir(paths), stage = temporaryInstallDir(target), backup = `${target}.backup-${randomUUID()}`;
    let backedUp = false, promoted = false;
    const checked = async (cmd: string, args: string[], env?: NodeJS.ProcessEnv, cwd = stage) => {
      const result = await runner(cmd, args, { cwd, env, timeoutMs: 600_000 });
      if (result.code !== 0 || result.timedOut) throw fail("IPSAE_INSTALL_FAILED", (result.stderr || result.stdout).slice(-4000));
      return result;
    };
    try {
      fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
      const source = await cacheAsset(IPSAE_SOURCE, paths, options);
      fs.copyFileSync(source, path.join(stage, "ipsae.py"));
      for (const file of ["validate.py", "self-test.py", "LICENSE"]) fs.copyFileSync(path.join(IPSAE_RESOURCES, file), path.join(stage, file));
      fs.writeFileSync(path.join(stage, "requirements.txt"), IPSAE_REQUIREMENTS);
      const py = await prepareManagedPython({ ...options, paths, targetDir: stage, python: IPSAE_PYTHON });
      await checked(py.uv, ["pip", "install", "--python", py.executable, "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", path.join(stage, "requirements.txt")], py.env);
      const version = await checked(py.executable, ["-I", "-B", "-c", "import sys,numpy; assert numpy.__version__ == '2.2.6'; print(sys.version)"], py.env);
      const scratch = path.join(stage, "self-test"); fs.mkdirSync(scratch);
      await checked(py.executable, ["-I", "-B", path.join(stage, "self-test.py")], py.env, scratch);
      await checked(py.executable, ["-I", "-B", path.join(stage, "validate.py"), "4"], py.env, scratch);
      await checked(py.executable, ["-I", "-B", path.join(stage, "ipsae.py"), "pae_prediction.npz", "prediction.cif", "15", "15"], py.env, scratch);
      const scores = parseIpsaeOutput(fs.readFileSync(path.join(scratch, "prediction_15_15.txt"), "utf8"), "A", "B", 15, 15);
      if (scores.ipsaeTargetToBinder !== 0.5 || scores.ipsaeBinderToTarget !== 0.2 || scores.ipsaeMax !== 0.5) throw fail("IPSAE_INSTALL_FAILED", "Deterministic ipSAE self-test failed.");
      const receipt: IpsaeReceipt = { schemaVersion: 1, tool: "ipsae", revision: IPSAE_REVISION, sourceUrl: IPSAE_SOURCE.url, sourceSha256: IPSAE_SOURCE.sha256,
        platform: `${process.platform}-${process.arch}`, pythonVersion: version.stdout.trim(), numpyVersion: "2.2.6", license: "MIT", installedAt: new Date().toISOString(),
        files: await inventory(stage), pythonSha256: await sha256File(py.executable) };
      fs.writeFileSync(path.join(stage, "installation.json"), JSON.stringify(receipt), { mode: 0o600 });
      if (fs.existsSync(target)) { fs.renameSync(target, backup); backedUp = true; }
      fs.renameSync(stage, target); promoted = true;
      const installation = await requireIpsae(paths);
      if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
      return { status: existing ? "reinstalled" : "installed", installation };
    } catch (error) {
      if (promoted) fs.rmSync(target, { recursive: true, force: true });
      if (backedUp) fs.renameSync(backup, target);
      fs.rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  });
}
export async function uninstallIpsae(options: { paths?: MoldeskPaths } = {}): Promise<boolean> {
  const paths = options.paths ?? getMoldeskPaths();
  return withModelLock(paths, `ipsae-${IPSAE_REVISION}`, async () => {
    const dir = ipsaeDir(paths);
    if (!fs.existsSync(dir)) return false;
    const trash = `${dir}.removing-${randomUUID()}`;
    fs.renameSync(dir, trash); fs.rmSync(trash, { recursive: true, force: true }); return true;
  });
}
