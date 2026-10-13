import {
  CredentialStore,
  RunpodExecutionBackend,
  RunpodProvider,
  createKeyringTokenStore,
  credentialFingerprint,
  getMoldeskPaths,
  type MoldeskPaths,
  type TokenStore,
  type WorkerBundle,
} from "@moldesk/runtime";
import { resolveDeadlineGuard, type DeadlineGuard } from "./guard.js";
import type { CloudRunDeps } from "./run.js";
import { CloudJournal } from "./state.js";
import { resolveWorkerBundle } from "./worker-release.js";

export interface RunpodDepsOptions {
  paths?: MoldeskPaths;
  store?: CredentialStore;
  tokenStore?: TokenStore;
  workerBundle?: WorkerBundle;
  guard?: DeadlineGuard;
  env?: NodeJS.ProcessEnv;
}

/**
 * Production wiring for Runpod: key from the credential store (read per request), account scope from
 * a keyed credential fingerprint, per-job tokens in the keyring, and the deadline guard resolver,
 * which refuses until a verified independent scheduler exists.
 */
export async function createRunpodCloudDeps(options: RunpodDepsOptions = {}): Promise<CloudRunDeps> {
  const paths = options.paths ?? getMoldeskPaths();
  const store = options.store ?? new CredentialStore();
  const credential = await store.require("runpod");
  const journal = CloudJournal.open(paths);
  const accountScope = (() => {
    try {
      return credentialFingerprint(credential.key, journal.clientId);
    } finally {
      journal.close();
    }
  })();
  const provider = new RunpodProvider({ getApiKey: async () => (await store.require("runpod")).key });
  const bundle = options.workerBundle ?? resolveWorkerBundle(options.env);
  const backend = new RunpodExecutionBackend({
    provider,
    tokenStore: options.tokenStore ?? createKeyringTokenStore(),
    ...(bundle ? { workerBundle: bundle } : {}),
  });
  return { provider, paths, backend, guard: options.guard ?? resolveDeadlineGuard(), accountScope };
}
