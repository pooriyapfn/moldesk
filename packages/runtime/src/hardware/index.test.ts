import { describe, expect, it } from "vitest";
import { getDiskInfo } from "./index.js";

describe("getDiskInfo — probeFailed vs genuine zero", () => {
  it("does not set probeFailed on a genuine successful zero-byte reading", async () => {
    const disk = await getDiskInfo({ MOLDESK_HOME: "/tmp" }, async () => ({ availableBytes: 0 }));
    expect(disk.availableBytes).toBe(0);
    expect(disk.probeFailed).toBeUndefined();
    expect(disk.probeError).toBeUndefined();
  });

  it("sets probeFailed + probeError when statfs resolves null (unsupported)", async () => {
    const disk = await getDiskInfo({ MOLDESK_HOME: "/tmp" }, async () => null);
    expect(disk.probeFailed).toBe(true);
    expect(disk.probeError).toBeTruthy();
  });

  it("sets probeFailed + probeError with the thrown message when statfs throws", async () => {
    const disk = await getDiskInfo({ MOLDESK_HOME: "/tmp" }, async () => {
      throw new Error("EACCES: permission denied");
    });
    expect(disk.probeFailed).toBe(true);
    expect(disk.probeError).toBe("EACCES: permission denied");
  });

  it("reports a genuine positive reading without probeFailed", async () => {
    const disk = await getDiskInfo({ MOLDESK_HOME: "/tmp" }, async () => ({ availableBytes: 5 * 1024 ** 3 }));
    expect(disk.availableBytes).toBe(5 * 1024 ** 3);
    expect(disk.probeFailed).toBeUndefined();
  });
});
