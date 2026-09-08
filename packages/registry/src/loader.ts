import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { MoldeskError } from "./errors.js";
import { modelManifestV1Schema, type ModelManifestV1 } from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function packagedModelsDir(): string {
  return path.resolve(__dirname, "models");
}

function sourceModelsDir(): string {
  // packages/registry/src -> repo root -> models (dev fallback only)
  return path.resolve(__dirname, "../../../models");
}

function resolveModelsDir(): string {
  const override = process.env["MOLDESK_MODELS_DIR"];
  if (override && fs.existsSync(override)) return override;
  if (fs.existsSync(packagedModelsDir())) return packagedModelsDir();
  if (fs.existsSync(sourceModelsDir())) return sourceModelsDir();
  throw new MoldeskError({
    code: "REGISTRY_NOT_FOUND",
    message: "MoleculeDesk model registry is missing from this installation.",
    remediation: "Reinstall @moldesk/cli. Package maintainers should verify that @moldesk/registry includes dist/models.",
    details: { packagedModelsDir: packagedModelsDir(), sourceModelsDir: sourceModelsDir() },
  });
}

function toMoldeskError(manifestPath: string, error: unknown): MoldeskError {
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    const field = first && first.path.length > 0 ? first.path.join(".") : "(root)";
    return new MoldeskError({
      code: "INVALID_MANIFEST",
      message: `Invalid manifest ${manifestPath}: ${field}: ${first?.message ?? "validation failed"}`,
      remediation: "Fix the manifest field and re-run the registry build. See docs/v0.1-implementation-spec.md Step 1.",
      details: { manifestPath, field, issues: error.issues },
    });
  }
  return new MoldeskError({
    code: "INVALID_MANIFEST",
    message: `Invalid manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    remediation: "Ensure the file is valid YAML matching ModelManifestV1.",
    details: { manifestPath },
    cause: error,
  });
}

export function parseManifest(raw: unknown, manifestPath: string): ModelManifestV1 {
  if (typeof raw !== "object" || raw === null) {
    throw new MoldeskError({
      code: "INVALID_MANIFEST",
      message: `Invalid manifest ${manifestPath}: root must be a mapping`,
      remediation: "Ensure the manifest is a YAML mapping with schemaVersion: 1.",
      details: { manifestPath },
    });
  }
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== 1) {
    throw new MoldeskError({
      code: "UNKNOWN_SCHEMA_VERSION",
      message: `Unknown schema version in ${manifestPath}: ${String(record["schemaVersion"])}`,
      remediation: "Set schemaVersion: 1. Only v1 manifests are supported in v0.1.",
      details: { manifestPath, schemaVersion: record["schemaVersion"] },
    });
  }
  if ("version" in record && !("modelVersion" in record)) {
    throw new MoldeskError({
      code: "INVALID_MANIFEST",
      message: `Invalid manifest ${manifestPath}: ambiguous top-level "version" field; use modelVersion + adapterVersion`,
      remediation: "Rename version to modelVersion and add adapterVersion.",
      details: { manifestPath, field: "version" },
    });
  }
  try {
    return modelManifestV1Schema.parse(raw);
  } catch (error) {
    throw toMoldeskError(manifestPath, error);
  }
}

export function loadManifestFile(manifestPath: string): ModelManifestV1 {
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    throw new MoldeskError({
      code: "INVALID_MANIFEST",
      message: `Invalid manifest ${manifestPath}: YAML parse failed`,
      remediation: "Fix YAML syntax.",
      details: { manifestPath },
      cause: error,
    });
  }
  return parseManifest(raw, manifestPath);
}

export function listAvailableModels(modelsDir?: string): ModelManifestV1[] {
  const dir = modelsDir ?? resolveModelsDir();
  if (!fs.existsSync(dir)) return [];
  const manifests: ModelManifestV1[] = [];
  const seen = new Set<string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(dir, entry.name, "manifest.yaml");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = loadManifestFile(manifestPath);
    if (seen.has(manifest.name)) {
      throw new MoldeskError({
        code: "DUPLICATE_MODEL_ID",
        message: `Duplicate model id "${manifest.name}" in ${manifestPath}`,
        remediation: "Rename one model so every manifest name is unique.",
        details: { manifestPath, name: manifest.name },
      });
    }
    seen.add(manifest.name);
    manifests.push(manifest);
  }
  manifests.sort((a, b) => a.name.localeCompare(b.name));
  return manifests;
}

export function listInstalledModels(): ModelManifestV1[] {
  // No models are installed yet — installation support lands with `moldesk install` (Step 3).
  return [];
}

export function getModelsDir(): string {
  return resolveModelsDir();
}
