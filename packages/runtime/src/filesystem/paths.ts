import os from "node:os";
import path from "node:path";
import { MoldeskError } from "@moldesk/registry";

export interface MoldeskPaths {
  home: string;
  cache: string;
  downloads: string;
  objects: string;
  models: string;
  runs: string;
  state: string;
  locks: string;
  tools: string;
}

function defaultHome(): string {
  // macOS/Linux default per spec §1.3. Windows out of v0.1 execution scope.
  return path.join(os.homedir(), ".moldesk");
}

function unsafePath(message: string, details: Record<string, unknown>): never {
  throw new MoldeskError({
    code: "UNSAFE_PATH",
    message,
    remediation: "Use a MoleculeDesk-owned directory and safe identifier values without path separators.",
    details,
  });
}

function safeSegment(value: string, label: string, pattern: RegExp): string {
  if (!pattern.test(value) || value === "." || value === ".." || value.includes("\0")) {
    return unsafePath(`Unsafe ${label}: ${JSON.stringify(value)}`, { label, value });
  }
  return value;
}

function safeModelName(value: string): string {
  return safeSegment(value, "model name", /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
}

function safeVersion(value: string, label: string): string {
  return safeSegment(value, label, /^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
}

function safeRuntimeFingerprint(value: string): string {
  return safeSegment(value, "runtime fingerprint", /^(?:python|docker)-[a-f0-9]{16,64}$/);
}

const RUN_ID_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function safeRunId(value: string): string {
  return safeSegment(value, "run id", RUN_ID_PATTERN);
}

/** Centralized home resolution. Honors MOLDESK_HOME for tests/advanced users. */
export function getMoldeskHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["MOLDESK_HOME"];
  if (override && override.trim().length > 0) {
    const resolved = path.resolve(override.trim());
    const filesystemRoot = path.parse(resolved).root;
    if (resolved === filesystemRoot || resolved === path.resolve(os.homedir())) {
      return unsafePath(`Refusing unsafe MOLDESK_HOME: ${resolved}`, { resolved });
    }
    return resolved;
  }
  return defaultHome();
}

/** Central path calculation. No other module should construct these paths by hand. */
export function getMoldeskPaths(env: NodeJS.ProcessEnv = process.env): MoldeskPaths {
  const home = getMoldeskHome(env);
  const cache = path.join(home, "cache");
  const state = path.join(home, "state");
  return {
    home,
    cache,
    downloads: path.join(cache, "downloads"),
    objects: path.join(cache, "objects"),
    models: path.join(home, "models"),
    runs: path.join(home, "runs"),
    state,
    locks: path.join(state, "locks"),
    tools: path.join(home, "tools"),
  };
}

export function modelVersionDir(model: string, modelVersion: string, env?: NodeJS.ProcessEnv): string {
  return path.join(
    getMoldeskPaths(env).models,
    safeModelName(model),
    safeVersion(modelVersion, "model version"),
  );
}

export function modelInstallDir(
  model: string,
  modelVersion: string,
  runtimeFingerprint: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(
    modelVersionDir(model, modelVersion, env),
    safeRuntimeFingerprint(runtimeFingerprint),
  );
}

export function runDir(runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(getMoldeskPaths(env).runs, safeRunId(runId));
}

export function uvToolDir(version: string, env?: NodeJS.ProcessEnv): string {
  return path.join(getMoldeskPaths(env).tools, "uv", safeVersion(version, "uv version"));
}

export function pythonToolDir(version: string, env?: NodeJS.ProcessEnv): string {
  return path.join(getMoldeskPaths(env).tools, "python", safeVersion(version, "Python version"));
}
