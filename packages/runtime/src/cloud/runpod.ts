import { MoldeskError } from "../providers.js";
import type {
  CloudAccountCheck,
  CloudCatalog,
  CloudDataCenter,
  CloudDeleteResult,
  CloudErrorCode,
  CloudPod,
  CloudPodStatus,
  CloudProvider,
  CloudVolume,
  CreatePodRequest,
  CreateVolumeRequest,
} from "./types.js";

export const RUNPOD_API_BASE = "https://api.runpod.io/v2";
/** Runpod's edge rejects default HTTP-client User-Agents (observed: Cloudflare 403, error code 1010). */
export const RUNPOD_USER_AGENT = "moldesk-runpod/1";

const POD_STATUSES: readonly CloudPodStatus[] = ["PROVISIONING", "STARTING", "RUNNING", "EXITED", "ERROR", "TERMINATED"];
const IDEMPOTENT_RETRIES = 3;
const MAX_BODY_CHARS = 500;

export interface RunpodProviderOptions {
  /** Resolved per request so the key never lives in a long-lived field or log. */
  getApiKey: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  baseUrl?: string;
  requestTimeoutMs?: number;
}

interface HttpResult {
  status: number;
  body: unknown;
  retryAfterSeconds?: number;
}

function cloudError(code: CloudErrorCode, message: string, remediation: string, details?: Record<string, unknown>, cause?: unknown): MoldeskError {
  return new MoldeskError({ code, message, remediation, details, cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw cloudError("CLOUD_BAD_RESPONSE", `Runpod response is missing "${field}".`, "Retry; if it persists the Runpod API may have changed.");
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw cloudError("CLOUD_BAD_RESPONSE", `Runpod response has an invalid "${field}".`, "Retry; if it persists the Runpod API may have changed.");
  }
  return value;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw cloudError("CLOUD_BAD_RESPONSE", `Runpod response is missing list "${field}".`, "Retry; if it persists the Runpod API may have changed.");
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw cloudError("CLOUD_BAD_RESPONSE", `Runpod response has an invalid "${field}".`, "Retry; if it persists the Runpod API may have changed.");
  return value;
}

function parsePod(value: unknown): CloudPod {
  const pod = asRecord(value, "pod");
  const status = asString(pod.status, "pod.status") as CloudPodStatus;
  if (!POD_STATUSES.includes(status)) {
    throw cloudError("CLOUD_BAD_RESPONSE", `Runpod returned an unknown pod status "${status}".`, "Update MoleculeDesk or retry.");
  }
  return {
    id: asString(pod.id, "pod.id"),
    name: typeof pod.name === "string" ? pod.name : "",
    status,
    dataCenterId: typeof pod.dataCenterId === "string" ? pod.dataCenterId : null,
    costUsdPerHour: typeof pod.cost === "number" ? pod.cost : null,
    createdAt: typeof pod.createdAt === "string" ? pod.createdAt : null,
  };
}

function parseVolume(value: unknown): CloudVolume {
  const volume = asRecord(value, "volume");
  return {
    id: asString(volume.id, "volume.id"),
    name: typeof volume.name === "string" ? volume.name : "",
    sizeGb: asNumber(volume.size, "volume.size"),
    dataCenterId: asString(volume.dataCenter, "volume.dataCenter"),
    type: typeof volume.type === "string" ? volume.type : null,
  };
}

export class RunpodProvider implements CloudProvider {
  readonly name = "runpod";
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: RunpodProviderOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.baseUrl = options.baseUrl ?? RUNPOD_API_BASE;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async validateCredentials(): Promise<CloudAccountCheck> {
    // Smallest read-only call; a restricted key may lack Pod list access (403), which is reported as such.
    await this.request("GET", "/pods", undefined, { retry: true });
    return { ok: true, checkedAt: this.now().toISOString() };
  }

  async getCatalog(): Promise<CloudCatalog> {
    const [gpus, cpus, dataCenters] = await Promise.all([
      this.request("GET", "/catalog/gpus?include=AVAILABILITY&product=POD", undefined, { retry: true }),
      this.request("GET", "/catalog/cpus", undefined, { retry: true }),
      this.request("GET", "/catalog/datacenters", undefined, { retry: true }),
    ]);
    return {
      retrievedAt: this.now().toISOString(),
      gpus: asArray(asRecord(gpus.body, "gpus").gpus, "gpus").map((raw) => {
        const gpu = asRecord(raw, "gpu");
        const price = asRecord(gpu.price, "gpu.price");
        const availability = typeof gpu.availability === "string" ? gpu.availability : "UNKNOWN";
        return {
          id: asString(gpu.id, "gpu.id"),
          name: typeof gpu.name === "string" ? gpu.name : asString(gpu.id, "gpu.id"),
          memoryGb: asNumber(gpu.memory, "gpu.memory"),
          priceUsdPerHour: asNumber(price.secure, "gpu.price.secure"),
          availability: (["NONE", "LOW", "MEDIUM", "HIGH"].includes(availability) ? availability : "UNKNOWN") as CloudCatalog["gpus"][number]["availability"],
          dataCenters: Array.isArray(gpu.dataCenters)
            ? gpu.dataCenters.filter(isRecord).map((dc) => ({ id: asString(dc.id, "gpu.dataCenters.id"), availability: String(dc.availability ?? "UNKNOWN") }))
            : [],
          cudaVersions: Array.isArray(gpu.cudaVersions)
            ? gpu.cudaVersions.filter(isRecord).filter((v) => v.available === true).map((v) => String(v.version))
            : [],
        };
      }),
      cpus: asArray(asRecord(cpus.body, "cpus").cpus, "cpus").map((raw) => {
        const cpu = asRecord(raw, "cpu");
        const vcpu = asRecord(cpu.vcpu, "cpu.vcpu");
        return {
          id: asString(cpu.id, "cpu.id"),
          name: typeof cpu.name === "string" ? cpu.name : asString(cpu.id, "cpu.id"),
          priceUsdPerVcpuHour: asNumber(asRecord(cpu.price, "cpu.price").securePerVcpu, "cpu.price.securePerVcpu"),
          ramGbPerVcpu: asNumber(cpu.ramGbPerVcpu, "cpu.ramGbPerVcpu"),
          minVcpu: asNumber(vcpu.min, "cpu.vcpu.min"),
          maxVcpu: asNumber(vcpu.max, "cpu.vcpu.max"),
        };
      }),
      dataCenters: asArray(asRecord(dataCenters.body, "datacenters").dataCenters, "dataCenters").map((raw): CloudDataCenter => {
        const dc = asRecord(raw, "dataCenter");
        return {
          id: asString(dc.id, "dataCenter.id"),
          region: typeof dc.region === "string" ? dc.region : "",
          networkVolumeTypes: Array.isArray(dc.networkVolumeTypes) ? dc.networkVolumeTypes.map(String) : [],
        };
      }),
    };
  }

  async createPod(request: CreatePodRequest): Promise<CloudPod> {
    if ((request.gpu ? 1 : 0) + (request.cpu ? 1 : 0) !== 1) {
      throw cloudError("CLOUD_REQUEST_REJECTED", "A pod needs exactly one of gpu or cpu.", "Fix the pod request.");
    }
    const body: Record<string, unknown> = {
      name: request.name,
      image: request.image,
      disk: request.containerDiskGb,
      dataCenterIds: [request.dataCenterId],
      ...(request.gpu ? { gpu: { id: request.gpu.id, count: request.gpu.count } } : {}),
      ...(request.cpu ? { cpu: { id: request.cpu.id, vcpuCount: request.cpu.vcpuCount } } : {}),
      ...(request.volume ? { mounts: { network: [{ volumeId: request.volume.id, path: request.volume.mountPath }] } } : {}),
      ...(request.ports ? { ports: request.ports } : {}),
      ...(request.env ? { env: request.env } : {}),
      // `args` as an {entrypoint, cmd} object is the form verified live against the v2 API.
      ...(request.entrypoint || request.cmd
        ? { args: JSON.stringify({ ...(request.entrypoint ? { entrypoint: request.entrypoint } : {}), ...(request.cmd ? { cmd: request.cmd } : {}) }) }
        : {}),
    };
    const result = await this.request("POST", "/pods", body, { retry: false, ambiguousOnFailure: true });
    return parsePod(result.body);
  }

  async getPod(id: string): Promise<CloudPod | null> {
    const result = await this.request("GET", `/pods/${encodeURIComponent(id)}`, undefined, { retry: true, allow404: true });
    return result.status === 404 ? null : parsePod(result.body);
  }

  async listPods(): Promise<CloudPod[]> {
    const result = await this.request("GET", "/pods", undefined, { retry: true });
    return asArray(asRecord(result.body, "pods").pods, "pods").map(parsePod);
  }

  async terminatePod(id: string): Promise<CloudDeleteResult> {
    const result = await this.request("POST", `/pods/${encodeURIComponent(id)}/action`, { action: "terminate" }, { retry: true, allow404: true });
    return { id, alreadyAbsent: result.status === 404 };
  }

  async createVolume(request: CreateVolumeRequest): Promise<CloudVolume> {
    const body = { name: request.name, size: request.sizeGb, dataCenter: request.dataCenterId };
    const result = await this.request("POST", "/network-volumes", body, { retry: false, ambiguousOnFailure: true });
    return parseVolume(result.body);
  }

  async getVolume(id: string): Promise<CloudVolume | null> {
    const result = await this.request("GET", `/network-volumes/${encodeURIComponent(id)}`, undefined, { retry: true, allow404: true });
    return result.status === 404 ? null : parseVolume(result.body);
  }

  async listVolumes(): Promise<CloudVolume[]> {
    const result = await this.request("GET", "/network-volumes", undefined, { retry: true });
    return asArray(asRecord(result.body, "volumes").networkVolumes, "networkVolumes").map(parseVolume);
  }

  async deleteVolume(id: string): Promise<CloudDeleteResult> {
    const result = await this.request("DELETE", `/network-volumes/${encodeURIComponent(id)}`, undefined, { retry: true, allow404: true });
    return { id, alreadyAbsent: result.status === 404 };
  }

  /**
   * One HTTP call with status-to-error mapping. Only `retry` calls (reads and idempotent
   * terminate/delete) are retried, on 429/5xx/network failure. Creates are never retried; a
   * failure that may have taken effect is surfaced as CLOUD_AMBIGUOUS_CREATE.
   */
  private async request(
    method: string,
    path: string,
    body: unknown,
    flags: { retry: boolean; allow404?: boolean; ambiguousOnFailure?: boolean },
  ): Promise<HttpResult> {
    const attempts = flags.retry ? IDEMPOTENT_RETRIES : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let result: HttpResult | undefined;
      try {
        result = await this.send(method, path, body);
      } catch (error) {
        lastError = flags.ambiguousOnFailure
          ? cloudError("CLOUD_AMBIGUOUS_CREATE", "The Runpod create request did not complete; the resource may exist.", "List owned resources and match by name before retrying.", { path }, error)
          : cloudError("CLOUD_UNAVAILABLE", "Could not reach Runpod.", "Check your connection and retry.", { path }, error);
        if (attempt < attempts) {
          await this.sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      }
      if (result.status >= 200 && result.status < 300) return result;
      if (result.status === 404 && flags.allow404) return result;
      const retryable = result.status === 429 || result.status >= 500;
      if (retryable && attempt < attempts) {
        await this.sleep(result.retryAfterSeconds !== undefined ? result.retryAfterSeconds * 1000 : 500 * 2 ** (attempt - 1));
        continue;
      }
      throw this.mapStatus(result, path, flags.ambiguousOnFailure === true);
    }
    throw lastError;
  }

  private async send(method: string, path: string, body: unknown): Promise<HttpResult> {
    const key = await this.options.getApiKey();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "User-Agent": RUNPOD_USER_AGENT,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text.slice(0, MAX_BODY_CHARS);
        }
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        status: response.status,
        body: parsed,
        ...(Number.isFinite(retryAfter) && retryAfter >= 0 && response.headers.get("retry-after") ? { retryAfterSeconds: retryAfter } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private mapStatus(result: HttpResult, path: string, isCreate: boolean): MoldeskError {
    const detail = isRecord(result.body) && typeof result.body.detail === "string" ? result.body.detail.slice(0, MAX_BODY_CHARS) : undefined;
    const details = { status: result.status, path, ...(detail ? { detail } : {}) };
    switch (result.status) {
      case 401:
        return cloudError("CLOUD_AUTH_FAILED", "Runpod rejected the API key.", "Run `moldesk cloud connect runpod` with a valid key.", details);
      case 402:
        return cloudError("CLOUD_PAYMENT_REQUIRED", "Runpod reports insufficient credit.", "Add credit to the Runpod account.", details);
      case 403:
        return cloudError("CLOUD_FORBIDDEN", "The Runpod API key lacks permission for this action.", "Use a key with Pod and network volume permissions.", details);
      case 429:
        return cloudError("CLOUD_RATE_LIMITED", "Runpod rate limit reached.", "Wait and retry.", { ...details, retryAfterSeconds: result.retryAfterSeconds });
      default:
        if (result.status === 400 && detail && /no longer any instances|no instances available|not enough free/i.test(detail)) {
          return cloudError("CLOUD_CAPACITY_UNAVAILABLE", "Runpod has no capacity for the requested resources.", "Pick another GPU or datacenter, or retry later. Capacity is never reserved by a quote.", details);
        }
        if (result.status >= 500) {
          return isCreate
            ? cloudError("CLOUD_AMBIGUOUS_CREATE", "Runpod failed while creating a resource; it may exist.", "List owned resources and match by name before retrying.", details)
            : cloudError("CLOUD_UNAVAILABLE", "Runpod is temporarily unavailable.", "Retry shortly.", details);
        }
        return cloudError("CLOUD_REQUEST_REJECTED", `Runpod rejected the request (${result.status}).`, "Check the request parameters.", details);
    }
  }
}
