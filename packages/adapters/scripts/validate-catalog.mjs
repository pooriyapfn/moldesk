import { adapterCatalog, validateAdapterCatalog } from "../dist/catalog.js";
import { listAvailableModels } from "@moldesk/registry";

const manifests = listAvailableModels();
const errors = validateAdapterCatalog(manifests);

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(`Adapter catalog: ${Object.keys(adapterCatalog).length} adapter(s) validated against ${manifests.length} manifest(s).`);
