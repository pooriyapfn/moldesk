import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AssetSpec, DockerRuntimeSpec, PythonRuntimeSpec } from "@moldesk/registry";
import { MoldeskError } from "@moldesk/registry";
import { getMoldeskPaths, pythonToolDir, uvToolDir, type MoldeskPaths } from "../filesystem/index.js";
import { runCommand, type RunResult } from "../process/index.js";

export type InstallCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<RunResult>;

export interface InstallProgress {
  step: string;
  message: string;
  receivedBytes?: number;
  totalBytes?: number;
}

export interface PythonInstallRequest {
  targetDir: string;
  repository: string;
  revision: string;
  runtime: PythonRuntimeSpec;
  runner?: InstallCommandRunner;
  fetch?: AssetFetch;
  paths?: MoldeskPaths;
  uvExecutable?: string;
  onProgress?: (progress: InstallProgress) => void;
}

export interface PostInstallHookResult {
  hook: string;
  stdout: string;
  stderr: string;
}

export interface PreparedPythonEnvironment {
  executable: string;
  lock: string[];
  pythonVersion: string;
  /** One entry per `runtime.postInstall` hook that ran, in declared order. Empty
   * when the runtime declares no postInstall hooks. */
  postInstall: PostInstallHookResult[];
}

export interface PreparedDockerImage {
  image: string;
  digest: string;
}

type FetchResponse = {
  ok: boolean;
  status: number;
  url?: string;
  headers: { get(name: string): string | null };
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
};

export type AssetFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponse>;

export const MANAGED_UV_VERSION = "0.12.8";

export const UV_RELEASES: Record<string, { triple: string; sha256: string; sizeBytes: number }> = {
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    sha256: "8ce083658dbff20143607ca7af8e0c1d64b6fd7bf03a5cdcb62bf3d47d991b5f",
    sizeBytes: 16_657_135,
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-gnu",
    sha256: "2e2b37e9811e17675a9e70bed5e1a58fc8c0388be63d751d72cc735188c149ff",
    sizeBytes: 19_428_791,
  },
};

