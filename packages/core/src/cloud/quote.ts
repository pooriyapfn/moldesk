import { CPU_PREP_TYPE_IDS, type CloudCatalog, type CloudCpuType, type CloudGpuType, type CloudDataCenter } from "@moldesk/runtime";
import type { CloudSpec, ModelManifestV1 } from "@moldesk/registry";
import { MoldeskError } from "../errors.js";
import { digest } from "../hash.js";
import type { CloudCachePolicy } from "./state.js";

export const QUOTE_VERSION = 1;
/** Approvals older than this are refused; the user must see a fresh quote. */
export const APPROVAL_MAX_AGE_MS = 15 * 60 * 1000;
/** A price rise above this fraction since approval requires a new approval. */
export const PRICE_TOLERANCE = 0.1;
/** Storage amounts below these absolute rises are noise, not a material change (USD). */
export const STORAGE_NOISE_FLOOR_USD = 0.01;
export const RECURRING_NOISE_FLOOR_USD_PER_MONTH = 0.1;
/** Shown prominently before approval and must be explicitly acknowledged: there is no independent shutdown service. */
export const LIFETIME_RISK_WARNING =
  "If MoleculeDesk closes or loses connection, your Runpod Pod may keep running and charging. Automatic shutdown is not guaranteed. Check your Runpod dashboard and terminate any remaining Pod.";
export const STORAGE_CHARGES_WARNING =
  "Persistent caching keeps a network volume. Storage charges continue until you delete it (`moldesk cloud cache delete`, or in the Runpod dashboard).";

export type CloudAcknowledgment = "lifetime-risk" | "storage-charges";

export interface QuoteWarning {
  id: CloudAcknowledgment;
  text: string;
}

export const DEFAULT_MAX_LIFETIME_SECONDS = 3600;
/** Default GPU price range: GPUs up to this multiple of the cheapest eligible one are acceptable. */
export const DEFAULT_GPU_PRICE_RANGE_FACTOR = 2;
/** Billing months are 730 hours. */
const HOURS_PER_MONTH = 730;
export const PREP_CPU_VCPU = 2;

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
  /** The first choice: the cheapest GPU currently available. Capacity is never reserved, so another may be used. */
  gpu: { id: string; name: string; memoryGb: number; priceUsdPerHour: number };
  datacenterId: string;
  /** Any currently available GPU in this range may be used instead of waiting on one model. */
  gpuRange: {
    minVramGb: number;
    /** Highest GPU hourly rate this quote covers; compute is costed at this rate for the lifetime limit. */
    maxUsdPerHour: number;
    pinnedGpuId: string | null;
    /** The manifest's validated GPU ids when it restricts them; no other GPU is used. */
    allowedGpuIds: string[] | null;
    lockDatacenter: boolean;
    /** Available now within the range, cheapest first (informational; availability changes). */
    candidates: Array<{ id: string; name: string; memoryGb: number; priceUsdPerHour: number; datacenterIds: string[] }>;
  };
  /** Asset-preparation machine (persistent runs). Any available type up to `maxUsdPerHour` may be used. */
  cpu?: { id: string; vcpuCount: number; priceUsdPerHour: number; maxUsdPerHour: number };
  images: { gpu: string; cpu: string };
  upload: { files: number; bytes: number };
  maxLifetimeSeconds: number;
  maxBudgetUsd: number;
  cost: {
    /** Hourly rate times the approved lifetime for every paid compute role. A ceiling, not a spend cap. */
    worstCaseComputeUsd: number;
    /** Container disk for the machines' lifetime; `null` when the provider publishes no rate. */
    temporaryStorage: { diskGb: number; machines: number; worstCaseUsd: number | null };
    /** Retained network volume; billed monthly until deleted. `null` when the provider publishes no rate. */
    recurringStorage: { recurring: boolean; volumeGb: number | null; usdPerMonth: number | null };
    /** What `maxBudgetUsd` is compared against: compute plus any temporary storage with a known rate. */
    worstCaseBudgetedUsd: number;
  };
  /** Exactly what the budget guard covers, what it does not, and which costs have no known figure. */
  budgetCoverage: { counted: string[]; notCounted: string[]; unknown: string[] };
  /** `null` means no measured estimate exists; it is never guessed. */
  timing: { preparation: QuoteRange | null; inference: QuoteRange | null; transfer: QuoteRange | null };
  /** Every warning here must be acknowledged by the user for the approval to be valid. */
  warnings: QuoteWarning[];
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
  /** Override the manifest's worker images (a tag or a digest-pinned reference). */
  gpuImage?: string;
  cpuImage?: string;
  /** Highest GPU hourly rate to accept. Default: twice the cheapest eligible GPU, capped by the budget. */
  maxGpuUsdPerHour?: number;
  maxBudgetUsd: number;
  maxLifetimeSeconds: number;
  inputs: Array<{ role: string; sha256: string; sizeBytes: number }>;
  /** Datacenter of a compatible retained volume; persistent runs must stay there. */
  existingVolumeDatacenterId?: string;
}

