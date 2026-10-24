import { getAdapter, type ParamDescriptor } from "@moldesk/adapters";
import { getMoldeskPaths, getSystemReport, type MoldeskPaths, type SystemReport } from "@moldesk/runtime";
import { listAvailableModels, type ModelManifestV1, type PlatformId, type RuntimeKind, type RuntimeSpec } from "@moldesk/registry";
import { evaluateCompatibility, shortReason, type CompatibilityResult } from "../compatibility.js";
import { MoldeskError } from "../errors.js";
import { listInstalledModels } from "../install-state.js";
import { ENVELOPE_SCHEMA_VERSION, type AnalysisEnvelope } from "../schemas/envelope.js";
import { VERSION } from "../version.js";

type Value = string | number | boolean;

export interface ModelParameter {
  name: string;
  type: ParamDescriptor["type"];
  required: boolean;
  /** Static default. Some models choose a default per platform instead; see `defaultsByPlatform`. */
  default?: Value;
  /** Defaults the adapter picks for the platform a runtime was installed for (e.g. Boltz's `accelerator`). */
  defaultsByPlatform?: Record<string, Value>;
  min?: number;
  max?: number;
  enum?: Array<string | number>;
  description?: string;
}

export interface ModelDescription {
  name: string;
  displayName: string;
  modelVersion: string;
  adapterVersion: string;
  description: string;
  category: string;
  status: ModelManifestV1["status"];
  license?: string;
  homepage?: string;
  source?: { repository: string; revision: string };
  capabilities: { category: string; installable: boolean; installed: boolean; cloud: boolean };
  input: { formats: string[]; required: boolean };
  outputs: Array<{ id: string; glob: string; required: boolean }>;
  /** Exactly the `--param` names `moldesk run` accepts. */
  parameters: ModelParameter[];
  runtimes: Array<Record<string, unknown>>;
  hardware: ModelManifestV1["hardware"];
  assets: Array<{ id: string; url: string; sizeBytes?: number; license?: string; source?: string }>;
  /** Verdict for the machine this ran on, from the same logic as `moldesk list` and `moldesk install`. */
  compatibility: CompatibilityResult;
  verdict: string;
  cloud:
    | { available: false }
    | { available: true; provider: "runpod"; platform: string; minVramGb: number; minRamGb: number; gpuAllowList?: string[]; ephemeralDiskGb: number; volumeGb: number; cpuAssetPreparation: boolean };
  adapterVerification?: { lastVerifiedAt: string; platforms: string[]; notes?: string };
}

export interface DescribeOptions {
  /** Test seam: a machine profile; defaults to probing this machine. */
  report?: SystemReport;
  /** Only judge this runtime, like `moldesk list --runtime`. */
  requestedRuntime?: RuntimeKind;
  paths?: MoldeskPaths;
  modelsDir?: string;
}

const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** Platforms a manifest's runtimes are built for, used to show the adapter's per-platform defaults. */
function manifestPlatforms(manifest: ModelManifestV1): PlatformId[] {
  const fromRuntimes = manifest.runtimes.flatMap((r) => (r.kind === "python" ? (r.platforms ?? []) : []));
  return [...new Set(fromRuntimes.length > 0 ? fromRuntimes : (manifest.hardware.platforms ?? []))];
}

function describeParameters(manifest: ModelManifestV1): ModelParameter[] {
  const adapter = getAdapter(manifest.name);
  const platforms = manifestPlatforms(manifest);
  const perPlatform = new Map<string, Record<string, Value>>();
  for (const platform of platforms) {
    const defaults = adapter?.resolveParamDefaults?.({
      manifestName: manifest.name,
      installed: { runtime: { kind: "python", python: { platform, platformSelected: true } } },
    });
    for (const [key, value] of Object.entries(defaults ?? {})) {
      perPlatform.set(key, { ...(perPlatform.get(key) ?? {}), [platform]: value as Value });
    }
  }
  return (adapter?.params ?? []).map((p) =>
    compact({
      name: p.name,
      type: p.type,
      required: p.required === true,
      default: p.default,
      defaultsByPlatform: perPlatform.get(p.name),
      min: p.min,
      max: p.max,
      enum: p.enum,
      description: p.description,
    }),
  );
}

