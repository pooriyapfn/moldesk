import type { WorkerBundle } from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";

/**
 * The published, checksummed worker bundle matching this release. Intentionally unset until a
 * release bundle has been built, published and validated on a clean machine; cloud runs refuse to
 * start without one. See packages/core/scripts/build-worker.mjs.
 */
export const RELEASED_WORKER_BUNDLE: WorkerBundle | undefined = undefined;

/**
 * Environment override for development and self-hosting: both values are required, the URL must be
 * HTTPS and the checksum a full SHA-256, so a bundle is never fetched without verification.
 */
export function resolveWorkerBundle(env: NodeJS.ProcessEnv = process.env): WorkerBundle | undefined {
  const url = env.MOLDESK_WORKER_BUNDLE_URL;
  const sha256 = env.MOLDESK_WORKER_BUNDLE_SHA256;
  if (url === undefined && sha256 === undefined) return RELEASED_WORKER_BUNDLE;
  if (!url || !sha256 || !/^https:\/\//.test(url) || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new MoldeskError({
      code: "CLOUD_WORKER_BUNDLE_INVALID",
      message: "MOLDESK_WORKER_BUNDLE_URL and MOLDESK_WORKER_BUNDLE_SHA256 must both be set, with an https URL and a 64-character SHA-256.",
      remediation: "Set both variables, or unset them to use the bundle published with this release.",
    });
  }
  return { url, sha256: sha256.toLowerCase() };
}