function installError(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

async function checked(
  runner: InstallCommandRunner,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  const result = await runner(command, args, { ...options, timeoutMs: options.timeoutMs ?? 30 * 60_000 });
  if (result.code !== 0 || result.timedOut) {
    throw installError(
      "INSTALL_COMMAND_FAILED",
      `${command} ${args.join(" ")} failed${result.timedOut ? " (timed out)" : ` with exit code ${result.code}`}.`,
      "Review command output, network access, and disk space, then run install --reinstall.",
      { command, args, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut },
    );
  }
  return result;
}

function managedEnvironment(
  paths: MoldeskPaths,
  pythonVersion: string,
  options: { extraIndexUrls?: string[]; findLinks?: string[]; torchBackend?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    TMPDIR: process.env["TMPDIR"],
    SSL_CERT_FILE: process.env["SSL_CERT_FILE"],
    SSL_CERT_DIR: process.env["SSL_CERT_DIR"],
    UV_CACHE_DIR: path.join(paths.cache, "uv"),
    UV_PYTHON_INSTALL_DIR: pythonToolDir(pythonVersion, { MOLDESK_HOME: paths.home }),
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_PROGRESS: "1",
  };
  // Deliberately never overrides UV_INDEX_URL (the default/primary index stays
  // PyPI) — a runtime entry that needs a CUDA-specific extra index (e.g. PyTorch's
  // own cu117 index) must not lose access to ordinary packages like pandas/scipy
  // by replacing the default index outright. `extraIndexUrls` (PEP-503-style
  // indexes) and `findLinks` (flat wheel-listing pages, a distinct pip/uv
  // mechanism) are kept as separate fields precisely because conflating them
  // breaks resolution — a page meant for `--find-links` is not always a valid
  // PEP-503 index.
  if (options.extraIndexUrls && options.extraIndexUrls.length > 0) {
    env["UV_EXTRA_INDEX_URL"] = options.extraIndexUrls.join(" ");
  }
  if (options.findLinks && options.findLinks.length > 0) {
    env["UV_FIND_LINKS"] = options.findLinks.join(" ");
  }
  // Schema-validated closed enum (e.g. "cu126"); uv routes torch-ecosystem
  // packages to the matching official PyTorch index.
  if (options.torchBackend) env["UV_TORCH_BACKEND"] = options.torchBackend;
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function platformId(): string {
  return `${process.platform}-${process.arch}`;
}

export function managedUvDownloadBytes(paths: MoldeskPaths = getMoldeskPaths()): number {
  const release = UV_RELEASES[platformId()];
  if (!release) return 0;
  const executable = path.join(uvToolDir(MANAGED_UV_VERSION, { MOLDESK_HOME: paths.home }), "uv");
  return fs.existsSync(executable) ? 0 : release.sizeBytes;
}

export async function ensureManagedUv(options: {
  paths?: MoldeskPaths;
  fetch?: AssetFetch;
  runner?: InstallCommandRunner;
  onProgress?: (progress: InstallProgress) => void;
} = {}): Promise<string> {
  const paths = options.paths ?? getMoldeskPaths();
  const runner = options.runner ?? runCommand;
  const release = UV_RELEASES[platformId()];
  if (!release) {
    throw installError("UV_PLATFORM_UNSUPPORTED", `Managed uv is unavailable for ${platformId()}.`, "Use macOS ARM64 or Linux x64 for v0.1.");
  }
  const toolDir = uvToolDir(MANAGED_UV_VERSION, { MOLDESK_HOME: paths.home });
  const executable = path.join(toolDir, "uv");
  const receipt = path.join(toolDir, "verified.json");
  if (fs.existsSync(executable) && fs.existsSync(receipt)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(receipt, "utf8")) as { version?: unknown; sha256?: unknown };
      if (metadata.version === MANAGED_UV_VERSION && metadata.sha256 === release.sha256) {
        const verified = await runner(executable, ["--version"], { timeoutMs: 15_000 });
        if (verified.code === 0 && verified.stdout.includes(MANAGED_UV_VERSION)) return executable;
      }
    } catch {
      // Replace an incomplete or unverifiable tool installation below.
    }
  }

  options.onProgress?.({ step: "uv", message: `Downloading managed uv ${MANAGED_UV_VERSION}` });
  const archiveName = `uv-${release.triple}.tar.gz`;
  const asset: AssetSpec = {
    id: `uv-${MANAGED_UV_VERSION}-${release.triple}`,
    url: `https://github.com/astral-sh/uv/releases/download/${MANAGED_UV_VERSION}/${archiveName}`,
    source: "Official astral-sh/uv GitHub release",
    license: "Apache-2.0 OR MIT",
    sha256: release.sha256,
    target: archiveName,
    sizeBytes: release.sizeBytes,
    archive: "none",
  };
  const object = await cacheAsset(asset, paths, { fetch: options.fetch, onProgress: options.onProgress });
  const staging = `${toolDir}.partial-${process.pid}-${randomUUID()}`;
  const backup = `${toolDir}.backup-${randomUUID()}`;
  let backedUp = false;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    const listing = await checked(runner, "tar", ["-tzf", object]);
    if (listing.stdout.split(/\r?\n/).filter(Boolean).some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
      throw installError("UNSAFE_ARCHIVE_ENTRY", "Managed uv archive contains an unsafe path.", "Report the release artifact as unsafe.");
    }
    // Managed volumes may forbid chown even for root; archive owners are not
    // part of the tool's provenance and should never replace the local owner.
    await checked(runner, "tar", ["-xzf", object, "--no-same-owner", "-C", staging]);
    const extracted = path.join(staging, `uv-${release.triple}`, "uv");
    if (!fs.existsSync(extracted)) {
      throw installError("UV_ARCHIVE_INVALID", `Managed uv archive did not contain ${extracted}.`, "Retry download or report the pinned artifact.");
    }
    fs.chmodSync(extracted, 0o755);
    const verified = await checked(runner, extracted, ["--version"]);
    if (!verified.stdout.includes(MANAGED_UV_VERSION)) {
      throw installError("UV_VERSION_MISMATCH", `Expected uv ${MANAGED_UV_VERSION}, received ${verified.stdout.trim()}.`, "Report the pinned artifact.");
    }
    fs.writeFileSync(path.join(staging, "verified.json"), `${JSON.stringify({ version: MANAGED_UV_VERSION, sha256: release.sha256 })}\n`, { mode: 0o600 });
    fs.copyFileSync(extracted, path.join(staging, "uv"));
    fs.chmodSync(path.join(staging, "uv"), 0o755);
    if (fs.existsSync(toolDir)) {
      fs.renameSync(toolDir, backup);
      backedUp = true;
    }
    fs.renameSync(staging, toolDir);
    fs.rmSync(backup, { recursive: true, force: true });
    return executable;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (backedUp && fs.existsSync(backup) && !fs.existsSync(toolDir)) fs.renameSync(backup, toolDir);
    throw error;
  }
}

