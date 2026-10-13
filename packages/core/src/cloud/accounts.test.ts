import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialStore,
  getMoldeskPaths,
  type CloudPod,
  type CloudProvider,
  type CloudVolume,
  type SecretBackend,
} from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import { connectCloudProvider, disconnectCloudProvider, getCloudStatus, listCloudResources } from "./accounts.js";
import { CloudJournal } from "./state.js";

const KEY = "rpa_TESTKEY0123456789";
const RUN = "2026-10-13T11-55-45-123Z-0a1b2c3d-1111-2222-3333-444455556666";
const dirs: string[] = [];

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk cloud accounts "));
  dirs.push(home);
  const data = new Map<string, string>();
  const backend: SecretBackend = {
    async get(service, account) {
      return data.get(`${service}/${account}`) ?? null;
    },
    async set(service, account, secret) {
      data.set(`${service}/${account}`, secret);
    },
    async delete(service, account) {
      return data.delete(`${service}/${account}`);
    },
  };
  const paths = getMoldeskPaths({ MOLDESK_HOME: home });
  const store = (env: NodeJS.ProcessEnv = {}) => new CredentialStore({ backend, env, dotEnvDir: home });
  return { paths, data, store };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeProvider(options: { pods?: CloudPod[]; volumes?: CloudVolume[]; validate?: () => Promise<{ ok: true; checkedAt: string }> } = {}) {
  const seenKeys: string[] = [];
  const factory = (_name: string, getApiKey: () => Promise<string>): CloudProvider => ({
    name: "fake",
    async validateCredentials() {
      seenKeys.push(await getApiKey());
      return options.validate ? options.validate() : { ok: true, checkedAt: "2026-10-13T12:00:00.000Z" };
    },
    async getCatalog() {
      throw new Error("unused");
    },
    async createPod() {
      throw new Error("must not create");
    },
    async getPod() {
      return null;
    },
    async listPods() {
      return options.pods ?? [];
    },
    async terminatePod() {
      throw new Error("must not terminate");
    },
    async createVolume() {
      throw new Error("must not create");
    },
    async getVolume() {
      return null;
    },
    async listVolumes() {
      return options.volumes ?? [];
    },
    async deleteVolume() {
      throw new Error("must not delete");
    },
  });
  return { factory, seenKeys };
}

const pod = (id: string, name: string, status: CloudPod["status"] = "RUNNING"): CloudPod => ({
  id,
  name,
  status,
  dataCenterId: "EU-RO-1",
  costUsdPerHour: 0.57,
  createdAt: null,
});

