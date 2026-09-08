import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MoldeskError } from "@moldesk/registry";
import { adapterCatalog, getAdapter, validateAdapterCatalog } from "./catalog.js";

describe("adapterCatalog", () => {
  it("matches source model directories without a hard-coded name list", () => {
    const modelsDir = fileURLToPath(new URL("../../../models", import.meta.url));
    const manifestNames = fs
      .readdirSync(modelsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(modelsDir, entry.name, "manifest.yaml")))
      .map((entry) => entry.name)
      .sort();
    const adapterNames = Object.keys(adapterCatalog).sort();

    expect(adapterNames).toEqual(manifestNames);
    for (const [name, adapter] of Object.entries(adapterCatalog)) expect(adapter.modelName).toBe(name);
  });

  it("has unique model names", () => {
    const names = Object.keys(adapterCatalog);
    expect(new Set(names).size).toBe(names.length);
  });

  it("rejects an available manifest without a compiled adapter", () => {
    const errors = validateAdapterCatalog([{ name: "missing-model", status: "available" }], {});
    expect(errors).toEqual([expect.stringContaining("missing-model")]);
  });

  it("makes planned adapters fail closed", async () => {
    const context = { manifestName: "proteinmpnn", modelDir: "/model", assetsDir: "/assets" };
    const adapter = getAdapter("proteinmpnn");
    expect(adapter).toBeDefined();
    await expect(adapter!.verifyInstallation(context)).rejects.toBeInstanceOf(MoldeskError);
  });
});
