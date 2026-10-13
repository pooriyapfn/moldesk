import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialStore,
  KEYRING_SERVICE,
  credentialFingerprint,
  redactSecrets,
  validateSecretShape,
  type SecretBackend,
} from "./credentials.js";

const KEY = "rpa_TESTKEY0123456789";
const dirs: string[] = [];

function emptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk cred "));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function memoryBackend(initial: Record<string, string> = {}): SecretBackend & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
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
}

describe("CredentialStore", () => {
  it("stores in the OS backend under a namespaced account and resolves it", async () => {
    const backend = memoryBackend();
    const store = new CredentialStore({ backend, env: {} });
    await store.set("runpod", KEY);
    expect([...backend.data.keys()]).toEqual([`${KEYRING_SERVICE}/runpod:default`]);
    expect(await store.resolve("runpod")).toEqual({ key: KEY, source: "keyring" });
    expect(await store.status("runpod")).toEqual({ source: "keyring" });
  });

  it("prefers an explicit environment override, then the keyring", async () => {
    const backend = memoryBackend({ [`${KEYRING_SERVICE}/runpod:default`]: `${KEY}-keyring` });
    const withEnv = new CredentialStore({ backend, env: { RUNPOD_API_KEY: `${KEY}-env` } });
    expect(await withEnv.resolve("runpod")).toEqual({ key: `${KEY}-env`, source: "env" });
    const keyringOnly = new CredentialStore({ backend, env: {} });
    expect(await keyringOnly.resolve("runpod")).toEqual({ key: `${KEY}-keyring`, source: "keyring" });
  });

  it("never reads a .env file from the working directory or anywhere else", async () => {
    const dir = emptyDir();
    fs.writeFileSync(path.join(dir, ".env"), `RUNPOD_API_KEY=${KEY}-dotenv\n`);
    const original = process.cwd();
    process.chdir(dir);
    try {
      const store = new CredentialStore({ backend: memoryBackend(), env: {} });
      expect(await store.resolve("runpod")).toBeNull();
      expect(await store.status("runpod")).toEqual({ source: "none" });
    } finally {
      process.chdir(original);
    }
  });

  it("has no plaintext fallback: with nothing configured it reports none and require() is actionable", async () => {
    const store = new CredentialStore({ backend: memoryBackend(), env: {} });
    expect(await store.resolve("runpod")).toBeNull();
    expect(await store.status("runpod")).toEqual({ source: "none" });
    await expect(store.require("runpod")).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
  });

  it("deletes only the stored key, never the environment override", async () => {
    const backend = memoryBackend();
    const store = new CredentialStore({ backend, env: { RUNPOD_API_KEY: KEY } });
    await store.set("runpod", `${KEY}-stored`);
    expect(await store.delete("runpod")).toBe(true);
    expect(await store.delete("runpod")).toBe(false);
    expect(await store.resolve("runpod")).toMatchObject({ source: "env", key: KEY });
  });

  it("separates accounts and rejects unsafe references and unknown providers", async () => {
    const backend = memoryBackend();
    const store = new CredentialStore({ backend, env: {} });
    await store.set("runpod", `${KEY}-a`, "work");
    await store.set("runpod", `${KEY}-b`, "home");
    expect((await store.resolve("runpod", "work"))?.key).toBe(`${KEY}-a`);
    expect((await store.resolve("runpod", "home"))?.key).toBe(`${KEY}-b`);
    await expect(store.set("runpod", KEY, "../escape")).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    await expect(store.resolve("nope")).rejects.toMatchObject({ code: "CREDENTIAL_UNSUPPORTED_PROVIDER" });
  });

  it("rejects malformed keys on write and when found in the environment", async () => {
    const store = new CredentialStore({ backend: memoryBackend(), env: { RUNPOD_API_KEY: "has space in it" } });
    await expect(store.set("runpod", "short")).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    await expect(store.set("runpod", `${KEY}\n`)).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    await expect(store.resolve("runpod")).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
  });

  it("surfaces a backend failure as CREDENTIAL_STORE_UNAVAILABLE without falling back", async () => {
    const failing: SecretBackend = {
      async get() {
        throw Object.assign(new Error("locked"), { code: "CREDENTIAL_STORE_UNAVAILABLE" });
      },
      async set() {},
      async delete() {
        return false;
      },
    };
    const store = new CredentialStore({ backend: failing, env: {} });
    await expect(store.resolve("runpod")).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  });
});

describe("helpers", () => {
  it("validates secret shape", () => {
    expect(() => validateSecretShape(KEY)).not.toThrow();
    expect(() => validateSecretShape("")).toThrow();
    expect(() => validateSecretShape("a b c d e f g h")).toThrow();
  });

  it("fingerprints deterministically per salt without exposing the key", () => {
    const one = credentialFingerprint(KEY, "salt-1");
    expect(one).toBe(credentialFingerprint(KEY, "salt-1"));
    expect(one).not.toBe(credentialFingerprint(KEY, "salt-2"));
    expect(one).not.toContain(KEY);
    expect(one).toMatch(/^[0-9a-f]{32}$/);
  });

  it("redacts secrets and their URL-encoded form, ignoring tiny strings", () => {
    const text = `token ${KEY} and ${encodeURIComponent("a/b+c=d-secret")} ok`;
    expect(redactSecrets(text, [KEY, "a/b+c=d-secret"])).toBe("token [REDACTED] and [REDACTED] ok");
    expect(redactSecrets("abc abc", ["abc"])).toBe("abc abc");
  });
});