function rejected(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

/** Loose syntax check for a user-supplied image reference; the registry is the real authority. */
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._-]*(?::\d+)?(?:\/[a-z0-9][a-z0-9._-]*)+(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;

function resolveImages(input: QuoteInputs): { images: { gpu: string; cpu: string }; unpinned: string[] } {
  const images = { gpu: input.gpuImage ?? input.cloud.images.gpu, cpu: input.cpuImage ?? input.cloud.images.cpu };
  for (const [role, ref] of Object.entries(images)) {
    if (ref.length > 255 || !IMAGE_REFERENCE.test(ref)) {
      throw rejected(
        "CLOUD_IMAGE_INVALID",
        `The ${role} image "${ref}" is not a valid image reference.`,
        "Use registry/name:tag or registry/name@sha256:<digest>, for example runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404.",
      );
    }
  }
  return { images, unpinned: Object.entries(images).filter(([, ref]) => !ref.includes("@sha256:")).map(([role, ref]) => `${role} image ${ref}`) };
}

function datacenterSupports(dc: CloudDataCenter | undefined, persistent: boolean): boolean {
  return dc !== undefined && (!persistent || dc.networkVolumeTypes.length > 0);
}

interface GpuPlacement {
  gpu: CloudGpuType;
  datacenterId: string;
  lockDatacenter: boolean;
  /** Every eligible GPU with the datacenters where it is available now, cheapest first. */
  options: Array<{ gpu: CloudGpuType; datacenterIds: string[] }>;
}

/**
 * Picks the cheapest eligible, currently available GPU as the first choice, and returns every
 * eligible alternative so the price range can be applied. A user's explicit GPU is validated, never
 * silently replaced. For persistent runs the datacenter must host volumes and is chosen to keep the
 * most GPU options open, because the Pod has to land in the volume's datacenter.
 */
function chooseGpuPlacement(input: QuoteInputs, priceLimit: number): GpuPlacement {
  const persistent = input.cachePolicy === "persistent";
  const dcById = new Map(input.catalog.dataCenters.map((dc) => [dc.id, dc]));
  const allowed = input.cloud.gpuAllowList;
  const isAllowed = (id: string): boolean => allowed === undefined || allowed.includes(id);
  const eligible = input.catalog.gpus.filter(
    (gpu) => gpu.memoryGb >= input.cloud.minVramGb && isAllowed(gpu.id) && gpu.priceUsdPerHour > 0 && gpu.availability !== "NONE",
  );

  if (input.gpuId) {
    const gpu = input.catalog.gpus.find((candidate) => candidate.id === input.gpuId);
    if (!gpu) throw rejected("CLOUD_GPU_UNKNOWN", `GPU "${input.gpuId}" is not in the provider catalog.`, "Pick an id from the provider's GPU catalog.");
    if (gpu.memoryGb < input.cloud.minVramGb) {
      throw rejected("CLOUD_GPU_INELIGIBLE", `${gpu.name} has ${gpu.memoryGb} GB VRAM; ${input.manifest.name} needs at least ${input.cloud.minVramGb} GB.`, "Choose a larger GPU.");
    }
    if (!isAllowed(gpu.id)) {
      throw rejected(
        "CLOUD_GPU_INELIGIBLE",
        `${gpu.name} is not validated for ${input.manifest.name}; its pinned framework may not support this GPU generation.`,
        `Choose one of: ${allowed!.join(", ")}.`,
        { gpuAllowList: allowed },
      );
    }
  }

  // A persistent cold run prepares assets on a CPU Pod in the same datacenter as the volume and the GPU.
  const needsCpu = persistent && input.cloud.cpuAssetPreparation;
  const cpuDatacenterOk = (id: string): boolean => !needsCpu || cpuOptions(input.catalog, id).length > 0;
  const lockedDatacenterId = input.existingVolumeDatacenterId ?? input.datacenterId;
  const usable = (input.gpuId ? eligible.filter((gpu) => gpu.id === input.gpuId) : eligible).sort((a, b) => a.priceUsdPerHour - b.priceUsdPerHour);
  const options = usable
    .map((gpu) => ({
      gpu,
      datacenterIds: gpu.dataCenters
        .filter((dc) => dc.availability !== "NONE")
        .map((dc) => dc.id)
        .filter((id) => datacenterSupports(dcById.get(id), persistent))
        .filter(cpuDatacenterOk)
        .filter((id) => !input.datacenterId || id === input.datacenterId)
        .filter((id) => !input.existingVolumeDatacenterId || id === input.existingVolumeDatacenterId),
    }))
    .filter((option) => option.datacenterIds.length > 0);
  if (options.length === 0) {
    throw rejected(
      "CLOUD_CAPACITY_UNAVAILABLE",
      "No eligible GPU currently has capacity in a compatible datacenter.",
      `Retry later, relax --gpu/--datacenter, or use an ephemeral cache policy if a persistent volume location is the constraint. Quotes never reserve capacity.${allowed ? ` ${input.manifest.name} runs only on: ${allowed.join(", ")}.` : ""}`,
      { cachePolicy: input.cachePolicy, minVramGb: input.cloud.minVramGb, ...(allowed ? { gpuAllowList: allowed } : {}) },
    );
  }

  const cheapest = options[0]!;
  if (!persistent || lockedDatacenterId) {
    return { gpu: cheapest.gpu, datacenterId: lockedDatacenterId ?? cheapest.datacenterIds[0]!, lockDatacenter: lockedDatacenterId !== undefined, options };
  }
  // A new persistent volume pins the datacenter, so choose it where a GPU is actually affordable and
  // the most alternatives sit near the cheapest one: a datacenter full of GPUs far above the budget is
  // no use. Falls back to every option when nothing is affordable, so the budget error names the real
  // cheapest GPU.
  const affordable = options.filter((option) => option.gpu.priceUsdPerHour <= priceLimit);
  const pool = affordable.length > 0 ? affordable : options;
  const scored = [...new Set(pool.flatMap((option) => option.datacenterIds))].map((id) => {
    const inDc = pool.filter((option) => option.datacenterIds.includes(id));
    const cheapestInDc = inDc[0]!;
    const rangeTop = Math.min(priceLimit, cheapestInDc.gpu.priceUsdPerHour * DEFAULT_GPU_PRICE_RANGE_FACTOR);
    return { id, first: cheapestInDc, count: inDc.filter((option) => option.gpu.priceUsdPerHour <= rangeTop).length };
  });
  scored.sort((a, b) => b.count - a.count || a.first.gpu.priceUsdPerHour - b.first.gpu.priceUsdPerHour || (a.id < b.id ? -1 : 1));
  const best = scored[0]!;
  return { gpu: best.first.gpu, datacenterId: best.id, lockDatacenter: true, options };
}

/** CPU types that can prepare assets in a datacenter, cheapest first; availability unknown counts as available. */
function cpuOptions(catalog: CloudCatalog, datacenterId?: string): Array<{ type: CloudCpuType; vcpuCount: number; priceUsdPerHour: number }> {
  return catalog.cpus
    .filter((type) => (CPU_PREP_TYPE_IDS as readonly string[]).includes(type.id))
    .filter((type) => datacenterId === undefined || type.dataCenters === undefined || type.dataCenters.some((dc) => dc.id === datacenterId && dc.availability !== "NONE"))
    .map((type) => {
      const vcpuCount = Math.max(PREP_CPU_VCPU, type.minVcpu);
      return { type, vcpuCount, priceUsdPerHour: round(type.priceUsdPerVcpuHour * vcpuCount) };
    })
    .sort((a, b) => a.priceUsdPerHour - b.priceUsdPerHour);
}

function requiredWarnings(persistent: boolean): QuoteWarning[] {
  return [
    { id: "lifetime-risk", text: LIFETIME_RISK_WARNING },
    ...(persistent ? [{ id: "storage-charges" as const, text: STORAGE_CHARGES_WARNING }] : []),
  ];
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
  const { images, unpinned } = resolveImages(input);
  const persistent = input.cachePolicy === "persistent";
  const hours = input.maxLifetimeSeconds / 3600;

  const needsCpu = persistent && input.cloud.cpuAssetPreparation;
  if (needsCpu && cpuOptions(input.catalog).length === 0) {
    throw rejected("CLOUD_CPU_UNAVAILABLE", `None of the CPU types ${CPU_PREP_TYPE_IDS.join(", ")} is in the provider catalog.`, "Retry later or use an ephemeral cache policy.");
  }
  // The datacenter is not known yet: size the budget with the cheapest CPU, then re-cost with the real one.
  const prelimCpuRate = needsCpu ? cpuOptions(input.catalog)[0]!.priceUsdPerHour : 0;

  // Storage: only rates the provider actually publishes are used; everything else is stated as unknown.
  const rates = input.catalog.storageRates;
  const machines = needsCpu ? 2 : 1;
  const diskGb = input.cloud.ephemeralDiskGb;
  const diskRate = rates?.containerDiskUsdPerGbMonth;
  const temporaryUsd = diskRate !== undefined ? round(diskGb * machines * diskRate * (hours / HOURS_PER_MONTH)) : null;
  const volumeRate = rates?.networkVolumeUsdPerGbMonth;
  const volumeGb = persistent ? input.cloud.volumeGb : null;
  const volumeMonthlyUsd = persistent && volumeRate !== undefined ? round(input.cloud.volumeGb * volumeRate) : null;
  const ceilingFor = (cpuRate: number): number => Math.floor((((input.maxBudgetUsd - (temporaryUsd ?? 0)) / hours) - cpuRate) * 10_000) / 10_000;
  const { gpu, datacenterId, lockDatacenter, options } = chooseGpuPlacement(input, Math.min(ceilingFor(prelimCpuRate), input.maxGpuUsdPerHour ?? Number.POSITIVE_INFINITY));

  // The CPU Pod lands in the chosen datacenter. Cost the worst case at the dearest type allowed there,
  // since a capacity rejection can move the preparation to another type.
  let cpu: CloudQuote["cpu"];
  if (needsCpu) {
    const here = cpuOptions(input.catalog, datacenterId);
    cpu = { id: here[0]!.type.id, vcpuCount: here[0]!.vcpuCount, priceUsdPerHour: here[0]!.priceUsdPerHour, maxUsdPerHour: here[here.length - 1]!.priceUsdPerHour };
  }
  const cpuRate = cpu?.maxUsdPerHour ?? 0;
  const budgetCeiling = ceilingFor(cpuRate);

  // The first choice must fit the budget on its own; otherwise nothing can.
  const firstChoiceBudgetedUsd = round((gpu.priceUsdPerHour + cpuRate) * hours + (temporaryUsd ?? 0));
  if (firstChoiceBudgetedUsd > input.maxBudgetUsd) {
    throw rejected(
      "CLOUD_BUDGET_EXCEEDED",
      `Worst-case cost counted against the budget, $${firstChoiceBudgetedUsd} (${gpu.name} at $${gpu.priceUsdPerHour}/h for up to ${input.maxLifetimeSeconds}s${temporaryUsd !== null ? " plus container disk" : ""}), exceeds the $${input.maxBudgetUsd} budget.`,
      "Raise --max-budget, lower --max-lifetime, or choose a cheaper GPU. The budget is a guard on this estimate, not a provider-enforced cap.",
      { worstCaseBudgetedUsd: firstChoiceBudgetedUsd, maxBudgetUsd: input.maxBudgetUsd },
    );
  }

  // Price range: any available GPU up to this hourly rate may be used. The budget bounds it, so the
  // worst case below holds whichever GPU is obtained.
  const requestedMax = input.maxGpuUsdPerHour ?? round(gpu.priceUsdPerHour * DEFAULT_GPU_PRICE_RANGE_FACTOR);
  if (!Number.isFinite(requestedMax) || requestedMax < gpu.priceUsdPerHour) {
    throw rejected(
      "CLOUD_GPU_PRICE_RANGE_INVALID",
      `--max-gpu-price $${input.maxGpuUsdPerHour} is below the cheapest eligible GPU, ${gpu.name} at $${gpu.priceUsdPerHour}/h.`,
      "Raise --max-gpu-price or omit it to allow up to twice the cheapest eligible GPU.",
      { cheapestUsdPerHour: gpu.priceUsdPerHour },
    );
  }
  const maxGpuUsdPerHour = Math.floor(Math.min(requestedMax, budgetCeiling) * 10_000) / 10_000;
  const candidates = options
    .filter((option) => option.gpu.priceUsdPerHour <= maxGpuUsdPerHour)
    .map((option) => ({
      id: option.gpu.id,
      name: option.gpu.name,
      memoryGb: option.gpu.memoryGb,
      priceUsdPerHour: option.gpu.priceUsdPerHour,
      datacenterIds: lockDatacenter ? option.datacenterIds.filter((id) => id === datacenterId) : option.datacenterIds,
    }))
    .filter((option) => option.datacenterIds.length > 0);
  const worstCaseComputeUsd = round((maxGpuUsdPerHour + cpuRate) * hours);
  const worstCaseBudgetedUsd = round(worstCaseComputeUsd + (temporaryUsd ?? 0));

  const counted = [`GPU (up to $${maxGpuUsdPerHour}/h)${cpu ? " and preparation-CPU" : ""} compute at catalog rates for up to ${input.maxLifetimeSeconds}s each`];
  const notCounted: string[] = [];
  const unknown: string[] = [];
  if (temporaryUsd !== null) counted.push(`container disk (${diskGb} GB x ${machines} machine${machines > 1 ? "s" : ""}) at the published rate`);
  else {
    notCounted.push(`container disk charges (${diskGb} GB x ${machines} machine${machines > 1 ? "s" : ""})`);
    unknown.push("container disk rate is not published by the provider's catalog API");
  }
  if (persistent) {
    notCounted.push(`retained network volume storage (${input.cloud.volumeGb} GB), billed monthly until deleted${volumeMonthlyUsd !== null ? `: about $${volumeMonthlyUsd}/month` : ""}`);
    if (volumeMonthlyUsd === null) unknown.push("network volume rate is not published by the provider's catalog API");
  }
  notCounted.push("network transfer or any other provider fees", "charges for time beyond the lifetime limit if a machine is not terminated");
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
    // Availability is volatile and never bound: only what the user constrained, and the price range.
    pinnedGpuId: input.gpuId ?? null,
    pinnedDatacenterId: input.datacenterId ?? input.existingVolumeDatacenterId ?? null,
    minVramGb: input.cloud.minVramGb,
    gpuAllowList: input.cloud.gpuAllowList ?? null,
    // The default range is relative to the live cheapest price, which the price guard already watches.
    maxGpuUsdPerHour: input.maxGpuUsdPerHour ?? null,
    gpuRangeFactor: input.maxGpuUsdPerHour === undefined ? DEFAULT_GPU_PRICE_RANGE_FACTOR : null,
    lockDatacenter,
    cpuId: cpu?.id ?? null,
    images,
    maxLifetimeSeconds: input.maxLifetimeSeconds,
    maxBudgetUsd: input.maxBudgetUsd,
    acknowledgments: requiredWarnings(persistent).map((warning) => warning.id),
    bindings,
  });

  const disclosures = [
    `Uploads ${input.inputs.length} input file(s) (${input.inputs.reduce((total, file) => total + file.sizeBytes, 0)} bytes) to ${input.provider} ${lockDatacenter ? `in ${datacenterId}` : "in whichever datacenter has capacity (pin one with --datacenter)"}.`,
    `MoleculeDesk enforces the ${input.maxLifetimeSeconds}s lifetime limit and terminates machines only while it is running and connected, plus a best-effort watchdog inside the machine; results may be lost if the limit is reached before download.`,
    `Capacity and price are not reserved by this quote. If the first-choice GPU is unavailable, any available GPU up to $${maxGpuUsdPerHour}/h may be used instead${lockDatacenter ? ` in ${datacenterId}` : ""}.`,
  ];
  if (unpinned.length > 0) {
    disclosures.push(`Not pinned by digest, so its contents can change between runs: ${unpinned.join("; ")}.`);
  }
  if (persistent) {
    disclosures.push("A network volume is created or reused and kept after the run; its storage is billed until you delete it with `moldesk cloud cache delete`.");
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
    gpuRange: { minVramGb: input.cloud.minVramGb, maxUsdPerHour: maxGpuUsdPerHour, pinnedGpuId: input.gpuId ?? null, allowedGpuIds: input.cloud.gpuAllowList ?? null, lockDatacenter, candidates },
    ...(cpu ? { cpu } : {}),
    images,
    upload: { files: input.inputs.length, bytes: input.inputs.reduce((total, file) => total + file.sizeBytes, 0) },
    maxLifetimeSeconds: input.maxLifetimeSeconds,
    maxBudgetUsd: input.maxBudgetUsd,
    cost: {
      worstCaseComputeUsd,
      temporaryStorage: { diskGb, machines, worstCaseUsd: temporaryUsd },
      recurringStorage: { recurring: persistent, volumeGb, usdPerMonth: volumeMonthlyUsd },
      worstCaseBudgetedUsd,
    },
    budgetCoverage: { counted, notCounted, unknown },
    timing: { preparation: null, inference: null, transfer: null },
    warnings: requiredWarnings(persistent),
    disclosures,
    bindings,
  };
}

