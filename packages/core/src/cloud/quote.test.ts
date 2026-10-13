import { describe, expect, it } from "vitest";
import type { CloudCatalog } from "@moldesk/runtime";
import { parseManifest, type ModelManifestV1 } from "@moldesk/registry";
import { assertApprovalValid, buildQuote, type QuoteInputs } from "./quote.js";

const DIGEST = "a".repeat(64);

function manifest(): ModelManifestV1 {
  return parseManifest(
    {
      schemaVersion: 1,
      name: "test-model",
      displayName: "Test",
      modelVersion: "1.0.0",
      adapterVersion: "0.1.0",
      description: "t",
      category: "other",
      status: "planned",
      runtimes: [{ kind: "python", python: "3.11", installer: "uv", platforms: ["linux-x64"], requirements: [{ name: "torch" }] }],
      hardware: { platforms: ["linux-x64"] },
      input: { formats: [".pdb"], required: true },
      outputs: [{ id: "o", glob: "*.fa", required: true }],
      cloud: {
        schemaVersion: 1,
        platform: "linux-x64",
        images: { gpu: `registry.example/w/gpu@sha256:${DIGEST}`, cpu: `registry.example/w/cpu@sha256:${DIGEST}` },
        minVramGb: 24,
        minRamGb: 32,
        ephemeralDiskGb: 40,
        volumeGb: 40,
        assetLayoutRevision: "1",
        cpuAssetPreparation: true,
      },
    },
    "x/manifest.yaml",
  );
}

function catalog(): CloudCatalog {
  return {
    retrievedAt: "2026-10-13T12:00:00.000Z",
    gpus: [
      { id: "small", name: "Small", memoryGb: 16, priceUsdPerHour: 0.2, availability: "HIGH", dataCenters: [{ id: "DC-A", availability: "HIGH" }], cudaVersions: [] },
      { id: "a40", name: "A40", memoryGb: 48, priceUsdPerHour: 0.6, availability: "LOW", dataCenters: [{ id: "DC-NOVOL", availability: "LOW" }, { id: "DC-VOL", availability: "LOW" }], cudaVersions: [] },
      { id: "a5000", name: "A5000", memoryGb: 24, priceUsdPerHour: 0.3, availability: "NONE", dataCenters: [{ id: "DC-VOL", availability: "NONE" }], cudaVersions: [] },
      { id: "l40", name: "L40", memoryGb: 48, priceUsdPerHour: 0.9, availability: "MEDIUM", dataCenters: [{ id: "DC-VOL", availability: "MEDIUM" }], cudaVersions: [] },
    ],
    cpus: [{ id: "cpu3c", name: "c", priceUsdPerVcpuHour: 0.03, ramGbPerVcpu: 2, minVcpu: 2, maxVcpu: 32 }],
    dataCenters: [
      { id: "DC-NOVOL", region: "EU", networkVolumeTypes: [] },
      { id: "DC-VOL", region: "EU", networkVolumeTypes: ["STANDARD"] },
      { id: "DC-A", region: "EU", networkVolumeTypes: ["STANDARD"] },
    ],
  };
}

function inputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
  const m = manifest();
  return {
    provider: "runpod",
    manifest: m,
    cloud: m.cloud!,
    catalog: catalog(),
    cachePolicy: "ephemeral",
    maxBudgetUsd: 5,
    maxLifetimeSeconds: 3600,
    inputs: [{ role: "job", sha256: "b".repeat(64), sizeBytes: 100 }],
    ...overrides,
  };
}

