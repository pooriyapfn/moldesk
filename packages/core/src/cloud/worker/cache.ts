import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { effectiveRuntimeSource, selectPythonRuntime, type ModelManifestV1 } from "@moldesk/registry";
import { isSafeRelativePath } from "@moldesk/runtime";
import { MoldeskError } from "../../errors.js";
import { digest } from "../../hash.js";

/**
 * On-volume model cache. Layout under `<volume>/moldesk-cache`:
 *   objects/ and home/...   raw download cache (checksummed objects)
 *   <key>/assets/           materialized assets
 *   <key>/ready.json        written LAST, inside a staging directory that is then renamed into place
 * A cache is only ever reachable as `<key>` after the rename, so an interrupted preparation can
 * never look READY, and a mutated or partial tree is detected by re-hashing against `ready.json`.
 */

export const CACHE_DIR_NAME = "moldesk-cache";
export const READY_FILE = "ready.json";
const REMOTE_PLATFORM = "linux-x64" as const;

export interface CacheFileEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface CacheReadyMetadata {
  version: 1;
  cacheKey: string;
  layoutRevision: string;
  manifestDigest: string;
  files: CacheFileEntry[];
  /** Digest of the canonical file list; also recorded in the client journal. */
  checksumManifestSha256: string;
  sizeBytes: number;
  preparedAt: string;
}

/** Changes whenever anything that affects the prepared assets changes; conservative by design. */
export function cloudCacheKey(manifest: ModelManifestV1): string {
  const runtime = selectPythonRuntime(manifest.runtimes, REMOTE_PLATFORM);
  const source = effectiveRuntimeSource(manifest, runtime);
  return digest({
    model: manifest.name,
    modelVersion: manifest.modelVersion,
    sourceRevision: source?.revision ?? null,
    assets: (manifest.assets ?? []).map((asset) => ({ id: asset.id, sha256: asset.sha256.toLowerCase(), target: asset.target, archive: asset.archive ?? "none" })),
    layout: manifest.cloud?.assetLayoutRevision ?? null,
  });
}

export const cacheRoot = (volumeMount: string): string => path.posix.join(volumeMount, CACHE_DIR_NAME);
export const cacheDirFor = (root: string, key: string): string => path.join(root, key);

function cacheError(code: string, message: string, remediation: string): MoldeskError {
  return new MoldeskError({ code, message, remediation });
}

/** Hashes every regular file under `dir`; symlinks, special files and unsafe names are refused. */
export async function hashTree(dir: string, skip: ReadonlySet<string> = new Set()): Promise<CacheFileEntry[]> {
  const files: CacheFileEntry[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (skip.has(relative)) continue;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw cacheError("CLOUD_CACHE_UNSAFE", `Cache contains a symlink: ${relative}.`, "The cache is rejected and will be rebuilt.");
      if (!isSafeRelativePath(relative)) throw cacheError("CLOUD_CACHE_UNSAFE", `Cache contains an unsafe path: ${relative}.`, "The cache is rejected and will be rebuilt.");
      if (stat.isDirectory()) await walk(full, relative);
      else if (stat.isFile()) {
        const hash = createHash("sha256");
        for await (const chunk of fs.createReadStream(full)) hash.update(chunk as Buffer);
        files.push({ path: relative, sizeBytes: stat.size, sha256: hash.digest("hex") });
      } else throw cacheError("CLOUD_CACHE_UNSAFE", `Cache contains a non-regular file: ${relative}.`, "The cache is rejected and will be rebuilt.");
    }
  };
  await walk(dir, "");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const checksumDigest = (files: CacheFileEntry[]): string => digest(files.map((file) => [file.path, file.sizeBytes, file.sha256]));

/**
 * Publishes a fully prepared staging directory (`<staging>/assets/...`) as the cache for `key`:
 * hashes the tree, writes ready.json into staging, then atomically renames staging into place.
 */
