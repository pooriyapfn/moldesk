import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type Database from "better-sqlite3";
import type { MoldeskPaths } from "@moldesk/runtime";

/**
 * Cloud journal: the durable record of paid-resource intent and ownership, kept in
 * `<state>/cloud.sqlite`. Scientific history stays in each run's `run.json`; this file only exists
 * so a restarted client can find, reconcile and clean up what it created. It never stores secrets.
 */

export type CloudJobStage =
  | "quoted"
  | "approved"
  | "provisioning"
  | "preparing_assets"
  | "installing_runtime"
  | "running"
  | "transferring"
  | "cleaning_up"
  | "done";

export type CloudJobStatus = "active" | "succeeded" | "failed" | "cancelled" | "cleanup_pending";
export type CloudResourceRole = "cpu" | "gpu" | "volume";
export type CloudResourceState = "create_pending" | "active" | "delete_pending" | "deleted";
export type CloudCacheState = "PREPARING" | "VERIFYING" | "READY" | "FAILED";
export type CloudCachePolicy = "ephemeral" | "persistent";

export interface CloudJobRecord {
  runId: string;
  accountScope: string;
  quoteDigest: string;
  cachePolicy: CloudCachePolicy;
  stage: CloudJobStage;
  status: CloudJobStatus;
  gpuId: string | null;
  datacenterId: string | null;
  volumeId: string | null;
  /** ISO time after which all of this job's resources must be gone. */
  deadlineAt: string;
  /** Registration id of the independent deadline guard, so recovery can disarm it. */
  guardId: string | null;
  manifestDigest: string;
  runtimeDigest: string | null;
  transferState: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudResourceRecord {
  intentId: string;
  runId: string | null;
  clientId: string;
  role: CloudResourceRole;
  name: string;
  providerId: string | null;
  state: CloudResourceState;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudCacheRecord {
  accountScope: string;
  datacenterId: string;
  volumeId: string;
  model: string;
  modelVersion: string;
  cacheKey: string;
  layoutRevision: string;
  manifestDigest: string;
  cachePath: string;
  sizeBytes: number | null;
  checksumManifestDigest: string | null;
  state: CloudCacheState;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  lastUsedAt: string;
}

export interface NewCloudJob {
  runId: string;
  accountScope: string;
  quoteDigest: string;
  cachePolicy: CloudCachePolicy;
  gpuId?: string;
  datacenterId?: string;
  deadlineAt: string;
  manifestDigest: string;
}

/** What a provider listing says exists, reduced to what reconciliation needs. */
export interface ProviderResourceView {
  providerId: string;
  name: string;
  role: CloudResourceRole;
}

export interface ReconciliationReport {
  /** Provider resources whose name claims this client but that no journal row owns. Never auto-deleted. */
  orphaned: ProviderResourceView[];
  /** Journal rows the provider no longer has; they were marked deleted. */
  vanished: CloudResourceRecord[];
  /** `create_pending` rows that matched a provider resource by name; their provider ID was recorded. */
  adopted: CloudResourceRecord[];
  /** `create_pending` rows with no provider match: the create never took effect. Marked deleted. */
  abandoned: CloudResourceRecord[];
  /** Rows whose deletion is still owed (delete_pending, or past deadline and still active). */
  cleanupOwed: CloudResourceRecord[];
}

const SCHEMA_VERSION = 1;

/** Loaded lazily so a platform without a better-sqlite3 binary only breaks cloud commands, not the whole CLI. */
function loadDatabase(): typeof Database {
  return createRequire(import.meta.url)("better-sqlite3") as typeof Database;
}
const RESOURCE_NAME_PREFIX = "moldesk";

function nowIso(): string {
  return new Date().toISOString();
}

/** `moldesk-<client8>-<run8>-<role>`: discovery hint only; ownership is decided by journal match. */
export function cloudResourceName(clientId: string, runId: string, role: CloudResourceRole): string {
  const client = clientId.replace(/-/g, "").slice(0, 8);
  // Run IDs end in a UUID; use its first block so the name stays short and stable.
  const run = (runId.split("-").slice(-5)[0] ?? runId).slice(0, 8);
  return `${RESOURCE_NAME_PREFIX}-${client}-${run}-${role}`;
}

function parseResourceName(name: string): { client: string; run: string; role: CloudResourceRole } | undefined {
  const match = /^moldesk-([0-9a-f]{8})-([0-9a-f]{8})-(cpu|gpu|volume)$/.exec(name);
  return match ? { client: match[1]!, run: match[2]!, role: match[3] as CloudResourceRole } : undefined;
}

type Row = Record<string, unknown>;

function toJob(row: Row): CloudJobRecord {
  return {
    runId: row.run_id as string,
    accountScope: row.account_scope as string,
    quoteDigest: row.quote_digest as string,
    cachePolicy: row.cache_policy as CloudCachePolicy,
    stage: row.stage as CloudJobStage,
    status: row.status as CloudJobStatus,
    gpuId: (row.gpu_id as string | null) ?? null,
    datacenterId: (row.datacenter_id as string | null) ?? null,
    volumeId: (row.volume_id as string | null) ?? null,
    deadlineAt: row.deadline_at as string,
    guardId: (row.guard_id as string | null) ?? null,
    manifestDigest: row.manifest_digest as string,
    runtimeDigest: (row.runtime_digest as string | null) ?? null,
    transferState: (row.transfer_state as string | null) ?? null,
    error: row.error_code ? { code: row.error_code as string, message: row.error_message as string } : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toResource(row: Row): CloudResourceRecord {
  return {
    intentId: row.intent_id as string,
    runId: (row.run_id as string | null) ?? null,
    clientId: row.client_id as string,
    role: row.role as CloudResourceRole,
    name: row.name as string,
    providerId: (row.provider_id as string | null) ?? null,
    state: row.state as CloudResourceState,
    deadlineAt: (row.deadline_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toCache(row: Row): CloudCacheRecord {
  return {
    accountScope: row.account_scope as string,
    datacenterId: row.datacenter_id as string,
    volumeId: row.volume_id as string,
    model: row.model as string,
    modelVersion: row.model_version as string,
    cacheKey: row.cache_key as string,
    layoutRevision: row.layout_revision as string,
    manifestDigest: row.manifest_digest as string,
    cachePath: row.cache_path as string,
    sizeBytes: (row.size_bytes as number | null) ?? null,
    checksumManifestDigest: (row.checksum_manifest_digest as string | null) ?? null,
    state: row.state as CloudCacheState,
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
    createdAt: row.created_at as string,
    lastUsedAt: row.last_used_at as string,
  };
}

export class CloudJournal {
  private constructor(
    private readonly db: Database.Database,
    /** Stable per-installation identity used in resource names. */
    readonly clientId: string,
    private readonly now: () => string,
  ) {}

  static open(paths: MoldeskPaths, options: { now?: () => string } = {}): CloudJournal {
    fs.mkdirSync(paths.state, { recursive: true });
    return CloudJournal.openFile(path.join(paths.state, "cloud.sqlite"), options);
  }

  static openFile(file: string, options: { now?: () => string } = {}): CloudJournal {
    const db = new (loadDatabase())(file);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    CloudJournal.migrate(db);
    const existing = db.prepare("SELECT value FROM meta WHERE key = 'client_id'").get() as { value: string } | undefined;
    let clientId = existing?.value;
    if (!clientId) {
      clientId = randomUUID();
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('client_id', ?)").run(clientId);
      clientId = (db.prepare("SELECT value FROM meta WHERE key = 'client_id'").get() as { value: string }).value;
    }
    return new CloudJournal(db, clientId, options.now ?? nowIso);
  }

  private static migrate(db: Database.Database): void {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new Error(`cloud.sqlite schema version ${version} is newer than this MoleculeDesk supports (${SCHEMA_VERSION}).`);
    }
    if (version === SCHEMA_VERSION) return;
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cloud_jobs (
          run_id TEXT PRIMARY KEY,
          account_scope TEXT NOT NULL,
          quote_digest TEXT NOT NULL,
          cache_policy TEXT NOT NULL CHECK (cache_policy IN ('ephemeral','persistent')),
          stage TEXT NOT NULL,
          status TEXT NOT NULL,
          gpu_id TEXT,
          datacenter_id TEXT,
          volume_id TEXT,
          deadline_at TEXT NOT NULL,
          guard_id TEXT,
          manifest_digest TEXT NOT NULL,
          runtime_digest TEXT,
          transfer_state TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cloud_resources (
          intent_id TEXT PRIMARY KEY,
          run_id TEXT,
          client_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('cpu','gpu','volume')),
          name TEXT NOT NULL,
          provider_id TEXT,
          state TEXT NOT NULL CHECK (state IN ('create_pending','active','delete_pending','deleted')),
          deadline_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cloud_resources_state ON cloud_resources (state);
        CREATE INDEX IF NOT EXISTS cloud_resources_provider ON cloud_resources (provider_id);
        CREATE TABLE IF NOT EXISTS cloud_caches (
          account_scope TEXT NOT NULL,
          datacenter_id TEXT NOT NULL,
          volume_id TEXT NOT NULL,
          model TEXT NOT NULL,
          model_version TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          layout_revision TEXT NOT NULL,
          manifest_digest TEXT NOT NULL,
          cache_path TEXT NOT NULL,
          size_bytes INTEGER,
          checksum_manifest_digest TEXT,
          state TEXT NOT NULL CHECK (state IN ('PREPARING','VERIFYING','READY','FAILED')),
          lease_owner TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          PRIMARY KEY (account_scope, datacenter_id, volume_id, cache_key)
        );
      `);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  close(): void {
    this.db.close();
  }

  // --- jobs ---------------------------------------------------------------------------------

  createJob(job: NewCloudJob): CloudJobRecord {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO cloud_jobs (run_id, account_scope, quote_digest, cache_policy, stage, status, gpu_id, datacenter_id,
           deadline_at, manifest_digest, created_at, updated_at)
         VALUES (@runId, @accountScope, @quoteDigest, @cachePolicy, 'approved', 'active', @gpuId, @datacenterId,
           @deadlineAt, @manifestDigest, @at, @at)`,
      )
      .run({ ...job, gpuId: job.gpuId ?? null, datacenterId: job.datacenterId ?? null, at });
    return this.getJob(job.runId)!;
  }

  getJob(runId: string): CloudJobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM cloud_jobs WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? toJob(row) : undefined;
  }

  updateJob(
    runId: string,
    patch: Partial<Pick<CloudJobRecord, "stage" | "status" | "gpuId" | "datacenterId" | "volumeId" | "guardId" | "runtimeDigest" | "transferState" | "error">>,
  ): CloudJobRecord {
    const columns: Record<string, unknown> = {
      stage: patch.stage,
      status: patch.status,
      gpu_id: patch.gpuId,
      datacenter_id: patch.datacenterId,
      volume_id: patch.volumeId,
      guard_id: patch.guardId,
      runtime_digest: patch.runtimeDigest,
      transfer_state: patch.transferState,
    };
    if (patch.error !== undefined) {
      columns.error_code = patch.error?.code ?? null;
      columns.error_message = patch.error?.message ?? null;
    }
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
    const assignments = [...entries.map(([key]) => `${key} = @${key}`), "updated_at = @updated_at"].join(", ");
    const result = this.db
      .prepare(`UPDATE cloud_jobs SET ${assignments} WHERE run_id = @run_id`)
      .run({ ...Object.fromEntries(entries), updated_at: this.now(), run_id: runId });
    if (result.changes === 0) throw new Error(`No cloud job for run ${runId}.`);
    return this.getJob(runId)!;
  }

  /** Jobs that have not reached a terminal status, or whose cleanup is still owed. */
  listOpenJobs(): CloudJobRecord[] {
    const rows = this.db.prepare("SELECT * FROM cloud_jobs WHERE status IN ('active','cleanup_pending') ORDER BY created_at").all() as Row[];
    return rows.map(toJob);
  }

  // --- resources ----------------------------------------------------------------------------

  /** Persist intent BEFORE calling the provider. The returned `name` is what must be sent to it. */
  recordResourceIntent(input: { runId?: string; role: CloudResourceRole; deadlineAt?: string; intentId?: string }): CloudResourceRecord {
    const intentId = input.intentId ?? randomUUID();
    const at = this.now();
    const name = cloudResourceName(this.clientId, input.runId ?? intentId, input.role);
    this.db
      .prepare(
        `INSERT INTO cloud_resources (intent_id, run_id, client_id, role, name, state, deadline_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'create_pending', ?, ?, ?)`,
      )
      .run(intentId, input.runId ?? null, this.clientId, input.role, name, input.deadlineAt ?? null, at, at);
    return this.getResource(intentId)!;
  }

  /** Record the provider ID immediately after the create response. */
  recordResourceCreated(intentId: string, providerId: string): CloudResourceRecord {
    return this.transitionResource(intentId, ["create_pending"], "active", providerId);
  }

  /** Persist deletion intent BEFORE calling the provider's delete. */
  markResourceDeletePending(intentId: string): CloudResourceRecord {
    return this.transitionResource(intentId, ["create_pending", "active", "delete_pending"], "delete_pending");
  }

  /** Call only after the provider confirmed deletion or confirmed absence. */
  markResourceDeleted(intentId: string): CloudResourceRecord {
    return this.transitionResource(intentId, ["create_pending", "active", "delete_pending", "deleted"], "deleted");
  }

  private transitionResource(intentId: string, from: CloudResourceState[], to: CloudResourceState, providerId?: string): CloudResourceRecord {
    const current = this.getResource(intentId);
    if (!current) throw new Error(`No cloud resource intent ${intentId}.`);
    if (!from.includes(current.state)) {
      throw new Error(`Cannot move cloud resource ${intentId} from ${current.state} to ${to}.`);
    }
    this.db
      .prepare("UPDATE cloud_resources SET state = ?, provider_id = COALESCE(?, provider_id), updated_at = ? WHERE intent_id = ?")
      .run(to, providerId ?? null, this.now(), intentId);
    return this.getResource(intentId)!;
  }

  getResource(intentId: string): CloudResourceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM cloud_resources WHERE intent_id = ?").get(intentId) as Row | undefined;
    return row ? toResource(row) : undefined;
  }

  /** Authorization check before any delete: only a journal row owned by this client may be deleted. */
  findOwnedByProviderId(providerId: string): CloudResourceRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM cloud_resources WHERE provider_id = ? AND client_id = ? AND state != 'deleted'")
      .get(providerId, this.clientId) as Row | undefined;
    return row ? toResource(row) : undefined;
  }

  listResources(filter: { runId?: string; states?: CloudResourceState[] } = {}): CloudResourceRecord[] {
    const rows = this.db.prepare("SELECT * FROM cloud_resources ORDER BY created_at").all() as Row[];
    return rows
      .map(toResource)
      .filter((row) => (filter.runId === undefined || row.runId === filter.runId) && (filter.states === undefined || filter.states.includes(row.state)));
  }

  /**
   * Compare the journal with a provider listing. Pure bookkeeping plus journal updates; it never
   * calls the provider and never deletes anything. Names are discovery hints only: a provider
   * resource that merely looks ours is reported as orphaned, not adopted by guesswork, unless it
   * matches a `create_pending` row's exact name (an ambiguous create that did take effect).
   */
  reconcile(provider: ProviderResourceView[]): ReconciliationReport {
    const report: ReconciliationReport = { orphaned: [], vanished: [], adopted: [], abandoned: [], cleanupOwed: [] };
    const byProviderId = new Map(provider.map((resource) => [resource.providerId, resource]));
    const knownProviderIds = new Set<string>();
    const clientPrefix = this.clientId.replace(/-/g, "").slice(0, 8);

    this.db.transaction(() => {
      for (const row of this.listResources({ states: ["create_pending", "active", "delete_pending"] })) {
        if (row.state === "create_pending") {
          const matches = provider.filter((candidate) => candidate.name === row.name && candidate.role === row.role && !this.findOwnedByProviderId(candidate.providerId));
          if (matches.length === 1) {
            knownProviderIds.add(matches[0]!.providerId);
            report.adopted.push(this.recordResourceCreated(row.intentId, matches[0]!.providerId));
          } else if (matches.length === 0) {
            report.abandoned.push(this.markResourceDeleted(row.intentId));
          } else {
            // Several candidates share the name: cannot decide ownership safely; leave pending and flag.
            for (const match of matches) report.orphaned.push(match);
          }
          continue;
        }
        if (row.providerId) knownProviderIds.add(row.providerId);
        if (row.providerId && !byProviderId.has(row.providerId)) {
          report.vanished.push(this.markResourceDeleted(row.intentId));
          continue;
        }
        const overdue = row.state === "active" && row.deadlineAt !== null && row.deadlineAt <= this.now();
        if (row.state === "delete_pending" || overdue) report.cleanupOwed.push(row);
      }
    })();

    for (const resource of provider) {
      if (knownProviderIds.has(resource.providerId) || this.findOwnedByProviderId(resource.providerId)) continue;
      if (report.orphaned.some((entry) => entry.providerId === resource.providerId)) continue;
      const parsed = parseResourceName(resource.name);
      if (parsed && parsed.client === clientPrefix) report.orphaned.push(resource);
    }
    return report;
  }

  // --- caches -------------------------------------------------------------------------------

  upsertCache(cache: Omit<CloudCacheRecord, "createdAt" | "lastUsedAt" | "leaseOwner" | "leaseExpiresAt" | "state"> & { state?: CloudCacheState }): CloudCacheRecord {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO cloud_caches (account_scope, datacenter_id, volume_id, model, model_version, cache_key, layout_revision,
           manifest_digest, cache_path, size_bytes, checksum_manifest_digest, state, created_at, last_used_at)
         VALUES (@accountScope, @datacenterId, @volumeId, @model, @modelVersion, @cacheKey, @layoutRevision,
           @manifestDigest, @cachePath, @sizeBytes, @checksumManifestDigest, @state, @at, @at)
         ON CONFLICT (account_scope, datacenter_id, volume_id, cache_key) DO UPDATE SET
           manifest_digest = excluded.manifest_digest, cache_path = excluded.cache_path, last_used_at = excluded.last_used_at`,
      )
      .run({ ...cache, state: cache.state ?? "PREPARING", sizeBytes: cache.sizeBytes ?? null, checksumManifestDigest: cache.checksumManifestDigest ?? null, at });
    return this.getCache(cache.accountScope, cache.datacenterId, cache.volumeId, cache.cacheKey)!;
  }

  getCache(accountScope: string, datacenterId: string, volumeId: string, cacheKey: string): CloudCacheRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM cloud_caches WHERE account_scope = ? AND datacenter_id = ? AND volume_id = ? AND cache_key = ?")
      .get(accountScope, datacenterId, volumeId, cacheKey) as Row | undefined;
    return row ? toCache(row) : undefined;
  }

  listCaches(): CloudCacheRecord[] {
    return (this.db.prepare("SELECT * FROM cloud_caches ORDER BY created_at").all() as Row[]).map(toCache);
  }

  /** Allowed: PREPARING → VERIFYING → READY, and any → FAILED. READY is never set without verification. */
  setCacheState(
    key: Pick<CloudCacheRecord, "accountScope" | "datacenterId" | "volumeId" | "cacheKey">,
    next: CloudCacheState,
    details: { sizeBytes?: number; checksumManifestDigest?: string } = {},
  ): CloudCacheRecord {
    const current = this.getCache(key.accountScope, key.datacenterId, key.volumeId, key.cacheKey);
    if (!current) throw new Error("No such cloud cache.");
    const allowed: Record<CloudCacheState, CloudCacheState[]> = {
      PREPARING: ["VERIFYING", "FAILED"],
      VERIFYING: ["READY", "FAILED"],
      READY: ["FAILED"],
      FAILED: ["PREPARING"],
    };
    if (!allowed[current.state].includes(next)) throw new Error(`Cannot move cloud cache from ${current.state} to ${next}.`);
    if (next === "READY" && !(details.checksumManifestDigest ?? current.checksumManifestDigest)) {
      throw new Error("A cache cannot become READY without a checksum manifest digest.");
    }
    this.db
      .prepare(
        `UPDATE cloud_caches SET state = ?, size_bytes = COALESCE(?, size_bytes),
           checksum_manifest_digest = COALESCE(?, checksum_manifest_digest), last_used_at = ?
         WHERE account_scope = ? AND datacenter_id = ? AND volume_id = ? AND cache_key = ?`,
      )
      .run(next, details.sizeBytes ?? null, details.checksumManifestDigest ?? null, this.now(), key.accountScope, key.datacenterId, key.volumeId, key.cacheKey);
    return this.getCache(key.accountScope, key.datacenterId, key.volumeId, key.cacheKey)!;
  }

  /**
   * Lease for same-client concurrency. Succeeds if unheld, expired, or already ours (renewal).
   * Cross-machine safety additionally needs the on-volume lock; this alone does not provide it.
   */
  acquireCacheLease(
    key: Pick<CloudCacheRecord, "accountScope" | "datacenterId" | "volumeId" | "cacheKey">,
    owner: string,
    ttlSeconds: number,
  ): boolean {
    const at = this.now();
    const expires = new Date(Date.parse(at) + ttlSeconds * 1000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE cloud_caches SET lease_owner = ?, lease_expires_at = ?
         WHERE account_scope = ? AND datacenter_id = ? AND volume_id = ? AND cache_key = ?
           AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at <= ?)`,
      )
      .run(owner, expires, key.accountScope, key.datacenterId, key.volumeId, key.cacheKey, owner, at);
    return result.changes === 1;
  }

  releaseCacheLease(key: Pick<CloudCacheRecord, "accountScope" | "datacenterId" | "volumeId" | "cacheKey">, owner: string): void {
    this.db
      .prepare(
        `UPDATE cloud_caches SET lease_owner = NULL, lease_expires_at = NULL
         WHERE account_scope = ? AND datacenter_id = ? AND volume_id = ? AND cache_key = ? AND lease_owner = ?`,
      )
      .run(key.accountScope, key.datacenterId, key.volumeId, key.cacheKey, owner);
  }

  deleteCache(key: Pick<CloudCacheRecord, "accountScope" | "datacenterId" | "volumeId" | "cacheKey">): void {
    this.db
      .prepare("DELETE FROM cloud_caches WHERE account_scope = ? AND datacenter_id = ? AND volume_id = ? AND cache_key = ?")
      .run(key.accountScope, key.datacenterId, key.volumeId, key.cacheKey);
  }
}
