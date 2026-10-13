import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { CloudJournal, CredentialStore, MoldeskError, getMoldeskPaths, type CloudProvider, type CloudRunDeps, type SecretBackend } from "@moldesk/core";
import { cloudExitCode, registerCloudCommand } from "./cloud.js";

const KEY = "rpa_TESTKEY0123456789";
let home: string;
let out: string[];
let err: string[];
let stored: Map<string, string>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk cli cloud "));
  stored = new Map();
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

function backend(): SecretBackend {
  return {
    async get(service, account) {
      return stored.get(`${service}/${account}`) ?? null;
    },
    async set(service, account, secret) {
      stored.set(`${service}/${account}`, secret);
    },
    async delete(service, account) {
      return stored.delete(`${service}/${account}`);
    },
  };
}

function provider(validate: () => Promise<{ ok: true; checkedAt: string }>, pods: Awaited<ReturnType<CloudProvider["listPods"]>> = []): CloudProvider {
  return {
    name: "fake",
    validateCredentials: validate,
    getCatalog: async () => {
      throw new Error("unused");
    },
    createPod: async () => {
      throw new Error("must not create");
    },
    getPod: async () => null,
    listPods: async () => pods,
    terminatePod: async () => {
      throw new Error("must not terminate");
    },
    createVolume: async () => {
      throw new Error("must not create");
    },
    getVolume: async () => null,
    listVolumes: async () => [],
    deleteVolume: async () => {
      throw new Error("must not delete");
    },
  };
}

async function run(options: { env?: NodeJS.ProcessEnv; validate?: () => Promise<{ ok: true; checkedAt: string }>; pods?: Parameters<typeof provider>[1] }, ...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerCloudCommand(program, {
    paths: getMoldeskPaths({ MOLDESK_HOME: home }),
    store: new CredentialStore({ backend: backend(), env: options.env ?? {}, dotEnvDir: home }),
    createProvider: () => provider(options.validate ?? (async () => ({ ok: true, checkedAt: "t" })), options.pods),
  });
  await program.parseAsync(["cloud", ...args], { from: "user" });
}

describe("cloud commands", () => {
  it("connect refuses to prompt without a terminal and without --key-stdin", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await run({}, "connect", "runpod");
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    expect(err.join("\n")).toContain("No terminal is attached");
    expect(process.exitCode).toBe(2);
    expect(stored.size).toBe(0);
  });

  it("status without a credential is explicit and exits cleanly", async () => {
    await run({}, "status");
    expect(out.join("\n")).toContain("Credential:  none");
    expect(process.exitCode).toBeUndefined();
  });

  it("status with a working key reports ok and never prints the key", async () => {
    await run({ env: { RUNPOD_API_KEY: KEY } }, "status", "--json");
    const printed = out.join("\n");
    expect(printed).not.toContain(KEY);
    expect(JSON.parse(printed)).toMatchObject({ credential: { source: "env" }, connection: { ok: true } });
  });

  it("status exits 11 when the provider rejects the key", async () => {
    await run(
      {
        env: { RUNPOD_API_KEY: KEY },
        validate: async () => {
          throw new MoldeskError({ code: "CLOUD_AUTH_FAILED", message: "Runpod rejected the API key.", remediation: "x" });
        },
      },
      "status",
    );
    expect(out.join("\n")).toContain("failed (CLOUD_AUTH_FAILED)");
    expect(process.exitCode).toBe(11);
  });

  it("disconnect reports whether anything was removed", async () => {
    stored.set("moldesk/runpod:default", KEY);
    await run({}, "disconnect", "runpod");
    expect(out.join("\n")).toContain("Removed the stored runpod key.");
    out.length = 0;
    await run({}, "disconnect", "runpod");
    expect(out.join("\n")).toContain("No stored runpod key to remove.");
  });

  it("resources needs a credential and reports exit 11 otherwise", async () => {
    await run({}, "resources", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ status: "error", code: "CREDENTIAL_MISSING" });
    expect(process.exitCode).toBe(11);
  });

  it("resources lists orphans and exits 13 so scripts notice owed cleanup", async () => {
    const journal = CloudJournal.open(getMoldeskPaths({ MOLDESK_HOME: home }));
    const prefix = journal.clientId.replace(/-/g, "").slice(0, 8);
    journal.close();
    await run(
      {
        env: { RUNPOD_API_KEY: KEY },
        pods: [{ id: "podX", name: `moldesk-${prefix}-deadbeef-gpu`, status: "RUNNING", dataCenterId: null, costUsdPerHour: 0.5, createdAt: null }],
      },
      "resources",
    );
    const printed = out.join("\n");
    expect(printed).toContain("Orphaned");
    expect(printed).toContain("podX");
    expect(printed).toContain("Other resources on the account (not managed by MoleculeDesk): 0");
    expect(process.exitCode).toBe(13);
  });
});