export async function publishCache(params: { root: string; key: string; stagingDir: string; manifestDigest: string; layoutRevision: string }): Promise<CacheReadyMetadata> {
  const files = await hashTree(params.stagingDir, new Set([READY_FILE]));
  const metadata: CacheReadyMetadata = {
    version: 1,
    cacheKey: params.key,
    layoutRevision: params.layoutRevision,
    manifestDigest: params.manifestDigest,
    files,
    checksumManifestSha256: checksumDigest(files),
    sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    preparedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(params.stagingDir, READY_FILE), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  const final = cacheDirFor(params.root, params.key);
  if (fs.existsSync(final)) fs.renameSync(final, `${final}.replaced-${randomUUID()}`);
  fs.renameSync(params.stagingDir, final);
  return metadata;
}

export type CacheVerification =
  | { ok: true; metadata: CacheReadyMetadata; assetsDir: string }
  | { ok: false; code: "CLOUD_CACHE_MISSING" | "CLOUD_CACHE_INVALID"; message: string };

/** Verifies the on-volume cache before use: metadata matches this job, and every file hashes as recorded. */
export async function verifyCache(params: { root: string; key: string; manifestDigest: string; layoutRevision: string }): Promise<CacheVerification> {
  const dir = cacheDirFor(params.root, params.key);
  const readyPath = path.join(dir, READY_FILE);
  if (!fs.existsSync(readyPath)) return { ok: false, code: "CLOUD_CACHE_MISSING", message: "No prepared cache exists on the volume." };
  let metadata: CacheReadyMetadata;
  try {
    metadata = JSON.parse(fs.readFileSync(readyPath, "utf8")) as CacheReadyMetadata;
  } catch {
    return { ok: false, code: "CLOUD_CACHE_INVALID", message: "The cache metadata is unreadable." };
  }
  if (metadata.version !== 1 || metadata.cacheKey !== params.key || metadata.layoutRevision !== params.layoutRevision || metadata.manifestDigest !== params.manifestDigest) {
    return { ok: false, code: "CLOUD_CACHE_INVALID", message: "The cache was prepared for a different model, source or layout." };
  }
  if (checksumDigest(metadata.files) !== metadata.checksumManifestSha256) {
    return { ok: false, code: "CLOUD_CACHE_INVALID", message: "The cache checksum manifest was altered." };
  }
  let actual: CacheFileEntry[];
  try {
    actual = await hashTree(dir, new Set([READY_FILE]));
  } catch (error) {
    return { ok: false, code: "CLOUD_CACHE_INVALID", message: error instanceof Error ? error.message : String(error) };
  }
  if (checksumDigest(actual) !== metadata.checksumManifestSha256) {
    return { ok: false, code: "CLOUD_CACHE_INVALID", message: "The cache contents no longer match their recorded checksums." };
  }
  return { ok: true, metadata, assetsDir: path.join(dir, "assets") };
}

export interface VolumeLock {
  release(): void;
}

/**
 * Advisory lock for preparing one cache, as an atomic directory with owner and expiry. An expired
 * lock is reclaimed only when the caller asserts the previous owner is gone (`reclaimStale`).
 */
export function acquireVolumeLock(params: { root: string; key: string; owner: string; ttlSeconds: number; reclaimStale?: boolean; now?: () => number }): VolumeLock {
  const now = params.now ?? Date.now;
  const lock = path.join(params.root, `${params.key}.lock`);
  fs.mkdirSync(params.root, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ owner: params.owner, expiresAt: now() + params.ttlSeconds * 1000 }));
      return { release: () => fs.rmSync(lock, { recursive: true, force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let expired = false;
      try {
        expired = (JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as { expiresAt: number }).expiresAt <= now();
      } catch {
        expired = true;
      }
      if (expired && params.reclaimStale && attempt === 0) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      throw cacheError("CLOUD_CACHE_LOCKED", "Another machine is preparing this cache.", "Wait for it to finish; a stale lock is reclaimed only after the previous owner is confirmed gone.");
    }
  }
  throw cacheError("CLOUD_CACHE_LOCKED", "Could not take the cache lock.", "Retry.");
}
