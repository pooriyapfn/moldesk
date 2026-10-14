import { describe, expect, it } from "vitest";
import type { CloudCatalog } from "@moldesk/runtime";
import { parseManifest, type ModelManifestV1 } from "@moldesk/registry";
import { LIFETIME_RISK_WARNING, STORAGE_CHARGES_WARNING, assertApprovalValid, buildQuote, type QuoteInputs } from "./quote.js";
import type { CloudCatalog as Catalog } from "@moldesk/runtime";

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
    // Compute is costed at the top of the default price range (twice the cheapest eligible GPU).
    expect(quote.gpuRange).toMatchObject({ minVramGb: 24, maxUsdPerHour: 1.2, pinnedGpuId: null, lockDatacenter: false });
    expect(quote.cost.worstCaseComputeUsd).toBe(1.2);
    expect(quote.timing).toEqual({ preparation: null, inference: null, transfer: null });
    expect(quote.cost.recurringStorage).toEqual({ recurring: false, volumeGb: null, usdPerMonth: null });
    expect(quote.cpu).toBeUndefined();
  });

  it("persistent policy needs a volume-capable datacenter, adds the CPU preparer and discloses recurring storage", () => {
    const quote = buildQuote(inputs({ cachePolicy: "persistent" }));
    expect(quote.datacenterId).toBe("DC-VOL");
    expect(quote.cpu).toEqual({ id: "cpu3c", vcpuCount: 2, priceUsdPerHour: 0.06 });
    expect(quote.cost.worstCaseComputeUsd).toBe(1.26);
    expect(quote.gpuRange.lockDatacenter).toBe(true);
    expect(quote.gpuRange.candidates.every((c) => c.datacenterIds.every((id) => id === "DC-VOL"))).toBe(true);
    expect(quote.cost.recurringStorage).toEqual({ recurring: true, volumeGb: 40, usdPerMonth: null });
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
    // The budget caps the GPU price range, so the worst case holds whichever GPU is obtained.
    const capped = buildQuote(inputs({ maxBudgetUsd: 0.7 }));
    expect(capped.gpuRange.maxUsdPerHour).toBe(0.7);
    expect(capped.gpuRange.candidates.map((c) => c.id)).toEqual(["a40"]);
    expect(capped.cost.worstCaseBudgetedUsd).toBeLessThanOrEqual(0.7);
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
    expect(buildQuote(inputs({ maxGpuUsdPerHour: 1 })).id).not.toBe(base.id);
  });

  it("offers every available GPU in the price range, cheapest first, and never one over it", () => {
    const quote = buildQuote(inputs({ maxGpuUsdPerHour: 0.95 }));
    expect(quote.gpuRange.candidates.map((c) => [c.id, c.priceUsdPerHour, c.datacenterIds])).toEqual([
      ["a40", 0.6, ["DC-NOVOL", "DC-VOL"]],
      ["l40", 0.9, ["DC-VOL"]],
    ]);
    expect(buildQuote(inputs({ maxGpuUsdPerHour: 0.7 })).gpuRange.candidates.map((c) => c.id)).toEqual(["a40"]);
    expect(() => buildQuote(inputs({ maxGpuUsdPerHour: 0.5 }))).toThrow(expect.objectContaining({ code: "CLOUD_GPU_PRICE_RANGE_INVALID" }));
  });

  it("lets the user override the worker images, binds them to the id and discloses unpinned ones", () => {
    const base = buildQuote(inputs());
    expect(base.disclosures.join(" ")).not.toMatch(/Not pinned by digest/);
    const custom = buildQuote(inputs({ gpuImage: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404" }));
    expect(custom.images).toEqual({ gpu: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404", cpu: base.images.cpu });
    expect(custom.id).not.toBe(base.id);
    expect(custom.disclosures.join(" ")).toMatch(/Not pinned by digest.*gpu image runpod\/pytorch:1\.0\.2/);
    expect(() => buildQuote(inputs({ gpuImage: "bad image;rm -rf /" }))).toThrow(expect.objectContaining({ code: "CLOUD_IMAGE_INVALID" }));
  });

  it("substitutes nothing when the user pinned a GPU", () => {
    const quote = buildQuote(inputs({ gpuId: "l40" }));
    expect(quote.gpuRange.pinnedGpuId).toBe("l40");
    expect(quote.gpuRange.candidates.map((c) => c.id)).toEqual(["l40"]);
  });
});

describe("storage costs and budget coverage", () => {
  const withRates = () => ({ ...catalog(), storageRates: { containerDiskUsdPerGbMonth: 0.1, networkVolumeUsdPerGbMonth: 0.07 } });

  it("states storage as unknown, not counted, when the provider publishes no rates", () => {
    const eph = buildQuote(inputs());
    expect(eph.cost.temporaryStorage).toEqual({ diskGb: 40, machines: 1, worstCaseUsd: null });
    expect(eph.cost.worstCaseBudgetedUsd).toBe(eph.cost.worstCaseComputeUsd);
    expect(eph.budgetCoverage.unknown).toEqual(["container disk rate is not published by the provider's catalog API"]);
    expect(eph.budgetCoverage.notCounted.join(" | ")).toMatch(/container disk charges \(40 GB x 1 machine\)/);
    expect(eph.budgetCoverage.notCounted.join(" | ")).toMatch(/network transfer or any other provider fees/);
    expect(eph.budgetCoverage.counted).toHaveLength(1);

    const per = buildQuote(inputs({ cachePolicy: "persistent" }));
    expect(per.cost.temporaryStorage.machines).toBe(2);
    expect(per.budgetCoverage.unknown).toHaveLength(2);
    expect(per.budgetCoverage.notCounted.join(" | ")).toMatch(/retained network volume storage \(40 GB\), billed monthly until deleted(?!:)/);
  });

  it("counts temporary storage in the budget and reports recurring storage separately when rates are published", () => {
    const eph = buildQuote(inputs({ catalog: withRates() }));
    expect(eph.cost.temporaryStorage.worstCaseUsd).toBeCloseTo(40 * 0.1 * (1 / 730), 4);
    expect(eph.cost.worstCaseBudgetedUsd).toBeCloseTo(1.2 + eph.cost.temporaryStorage.worstCaseUsd!, 4);
    expect(eph.budgetCoverage.unknown).toEqual([]);
    expect(eph.budgetCoverage.counted.join(" | ")).toMatch(/container disk/);

    const per = buildQuote(inputs({ cachePolicy: "persistent", catalog: withRates() }));
    expect(per.cost.recurringStorage).toEqual({ recurring: true, volumeGb: 40, usdPerMonth: 2.8 });
    expect(per.budgetCoverage.notCounted.join(" | ")).toMatch(/billed monthly until deleted: about \$2\.8\/month/);
    expect(per.budgetCoverage.unknown).toEqual([]);
    // Recurring storage is disclosed, never silently folded into the one-run budget.
    expect(per.cost.worstCaseBudgetedUsd).toBeCloseTo(per.cost.worstCaseComputeUsd + per.cost.temporaryStorage.worstCaseUsd!, 4);
  });

  it("rejects when known storage pushes the counted worst case over the budget", () => {
    expect(buildQuote(inputs({ maxBudgetUsd: 0.6 })).cost.worstCaseBudgetedUsd).toBe(0.6);
    expect(() => buildQuote(inputs({ maxBudgetUsd: 0.6, catalog: withRates() }))).toThrow(expect.objectContaining({ code: "CLOUD_BUDGET_EXCEEDED" }));
  });

  it("does not change the approval id", () => {
    expect(buildQuote(inputs({ catalog: withRates() })).id).toBe(buildQuote(inputs()).id);
  });
});

describe("assertApprovalValid", () => {
  const now = new Date("2026-10-13T12:05:00.000Z");
  const approval = (quote: { id: string; warnings: Array<{ id: "lifetime-risk" | "storage-charges" }> }, approvedAt = "2026-10-13T12:00:00.000Z") => ({ quoteId: quote.id, approvedAt, acknowledged: quote.warnings.map((w) => w.id) });

  it("accepts a matching, fresh approval", () => {
    const quote = buildQuote(inputs());
    expect(() => assertApprovalValid(quote, approval(quote), buildQuote(inputs()), now)).not.toThrow();
  });

  it("rejects mismatched, expired and future-dated approvals", () => {
    const quote = buildQuote(inputs());
    expect(() => assertApprovalValid(quote, { quoteId: "other", approvedAt: "2026-10-13T12:00:00.000Z", acknowledged: ["lifetime-risk"] }, quote, now)).toThrow(expect.objectContaining({ code: "CLOUD_APPROVAL_MISMATCH" }));
    expect(() => assertApprovalValid(quote, approval(quote, "2026-10-13T11:00:00.000Z"), quote, now)).toThrow(expect.objectContaining({ code: "CLOUD_APPROVAL_EXPIRED" }));
    expect(() => assertApprovalValid(quote, approval(quote, "2026-10-13T13:00:00.000Z"), quote, now)).toThrow(expect.objectContaining({ code: "CLOUD_APPROVAL_EXPIRED" }));
    expect(() => assertApprovalValid(quote, approval(quote, "garbage"), quote, now)).toThrow(expect.objectContaining({ code: "CLOUD_APPROVAL_EXPIRED" }));
  });

  it("requires a new approval when constraints, inputs or a material price change since", () => {
    const quote = buildQuote(inputs());
    // Availability moving between datacenters is covered by the approved range, not a new consent.
    const moved = catalog();
    moved.gpus[1]!.dataCenters = [{ id: "DC-VOL", availability: "LOW" }];
    expect(() => assertApprovalValid(quote, approval(quote), buildQuote(inputs({ catalog: moved })), now)).not.toThrow();
    expect(() => assertApprovalValid(quote, approval(quote), buildQuote(inputs({ gpuId: "l40" })), now)).toThrow(expect.objectContaining({ code: "CLOUD_REQUOTE_REQUIRED" }));

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

describe("approval revalidation of storage cost and budget coverage", () => {
  const now = new Date("2026-10-13T12:05:00.000Z");
  const rates = (disk: number | undefined, volume: number | undefined): Catalog => ({
    ...catalog(),
    ...(disk !== undefined || volume !== undefined ? { storageRates: { ...(disk !== undefined ? { containerDiskUsdPerGbMonth: disk } : {}), ...(volume !== undefined ? { networkVolumeUsdPerGbMonth: volume } : {}) } } : {}),
  });
  const approve = (quote: { id: string; warnings: Array<{ id: "lifetime-risk" | "storage-charges" }> }) => ({ quoteId: quote.id, approvedAt: "2026-10-13T12:00:00.000Z", acknowledged: quote.warnings.map((w) => w.id) });
  const check = (approved: ReturnType<typeof buildQuote>, fresh: ReturnType<typeof buildQuote>) => assertApprovalValid(approved, approve(approved), fresh, now);
  const requote = expect.objectContaining({ code: "CLOUD_REQUOTE_REQUIRED" });

  it("passes when storage figures and coverage are identical", () => {
    const a = buildQuote(inputs({ cachePolicy: "persistent", catalog: rates(5, 0.07) }));
    expect(() => check(a, buildQuote(inputs({ cachePolicy: "persistent", catalog: rates(5, 0.07) })))).not.toThrow();
    const unknown = buildQuote(inputs({ cachePolicy: "persistent" }));
    expect(() => check(unknown, buildQuote(inputs({ cachePolicy: "persistent" })))).not.toThrow();
  });

  it("requires fresh approval when an unknown rate becomes known, even if the amount is tiny", () => {
    const approved = buildQuote(inputs());
    expect(approved.cost.temporaryStorage.worstCaseUsd).toBeNull();
    const fresh = buildQuote(inputs({ catalog: rates(0.0001, undefined) }));
    expect(fresh.cost.temporaryStorage.worstCaseUsd).not.toBeNull();
    expect(fresh.id).toBe(approved.id);
    expect(() => check(approved, fresh)).toThrow(requote);
    expect(() => check(approved, fresh)).toThrow(/coverage changed.*diskCounted/);
  });

  it("requires fresh approval when a known rate becomes unknown (coverage shrinks)", () => {
    const approved = buildQuote(inputs({ catalog: rates(0.1, undefined) }));
    expect(() => check(approved, buildQuote(inputs()))).toThrow(requote);
  });

  it("requires fresh approval when the recurring volume rate becomes known or unknown", () => {
    const unknownVolume = buildQuote(inputs({ cachePolicy: "persistent" }));
    const knownVolume = buildQuote(inputs({ cachePolicy: "persistent", catalog: rates(undefined, 0.07) }));
    expect(() => check(unknownVolume, knownVolume)).toThrow(/volumeRateKnown/);
    expect(() => check(knownVolume, unknownVolume)).toThrow(requote);
  });

  it("requires fresh approval for a material rise in container disk, recurring storage or the counted total, but not for noise or drops", () => {
    const a = buildQuote(inputs({ cachePolicy: "persistent", catalog: rates(10, 0.07), maxBudgetUsd: 50 }));
    // Disk rate doubles: temporary disk cost rises well past tolerance and the noise floor.
    expect(() => check(a, buildQuote(inputs({ cachePolicy: "persistent", catalog: rates(20, 0.07), maxBudgetUsd: 50 })))).toThrow(/Container disk cost rose/);
    // Volume rate doubles: recurring cost rises 2.8 -> 5.6 per month.
    expect(() => check(a, buildQuote(inputs({ cachePolicy: "persistent", catalog: rates(10, 0.14), maxBudgetUsd: 50 })))).toThrow(/Recurring volume storage rose/);
    // Within tolerance: allowed.
    expect(() => check(a, buildQuote(inputs({ cachePolicy: "persistent", catalog: rates(10.5, 0.074), maxBudgetUsd: 50 })))).not.toThrow();
    // Cheaper with the same coverage: allowed.
    expect(() => check(a, buildQuote(inputs({ cachePolicy: "persistent", catalog: rates(5, 0.03), maxBudgetUsd: 50 })))).not.toThrow();
  });

  it("ignores sub-floor absolute changes so rounding noise never forces re-approval", () => {
    const a = buildQuote(inputs({ catalog: rates(0.1, undefined) })); // ~ $0.0055 disk
    const tiny = buildQuote(inputs({ catalog: rates(0.15, undefined) })); // ~ $0.0082: +50% but only ~$0.003
    expect(() => check(a, tiny)).not.toThrow();
  });

  it("a changed disk size or machine count (persistent vs not) is a coverage change and already a different quote id", () => {
    const eph = buildQuote(inputs());
    const per = buildQuote(inputs({ cachePolicy: "persistent" }));
    expect(() => check(eph, per)).toThrow(requote);
  });
});

describe("explicit risk acknowledgment", () => {
  const now = new Date("2026-10-13T12:05:00.000Z");
  const base = { approvedAt: "2026-10-13T12:00:00.000Z" };
  const needs = expect.objectContaining({ code: "CLOUD_ACKNOWLEDGMENT_REQUIRED" });

  it("every quote carries the exact lifetime warning", () => {
    const quote = buildQuote(inputs());
    expect(quote.warnings).toEqual([{ id: "lifetime-risk", text: LIFETIME_RISK_WARNING }]);
    expect(LIFETIME_RISK_WARNING).toBe(
      "If MoleculeDesk closes or loses connection, your Runpod Pod may keep running and charging. Automatic shutdown is not guaranteed. Check your Runpod dashboard and terminate any remaining Pod.",
    );
    expect(quote.disclosures.join(" ")).toMatch(/only while it is running and connected/);
    expect(quote.disclosures.join(" ")).not.toMatch(/are terminated after the run or at the/);
  });

  it("persistent quotes also carry the storage-charges warning; ephemeral ones do not", () => {
    expect(buildQuote(inputs({ cachePolicy: "persistent" })).warnings.map((w) => w.id)).toEqual(["lifetime-risk", "storage-charges"]);
    expect(buildQuote(inputs({ cachePolicy: "persistent" })).warnings[1]!.text).toBe(STORAGE_CHARGES_WARNING);
    expect(STORAGE_CHARGES_WARNING).toMatch(/Storage charges continue until you delete it/);
    expect(buildQuote(inputs()).warnings.map((w) => w.id)).toEqual(["lifetime-risk"]);
  });

  it("an approval without the lifetime acknowledgment is refused", () => {
    const quote = buildQuote(inputs());
    expect(() => assertApprovalValid(quote, { quoteId: quote.id, ...base, acknowledged: [] }, quote, now)).toThrow(needs);
    expect(() => assertApprovalValid(quote, { quoteId: quote.id, ...base, acknowledged: ["lifetime-risk"] }, quote, now)).not.toThrow();
  });

  it("persistent approvals need both acknowledgments; acknowledging only one is refused", () => {
    const quote = buildQuote(inputs({ cachePolicy: "persistent" }));
    expect(() => assertApprovalValid(quote, { quoteId: quote.id, ...base, acknowledged: ["lifetime-risk"] }, quote, now)).toThrow(/Storage charges continue/);
    expect(() => assertApprovalValid(quote, { quoteId: quote.id, ...base, acknowledged: ["storage-charges"] }, quote, now)).toThrow(needs);
    expect(() => assertApprovalValid(quote, { quoteId: quote.id, ...base, acknowledged: ["lifetime-risk", "storage-charges"] }, quote, now)).not.toThrow();
  });

  it("a missing acknowledgments field (old or hand-built approval) is refused, not assumed", () => {
    const quote = buildQuote(inputs());
    expect(() => assertApprovalValid(quote, { quoteId: quote.id, ...base } as never, quote, now)).toThrow(needs);
  });
});
