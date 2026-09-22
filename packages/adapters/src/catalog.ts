import type { ModelAdapterDefinition } from "./index.js";
import type { ModelManifestV1 } from "@moldesk/registry";
import { proteinmpnnAdapter } from "./proteinmpnn/index.js";
import { ligandmpnnAdapter } from "./ligandmpnn/index.js";
import { boltzAdapter } from "./boltz/index.js";

export const adapterCatalog: Record<string, ModelAdapterDefinition> = {
  proteinmpnn: proteinmpnnAdapter,
  ligandmpnn: ligandmpnnAdapter,
  boltz: boltzAdapter,
};

export function getAdapter(modelName: string): ModelAdapterDefinition | undefined {
  return adapterCatalog[modelName];
}

export function hasAdapter(modelName: string): boolean {
  return modelName in adapterCatalog;
}

export function validateAdapterCatalog(
  manifests: ReadonlyArray<Pick<ModelManifestV1, "name" | "status">>,
  catalog: Record<string, ModelAdapterDefinition> = adapterCatalog,
): string[] {
  const manifestsByName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const errors: string[] = [];

  for (const manifest of manifests) {
    if (manifest.status === "available" && !(manifest.name in catalog)) {
      errors.push(`Available model "${manifest.name}" has no compiled adapter registration.`);
    }
  }
  for (const [name, adapter] of Object.entries(catalog)) {
    if (!manifestsByName.has(name)) errors.push(`Adapter "${name}" has no registry manifest.`);
    if (adapter.modelName !== name) {
      errors.push(`Adapter catalog key "${name}" does not match adapter.modelName "${adapter.modelName}".`);
    }
  }

  return errors;
}