function describeRuntime(runtime: RuntimeSpec): Record<string, unknown> {
  if (runtime.kind === "docker") {
    return compact({ kind: runtime.kind, image: runtime.image, digest: runtime.digest, gpu: runtime.gpu, estimatedDownloadBytes: runtime.estimatedDownloadBytes, estimatedDiskBytes: runtime.estimatedDiskBytes });
  }
  return compact({
    kind: runtime.kind,
    platforms: runtime.platforms,
    python: runtime.python,
    installer: runtime.installer,
    nvidiaGpu: runtime.nvidiaGpu,
    cuda: runtime.cuda,
    minVramGb: runtime.minVramGb,
    estimatedDownloadBytes: runtime.estimatedDownloadBytes,
    estimatedDiskBytes: runtime.estimatedDiskBytes,
  });
}

/** One self-describing document for a model, as a `moldesk.model` envelope. */
export async function describeModel(name: string, options: DescribeOptions = {}): Promise<AnalysisEnvelope<ModelDescription>> {
  const manifest = listAvailableModels(options.modelsDir).find((m) => m.name === name);
  if (!manifest) {
    throw new MoldeskError({ code: "UNKNOWN_MODEL", message: `Unknown model "${name.slice(0, 80)}".`, remediation: "Run `moldesk list` to see the available models." });
  }
  const report = options.report ?? (await getSystemReport());
  const compatibility = evaluateCompatibility(manifest, report, { requestedRuntime: options.requestedRuntime });
  const installed = listInstalledModels(options.paths ?? getMoldeskPaths()).some((m) => m.model === manifest.name && m.status === "ready");
  const hasAdapter = getAdapter(manifest.name) !== undefined;
  const verdict =
    compatibility.status === "compatible"
      ? "compatible"
      : compatibility.status === "warning"
        ? `warning: ${shortReason(compatibility)}`
        : manifest.status === "planned"
          ? "not installable"
          : `unsupported: ${shortReason(compatibility)}`;

  const description: ModelDescription = {
    name: manifest.name,
    displayName: manifest.displayName,
    modelVersion: manifest.modelVersion,
    adapterVersion: manifest.adapterVersion,
    description: manifest.description,
    category: manifest.category,
    status: manifest.status,
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    ...(manifest.source ? { source: { repository: manifest.source.repository, revision: manifest.source.revision } } : {}),
    capabilities: { category: manifest.category, installable: manifest.status !== "planned" && hasAdapter, installed, cloud: manifest.cloud !== undefined },
    input: { formats: manifest.input.formats, required: manifest.input.required },
    outputs: manifest.outputs.map((o) => ({ id: o.id, glob: o.glob, required: o.required })),
    parameters: describeParameters(manifest),
    runtimes: manifest.runtimes.map(describeRuntime),
    hardware: manifest.hardware,
    assets: (manifest.assets ?? []).map((a) => compact({ id: a.id, url: a.url, sizeBytes: a.sizeBytes, license: a.license, source: a.source })),
    compatibility,
    verdict,
    cloud: manifest.cloud
      ? compact({
          available: true as const,
          provider: "runpod" as const,
          platform: manifest.cloud.platform,
          minVramGb: manifest.cloud.minVramGb,
          minRamGb: manifest.cloud.minRamGb,
          gpuAllowList: manifest.cloud.gpuAllowList,
          ephemeralDiskGb: manifest.cloud.ephemeralDiskGb,
          volumeGb: manifest.cloud.volumeGb,
          cpuAssetPreparation: manifest.cloud.cpuAssetPreparation,
        })
      : { available: false },
    ...(manifest.adapterVerification ? { adapterVerification: compact({ lastVerifiedAt: manifest.adapterVerification.lastVerifiedAt, platforms: manifest.adapterVerification.platforms, notes: manifest.adapterVerification.notes }) } : {}),
  };
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    kind: "moldesk.model",
    status: "ok",
    result: description,
    warnings: [],
    provenance: { moldeskVersion: VERSION },
  };
}
