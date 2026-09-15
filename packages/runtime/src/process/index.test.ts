import { describe, expect, it } from "vitest";
import { runCommand } from "./index.js";

describe("runCommand", () => {
  it("exposes the child pid via onSpawn and on the result", async () => {
    let spawnedPid: number | undefined;
    const result = await runCommand(process.execPath, ["-e", "process.exit(0)"], {
      onSpawn: (pid) => {
        spawnedPid = pid;
      },
    });
    expect(spawnedPid).toBeTypeOf("number");
    expect(result.pid).toBe(spawnedPid);
    expect(result.code).toBe(0);
  });

  it("escalates to SIGKILL after gracefulTimeoutMs when an aborted process ignores SIGTERM", async () => {
    const controller = new AbortController();
    const ignoreSigterm = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const runPromise = runCommand(process.execPath, ["-e", ignoreSigterm], {
      signal: controller.signal,
      gracefulTimeoutMs: 150,
    });
    controller.abort();
    const result = await runPromise;
    expect(result.cancelled).toBe(true);
  }, 10_000);

  it("kills immediately with no graceful escalation when gracefulTimeoutMs is unset (pre-existing behavior)", async () => {
    const controller = new AbortController();
    const sleep = "setTimeout(() => {}, 10000);";
    const started = Date.now();
    const runPromise = runCommand(process.execPath, ["-e", sleep], { signal: controller.signal });
    controller.abort();
    const result = await runPromise;
    expect(result.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  }, 10_000);
});