describe("recover and cache commands", () => {
  const volumes = new Map<string, { id: string; name: string; sizeGb: number; dataCenterId: string; type: string }>();
  const deleted: string[] = [];
  function runDeps(): CloudRunDeps {
    const provider = {
      name: "runpod",
      listVolumes: async () => [...volumes.values()],
      getVolume: async (id: string) => volumes.get(id) ?? null,
      deleteVolume: async (id: string) => {
        volumes.delete(id);
        deleted.push(id);
        return { id, alreadyAbsent: false };
      },
    } as unknown as CloudProvider;
    return { provider, paths: getMoldeskPaths({ MOLDESK_HOME: home }), accountScope: "acct" };
  }
  async function exec(confirmAnswer: boolean, ...args: string[]) {
    const program = new Command();
    program.exitOverride();
    registerCloudCommand(program, {}, { runDeps: async () => runDeps(), confirm: async () => confirmAnswer });
    await program.parseAsync(["cloud", ...args], { from: "user" });
  }
  function seedCache() {
    volumes.clear();
    deleted.length = 0;
    volumes.set("vol1", { id: "vol1", name: "n", sizeGb: 40, dataCenterId: "DC-1", type: "STANDARD" });
    const journal = CloudJournal.open(getMoldeskPaths({ MOLDESK_HOME: home }));
    const intent = journal.recordResourceIntent({ role: "volume" });
    journal.recordResourceCreated(intent.intentId, "vol1");
    journal.upsertCache({ accountScope: "acct", datacenterId: "DC-1", volumeId: "vol1", model: "boltz", modelVersion: "2.2.1", cacheKey: "k".repeat(64), layoutRevision: "1", manifestDigest: "m", cachePath: "/workspace/x", sizeBytes: null, checksumManifestDigest: null });
    journal.close();
  }

  it("cache list reports empty and populated states", async () => {
    await exec(true, "cache", "list");
    expect(out.join("\n")).toContain("No retained caches.");
    out.length = 0;
    seedCache();
    await exec(true, "cache", "list");
    expect(out.join("\n")).toMatch(/boltz 2\.2\.1\s+PREPARING\s+DC-1\s+volume vol1 \(40 GB, billed\)/);
  });

  it("cache delete shows exactly what will go and deletes nothing when declined", async () => {
    seedCache();
    await exec(false, "cache", "delete", "boltz");
    expect(err.join("\n")).toContain("permanently deletes 1 volume(s)");
    expect(err.join("\n")).toContain("vol1  DC-1  40 GB");
    expect(deleted).toEqual([]);
    expect(process.exitCode).toBe(2);
  });

  it("cache delete --yes deletes the owned volume and confirms", async () => {
    seedCache();
    await exec(false, "cache", "delete", "boltz", "--yes");
    expect(out.join("\n")).toContain("Deleted volume vol1.");
    expect(deleted).toEqual(["vol1"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("cache delete for a model with no cache is a no-op", async () => {
    await exec(true, "cache", "delete", "unknown-model");
    expect(out.join("\n")).toContain("No retained cache for unknown-model.");
  });

  it("recover rejects an unknown run with a clear code", async () => {
    await exec(true, "recover", "2026-01-01T00-00-00-000Z-00000000-0000-0000-0000-000000000000", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ status: "error", code: "CLOUD_RUN_UNKNOWN" });
    expect(process.exitCode).toBe(2);
  });
});

describe("cloudExitCode", () => {
  it("maps cloud error codes and defaults to 10", () => {
    expect(cloudExitCode(new MoldeskError({ code: "CLOUD_CAPACITY_UNAVAILABLE", message: "x" }))).toBe(12);
    expect(cloudExitCode(new MoldeskError({ code: "CREDENTIAL_INVALID", message: "x" }))).toBe(2);
    expect(cloudExitCode(new Error("boom"))).toBe(10);
  });
});
