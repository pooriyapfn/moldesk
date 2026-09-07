import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export interface ModelManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  homepage?: string;
  license?: string;
  compatibility?: {
    cpu?: boolean;
    gpu?: "required" | "recommended" | "unsupported";
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function repoModelsDir(): string {
  // packages/registry/src -> repo root -> models
  return path.resolve(__dirname, "../../../models");
}

export function listAvailableModels(): ModelManifest[] {
  const modelsDir = repoModelsDir();
  if (!fs.existsSync(modelsDir)) return [];

  return fs
    .readdirSync(modelsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = path.join(modelsDir, entry.name, "manifest.yaml");
      if (!fs.existsSync(manifestPath)) return null;
      const raw = fs.readFileSync(manifestPath, "utf-8");
      return YAML.parse(raw) as ModelManifest;
    })
    .filter((manifest): manifest is ModelManifest => manifest !== null);
}

export function listInstalledModels(): ModelManifest[] {
  // No models are installed yet — installation support lands with `moldesk install`.
  return [];
}
