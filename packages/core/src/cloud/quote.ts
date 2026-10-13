import type { CloudCatalog, CloudCpuType, CloudGpuType, CloudDataCenter } from "@moldesk/runtime";
import type { CloudSpec, ModelManifestV1 } from "@moldesk/registry";
import { MoldeskError } from "../errors.js";
import { digest } from "../hash.js";
import type { CloudCachePolicy } from "./state.js";

export const QUOTE_VERSION = 1;
/** Approvals older than this are refused; the user must see a fresh quote. */
export const APPROVAL_MAX_AGE_MS = 15 * 60 * 1000;
/** A price rise above this fraction since approval requires a new approval. */
export const PRICE_TOLERANCE = 0.1;
export const DEFAULT_MAX_LIFETIME_SECONDS = 3600;
export const DEFAULT_PREP_CPU = { id: "cpu3c", vcpuCount: 2 } as const;

export interface QuoteRange {
  minSeconds: number;
  maxSeconds: number;
}

export interface CloudQuote {
  version: typeof QUOTE_VERSION;
  /** Digest of everything the user consents to; excludes volatile prices and retrieval time. */
  id: string;
  provider: string;
  retrievedAt: string;
  model: string;
  modelVersion: string;
  cachePolicy: CloudCachePolicy;
  gpu: { id: string; name: string; memoryGb: number; priceUsdPerHour: number };
  datacenterId: string;
  cpu?: { id: string; vcpuCount: number; priceUsdPerHour: number };
  images: { gpu: string; cpu: string };
  upload: { files: number; bytes: number };
  maxLifetimeSeconds: number;
  maxBudgetUsd: number;
  cost: {
    /** Hourly rate times the approved lifetime for every paid compute role. A ceiling, not a spend cap. */
    worstCaseComputeUsd: number;
    storage: { recurring: boolean; usdPerMonth: number | null };
  };
  /** `null` means no measured estimate exists; it is never guessed. */
  timing: { preparation: QuoteRange | null; inference: QuoteRange | null; transfer: QuoteRange | null };
  disclosures: string[];
  bindings: { manifestDigest: string; inputs: Array<{ role: string; sha256: string }> };
}

export interface QuoteInputs {
  provider: string;
  manifest: ModelManifestV1;
  cloud: CloudSpec;
  catalog: CloudCatalog;
  cachePolicy: CloudCachePolicy;
  gpuId?: string;
  datacenterId?: string;
  maxBudgetUsd: number;
  maxLifetimeSeconds: number;
  inputs: Array<{ role: string; sha256: string; sizeBytes: number }>;
  /** Datacenter of a compatible retained volume; persistent runs must stay there. */
  existingVolumeDatacenterId?: string;
}