describe("connectCloudProvider", () => {
  it("validates the candidate key before storing it", async () => {
    const box = sandbox();
    const { factory, seenKeys } = fakeProvider();
    const result = await connectCloudProvider("runpod", KEY, { paths: box.paths, store: box.store(), createProvider: factory });
    expect(result).toEqual({ provider: "runpod", storedIn: "keyring", checkedAt: "2026-10-13T12:00:00.000Z" });
    expect(seenKeys).toEqual([KEY]);
    expect([...box.data.values()]).toEqual([KEY]);
  });

  it("stores nothing when the provider rejects the key or the key is malformed", async () => {
    const box = sandbox();
    const rejecting = fakeProvider({
      validate: async () => {
        throw new MoldeskError({ code: "CLOUD_AUTH_FAILED", message: "Runpod rejected the API key.", remediation: "x" });
      },
    });
    await expect(connectCloudProvider("runpod", KEY, { paths: box.paths, store: box.store(), createProvider: rejecting.factory })).rejects.toMatchObject({ code: "CLOUD_AUTH_FAILED" });
    expect(box.data.size).toBe(0);

    const unused = fakeProvider();
    await expect(connectCloudProvider("runpod", "bad key", { paths: box.paths, store: box.store(), createProvider: unused.factory })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    expect(unused.seenKeys).toHaveLength(0);
    expect(box.data.size).toBe(0);
  });

  it("warns when an environment key will override the stored one", async () => {
    const box = sandbox();
    const { factory } = fakeProvider();
    const result = await connectCloudProvider("runpod", KEY, { paths: box.paths, store: box.store({ RUNPOD_API_KEY: `${KEY}-env` }), createProvider: factory });
    expect(result.overriddenBy).toBe("env");
  });

  it("disconnect removes only the stored key", async () => {
    const box = sandbox();
    const { factory } = fakeProvider();
    await connectCloudProvider("runpod", KEY, { paths: box.paths, store: box.store(), createProvider: factory });
    expect(await disconnectCloudProvider("runpod", { paths: box.paths, store: box.store() })).toEqual({ removed: true });
    expect(await disconnectCloudProvider("runpod", { paths: box.paths, store: box.store() })).toEqual({ removed: false });
  });
});

describe("getCloudStatus", () => {
  it("reports no credential without calling the provider", async () => {
    const box = sandbox();
    const { factory, seenKeys } = fakeProvider();
    const status = await getCloudStatus("runpod", { paths: box.paths, store: box.store(), createProvider: factory });
    expect(status.credential).toEqual({ source: "none" });
    expect(status.connection).toBeUndefined();
    expect(seenKeys).toHaveLength(0);
  });

  it("reports a live connection, a non-secret scope and open journal work", async () => {
    const box = sandbox();
    const journal = CloudJournal.open(box.paths);
    journal.createJob({ runId: RUN, accountScope: "s", quoteDigest: "q", cachePolicy: "ephemeral", deadlineAt: "2026-10-13T13:00:00.000Z", manifestDigest: "m" });
    journal.recordResourceIntent({ runId: RUN, role: "gpu" });
    journal.close();
    const { factory } = fakeProvider();
    const status = await getCloudStatus("runpod", { paths: box.paths, store: box.store({ RUNPOD_API_KEY: KEY }), createProvider: factory });
    expect(status.credential.source).toBe("env");
    expect(status.connection).toMatchObject({ ok: true });
    expect(status.accountScope).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(status.journal.openJobs.map((job) => job.runId)).toEqual([RUN]);
    expect(status.journal.unresolvedResources).toHaveLength(1);
  });

  it("reports an auth failure as a result instead of throwing", async () => {
    const box = sandbox();
    const { factory } = fakeProvider({
      validate: async () => {
        throw new MoldeskError({ code: "CLOUD_AUTH_FAILED", message: "Runpod rejected the API key.", remediation: "x" });
      },
    });
    const status = await getCloudStatus("runpod", { paths: box.paths, store: box.store({ RUNPOD_API_KEY: KEY }), createProvider: factory });
    expect(status.connection).toEqual({ ok: false, code: "CLOUD_AUTH_FAILED", message: "Runpod rejected the API key." });
  });
});

describe("listCloudResources", () => {
  it("requires a configured credential", async () => {
    const box = sandbox();
    const { factory } = fakeProvider();
    await expect(listCloudResources("runpod", { paths: box.paths, store: box.store(), createProvider: factory })).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
  });

  it("separates owned, orphaned and unmanaged resources and reconciles the journal", async () => {
    const box = sandbox();
    const journal = CloudJournal.open(box.paths);
    const prefix = journal.clientId.replace(/-/g, "").slice(0, 8);
    const ownedIntent = journal.recordResourceIntent({ runId: RUN, role: "gpu" });
    journal.recordResourceCreated(ownedIntent.intentId, "podOwned");
    const volumeIntent = journal.recordResourceIntent({ role: "volume" });
    journal.recordResourceCreated(volumeIntent.intentId, "volOwned");
    const abandoned = journal.recordResourceIntent({ runId: RUN, role: "cpu" });
    journal.close();

    const { factory } = fakeProvider({
      pods: [
        pod("podOwned", ownedIntent.name),
        pod("podOrphan", `moldesk-${prefix}-deadbeef-gpu`),
        pod("podMine", "my-own-experiment"),
        pod("podGone", "moldesk-old", "TERMINATED"),
      ],
      volumes: [{ id: "volOwned", name: volumeIntent.name, sizeGb: 10, dataCenterId: "EU-RO-1", type: "STANDARD" }],
    });
    const listing = await listCloudResources("runpod", { paths: box.paths, store: box.store({ RUNPOD_API_KEY: KEY }), createProvider: factory });

    expect(listing.owned.map((entry) => [entry.record.providerId, entry.kind, entry.status ?? entry.sizeGb])).toEqual([
      ["podOwned", "pod", "RUNNING"],
      ["volOwned", "volume", 10],
    ]);
    expect(listing.orphaned.map((entry) => entry.providerId)).toEqual(["podOrphan"]);
    expect(listing.unmanagedCount).toBe(1);
    expect(listing.reconciliation.abandoned.map((entry) => entry.intentId)).toEqual([abandoned.intentId]);
    expect(JSON.stringify(listing)).not.toContain(KEY);
  });
});
