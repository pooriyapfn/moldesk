/**
 * Provider-neutral contracts for rented compute. Everything here is JSON-serializable so it can be
 * journaled and reconstructed after a client restart. This is separate from the local
 * `RuntimeProvider`, which spawns processes on this machine.
 */

export type CloudPodStatus = "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED" | "ERROR" | "TERMINATED";

export interface CloudGpuType {
  id: string;
  name: string;
  memoryGb: number;
  /** Secure-cloud on-demand price, USD per GPU-hour. */
  priceUsdPerHour: number;
  /** Availability by datacenter at retrieval time; capacity is never reserved. */
  availability: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  dataCenters: Array<{ id: string; availability: string }>;
  cudaVersions: string[];
}

export interface CloudCpuType {
  id: string;
  name: string;
  priceUsdPerVcpuHour: number;
  ramGbPerVcpu: number;
  minVcpu: number;
  maxVcpu: number;
}

export interface CloudDataCenter {
  id: string;
  region: string;
  /** Empty means network volumes are unsupported there. */
  networkVolumeTypes: string[];
}

export interface CloudCatalog {
  retrievedAt: string;
  gpus: CloudGpuType[];
  cpus: CloudCpuType[];
  dataCenters: CloudDataCenter[];
}

export interface CreatePodRequest {
  name: string;
  image: string;
  containerDiskGb: number;
  dataCenterId: string;
  gpu?: { id: string; count: number };
  cpu?: { id: string; vcpuCount: number };
  volume?: { id: string; mountPath: string };
  /** `port/protocol`, e.g. `8000/http`. */
  ports?: string[];
  env?: Record<string, string>;
  entrypoint?: string[];
  cmd?: string[];
}

export interface CloudPod {
  id: string;
  name: string;
  status: CloudPodStatus;
  dataCenterId: string | null;
  /** Provider-reported hourly cost in USD while running. */
  costUsdPerHour: number | null;
  createdAt: string | null;
}

export interface CreateVolumeRequest {
  name: string;
  sizeGb: number;
  dataCenterId: string;
}

export interface CloudVolume {
  id: string;
  name: string;
  sizeGb: number;
  dataCenterId: string;
  type: string | null;
}

export interface CloudAccountCheck {
  ok: true;
  checkedAt: string;
}

/** Result of an idempotent delete: absence counts as success. */
export interface CloudDeleteResult {
  id: string;
  alreadyAbsent: boolean;
}

export interface CloudProvider {
  readonly name: string;
  /** Minimum read-only call that proves the credential works. */
  validateCredentials(): Promise<CloudAccountCheck>;
  getCatalog(): Promise<CloudCatalog>;
  createPod(request: CreatePodRequest): Promise<CloudPod>;
  getPod(id: string): Promise<CloudPod | null>;
  listPods(): Promise<CloudPod[]>;
  terminatePod(id: string): Promise<CloudDeleteResult>;
  createVolume(request: CreateVolumeRequest): Promise<CloudVolume>;
  getVolume(id: string): Promise<CloudVolume | null>;
  listVolumes(): Promise<CloudVolume[]>;
  deleteVolume(id: string): Promise<CloudDeleteResult>;
}

export type CloudErrorCode =
  | "CLOUD_AUTH_FAILED"
  | "CLOUD_FORBIDDEN"
  | "CLOUD_PAYMENT_REQUIRED"
  | "CLOUD_RATE_LIMITED"
  | "CLOUD_CAPACITY_UNAVAILABLE"
  | "CLOUD_REQUEST_REJECTED"
  | "CLOUD_BAD_RESPONSE"
  | "CLOUD_UNAVAILABLE"
  /** A create request may or may not have taken effect; discover candidates before retrying. */
  | "CLOUD_AMBIGUOUS_CREATE";
