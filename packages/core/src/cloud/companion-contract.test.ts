import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getAdapter } from "@moldesk/adapters";
import { parseManifest } from "@moldesk/registry";
import type { CloudProvider } from "@moldesk/runtime";
import { planCloudRun } from "./run.js";
import { companionInputsFromJob } from "./worker/pipeline.js";

/**
 * A safety net for every model whose job file references other files: the cloud must hand the adapter exactly
 * the ids it declared, from files that really arrived, without reading the originals on the user's computer.
 * A new model with companion files is covered by adding its example job here.
 */
const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const CASES: Array<{ model: string; job: string }> = [
  { model: "diffdock", job: "diffdock/job.json" },
  { model: "bindcraft2", job: "bindcraft2/campaign.json" },
  { model: "opendde", job: "opendde/ligand-file.json" },
  { model: "opendde", job: "opendde/tiny.json" }, // self-contained: no extra files, so no upload warning
  { model: "rfd4-proteina", job: "rfd4-proteina/monomer.yaml" },
];

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeCloudManifest(name: string) {
  const digest = "a".repeat(64);
  return parseManifest(
    {
      schemaVersion: 1,
      name,
      displayName: name,
      modelVersion: "1.0.0",
      adapterVersion: "0.1.0",
      description: "t",
      category: "other",
      status: "planned",
      runtimes: [{ kind: "python", python: "3.11", installer: "uv", platforms: ["linux-x64"], requirements: [{ name: "torch" }] }],
      hardware: { platforms: ["linux-x64"] },
      input: { formats: [".json", ".txt"], required: true },
      outputs: [{ id: "o", glob: "*.out", required: false }],
      cloud: {
        schemaVersion: 1,
        platform: "linux-x64",
        images: { gpu: `r.example/g@sha256:${digest}`, cpu: `r.example/c@sha256:${digest}` },
        minVramGb: 16,
        minRamGb: 16,
        ephemeralDiskGb: 40,
        volumeGb: 40,
        assetLayoutRevision: "1",
        cpuAssetPreparation: true,
      },
    },
    "x/manifest.yaml",
  );
}

const provider = {
  name: "runpod",
  getCatalog: async () => ({
    retrievedAt: "2026-10-16T12:00:00.000Z",
    gpus: [{ id: "a40", name: "A40", memoryGb: 48, priceUsdPerHour: 0.6, availability: "HIGH", dataCenters: [{ id: "DC-1", availability: "HIGH" }], cudaVersions: [] }],
    cpus: [],
    dataCenters: [{ id: "DC-1", region: "EU", networkVolumeTypes: [] }],
  }),
} as unknown as CloudProvider;

describe.each(CASES)("cloud file handling for $model ($job)", ({ model, job }) => {
  it("plans the files the adapter declares, and the worker maps them back to the same ids without the originals", async () => {
    const adapter = getAdapter(model)!;
    const source = path.join(examples, path.dirname(job));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk contract "));
    temporary.push(work);
    const local = path.join(work, "local");
    fs.cpSync(source, local, { recursive: true });
    const jobPath = path.join(local, path.basename(job));

    const declared = (await adapter.resolveCompanionInputs?.(jobPath)) ?? [];
    const plan = await planCloudRun(
      model,
      jobPath,
      { cloud: { cachePolicy: "ephemeral", maxBudgetUsd: 5, maxLifetimeSeconds: 3600 } },
      { provider, resolveModel: () => ({ manifest: fakeCloudManifest(model), adapter }) },
    );
    expect(plan.companions.map((file) => file.id)).toEqual(declared.map((ref) => ref.id));
    expect(plan.quote.warnings.some((warning) => warning.id === "upload-files")).toBe(declared.length > 0);

    // What the client sends and the worker receives: `input/<id>/<name>`.
    const workerInput = path.join(work, "worker", "input");
    fs.mkdirSync(workerInput, { recursive: true });
    fs.copyFileSync(jobPath, path.join(workerInput, path.basename(jobPath)));
    const wire = [{ role: "job", relativePath: path.basename(jobPath) }];
    for (const file of plan.companions) {
      const relativePath = `${file.id}/${file.fileName}`;
      fs.mkdirSync(path.join(workerInput, file.id), { recursive: true });
      fs.copyFileSync(file.sourcePath, path.join(workerInput, relativePath));
      wire.push({ role: file.id, relativePath });
    }
    const mapped = companionInputsFromJob(wire, workerInput);
    expect(mapped.map((entry) => entry.id)).toEqual(declared.map((ref) => ref.id));

    // The adapter must not depend on the user's originals once the files arrived.
    fs.rmSync(local, { recursive: true, force: true });
    for (const entry of mapped) expect(fs.statSync(entry.path).isFile()).toBe(true);
  });
});
