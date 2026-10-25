import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMoldeskPaths, type MoldeskPaths } from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import { ENVELOPE_SCHEMA_VERSION, type AnalysisEnvelope } from "../schemas/envelope.js";
import { VERSION } from "../version.js";
import { guardedGet } from "./http.js";
import {
  afdbFileUrlPattern,
  ENDPOINTS,
  fileName,
  invalidSpec,
  LICENSES,
  MAX_API_BYTES,
  MAX_FASTA_BYTES,
  MAX_STRUCTURE_BYTES,
  parseFetchSpec,
  sniffContent,
  type FetchFormat,
  type FetchSource,
  type FetchSpec,
  type LicenseInfo,
  type SourceEndpoint,
} from "./sources.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_SIDECAR_BYTES = 64 * 1024;

/** Written next to every downloaded file as `<name>.provenance.json`. */
export interface FetchProvenance {
  schemaVersion: 1;
  source: FetchSource;
  id: string;
  file: string;
  format: FetchFormat;
  /** The URL the bytes came from. */
  url: string;
  /** The API request that named that URL (AlphaFold DB). */
  apiUrl?: string;
  retrievedAt: string;
  sha256: string;
  sizeBytes: number;
  /** What the source calls this version, and which field it came from. */
  sourceVersion: string | null;
  sourceVersionKind: "http-last-modified" | "alphafold-model-version" | "uniprot-release";
  /** Extra source facts, e.g. the AlphaFold DB model creation date. */
  details: Record<string, string>;
  license: LicenseInfo;
  moldeskVersion: string;
}