function rejected(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

function datacenterSupports(dc: CloudDataCenter | undefined, persistent: boolean): boolean {
  return dc !== undefined && (!persistent || dc.networkVolumeTypes.length > 0);
}

/** Cheapest eligible GPU in a datacenter that can host the policy; a user's explicit choice is validated, never silently replaced. */
function chooseGpuAndDatacenter(input: QuoteInputs): { gpu: CloudGpuType; datacenterId: string } {
  const persistent = input.cachePolicy === "persistent";
  const dcById = new Map(input.catalog.dataCenters.map((dc) => [dc.id, dc]));
  const eligible = input.catalog.gpus.filter(
    (gpu) => gpu.memoryGb >= input.cloud.minVramGb && gpu.priceUsdPerHour > 0 && gpu.availability !== "NONE",
  );

  if (input.gpuId) {
    const gpu = input.catalog.gpus.find((candidate) => candidate.id === input.gpuId);
    if (!gpu) throw rejected("CLOUD_GPU_UNKNOWN", `GPU "${input.gpuId}" is not in the provider catalog.`, "Pick an id from the provider's GPU catalog.");
    if (gpu.memoryGb < input.cloud.minVramGb) {
      throw rejected("CLOUD_GPU_INELIGIBLE", `${gpu.name} has ${gpu.memoryGb} GB VRAM; ${input.manifest.name} needs at least ${input.cloud.minVramGb} GB.`, "Choose a larger GPU.");
    }
  }

  const candidates = (input.gpuId ? eligible.filter((gpu) => gpu.id === input.gpuId) : eligible).sort((a, b) => a.priceUsdPerHour - b.priceUsdPerHour);
  for (const gpu of candidates) {
    const options = gpu.dataCenters
      .filter((dc) => dc.availability !== "NONE")
      .map((dc) => dc.id)
      .filter((id) => datacenterSupports(dcById.get(id), persistent))
      .filter((id) => !input.datacenterId || id === input.datacenterId)
      .filter((id) => !input.existingVolumeDatacenterId || id === input.existingVolumeDatacenterId);
    if (options.length > 0) return { gpu, datacenterId: options[0]! };
  }
  throw rejected(
    "CLOUD_CAPACITY_UNAVAILABLE",
    "No eligible GPU currently has capacity in a compatible datacenter.",
    "Retry later, relax --gpu/--datacenter, or use an ephemeral cache policy if a persistent volume location is the constraint. Quotes never reserve capacity.",
    { cachePolicy: input.cachePolicy, minVramGb: input.cloud.minVramGb },
  );
}

function chooseCpu(catalog: CloudCatalog): { type: CloudCpuType; vcpuCount: number } | undefined {
  const type = catalog.cpus.find((cpu) => cpu.id === DEFAULT_PREP_CPU.id);
  return type ? { type, vcpuCount: Math.max(DEFAULT_PREP_CPU.vcpuCount, type.minVcpu) } : undefined;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Pure: builds the quote shown to the user. Rejects over-budget quotes before anything is provisioned. */
export function buildQuote(input: QuoteInputs): CloudQuote {
  if (!Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0) {
    throw rejected("CLOUD_BUDGET_REQUIRED", "A positive maximum budget is required.", "Pass --max-budget <usd>.");
  }
  if (!Number.isInteger(input.maxLifetimeSeconds) || input.maxLifetimeSeconds <= 0) {
    throw rejected("CLOUD_LIFETIME_REQUIRED", "A positive maximum lifetime in seconds is required.", "Pass --max-lifetime <seconds>.");
  }
  const { gpu, datacenterId } = chooseGpuAndDatacenter(input);
  const persistent = input.cachePolicy === "persistent";
  const hours = input.maxLifetimeSeconds / 3600;

  let cpu: CloudQuote["cpu"];
  if (persistent && input.cloud.cpuAssetPreparation) {
    const chosen = chooseCpu(input.catalog);
    if (!chosen) throw rejected("CLOUD_CPU_UNAVAILABLE", `CPU type ${DEFAULT_PREP_CPU.id} is not in the provider catalog.`, "Retry later or use an ephemeral cache policy.");
    cpu = { id: chosen.type.id, vcpuCount: chosen.vcpuCount, priceUsdPerHour: round(chosen.type.priceUsdPerVcpuHour * chosen.vcpuCount) };
  }

  const worstCaseComputeUsd = round((gpu.priceUsdPerHour + (cpu?.priceUsdPerHour ?? 0)) * hours);
  if (worstCaseComputeUsd > input.maxBudgetUsd) {
    throw rejected(
      "CLOUD_BUDGET_EXCEEDED",
      `Worst-case compute cost $${worstCaseComputeUsd} (${gpu.name} at $${gpu.priceUsdPerHour}/h for up to ${input.maxLifetimeSeconds}s) exceeds the $${input.maxBudgetUsd} budget.`,
      "Raise --max-budget, lower --max-lifetime, or choose a cheaper GPU. The budget is a guard on this estimate, not a provider-enforced cap.",
      { worstCaseComputeUsd, maxBudgetUsd: input.maxBudgetUsd },
    );
  }

  const bindings = {
    manifestDigest: digest(input.manifest),
    inputs: input.inputs.map((file) => ({ role: file.role, sha256: file.sha256 })),
  };
  const id = digest({
    v: QUOTE_VERSION,
    provider: input.provider,
    model: input.manifest.name,
    modelVersion: input.manifest.modelVersion,
    cachePolicy: input.cachePolicy,
    gpuId: gpu.id,
    datacenterId,
    cpuId: cpu?.id ?? null,
    images: input.cloud.images,
    maxLifetimeSeconds: input.maxLifetimeSeconds,
    maxBudgetUsd: input.maxBudgetUsd,
    bindings,
  });

  const disclosures = [
    `Uploads ${input.inputs.length} input file(s) (${input.inputs.reduce((total, file) => total + file.sizeBytes, 0)} bytes) to ${input.provider} in ${datacenterId}.`,
    `Rented machines are terminated after the run or at the ${input.maxLifetimeSeconds}s lifetime limit, whichever comes first; results may be lost if the limit is reached before download.`,
    "Capacity and price are not reserved by this quote.",
  ];
  if (persistent) {
    disclosures.push("A network volume is created or reused and kept after the run; its storage is billed until you delete it with `moldesk cloud cache delete`. The recurring rate is not published by the catalog and is unknown here.");
  } else {
    disclosures.push("Model assets are downloaded again on every run; nothing is retained after cleanup.");
  }

  return {
    version: QUOTE_VERSION,
    id,
    provider: input.provider,
    retrievedAt: input.catalog.retrievedAt,
    model: input.manifest.name,
    modelVersion: input.manifest.modelVersion,
    cachePolicy: input.cachePolicy,
    gpu: { id: gpu.id, name: gpu.name, memoryGb: gpu.memoryGb, priceUsdPerHour: gpu.priceUsdPerHour },
    datacenterId,
    ...(cpu ? { cpu } : {}),
    images: input.cloud.images,
    upload: { files: input.inputs.length, bytes: input.inputs.reduce((total, file) => total + file.sizeBytes, 0) },
    maxLifetimeSeconds: input.maxLifetimeSeconds,
    maxBudgetUsd: input.maxBudgetUsd,
    cost: { worstCaseComputeUsd, storage: { recurring: persistent, usdPerMonth: null } },
    timing: { preparation: null, inference: null, transfer: null },
    disclosures,
    bindings,
  };
}

export interface CloudApproval {
  quoteId: string;
  approvedAt: string;
}

/**
 * Verifies that what was approved is what is about to be provisioned: same quote id, not expired,
 * and no material price rise or location change since. Throws before any resource is created.
 */
export function assertApprovalValid(approved: CloudQuote, approval: CloudApproval, fresh: CloudQuote, now: Date = new Date()): void {
  if (approval.quoteId !== approved.id) {
    throw rejected("CLOUD_APPROVAL_MISMATCH", "The approval does not match the quote.", "Review and approve the quote again.");
  }
  const approvedAt = Date.parse(approval.approvedAt);
  if (!Number.isFinite(approvedAt) || approvedAt > now.getTime() + 60_000 || now.getTime() - approvedAt > APPROVAL_MAX_AGE_MS) {
    throw rejected("CLOUD_APPROVAL_EXPIRED", "The approval has expired.", "Review and approve a fresh quote.");
  }
  if (fresh.id !== approved.id) {
    throw rejected(
      "CLOUD_REQUOTE_REQUIRED",
      "Inputs, model, GPU, location or limits changed since approval.",
      "Review and approve the new quote.",
      { approvedGpu: approved.gpu.id, approvedDatacenter: approved.datacenterId, freshGpu: fresh.gpu.id, freshDatacenter: fresh.datacenterId },
    );
  }
  const rate = (quote: CloudQuote): number => quote.gpu.priceUsdPerHour + (quote.cpu?.priceUsdPerHour ?? 0);
  if (rate(fresh) > rate(approved) * (1 + PRICE_TOLERANCE)) {
    throw rejected(
      "CLOUD_REQUOTE_REQUIRED",
      `The hourly price rose from $${round(rate(approved))} to $${round(rate(fresh))} since approval.`,
      "Review and approve the new quote.",
      { approvedRate: rate(approved), freshRate: rate(fresh) },
    );
  }
}