function requirementSpecifier(requirement: PythonRuntimeSpec["requirements"][number]): string {
  const nameWithExtras =
    requirement.extras && requirement.extras.length > 0
      ? `${requirement.name}[${requirement.extras.join(",")}]`
      : requirement.name;
  if (requirement.source) {
    const revision = requirement.revision ? `@${requirement.revision}` : "";
    return `${nameWithExtras} @ git+${requirement.source}${revision}`;
  }
  return requirement.version ? `${nameWithExtras}==${requirement.version}` : nameWithExtras;
}

/**
 * One requirements-file line per requirement, with `--hash=sha256:<digest>` tokens
 * appended when the requirement declares hashes. Hash-checking mode (uv/pip's
 * `--require-hashes`) is only reliable via a requirements file — not as bare CLI
 * args mixed across multiple packages — so hashed installs always go through
 * `preparePythonEnvironment`'s `-r <file>` path, never the positional-args path.
 */
function requirementFileLine(requirement: PythonRuntimeSpec["requirements"][number]): string {
  const specifier = requirementSpecifier(requirement);
  if (!requirement.hashes || requirement.hashes.length === 0) return specifier;
  return `${specifier} ${requirement.hashes.map((h) => `--hash=sha256:${h}`).join(" ")}`;
}

/**
 * Fixed dispatch table for `postInstall` hook names: named, non-shell fixups. Each
 * handler receives the venv's bin directory and runs a literal, reviewed executable
 * name from it via the injected runner — never a shell, never an interpolated
 * manifest string, so `postInstall` can never become a generic command escape hatch.
 */
const POST_INSTALL_HOOKS: Record<string, (venvBinDir: string, runner: InstallCommandRunner) => Promise<RunResult>> = {
  "boltz-fix-macos-libomp": (venvBinDir, runner) =>
    checked(runner, path.join(venvBinDir, "boltz-fix-macos-libomp"), []),
};

/**
 * Runs the existing two-pass install (verify hash-declared requirements by
 * artifact digest with `--no-deps`, then a normal resolving pass over every
 * requirement in the set) for one *stage* of requirements — a stage being
 * either the main `requirements[]` set or a `buildAfter`-deferred subset,
 * installed via its own separate invocation so a git-built package that
 * imports an earlier dependency at build time (e.g. openfold importing torch)
 * only ever builds after that dependency is already fully installed.
 * `--only-binary <name>` is appended for every requirement in `binaryOnlyNames`
 * so an ABI-sensitive CUDA extension package can never silently fall back to
 * building from source — install fails closed instead.
 */
async function installRequirementSet(
  runner: InstallCommandRunner,
  uv: string,
  python: string,
  targetDir: string,
  requirements: PythonRuntimeSpec["requirements"],
  binaryOnlyNames: Set<string>,
  env: NodeJS.ProcessEnv,
  lockFileSuffix: string,
): Promise<void> {
  if (requirements.length === 0) return;
  const binaryOnlyArgs = requirements
    .filter((r) => binaryOnlyNames.has(r.name))
    .flatMap((r) => ["--only-binary", r.name]);

  const hashedRequirements = requirements.filter((r) => r.hashes && r.hashes.length > 0);
  if (hashedRequirements.length > 0) {
    const requirementsFile = path.join(targetDir, `.requirements-lock${lockFileSuffix}.txt`);
    const content = `${hashedRequirements.map((r) => requirementFileLine(r)).join("\n")}\n`;
    fs.writeFileSync(requirementsFile, content, { mode: 0o600 });
    await checked(
      runner,
      uv,
      ["pip", "install", "--python", python, "--require-hashes", "--no-deps", ...binaryOnlyArgs, "-r", requirementsFile],
      { env },
    );
  }
  await checked(
    runner,
    uv,
    ["pip", "install", "--python", python, ...binaryOnlyArgs, ...requirements.map((r) => requirementSpecifier(r))],
    { env },
  );
}

