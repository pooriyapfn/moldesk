import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { getMoldeskPaths, parseManifest, type CloudProvider, type CloudRunDeps } from "@moldesk/core";
import { registerRunCommand } from "./run.js";
import { formatQuote } from "./run-cloud.js";

const DIGEST = "a".repeat(64);
let home: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk cli run cloud "));
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(home, { recursive: true, force: true });
});

const manifest = () =>
  parseManifest(
    {
      schemaVersion: 1,
      name: "fake-model",
      displayName: "Fake",
      modelVersion: "1.0.0",
      adapterVersion: "0.1.0",
      description: "t",
      category: "other",
      status: "planned",
      runtimes: [{ kind: "python", python: "3.11", installer: "uv", platforms: ["linux-x64"], requirements: [{ name: "torch" }] }],
      hardware: { platforms: ["linux-x64"] },
      input: { formats: [".txt"], required: true },
      outputs: [{ id: "result", glob: "*.out", required: true }],
      cloud: { schemaVersion: 1, platform: "linux-x64", images: { gpu: `r.example/g@sha256:${DIGEST}`, cpu: `r.example/c@sha256:${DIGEST}` }, minVramGb: 24, minRamGb: 32, ephemeralDiskGb: 40, volumeGb: 40, assetLayoutRevision: "1", cpuAssetPreparation: true },
    },
    "x/manifest.yaml",
  );

const adapter = {
  modelName: "fake-model",
  params: [],
  async validateInput() {},
  async installPlan() {
    return { steps: [] };
  },
  async command() {
    throw new Error("client never builds a remote command");
  },
  async collectOutputs(context: { outputDir: string }) {
    return fs.readdirSync(context.outputDir).filter((n) => n.endsWith(".out")).map((n) => ({ id: "result", path: path.join(context.outputDir, n) }));
  },
  async verifyInstallation() {
    return { passed: true };
  },
};

function fakeDeps(opts: { terminateFails?: boolean; guardRefuses?: boolean } = {}) {
  const pods = new Map<string, { id: string; name: string; status: "RUNNING" }>();
  const calls = { guard: 0, start: 0, upload: 0 };
  const provider = {
    name: "runpod",
    getCatalog: async () => ({
      retrievedAt: "2026-10-13T12:00:00.000Z",
      gpus: [{ id: "a40", name: "A40", memoryGb: 48, priceUsdPerHour: 0.6, availability: "LOW", dataCenters: [{ id: "DC-1", availability: "LOW" }], cudaVersions: [] }],
      cpus: [{ id: "cpu3c", name: "c", priceUsdPerVcpuHour: 0.03, ramGbPerVcpu: 2, minVcpu: 2, maxVcpu: 32 }],
      dataCenters: [{ id: "DC-1", region: "EU", networkVolumeTypes: ["STANDARD"] }],
    }),
    listPods: async () => [...pods.values()],
    getPod: async (id: string) => pods.get(id) ?? null,
    terminatePod: async (id: string) => {
      if (opts.terminateFails) throw new Error("down");
      pods.delete(id);
      return { id, alreadyAbsent: false };
    },
  } as unknown as CloudProvider;
  const backend = {
    async start(job: { runId: string }, context: { ledger: { beginCreate: (r: string) => { intentId: string; name: string }; created: (a: string, b: string) => void } }) {
      calls.start += 1;
      const intent = context.ledger.beginCreate("gpu");
      pods.set("pod1", { id: "pod1", name: intent.name, status: "RUNNING" });
      context.ledger.created(intent.intentId, "pod1");
      return { version: 1, runId: job.runId, podId: "pod1", endpoint: "https://w" };
    },
    async observe() {
      return { stage: "running", state: "succeeded", exitCode: 0, logs: { cursor: 1, stdout: "", stderr: "" }, runtime: { dependencyFreeze: [], gpu: { name: "A40" } } };
    },
    async cancel() {},
    async collect(_h: unknown, dir: string) {
      fs.writeFileSync(path.join(dir, "answer.out"), "ok");
      return { version: 1, files: [] };
    },
    async release() {},
  };
  const guard = {
    async register() {
      calls.guard += 1;
      if (opts.guardRefuses) throw Object.assign(new Error("No independent lifetime guard is configured."), { code: "CLOUD_GUARD_UNAVAILABLE", remediation: "x", name: "MoldeskError" });
      return { id: "g" };
    },
    async disarm() {},
  };
  const deps = { provider, backend, guard, paths: getMoldeskPaths({ MOLDESK_HOME: home }), accountScope: "acct", resolveModel: () => ({ manifest: manifest(), adapter }), sleep: async () => undefined, pollIntervalMs: 1, cleanupAttempts: 1 } as unknown as CloudRunDeps;
  return { deps, calls, pods };
}

async function run(hooks: Parameters<typeof registerRunCommand>[1], ...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program, hooks);
  await program.parseAsync(["run", "fake-model", inputPath(), ...args], { from: "user" });
}
function inputPath(): string {
  const file = path.join(home, "in.txt");
  fs.writeFileSync(file, "job");
  return file;
}
const base = ["--compute", "runpod", "--cache-policy", "ephemeral", "--max-budget", "5", "--max-lifetime", "3600"];

