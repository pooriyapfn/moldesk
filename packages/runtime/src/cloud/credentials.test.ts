import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialStore,
  KEYRING_SERVICE,
  credentialFingerprint,
  parseDotEnv,
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
    const store = new CredentialStore({ backend, env: {}, dotEnvDir: emptyDir() });
    await store.set("runpod", KEY);
    expect([...backend.data.keys()]).toEqual([`${KEYRING_SERVICE}/runpod:default`]);
    expect(await store.resolve("runpod")).toEqual({ key: KEY, source: "keyring" });
    expect(await store.status("runpod")).toEqual({ source: "keyring" });
  });

  it("prefers the environment, then .env, then the keyring", async () => {
    const dir = emptyDir();
    fs.writeFileSync(path.join(dir, ".env"), `RUNPOD_API_KEY=${KEY}-dotenv\nOTHER=ignored\n`);
    const backend = memoryBackend({ [`${KEYRING_SERVICE}/runpod:default`]: `${KEY}-keyring` });

    const withEnv = new CredentialStore({ backend, env: { RUNPOD_API_KEY: `${KEY}-env` }, dotEnvDir: dir });
    expect(await withEnv.resolve("runpod")).toEqual({ key: `${KEY}-env`, source: "env" });

    const withDotEnv = new CredentialStore({ backend, env: {}, dotEnvDir: dir });
    expect(await withDotEnv.resolve("runpod")).toEqual({ key: `${KEY}-dotenv`, source: "dotenv" });

    const keyringOnly = new CredentialStore({ backend, env: {}, dotEnvDir: emptyDir() });
    expect(await keyringOnly.resolve("runpod")).toEqual({ key: `${KEY}-keyring`, source: "keyring" });
  });

  it("has no plaintext fallback: with nothing configured it reports none and require() is actionable", async () => {
    const store = new CredentialStore({ backend: memoryBackend(), env: {}, dotEnvDir: emptyDir() });
    expect(await store.resolve("runpod")).toBeNull();
    expect(await store.status("runpod")).toEqual({ source: "none" });
    await expect(store.require("runpod")).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
  });

  it("deletes only the stored key, never environment or .env keys", async () => {
    const dir = emptyDir();
    fs.writeFileSync(path.join(dir, ".env"), `RUNPOD_API_KEY=${KEY}\n`);
    const backend = memoryBackend();
    const store = new CredentialStore({ backend, env: {}, dotEnvDir: dir });
    await store.set("runpod", `${KEY}-stored`);
    expect(await store.delete("runpod")).toBe(true);
    expect(await store.delete("runpod")).toBe(false);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain(KEY);
    expect(await store.resolve("runpod")).toMatchObject({ source: "dotenv" });
  });

  it("separates accounts and rejects unsafe references and unknown providers", async () => {
    const backend = memoryBackend();
    const store = new CredentialStore({ backend, env: {}, dotEnvDir: emptyDir() });
    await store.set("runpod", `${KEY}-a`, "work");
    await store.set("runpod", `${KEY}-b`, "home");
    expect((await store.resolve("runpod", "work"))?.key).toBe(`${KEY}-a`);
    expect((await store.resolve("runpod", "home"))?.key).toBe(`${KEY}-b`);
    await expect(store.set("runpod", KEY, "../escape")).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    await expect(store.resolve("nope")).rejects.toMatchObject({ code: "CREDENTIAL_UNSUPPORTED_PROVIDER" });
  });

  it("rejects malformed keys on write and when found in the environment", async () => {
    const store = new CredentialStore({ backend: memoryBackend(), env: { RUNPOD_API_KEY: "has space in it" }, dotEnvDir: emptyDir() });
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
    const store = new CredentialStore({ backend: failing, env: {}, dotEnvDir: emptyDir() });
    await expect(store.resolve("runpod")).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  });
});

describe("helpers", () => {
  it("parses only wanted variables, handling export, quotes and comments", () => {
    const text = [
      "# comment",
      "OTHER_SECRET=do-not-read",
      `export RUNPOD_API_KEY="${KEY}"`,
      "EMPTY=",
    ].join("\n");
    expect(parseDotEnv(text, ["RUNPOD_API_KEY"])).toEqual({ RUNPOD_API_KEY: KEY });
    expect(parseDotEnv(`RUNPOD_API_KEY=${KEY} # trailing`, ["RUNPOD_API_KEY"])).toEqual({ RUNPOD_API_KEY: KEY });
    expect(parseDotEnv("RUNPOD_API_KEY=", ["RUNPOD_API_KEY"])).toEqual({});
  });

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