export async function preparePythonEnvironment(request: PythonInstallRequest): Promise<PreparedPythonEnvironment> {
  const runner = request.runner ?? runCommand;
  const paths = request.paths ?? getMoldeskPaths();
  const uv = request.uvExecutable ?? await ensureManagedUv({ paths, fetch: request.fetch, runner, onProgress: request.onProgress });
  const env = managedEnvironment(paths, request.runtime.python, {
    extraIndexUrls: request.runtime.extraIndexUrls,
    findLinks: request.runtime.findLinks,
    torchBackend: request.runtime.torchBackend,
  });
  const sourceDir = path.join(request.targetDir, "source");
  const venvDir = path.join(request.targetDir, ".venv");
  const python = process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");

  request.onProgress?.({ step: "source", message: "Fetching pinned source revision" });
  fs.mkdirSync(request.targetDir, { recursive: true });
  await checked(runner, "git", ["init", sourceDir]);
  await checked(runner, "git", ["-C", sourceDir, "remote", "add", "origin", request.repository]);
  await checked(runner, "git", ["-C", sourceDir, "fetch", "--depth", "1", "origin", request.revision]);
  await checked(runner, "git", ["-C", sourceDir, "checkout", "--detach", "FETCH_HEAD"]);
  const revision = await checked(runner, "git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  if (revision.stdout.trim().toLowerCase() !== request.revision.toLowerCase()) {
    throw installError(
      "SOURCE_REVISION_MISMATCH",
      `Fetched source revision ${revision.stdout.trim()} does not match ${request.revision}.`,
      "Retry installation. If this persists, report a registry integrity issue.",
    );
  }

  request.onProgress?.({ step: "python", message: `Preparing managed Python ${request.runtime.python}` });
  await checked(runner, uv, ["python", "install", request.runtime.python], { env });
  // --relocatable: installs happen in a `.partial-<pid>-<uuid>` staging directory
  // that is atomically renamed to its final target on success (see
  // packages/core/src/installation.ts). Without this flag, console scripts uv
  // generates (e.g. `boltz`) bake the staging path into their shebang line and
  // break after the rename — confirmed by a real install+run on this machine
  // (`exec: .../.partial-.../.venv/bin/python: No such file or directory`).
  await checked(runner, uv, ["venv", "--relocatable", "--python", request.runtime.python, venvDir], { env });
  request.onProgress?.({ step: "dependencies", message: "Installing pinned dependencies" });

  // Stage 0: preInstall requirements, each its own separate invocation, strictly
  // before anything else — for a package (e.g. a pinned older `setuptools`) whose
  // own version a later requirement's source build depends on already being fully
  // resolved, not merely present somewhere in the same combined resolver graph.
  for (const req of request.runtime.preInstall ?? []) {
    request.onProgress?.({ step: "dependencies", message: `Installing ${req.name} (preInstall)` });
    await checked(runner, uv, ["pip", "install", "--python", python, requirementSpecifier(req)], { env });
  }

  // uv/pip's --require-hashes mode demands every requirement resolved by a given
  // install invocation be hashed, including the full transitive closure — not
  // just the manifest-declared top-level packages (confirmed directly: `uv pip
  // install --require-hashes` refuses over an unhashed transitive dependency like
  // `filelock`). Hand-pinning an entire transitive closure per model isn't
  // practical or what this manifest schema is for. Instead, verify each
  // hash-declared requirement's own artifact by digest with `--no-deps` (so only
  // that one wheel/sdist is checked, no transitive resolution), then do a second,
  // ordinary install pass over every requirement (hashed ones included, by their
  // plain specifier) so normal dependency resolution installs the rest of the
  // closure. A requirement pinned by git source+revision has no fixed artifact
  // hash to check at all (it's built from source) — that's a distinct, equally
  // valid provenance mechanism, not a gap. `binaryOnly` names get `--only-binary`
  // on both passes so an ABI-sensitive package can never silently fall back to a
  // from-source build.
  const binaryOnlyNames = new Set(request.runtime.binaryOnly ?? []);
  const deferredNames = new Set(request.runtime.buildAfter ?? []);
  const immediateRequirements = request.runtime.requirements.filter((r) => !deferredNames.has(r.name));
  const deferredRequirements = request.runtime.requirements.filter((r) => deferredNames.has(r.name));

  await installRequirementSet(runner, uv, python, request.targetDir, immediateRequirements, binaryOnlyNames, env, "");

  // Stage 2: buildAfter requirements, in their own separate final invocation,
  // strictly after every other requirement (including preInstall) has finished —
  // for a package whose own build process imports an earlier dependency (e.g. an
  // unpackaged git build that imports torch at setup time to select CUDA
  // architecture flags), which a single combined resolver invocation cannot
  // reliably sequence.
  if (deferredRequirements.length > 0) {
    request.onProgress?.({ step: "dependencies", message: "Installing buildAfter dependencies" });
    await installRequirementSet(runner, uv, python, request.targetDir, deferredRequirements, binaryOnlyNames, env, "-deferred");
  }

  const postInstall: PostInstallHookResult[] = [];
  for (const hook of request.runtime.postInstall ?? []) {
    const handler = POST_INSTALL_HOOKS[hook];
    if (!handler) {
      throw installError(
        "POST_INSTALL_HOOK_UNKNOWN",
        `Unknown postInstall hook "${hook}".`,
        "This is a MoleculeDesk bug — report it; the schema should have rejected this value.",
        { hook },
      );
    }
    request.onProgress?.({ step: "post-install", message: `Running postInstall hook ${hook}` });
    const venvBinDir = path.dirname(python);
    const result = await handler(venvBinDir, runner);
    postInstall.push({ hook, stdout: result.stdout, stderr: result.stderr });
  }

  const freeze = await checked(runner, uv, ["pip", "freeze", "--python", python], { env });
  const version = await checked(runner, python, ["--version"], { env });
  return {
    executable: python,
    lock: freeze.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort(),
    pythonVersion: `${version.stdout}\n${version.stderr}`.trim(),
    postInstall,
  };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function cacheAssetUnlocked(
  asset: AssetSpec,
  paths: MoldeskPaths,
  options: { fetch?: AssetFetch; onProgress?: (progress: InstallProgress) => void } = {},
): Promise<string> {
  fs.mkdirSync(paths.downloads, { recursive: true });
  fs.mkdirSync(paths.objects, { recursive: true });
  const expected = asset.sha256.toLowerCase();
  const objectPath = path.join(paths.objects, expected);
  if (fs.existsSync(objectPath)) {
    if (await sha256(objectPath) === expected) return objectPath;
    fs.rmSync(objectPath, { force: true });
  }

  const partial = path.join(paths.downloads, `${expected}.part`);
  if (fs.existsSync(partial) && await sha256(partial) === expected) {
    fs.renameSync(partial, objectPath);
    return objectPath;
  }
  let received = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  const fetcher: AssetFetch = options.fetch ?? (globalThis.fetch as unknown as AssetFetch);
  let response = await fetcher(asset.url, received > 0 ? { headers: { Range: `bytes=${received}-` } } : undefined);
  if (received > 0 && response.status !== 206) {
    fs.truncateSync(partial, 0);
    received = 0;
    response = await fetcher(asset.url);
  }
  if (!response.ok || !response.body) {
    throw installError(
      "ASSET_DOWNLOAD_FAILED",
      `Could not download ${asset.id}: HTTP ${response.status}.`,
      "Check network access and retry; partial downloads are preserved.",
      { asset: asset.id, url: asset.url },
    );
  }
  if (response.url && new URL(response.url).protocol !== "https:") {
    throw installError("ASSET_REDIRECT_UNSAFE", `Download for ${asset.id} redirected to unsupported URL ${response.url}.`, "Report the registry asset as unsafe.");
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const totalBytes = contentLength > 0 ? received + contentLength : asset.sizeBytes;
  const file = fs.openSync(partial, received > 0 ? "a" : "w");
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      fs.writeSync(file, value);
      received += value.byteLength;
      options.onProgress?.({ step: "asset", message: `Downloading ${asset.id}`, receivedBytes: received, totalBytes });
    }
  } finally {
    fs.closeSync(file);
  }

  if (asset.sizeBytes !== undefined && received !== asset.sizeBytes) {
    fs.rmSync(partial, { force: true });
    throw installError(
      "ASSET_SIZE_MISMATCH",
      `Size mismatch for ${asset.id}: expected ${asset.sizeBytes} bytes, received ${received}.`,
      "Retry download. If mismatch persists, report a registry integrity issue.",
    );
  }

  const actual = await sha256(partial);
  if (actual !== expected) {
    fs.rmSync(partial, { force: true });
    throw installError(
      "ASSET_CHECKSUM_MISMATCH",
      `Checksum mismatch for ${asset.id}: expected ${expected}, received ${actual}.`,
      "Retry download. If mismatch persists, report a registry integrity issue.",
    );
  }
  try {
    fs.renameSync(partial, objectPath);
  } catch (error) {
    if (!fs.existsSync(objectPath)) throw error;
    if (await sha256(objectPath) !== expected) throw error;
    fs.rmSync(partial, { force: true });
  }
  return objectPath;
}

