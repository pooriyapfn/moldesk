import { describe, expect, it } from "vitest";
import { RELEASED_WORKER_BUNDLE, resolveWorkerBundle } from "./worker-release.js";

describe("resolveWorkerBundle", () => {
  it("has no released bundle yet, so cloud runs refuse by default", () => {
    expect(RELEASED_WORKER_BUNDLE).toBeUndefined();
    expect(resolveWorkerBundle({})).toBeUndefined();
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
