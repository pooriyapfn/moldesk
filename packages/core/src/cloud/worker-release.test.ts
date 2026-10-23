import { describe, expect, it } from "vitest";
import { RELEASED_WORKER_BUNDLE, resolveWorkerBundle } from "./worker-release.js";

describe("resolveWorkerBundle", () => {
  it("uses the recorded release bundle by default: an https release asset with a full SHA-256", () => {
    expect(RELEASED_WORKER_BUNDLE).toBeDefined();
    expect(RELEASED_WORKER_BUNDLE!.url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v\d+\.\d+\.\d+[^/]*\/worker\.tar$/);
    expect(RELEASED_WORKER_BUNDLE!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveWorkerBundle({})).toEqual(RELEASED_WORKER_BUNDLE);
  });

  it("accepts an https URL with a SHA-256 override and normalizes case", () => {
    expect(resolveWorkerBundle({ MOLDESK_WORKER_BUNDLE_URL: "https://example.com/w.tgz", MOLDESK_WORKER_BUNDLE_SHA256: "A".repeat(64) })).toEqual({ url: "https://example.com/w.tgz", sha256: "a".repeat(64) });
  });

  it("rejects partial, non-https or unverifiable overrides", () => {
    for (const env of [
      { MOLDESK_WORKER_BUNDLE_URL: "https://example.com/w.tgz" },
      { MOLDESK_WORKER_BUNDLE_SHA256: "a".repeat(64) },
      { MOLDESK_WORKER_BUNDLE_URL: "http://example.com/w.tgz", MOLDESK_WORKER_BUNDLE_SHA256: "a".repeat(64) },
      { MOLDESK_WORKER_BUNDLE_URL: "https://example.com/w.tgz", MOLDESK_WORKER_BUNDLE_SHA256: "short" },
    ]) {
      expect(() => resolveWorkerBundle(env)).toThrow(expect.objectContaining({ code: "CLOUD_WORKER_BUNDLE_INVALID" }));
    }
  });
});