async function acquireDownloadLock(paths: MoldeskPaths, digest: string): Promise<string> {
  fs.mkdirSync(paths.locks, { recursive: true });
  const lock = path.join(paths.locks, `download-${digest}.lock`);
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as { pid?: unknown };
        let stale = Date.now() - fs.statSync(lock).mtimeMs > 60 * 60_000;
        if (typeof owner.pid === "number") {
          try {
            process.kill(owner.pid, 0);
          } catch (processError) {
            stale ||= (processError as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
        if (stale) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw installError("DOWNLOAD_LOCKED", `Timed out waiting for download ${digest}.`, "Wait for the other installation to finish, then retry.");
}

export async function cacheAsset(
  asset: AssetSpec,
  paths: MoldeskPaths,
  options: { fetch?: AssetFetch; onProgress?: (progress: InstallProgress) => void } = {},
): Promise<string> {
  fs.mkdirSync(paths.objects, { recursive: true });
  const expected = asset.sha256.toLowerCase();
  const objectPath = path.join(paths.objects, expected);
  if (fs.existsSync(objectPath) && await sha256(objectPath) === expected) return objectPath;
  const lock = await acquireDownloadLock(paths, expected);
  try {
    return await cacheAssetUnlocked(asset, paths, options);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export async function materializeAsset(asset: AssetSpec, objectPath: string, assetsDir: string): Promise<string> {
  const target = path.resolve(assetsDir, asset.target);
  const root = `${path.resolve(assetsDir)}${path.sep}`;
  if (!target.startsWith(root)) {
    throw installError("UNSAFE_ASSET_TARGET", `Asset target escapes installation: ${asset.target}.`, "Fix the registry manifest.");
  }
  if (!asset.archive || asset.archive === "none") {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.linkSync(objectPath, target);
    } catch {
      fs.copyFileSync(objectPath, target, fs.constants.COPYFILE_FICLONE);
    }
    return target;
  }
  fs.mkdirSync(target, { recursive: true });
  const listing = asset.archive === "zip"
    ? await checked(runCommand, "unzip", ["-Z1", objectPath])
    : await checked(runCommand, "tar", [asset.archive === "tar.gz" ? "-tzf" : "-tf", objectPath]);
  const unsafeEntry = listing.stdout.split(/\r?\n/).filter(Boolean).find((entry) => {
    const normalized = entry.replaceAll("\\", "/");
    return normalized.startsWith("/") || normalized.split("/").some((part) => part === "..");
  });
  if (unsafeEntry) {
    fs.rmSync(target, { recursive: true, force: true });
    throw installError("UNSAFE_ARCHIVE_ENTRY", `Archive ${asset.id} contains unsafe path ${unsafeEntry}.`, "Report the registry asset as unsafe.");
  }
  if (asset.archive === "zip") await checked(runCommand, "unzip", ["-q", objectPath, "-d", target]);
  else await checked(runCommand, "tar", [asset.archive === "tar.gz" ? "-xzf" : "-xf", objectPath, "--no-same-owner", "-C", target]);
  return target;
}

export async function prepareDockerImage(
  runtime: DockerRuntimeSpec,
  runner: InstallCommandRunner = runCommand,
): Promise<PreparedDockerImage> {
  const reference = `${runtime.image}@${runtime.digest}`;
  const inspect = await runner("docker", ["image", "inspect", reference], { timeoutMs: 30_000 });
  if (inspect.code !== 0) await checked(runner, "docker", ["pull", reference], { timeoutMs: 60 * 60_000 });
  await checked(runner, "docker", ["image", "inspect", reference], { timeoutMs: 30_000 });
  return { image: reference, digest: runtime.digest };
}

export function temporaryInstallDir(targetDir: string): string {
  return `${targetDir}.partial-${process.pid}-${randomUUID()}`;
}