export interface CloudApproval {
  quoteId: string;
  approvedAt: string;
  /** Warning ids the user explicitly acknowledged; must include every `quote.warnings` id. */
  acknowledged: CloudAcknowledgment[];
}

/**
 * Verifies that what was approved is what is about to be provisioned: same quote id, not expired,
 * and no material price rise or location change since. Throws before any resource is created.
 */
export function assertApprovalValid(approved: CloudQuote, approval: CloudApproval, fresh: CloudQuote, now: Date = new Date()): void {
  if (approval.quoteId !== approved.id) {
    throw rejected("CLOUD_APPROVAL_MISMATCH", "The approval does not match the quote.", "Review and approve the quote again.");
  }
  const missing = approved.warnings.filter((warning) => !approval.acknowledged?.includes(warning.id));
  if (missing.length > 0) {
    throw rejected(
      "CLOUD_ACKNOWLEDGMENT_REQUIRED",
      `You must acknowledge: ${missing.map((warning) => warning.text).join(" ")}`,
      "Re-run and explicitly accept the risk (--accept-lifetime-risk, and --accept-storage-charges for persistent caching), or answer the prompts.",
      { missing: missing.map((warning) => warning.id) },
    );
  }
  const approvedAt = Date.parse(approval.approvedAt);
  if (!Number.isFinite(approvedAt) || approvedAt > now.getTime() + 60_000 || now.getTime() - approvedAt > APPROVAL_MAX_AGE_MS) {
    throw rejected("CLOUD_APPROVAL_EXPIRED", "The approval has expired.", "Review and approve a fresh quote.");
  }
  if (fresh.id !== approved.id) {
    throw rejected(
      "CLOUD_REQUOTE_REQUIRED",
      "Inputs, model, GPU constraints, location or limits changed since approval.",
      "Review and approve the new quote.",
      { approvedGpu: approved.gpu.id, approvedDatacenter: approved.datacenterId, freshGpu: fresh.gpu.id, freshDatacenter: fresh.datacenterId },
    );
  }
  const rate = (quote: CloudQuote): number => quote.gpuRange.maxUsdPerHour + (quote.cpu?.priceUsdPerHour ?? 0);
  if (rate(fresh) > rate(approved) * (1 + PRICE_TOLERANCE)) {
    throw rejected(
      "CLOUD_REQUOTE_REQUIRED",
      `The hourly price rose from $${round(rate(approved))} to $${round(rate(fresh))} since approval.`,
      "Review and approve the new quote.",
      { approvedRate: rate(approved), freshRate: rate(fresh) },
    );
  }

  assertStorageAndCoverageUnchanged(approved, fresh);
}

