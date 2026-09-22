import { describe, expect, it } from "vitest";
import {
  detectDocker,
  isImageCachedLocally,
  probeDockerGpuAccess,
  pullDockerImage,
} from "./index.js";
import type { CaptureFn } from "../process/index.js";

function stubCapture(
  handler: (cmd: string, args: string[]) => { code: number; stdout?: string; stderr?: string; timedOut?: boolean },
): CaptureFn {
  return async (command, args) => {
    const r = handler(command, args);
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.timedOut };
  };
}

const VERSION_OK = { code: 0, stdout: "Docker version 24.0.7, build abc\n" };

describe("detectDocker — Tier 1 (docker info runtimes)", () => {
  it("resolves 'unknown' (not 'available') when the nvidia runtime is registered", async () => {
    const capture = stubCapture((cmd, args) => {
      if (args[0] === "--version") return VERSION_OK;
      if (args[0] === "info") return { code: 0, stdout: JSON.stringify({ Runtimes: { runc: {}, nvidia: {} } }) };
      return { code: 1 };
    });
    const result = await detectDocker(capture);
    expect(result).toMatchObject({ available: true, running: true, gpuAccess: "unknown" });
  });

  it("resolves 'unavailable' when no nvidia runtime is registered", async () => {
    const capture = stubCapture((cmd, args) => {
      if (args[0] === "--version") return VERSION_OK;
      if (args[0] === "info") return { code: 0, stdout: JSON.stringify({ Runtimes: { runc: {} } }) };
      return { code: 1 };
    });
    const result = await detectDocker(capture);
    expect(result).toMatchObject({ available: true, running: true, gpuAccess: "unavailable" });
  });

  it("resolves 'unknown' when the daemon is unreachable", async () => {
    const capture = stubCapture((cmd, args) => {
      if (args[0] === "--version") return VERSION_OK;
      return { code: 1, stderr: "Cannot connect to the Docker daemon" };
    });
    const result = await detectDocker(capture);
    expect(result).toMatchObject({ available: true, running: false, gpuAccess: "unknown" });
  });

  it("falls back to 'unknown' on malformed JSON from docker info", async () => {
    const capture = stubCapture((cmd, args) => {
      if (args[0] === "--version") return VERSION_OK;
      if (args[0] === "info") return { code: 0, stdout: "not json" };
      return { code: 1 };
    });
    const result = await detectDocker(capture);
    expect(result).toMatchObject({ available: true, running: true, gpuAccess: "unknown" });
  });

  it("an explicit options.gpuAccess override always wins over the Tier-1 signal", async () => {
    const capture = stubCapture((cmd, args) => {
      if (args[0] === "--version") return VERSION_OK;
      if (args[0] === "info") return { code: 0, stdout: JSON.stringify({ Runtimes: { runc: {} } }) };
      return { code: 1 };
    });
    const result = await detectDocker(capture, { gpuAccess: "available" });
    expect(result.gpuAccess).toBe("available");
  });
});

describe("Tier 2 — isImageCachedLocally / pullDockerImage / probeDockerGpuAccess", () => {
  it("isImageCachedLocally reports a cache hit", async () => {
    const capture = stubCapture(() => ({ code: 0, stdout: "[{}]" }));
    expect(await isImageCachedLocally("img@sha256:abc", capture)).toBe(true);
  });

  it("isImageCachedLocally reports a cache miss", async () => {
    const capture = stubCapture(() => ({ code: 1, stderr: "No such image" }));
    expect(await isImageCachedLocally("img@sha256:abc", capture)).toBe(false);
  });

  it("pullDockerImage succeeds", async () => {
    const capture = stubCapture(() => ({ code: 0, stdout: "Status: Downloaded" }));
    const result = await pullDockerImage("img@sha256:abc", capture);
    expect(result.ok).toBe(true);
  });

  it("pullDockerImage reports a failure", async () => {
    const capture = stubCapture(() => ({ code: 1, stderr: "manifest unknown" }));
    const result = await pullDockerImage("img@sha256:abc", capture);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("pullDockerImage reports a timeout distinctly", async () => {
    const capture = stubCapture(() => ({ code: 0, timedOut: true }));
    const result = await pullDockerImage("img@sha256:abc", capture);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });

  it("probeDockerGpuAccess reports available on success", async () => {
    const capture = stubCapture(() => ({ code: 0, stdout: "GPU 0: NVIDIA A100" }));
    const result = await probeDockerGpuAccess("img@sha256:abc", capture);
    expect(result.access).toBe("available");
  });

  it("probeDockerGpuAccess reports unavailable on failure", async () => {
    const capture = stubCapture(() => ({ code: 1, stderr: "could not select device driver" }));
    const result = await probeDockerGpuAccess("img@sha256:abc", capture);
    expect(result.access).toBe("unavailable");
    expect(result.error).toBeTruthy();
  });

  it("probeDockerGpuAccess reports unavailable on timeout", async () => {
    const capture = stubCapture(() => ({ code: 0, timedOut: true }));
    const result = await probeDockerGpuAccess("img@sha256:abc", capture);
    expect(result.access).toBe("unavailable");
    expect(result.error).toMatch(/timed out/);
  });
});