describe("moldesk run --compute runpod", () => {
  it("rejects cloud-only flags on a local run", async () => {
    await run({}, "--max-budget", "5");
    expect(err.join("\n")).toMatch(/only apply with --compute runpod/);
    expect(process.exitCode).toBe(2);
  });

  it("requires a cache policy, a budget and a lifetime before touching the provider", async () => {
    const f = fakeDeps();
    await run({ deps: async () => f.deps }, "--compute", "runpod", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ code: "CLOUD_OPTIONS_REQUIRED" });
    out.length = 0;
    await run({ deps: async () => f.deps }, "--compute", "runpod", "--cache-policy", "ephemeral", "--max-lifetime", "60", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ code: "CLOUD_BUDGET_REQUIRED" });
    out.length = 0;
    await run({ deps: async () => f.deps }, "--compute", "runpod", "--cache-policy", "ephemeral", "--max-budget", "1", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ code: "CLOUD_LIFETIME_REQUIRED" });
    expect(process.exitCode).toBe(2);
    expect(f.calls.start).toBe(0);
  });

  it("rejects the docker runtime and unsupported models before anything is provisioned", async () => {
    const f = fakeDeps();
    await run({ deps: async () => f.deps }, ...base, "--runtime", "docker");
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    const unsupported = { ...f.deps, resolveModel: () => ({ manifest: { ...manifest(), cloud: undefined }, adapter }) } as unknown as CloudRunDeps;
    await run({ deps: async () => unsupported }, ...base, "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ code: "CLOUD_MODEL_UNSUPPORTED" });
    expect(process.exitCode).toBe(4);
    expect(f.calls.guard).toBe(0);
  });

  it("--dry-run prints the quote and provisions nothing", async () => {
    const f = fakeDeps();
    await run({ deps: async () => f.deps }, ...base, "--dry-run");
    expect(err.join("\n")).toContain("Cloud quote (runpod");
    expect(err.join("\n")).toContain("Dry run: nothing was uploaded or provisioned.");
    expect(f.calls).toEqual({ guard: 0, start: 0, upload: 0 });
    expect(process.exitCode).toBeUndefined();
    expect(fs.existsSync(getMoldeskPaths({ MOLDESK_HOME: home }).runs)).toBe(false);
  });

  it("--dry-run --json emits a machine-readable quote on stdout only", async () => {
    const f = fakeDeps();
    await run({ deps: async () => f.deps }, ...base, "--dry-run", "--json");
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.status).toBe("quote");
    expect(parsed.quote).toMatchObject({ provider: "runpod", cachePolicy: "ephemeral", gpu: { id: "a40" } });
    expect(err).toEqual([]);
  });

  it("needs --yes without a terminal, and a declined prompt provisions nothing", async () => {
    const f = fakeDeps();
    await run({ deps: async () => f.deps, interactive: false }, ...base);
    expect(err.join("\n")).toMatch(/needs your approval, and no terminal is attached/);
    expect(process.exitCode).toBe(14);
    process.exitCode = undefined;
    err.length = 0;
    await run({ deps: async () => f.deps, confirm: async () => false }, ...base);
    expect(err.join("\n")).toContain("Not approved");
    expect(process.exitCode).toBe(2);
    expect(f.calls.start).toBe(0);
    expect(f.calls.guard).toBe(0);
  });

  it("runs end to end after approval and reports where it ran", async () => {
    const f = fakeDeps();
    await run({ deps: async () => f.deps, confirm: async () => true }, ...base);
    expect(out.join("\n")).toContain("fake-model: succeeded.");
    expect(out.join("\n")).toContain("Ran on: A40 (DC-1)");
    expect(process.exitCode).toBeUndefined();
    expect(f.pods.size).toBe(0);
    expect(f.calls.start).toBe(1);
  });

  it("--yes approves exactly the quote shown, with JSON on stdout", async () => {
    const f = fakeDeps();
    await run({ deps: async () => f.deps }, ...base, "--yes", "--json");
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toMatchObject({ status: "succeeded", record: { compute: { provider: "runpod", cleanup: "confirmed" } } });
  });

  it("exits 14 and provisions nothing when the deadline guard refuses", async () => {
    const f = fakeDeps({ guardRefuses: true });
    await run({ deps: async () => f.deps }, ...base, "--yes");
    expect(err.join("\n")).toContain("CLOUD_GUARD_UNAVAILABLE");
    expect(f.calls.start).toBe(0);
    expect(process.exitCode).toBe(14);
  });

  it("exits 13 with exact resource ids and a recover hint when cleanup cannot be confirmed", async () => {
    const f = fakeDeps({ terminateFails: true });
    await run({ deps: async () => f.deps }, ...base, "--yes");
    expect(err.join("\n")).toMatch(/CLOUD_CLEANUP_PENDING: .*gpu pod1/);
    expect(err.join("\n")).toMatch(/moldesk cloud recover /);
    expect(process.exitCode).toBe(13);
  });
});

describe("formatQuote", () => {
  it("states ceilings, unknowns and retained storage plainly", async () => {
    const f = fakeDeps();
    const { planCloudRun } = await import("@moldesk/core");
    const plan = await planCloudRun("fake-model", inputPath(), { cloud: { cachePolicy: "persistent", maxBudgetUsd: 5, maxLifetimeSeconds: 3600 } }, f.deps);
    const text = formatQuote(plan.quote);
    expect(text).toContain("not a provider-enforced spend cap");
    expect(text).toContain("recurring until you delete the cache; rate unknown");
    expect(text).toContain("no measured estimate available");
    expect(text).toContain("Prep CPU:");
  });
});
