import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { MoldeskError } from "../providers.js";

/**
 * Cloud API credentials. The OS credential store is the default. An explicit provider environment
 * variable (e.g. RUNPOD_API_KEY) is accepted as a documented development override and takes
 * precedence when set. Files such as `.env` are never read automatically, and there is no
 * plaintext-file fallback: if neither source holds a key, the caller is told to connect one.
 * Secrets are never written to run records, the cloud journal, error messages or command arguments.
 */

export const KEYRING_SERVICE = "moldesk";
export const DEFAULT_ACCOUNT_REF = "default";

/** Environment variable that carries each provider's key. */
export const PROVIDER_ENV_VARS: Readonly<Record<string, string>> = { runpod: "RUNPOD_API_KEY" };

const SECRET_MIN_LENGTH = 8;
const SECRET_MAX_LENGTH = 512;

export interface SecretBackend {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  /** Returns whether an entry existed. */
  delete(service: string, account: string): Promise<boolean>;
}

function storeUnavailable(action: string, cause: unknown): MoldeskError {
  return new MoldeskError({
    code: "CREDENTIAL_STORE_UNAVAILABLE",
    message: `The operating system credential store is unavailable (${action}).`,
    remediation: "Unlock your keychain/secret service, or provide the key through the provider environment variable for this session.",
    cause,
  });
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

/** OS keychain via a maintained N-API binding; loaded lazily so unsupported platforms only lose this feature. */
export function createKeyringBackend(): SecretBackend {
  type EntryCtor = new (service: string, account: string) => KeyringEntry;
  let ctor: EntryCtor | undefined;
  const entry = (service: string, account: string, action: string): KeyringEntry => {
    try {
      ctor ??= (createRequire(import.meta.url)("@napi-rs/keyring") as { Entry: EntryCtor }).Entry;
      return new ctor(service, account);
    } catch (error) {
      throw storeUnavailable(action, error);
    }
  };
  return {
    async get(service, account) {
      const target = entry(service, account, "read");
      try {
        return target.getPassword() ?? null;
      } catch (error) {
        throw storeUnavailable("read", error);
      }
    },
    async set(service, account, secret) {
      const target = entry(service, account, "write");
      try {
        target.setPassword(secret);
      } catch (error) {
        throw storeUnavailable("write", error);
      }
    },
    async delete(service, account) {
      const target = entry(service, account, "delete");
      try {
        return target.deletePassword();
      } catch (error) {
        throw storeUnavailable("delete", error);
      }
    },
  };
}

/** A key must be a single printable token; anything else is almost certainly a paste mistake. */
export function validateSecretShape(secret: string): void {
  const trimmed = secret.trim();
  if (trimmed !== secret || secret.length < SECRET_MIN_LENGTH || secret.length > SECRET_MAX_LENGTH || /[\s\u0000-\u001f\u007f]/.test(secret)) {
    throw new MoldeskError({
      code: "CREDENTIAL_INVALID",
      message: "The API key is malformed (empty, too short/long, or contains whitespace or control characters).",
      remediation: "Copy the key again from the provider console without surrounding spaces or newlines.",
    });
  }
}

export type CredentialSource = "env" | "keyring";

export interface ResolvedCredential {
  /** The secret itself. Hand it to a client; never log or persist it. */
  key: string;
  source: CredentialSource;
}

export interface CredentialStoreOptions {
  backend?: SecretBackend;
  /** Development override source. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export class CredentialStore {
  private readonly backend: SecretBackend;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: CredentialStoreOptions = {}) {
    this.backend = options.backend ?? createKeyringBackend();
    this.env = options.env ?? process.env;
  }

  private envVar(provider: string): string {
    const name = PROVIDER_ENV_VARS[provider];
    if (!name) throw new MoldeskError({ code: "CREDENTIAL_UNSUPPORTED_PROVIDER", message: `Unknown cloud provider "${provider}".`, remediation: "Use a supported provider, e.g. runpod." });
    return name;
  }

  private account(provider: string, accountRef: string): string {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(accountRef)) {
      throw new MoldeskError({ code: "CREDENTIAL_INVALID", message: `Unsafe account reference ${JSON.stringify(accountRef)}.`, remediation: "Use letters, digits, '.', '_' or '-'." });
    }
    return `${provider}:${accountRef}`;
  }

  /** Explicit environment override first, then the OS store. Returns null when nothing is configured. */
  async resolve(provider: string, accountRef: string = DEFAULT_ACCOUNT_REF): Promise<ResolvedCredential | null> {
    const name = this.envVar(provider);
    const fromEnv = this.env[name];
    if (fromEnv) return this.checked({ key: fromEnv, source: "env" });

    const stored = await this.backend.get(KEYRING_SERVICE, this.account(provider, accountRef));
    return stored ? this.checked({ key: stored, source: "keyring" }) : null;
  }

  /** Like `resolve` but throws an actionable error when no credential exists. */
  async require(provider: string, accountRef: string = DEFAULT_ACCOUNT_REF): Promise<ResolvedCredential> {
    const resolved = await this.resolve(provider, accountRef);
    if (!resolved) {
      throw new MoldeskError({
        code: "CREDENTIAL_MISSING",
        message: `No ${provider} API key is configured.`,
        remediation: `Run \`moldesk cloud connect ${provider}\`, or set ${this.envVar(provider)} in the environment (development override).`,
      });
    }
    return resolved;
  }

  /** Where the key would come from, without returning it. */
  async status(provider: string, accountRef: string = DEFAULT_ACCOUNT_REF): Promise<{ source: CredentialSource | "none" }> {
    const resolved = await this.resolve(provider, accountRef);
    return { source: resolved?.source ?? "none" };
  }

  /** Shape-check a candidate key for a supported provider without storing it. */
  async validate(provider: string, key: string): Promise<void> {
    this.envVar(provider);
    validateSecretShape(key);
  }

  async set(provider: string, key: string, accountRef: string = DEFAULT_ACCOUNT_REF): Promise<void> {
    this.envVar(provider);
    validateSecretShape(key);
    await this.backend.set(KEYRING_SERVICE, this.account(provider, accountRef), key);
  }

  /** Removes the stored key. An environment variable is the user's own and is never touched. */
  async delete(provider: string, accountRef: string = DEFAULT_ACCOUNT_REF): Promise<boolean> {
    this.envVar(provider);
    return this.backend.delete(KEYRING_SERVICE, this.account(provider, accountRef));
  }

  private checked(credential: ResolvedCredential): ResolvedCredential {
    validateSecretShape(credential.key);
    return credential;
  }
}

/**
 * Stable, non-reversible identifier for a credential, used only as a conservative account scope
 * when the provider exposes no account identity. Keyed so the stored value cannot be matched
 * against a guessed key without the per-installation salt.
 */
export function credentialFingerprint(key: string, installationSalt: string): string {
  return createHmac("sha256", installationSalt).update(key).digest("hex").slice(0, 32);
}

/** Replaces every occurrence of each secret (and its URL-encoded form) with a fixed marker. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < SECRET_MIN_LENGTH) continue;
    for (const variant of new Set([secret, encodeURIComponent(secret)])) out = out.split(variant).join("[REDACTED]");
  }
  return out;
}
