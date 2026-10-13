import {
  CredentialStore,
  RunpodProvider,
  credentialFingerprint,
  getMoldeskPaths,
  type CloudPod,
  type CloudProvider,
  type CloudVolume,
  type CredentialSource,
  type MoldeskPaths,
} from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import { CloudJournal, type CloudJobRecord, type CloudResourceRecord, type ProviderResourceView, type ReconciliationReport } from "./state.js";

/** Builds a provider that resolves its key per request via `getApiKey`. Injected for tests. */
export type CloudProviderFactory = (provider: string, getApiKey: () => Promise<string>) => CloudProvider;

export interface CloudAccountDeps {
  paths?: MoldeskPaths;
  store?: CredentialStore;
  createProvider?: CloudProviderFactory;
}

export const defaultProviderFactory: CloudProviderFactory = (provider, getApiKey) => {
  if (provider !== "runpod") {
    throw new MoldeskError({ code: "CREDENTIAL_UNSUPPORTED_PROVIDER", message: `Unknown cloud provider "${provider}".`, remediation: "Use a supported provider, e.g. runpod." });
  }
  return new RunpodProvider({ getApiKey });
};

function resolveDeps(deps: CloudAccountDeps) {
  return {
    paths: deps.paths ?? getMoldeskPaths(),
    store: deps.store ?? new CredentialStore(),
    createProvider: deps.createProvider ?? defaultProviderFactory,
  };
}

export interface ConnectResult {
  provider: string;
  /** Where future runs will read the key from. Env and .env override the keyring. */
  storedIn: "keyring";
  /** Present when an environment or .env key will still take precedence over the stored one. */
  overriddenBy?: CredentialSource;
  checkedAt: string;
}

/**
 * Validates the candidate key with a minimal read-only call and only then stores it. A key that
 * fails validation is never written anywhere.
 */
export async function connectCloudProvider(provider: string, key: string, deps: CloudAccountDeps = {}): Promise<ConnectResult> {
  const { store, createProvider } = resolveDeps(deps);
  // Shape-check first so obviously broken pastes never leave the machine.
  await store.validate(provider, key);
  const check = await createProvider(provider, async () => key).validateCredentials();
  await store.set(provider, key);
  const active = await store.resolve(provider);
  return {
    provider,
    storedIn: "keyring",
    ...(active && active.source !== "keyring" ? { overriddenBy: active.source } : {}),
    checkedAt: check.checkedAt,
  };
}

export async function disconnectCloudProvider(provider: string, deps: CloudAccountDeps = {}): Promise<{ removed: boolean }> {
  const { store } = resolveDeps(deps);
  return { removed: await store.delete(provider) };
}

export interface CloudStatus {
  provider: string;
  credential: { source: CredentialSource | "none" };
  /** Result of a live read-only check; absent when no credential exists. */
  connection?: { ok: true; checkedAt: string } | { ok: false; code: string; message: string };
  /** Non-secret credential identifier usable as an account scope. */
  accountScope?: string;
  journal: { openJobs: CloudJobRecord[]; unresolvedResources: CloudResourceRecord[] };
}

export async function getCloudStatus(provider: string, deps: CloudAccountDeps = {}): Promise<CloudStatus> {
  const { paths, store, createProvider } = resolveDeps(deps);
  const journal = CloudJournal.open(paths);
  try {
    const resolved = await store.resolve(provider);
    const status: CloudStatus = {
      provider,
      credential: { source: resolved?.source ?? "none" },
      journal: {
        openJobs: journal.listOpenJobs(),
        unresolvedResources: journal.listResources({ states: ["create_pending", "active", "delete_pending"] }),
      },
    };
    if (resolved) {
      status.accountScope = credentialFingerprint(resolved.key, journal.clientId);
      try {
        status.connection = await createProvider(provider, async () => resolved.key).validateCredentials();
      } catch (error) {
        status.connection = {
          ok: false,
          code: error instanceof MoldeskError ? error.code : "CLOUD_UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return status;
  } finally {
    journal.close();
  }
}

export interface CloudResourceListing {
  provider: string;
  /** Provider pods/volumes the journal owns, with their current provider state. */
  owned: Array<{ record: CloudResourceRecord; kind: "pod" | "volume"; status?: string; costUsdPerHour?: number | null; sizeGb?: number }>;
  /** Names that claim this client but have no journal owner. Report only; never auto-deleted. */
  orphaned: ProviderResourceView[];
  /** Deletion is still owed (pending, or past deadline). */
  cleanupOwed: CloudResourceRecord[];
  /** Everything else on the account, counted but not listed. */
  unmanagedCount: number;
  /** Journal changes made while reconciling. */
  reconciliation: Pick<ReconciliationReport, "adopted" | "abandoned" | "vanished">;
}

function toView(resource: CloudPod | CloudVolume, kind: "pod" | "volume"): ProviderResourceView {
  const match = /-(cpu|gpu|volume)$/.exec(resource.name);
  return { providerId: resource.id, name: resource.name, role: (match?.[1] as ProviderResourceView["role"] | undefined) ?? (kind === "volume" ? "volume" : "gpu") };
}

/** Lists what this installation owns on the provider and reconciles the journal. Read-only toward the provider. */
export async function listCloudResources(provider: string, deps: CloudAccountDeps = {}): Promise<CloudResourceListing> {
  const { paths, store, createProvider } = resolveDeps(deps);
  const credential = await store.require(provider);
  const api = createProvider(provider, async () => credential.key);
  const [pods, volumes] = await Promise.all([api.listPods(), api.listVolumes()]);
  const live = pods.filter((pod) => pod.status !== "TERMINATED");

  const journal = CloudJournal.open(paths);
  try {
    const report = journal.reconcile([...live.map((pod) => toView(pod, "pod")), ...volumes.map((volume) => toView(volume, "volume"))]);
    const podById = new Map(live.map((pod) => [pod.id, pod]));
    const volumeById = new Map(volumes.map((volume) => [volume.id, volume]));
    const owned: CloudResourceListing["owned"] = [];
    for (const record of journal.listResources({ states: ["active", "delete_pending"] })) {
      if (!record.providerId) continue;
      const pod = podById.get(record.providerId);
      const volume = volumeById.get(record.providerId);
      if (pod) owned.push({ record, kind: "pod", status: pod.status, costUsdPerHour: pod.costUsdPerHour });
      else if (volume) owned.push({ record, kind: "volume", sizeGb: volume.sizeGb });
    }
    const ownedIds = new Set(owned.map((entry) => entry.record.providerId));
    const orphanedIds = new Set(report.orphaned.map((entry) => entry.providerId));
    const unmanagedCount = [...live, ...volumes].filter((resource) => !ownedIds.has(resource.id) && !orphanedIds.has(resource.id)).length;
    return {
      provider,
      owned,
      orphaned: report.orphaned,
      cleanupOwed: report.cleanupOwed,
      unmanagedCount,
      reconciliation: { adopted: report.adopted, abandoned: report.abandoned, vanished: report.vanished },
    };
  } finally {
    journal.close();
  }
}