export interface FetchedFile {
  name: string;
  format: FetchFormat;
  /** The copy to use: in `--output` when given, otherwise in the cache. */
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface FetchResult {
  source: FetchSource;
  id: string;
  format: FetchFormat;
  fromCache: boolean;
  cacheDir: string;
  files: FetchedFile[];
  provenance: FetchProvenance;
}

export interface FetchOptions {
  /** `mmcif` (default) or `pdb` for `pdb:` and `afdb:`; `uniprot:` is always FASTA. */
  format?: "mmcif" | "pdb";
  /** Download again even if the cache has a verified copy. */
  refresh?: boolean;
  /** Copy the file and its provenance here; existing files are never overwritten. */
  outputDir?: string;
  paths?: MoldeskPaths;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
  /** Test seams. Not reachable from the CLI or the environment. */
  maxBytes?: number;
  fetch?: typeof fetch;
  endpoints?: Partial<Record<FetchSource, SourceEndpoint>>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function writeAtomic(dest: string, bytes: Uint8Array | string): void {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o644 });
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** `<cache>/fetch/<source>/<id>`, built only from validated parts and checked to stay inside the cache. */
export function fetchCacheDir(spec: FetchSpec, paths: MoldeskPaths = getMoldeskPaths()): string {
  const root = path.join(paths.cache, "fetch");
  const dir = path.join(root, spec.source, spec.id);
  const relative = path.relative(root, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw invalidSpec("The id does not map to a cache location.");
  return dir;
}

/** The cached copy, but only if its provenance is complete and the file still matches its recorded hash. */
function readCached(dir: string, name: string, spec: FetchSpec, format: FetchFormat): { provenance: FetchProvenance } | undefined {
  try {
    const sidecar = path.join(dir, `${name}.provenance.json`);
    const file = path.join(dir, name);
    if (fs.lstatSync(sidecar).size > MAX_SIDECAR_BYTES || !fs.lstatSync(file).isFile()) return undefined;
    const provenance = JSON.parse(fs.readFileSync(sidecar, "utf8")) as FetchProvenance;
    const bytes = fs.readFileSync(file);
    const sound =
      provenance.schemaVersion === 1 && provenance.source === spec.source && provenance.id === spec.id && provenance.file === name &&
      provenance.format === format && provenance.sha256 === sha256(bytes) && provenance.sizeBytes === bytes.length;
    return sound ? { provenance } : undefined;
  } catch {
    return undefined;
  }
}

function upstream(code: string, message: string): MoldeskError {
  return new MoldeskError({ code, message, remediation: "Nothing was saved. Try again later; if it persists, the service may have changed." });
}

interface Download {
  url: string;
  apiUrl?: string;
  bytes: Uint8Array;
  version: string | null;
  kind: FetchProvenance["sourceVersionKind"];
  details: Record<string, string>;
}

async function download(spec: FetchSpec, format: FetchFormat, options: FetchOptions): Promise<Download> {
  const endpoint = options.endpoints?.[spec.source] ?? ENDPOINTS[spec.source];
  const get = (url: string, maxBytes: number) =>
    guardedGet(url, { endpoint, maxBytes: Math.min(maxBytes, options.maxBytes ?? maxBytes), timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: options.signal, fetch: options.fetch });
  const base = `${endpoint.scheme}://${endpoint.host}`;

  if (spec.source === "pdb") {
    const response = await get(`${base}/download/${spec.id}.${format === "mmcif" ? "cif" : "pdb"}`, MAX_STRUCTURE_BYTES);
    const modified = response.headers.get("last-modified");
    const iso = modified && !Number.isNaN(Date.parse(modified)) ? new Date(modified).toISOString() : null;
    return { url: response.url, bytes: response.bytes, version: iso, kind: "http-last-modified", details: {} };
  }

  if (spec.source === "uniprot") {
    const response = await get(`${base}/uniprotkb/${spec.id}.fasta`, MAX_FASTA_BYTES);
    const release = response.headers.get("x-uniprot-release");
    const date = response.headers.get("x-uniprot-release-date");
    return { url: response.url, bytes: response.bytes, version: release, kind: "uniprot-release", details: date ? { releaseDate: date } : {} };
  }

  // AlphaFold DB: resolve the file URL through the API rather than guessing a model version.
  const apiUrl = `${base}/api/prediction/${spec.id}`;
  const api = await get(apiUrl, MAX_API_BYTES);
  let entries: unknown;
  try {
    entries = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(api.bytes));
  } catch {
    throw upstream("FETCH_BAD_CONTENT", `The AlphaFold DB API answer for ${spec.id} is not JSON.`);
  }
  const entry = Array.isArray(entries)
    ? (entries as Array<Record<string, unknown>>).find((e) => e !== null && typeof e === "object" && e.entryId === `AF-${spec.id}-F1`)
    : undefined;
  if (!entry) throw upstream("FETCH_BAD_CONTENT", `The AlphaFold DB API has no AF-${spec.id}-F1 entry in its answer.`);
  const fileUrl = entry[format === "mmcif" ? "cifUrl" : "pdbUrl"];
  const match = typeof fileUrl === "string" ? afdbFileUrlPattern(spec.id, format === "mmcif" ? "mmcif" : "pdb").exec(fileUrl) : null;
  if (!match) throw upstream("FETCH_BAD_CONTENT", `The AlphaFold DB API named a file URL that is not an AF-${spec.id}-F1 model on ${endpoint.host}.`);
  // The pattern pins the path; the request goes to the (possibly overridden) endpoint with that path only.
  const response = await get(`${base}${new URL(fileUrl as string).pathname}`, MAX_STRUCTURE_BYTES);
  const details: Record<string, string> = { entryId: `AF-${spec.id}-F1` };
  if (typeof entry.modelCreatedDate === "string") details.modelCreatedDate = entry.modelCreatedDate;
  return {
    url: response.url,
    apiUrl: api.url,
    bytes: response.bytes,
    version: `v${match[1]}`,
    kind: "alphafold-model-version",
    details,
  };
}

function copyOut(files: FetchedFile[], cacheDir: string, outputDir: string): FetchedFile[] {
  const out = path.resolve(outputDir);
  fs.mkdirSync(out, { recursive: true });
  return files.map((file) => {
    const copies = [file.name, `${file.name}.provenance.json`].map((name) => {
      const dest = path.join(out, name);
      const relative = path.relative(out, dest);
      if (relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) throw invalidSpec("Unsafe output name.");
      return { from: path.join(cacheDir, name), dest };
    });
    for (const { dest } of copies) {
      if (fs.existsSync(dest)) throw new MoldeskError({ code: "OUTPUT_EXISTS", message: `Refusing to overwrite existing file: ${dest}`, remediation: "Choose an empty directory or remove the existing file." });
    }
    for (const { from, dest } of copies) fs.copyFileSync(from, dest, fs.constants.COPYFILE_EXCL);
    return { ...file, path: copies[0].dest };
  });
}

/** Fetches `<source>:<id>` into the cache (or reuses a verified copy) and optionally copies it to a directory. */
export async function fetchStructure(specText: string, options: FetchOptions = {}): Promise<AnalysisEnvelope<FetchResult>> {
  const spec = parseFetchSpec(specText); // validates before any network call or path join
  if (options.format !== undefined && spec.source === "uniprot") {
    throw new MoldeskError({ code: "INVALID_FETCH_ARGS", message: "--format does not apply to uniprot: (it is always FASTA).", remediation: "Drop --format." });
  }
  const format: FetchFormat = spec.source === "uniprot" ? "fasta" : (options.format ?? "mmcif");
  const paths = options.paths ?? getMoldeskPaths();
  const dir = fetchCacheDir(spec, paths);
  const name = fileName(spec, format);
  const warnings: AnalysisEnvelope["warnings"] = [];

  let provenance: FetchProvenance;
  let bytesLength: number;
  const cached = options.refresh ? undefined : readCached(dir, name, spec, format);
  if (cached) {
    provenance = cached.provenance;
    bytesLength = provenance.sizeBytes;
  } else {
    const got = await download(spec, format, options);
    sniffContent(spec, format, got.bytes);
    provenance = {
      schemaVersion: 1,
      source: spec.source,
      id: spec.id,
      file: name,
      format,
      url: got.url,
      ...(got.apiUrl ? { apiUrl: got.apiUrl } : {}),
      retrievedAt: (options.now?.() ?? new Date()).toISOString(),
      sha256: sha256(got.bytes),
      sizeBytes: got.bytes.length,
      sourceVersion: got.version,
      sourceVersionKind: got.kind,
      details: got.details,
      license: LICENSES[spec.source],
      moldeskVersion: VERSION,
    };
    fs.mkdirSync(dir, { recursive: true });
    // The file first, then the sidecar that makes it count as cached: a crash in between is just a cache miss.
    writeAtomic(path.join(dir, name), got.bytes);
    writeAtomic(path.join(dir, `${name}.provenance.json`), `${JSON.stringify(provenance, null, 2)}\n`);
    bytesLength = got.bytes.length;
  }

  if (spec.source === "afdb") {
    warnings.push({ code: "PREDICTED_STRUCTURE", message: "This is an AlphaFold DB prediction, not an experimental structure. CC-BY 4.0: cite it when you use it." });
  }
  let files: FetchedFile[] = [{ name, format, path: path.join(dir, name), sha256: provenance.sha256, sizeBytes: bytesLength }];
  if (options.outputDir !== undefined) files = copyOut(files, dir, options.outputDir);

  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    kind: "moldesk.fetch",
    status: "ok",
    result: { source: spec.source, id: spec.id, format, fromCache: cached !== undefined, cacheDir: dir, files, provenance },
    warnings,
    provenance: { moldeskVersion: VERSION },
  };
}