describe("buildQuote", () => {
  it("picks the cheapest GPU that meets VRAM and has capacity, skipping unavailable ones", () => {
    const quote = buildQuote(inputs());
    expect(quote.gpu.id).toBe("a40");
    expect(quote.datacenterId).toBe("DC-NOVOL");
    expect(quote.cost.worstCaseComputeUsd).toBe(0.6);
    expect(quote.timing).toEqual({ preparation: null, inference: null, transfer: null });
    expect(quote.cost.storage).toEqual({ recurring: false, usdPerMonth: null });
    expect(quote.cpu).toBeUndefined();
  });

  it("persistent policy needs a volume-capable datacenter, adds the CPU preparer and discloses recurring storage", () => {
    const quote = buildQuote(inputs({ cachePolicy: "persistent" }));
    expect(quote.datacenterId).toBe("DC-VOL");
    expect(quote.cpu).toEqual({ id: "cpu3c", vcpuCount: 2, priceUsdPerHour: 0.06 });
    expect(quote.cost.worstCaseComputeUsd).toBe(0.66);
    expect(quote.cost.storage.recurring).toBe(true);
    expect(quote.disclosures.join(" ")).toMatch(/billed until you delete/);
  });

  it("pins persistent runs to an existing volume's datacenter or fails with capacity guidance", () => {
    expect(buildQuote(inputs({ cachePolicy: "persistent", existingVolumeDatacenterId: "DC-VOL" })).datacenterId).toBe("DC-VOL");
    expect(() => buildQuote(inputs({ cachePolicy: "persistent", existingVolumeDatacenterId: "DC-A" }))).toThrow(/No eligible GPU/);
  });

  it("validates an explicit GPU instead of silently replacing it", () => {
    expect(() => buildQuote(inputs({ gpuId: "nope" }))).toThrow(/not in the provider catalog/);
    expect(() => buildQuote(inputs({ gpuId: "small" }))).toThrow(/needs at least 24 GB/);
    expect(() => buildQuote(inputs({ gpuId: "a5000" }))).toThrow(/No eligible GPU/);
    expect(buildQuote(inputs({ gpuId: "l40" })).gpu.id).toBe("l40");
    expect(() => buildQuote(inputs({ gpuId: "a40", datacenterId: "DC-ELSEWHERE" }))).toThrow(/No eligible GPU/);
  });

  it("rejects over-budget quotes before anything is provisioned", () => {
    expect(() => buildQuote(inputs({ maxBudgetUsd: 0.5 }))).toThrow(expect.objectContaining({ code: "CLOUD_BUDGET_EXCEEDED" }));
    expect(() => buildQuote(inputs({ maxBudgetUsd: 0 }))).toThrow(expect.objectContaining({ code: "CLOUD_BUDGET_REQUIRED" }));
    expect(() => buildQuote(inputs({ maxLifetimeSeconds: 0 }))).toThrow(expect.objectContaining({ code: "CLOUD_LIFETIME_REQUIRED" }));
    expect(buildQuote(inputs({ maxBudgetUsd: 0.3, maxLifetimeSeconds: 1800 })).cost.worstCaseComputeUsd).toBe(0.3);
  });

  it("derives a stable id bound to inputs, policy, location and limits but not to price", () => {
    const base = buildQuote(inputs());
    expect(buildQuote(inputs()).id).toBe(base.id);
    const cheaper = catalog();
    cheaper.gpus[1]!.priceUsdPerHour = 0.5;
    expect(buildQuote(inputs({ catalog: cheaper })).id).toBe(base.id);
    expect(buildQuote(inputs({ inputs: [{ role: "job", sha256: "c".repeat(64), sizeBytes: 100 }] })).id).not.toBe(base.id);
    expect(buildQuote(inputs({ cachePolicy: "persistent" })).id).not.toBe(base.id);
    expect(buildQuote(inputs({ maxLifetimeSeconds: 1800 })).id).not.toBe(base.id);
    expect(buildQuote(inputs({ gpuId: "l40" })).id).not.toBe(base.id);
  });
});

describe("assertApprovalValid", () => {
  const now = new Date("2026-10-13T12:05:00.000Z");
  const approval = (quote: { id: string }, approvedAt = "2026-10-13T12:00:00.000Z") => ({ quoteId: quote.id, approvedAt });

  it("accepts a matching, fresh approval", () => {
    const quote = buildQuote(inputs());
    expect(() => assertApprovalValid(quote, approval(quote), buildQuote(inputs()), now)).not.toThrow();
  });

  it("rejects mismatched, expired and future-dated approvals", () => {
    const quote = buildQuote(inputs());
    expect(() => assertApprovalValid(quote, { quoteId: "other", approvedAt: "2026-10-13T12:00:00.000Z" }, quote, now)).toThrow(expect.objectContaining({ code: "CLOUD_APPROVAL_MISMATCH" }));
    expect(() => assertApprovalValid(quote, approval(quote, "2026-10-13T11:00:00.000Z"), quote, now)).toThrow(expect.objectContaining({ code: "CLOUD_APPROVAL_EXPIRED" }));
    expect(() => assertApprovalValid(quote, approval(quote, "2026-10-13T13:00:00.000Z"), quote, now)).toThrow(expect.objectContaining({ code: "CLOUD_APPROVAL_EXPIRED" }));
    expect(() => assertApprovalValid(quote, approval(quote, "garbage"), quote, now)).toThrow(expect.objectContaining({ code: "CLOUD_APPROVAL_EXPIRED" }));
  });

  it("requires a new approval when location, inputs or a material price change since", () => {
    const quote = buildQuote(inputs());
    const moved = catalog();
    moved.gpus[1]!.dataCenters = [{ id: "DC-VOL", availability: "LOW" }];
    moved.dataCenters = moved.dataCenters.filter((dc) => dc.id !== "DC-NOVOL");
    expect(() => assertApprovalValid(quote, approval(quote), buildQuote(inputs({ catalog: moved })), now)).toThrow(expect.objectContaining({ code: "CLOUD_REQUOTE_REQUIRED" }));

    const pricier = catalog();
    pricier.gpus[1]!.priceUsdPerHour = 0.7;
    const fresh = buildQuote(inputs({ catalog: pricier }));
    expect(fresh.id).toBe(quote.id);
    expect(() => assertApprovalValid(quote, approval(quote), fresh, now)).toThrow(/price rose/);

    const slightly = catalog();
    slightly.gpus[1]!.priceUsdPerHour = 0.63;
    expect(() => assertApprovalValid(quote, approval(quote), buildQuote(inputs({ catalog: slightly })), now)).not.toThrow();
  });
});
