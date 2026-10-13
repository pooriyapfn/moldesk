import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { CloudJournal, CredentialStore, MoldeskError, getMoldeskPaths, type CloudProvider, type SecretBackend } from "@moldesk/core";
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

describe("cloudExitCode", () => {
  it("maps cloud error codes and defaults to 10", () => {
    expect(cloudExitCode(new MoldeskError({ code: "CLOUD_CAPACITY_UNAVAILABLE", message: "x" }))).toBe(12);
    expect(cloudExitCode(new MoldeskError({ code: "CREDENTIAL_INVALID", message: "x" }))).toBe(2);
    expect(cloudExitCode(new Error("boom"))).toBe(10);
  });
});