/** What the budget does and does not cover, independent of the wording of the disclosures. */
function coverageShape(quote: CloudQuote) {
  return {
    diskGb: quote.cost.temporaryStorage.diskGb,
    machines: quote.cost.temporaryStorage.machines,
    diskCounted: quote.cost.temporaryStorage.worstCaseUsd !== null,
    recurring: quote.cost.recurringStorage.recurring,
    volumeGb: quote.cost.recurringStorage.volumeGb,
    volumeRateKnown: quote.cost.recurringStorage.usdPerMonth !== null,
    unknownCount: quote.budgetCoverage.unknown.length,
  };
}

/**
 * Approval covers what the user saw: the same costs counted, the same costs unknown, and storage
 * amounts no more than a tolerance higher. An unknown rate becoming known (or the reverse) changes
 * what the budget covers, so it needs a fresh approval even if the new figure looks small.
 */
function assertStorageAndCoverageUnchanged(approved: CloudQuote, fresh: CloudQuote): void {
  const before = coverageShape(approved);
  const after = coverageShape(fresh);
  const changed = (Object.keys(before) as Array<keyof typeof before>).filter((key) => before[key] !== after[key]);
  if (changed.length > 0) {
    throw rejected(
      "CLOUD_REQUOTE_REQUIRED",
      `Storage cost coverage changed since approval (${changed.join(", ")}): costs that were ${before.diskCounted && after.diskCounted ? "" : "unknown or "}uncounted may now be known, or the reverse.`,
      "Review the new quote, including what the budget covers, and approve it again.",
      { changed, approved: before, fresh: after },
    );
  }
  const risen = (from: number | null, to: number | null, floor: number): boolean => from !== null && to !== null && to > from * (1 + PRICE_TOLERANCE) && to - from >= floor;
  if (risen(approved.cost.temporaryStorage.worstCaseUsd, fresh.cost.temporaryStorage.worstCaseUsd, STORAGE_NOISE_FLOOR_USD)) {
    throw rejected(
      "CLOUD_REQUOTE_REQUIRED",
      `Container disk cost rose from $${approved.cost.temporaryStorage.worstCaseUsd} to $${fresh.cost.temporaryStorage.worstCaseUsd} since approval.`,
      "Review and approve the new quote.",
      { approved: approved.cost.temporaryStorage.worstCaseUsd, fresh: fresh.cost.temporaryStorage.worstCaseUsd },
    );
  }
  if (risen(approved.cost.recurringStorage.usdPerMonth, fresh.cost.recurringStorage.usdPerMonth, RECURRING_NOISE_FLOOR_USD_PER_MONTH)) {
    throw rejected(
      "CLOUD_REQUOTE_REQUIRED",
      `Recurring volume storage rose from $${approved.cost.recurringStorage.usdPerMonth}/month to $${fresh.cost.recurringStorage.usdPerMonth}/month since approval.`,
      "Review and approve the new quote.",
      { approved: approved.cost.recurringStorage.usdPerMonth, fresh: fresh.cost.recurringStorage.usdPerMonth },
    );
  }
  if (risen(approved.cost.worstCaseBudgetedUsd, fresh.cost.worstCaseBudgetedUsd, STORAGE_NOISE_FLOOR_USD)) {
    throw rejected(
      "CLOUD_REQUOTE_REQUIRED",
      `The worst-case cost counted against the budget rose from $${approved.cost.worstCaseBudgetedUsd} to $${fresh.cost.worstCaseBudgetedUsd} since approval.`,
      "Review and approve the new quote.",
      { approved: approved.cost.worstCaseBudgetedUsd, fresh: fresh.cost.worstCaseBudgetedUsd },
    );
  }
}
