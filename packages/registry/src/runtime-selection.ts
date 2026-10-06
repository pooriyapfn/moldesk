import { MoldeskError } from "./errors.js";
import type { ModelManifestV1, PlatformId, PythonRuntimeSpec, RuntimeSpec, SourceSpec } from "./schema.js";

/**
 * Maps the running process's OS/arch to a manifest `PlatformId`. Returns `undefined`
 * for any host outside the two platforms MoleculeDesk v0.1 supports — callers must
 * treat that as "no platform id", not throw here, since a legacy runtime entry with
 * no `platforms` field must still resolve on hosts outside this enum (matching the
 * pre-existing behavior of installs that never checked platform at all).
 */
export function detectHostPlatformId(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformId | undefined {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return undefined;
}

/**
 * Resolves exactly one python runtime entry from `runtimes` for the given host
 * platform. An entry with no `platforms` field matches every platform (legacy,
 * single-runtime manifests such as ProteinMPNN/LigandMPNN); an entry with a
 * `platforms` field matches only when it includes `platform`.
 *
 * Fails closed:
 * - zero matches -> `RUNTIME_PLATFORM_UNSUPPORTED`
 * - more than one match -> `RUNTIME_SELECTION_AMBIGUOUS` (a manifest-authoring bug —
 *   two runtime entries must never both claim the same host platform).
 */
export function selectPythonRuntime(
  runtimes: readonly RuntimeSpec[],
  platform: PlatformId | undefined,
): PythonRuntimeSpec {
  const pythonRuntimes = runtimes.filter((r): r is PythonRuntimeSpec => r.kind === "python");
  const matches = pythonRuntimes.filter(
    (r) => r.platforms === undefined || (platform !== undefined && r.platforms.includes(platform)),
  );

  if (matches.length === 0) {
    throw new MoldeskError({
      code: "RUNTIME_PLATFORM_UNSUPPORTED",
      message: platform
        ? `No python runtime entry supports platform ${platform}.`
        : "No python runtime entry supports this host platform.",
      remediation: "Run on darwin-arm64 or linux-x64, or pick a model whose runtimes[] declares this platform.",
      details: { platform, candidateCount: pythonRuntimes.length },
    });
  }
  if (matches.length > 1) {
    throw new MoldeskError({
      code: "RUNTIME_SELECTION_AMBIGUOUS",
      message: `${matches.length} python runtime entries match platform ${platform ?? "this host"}; a manifest must declare at most one match per platform.`,
      remediation: "Fix the manifest so no two runtime entries' `platforms` (or absence thereof) overlap for the same host platform.",
      details: { platform, matchCount: matches.length },
    });
  }
  return matches[0]!;
}

/** The effective source for an already-selected python runtime entry: its own
 * per-entry override when present, otherwise the manifest-level `source`. */
export function effectiveRuntimeSource(
  manifest: Pick<ModelManifestV1, "source">,
  runtime: Pick<PythonRuntimeSpec, "source">,
): SourceSpec | undefined {
  return runtime.source ?? manifest.source;
}
