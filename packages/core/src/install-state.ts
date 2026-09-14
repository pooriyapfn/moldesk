import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMoldeskPaths, modelInstallDir, type MoldeskPaths } from "@moldesk/runtime";
import type { RuntimeKind } from "@moldesk/registry";

export interface InstalledModel {
  schemaVersion: 1;
  installationId: string;
  model: string;
  displayName: string;
  modelVersion: string;
  adapterVersion: string;
  runtime: {
    kind: RuntimeKind;
    fingerprint: string;
    python?: { version: string; executable: string; lockSha256: string };
    docker?: { image: string; digest: string };
  };
  environmentFingerprint: string;
  installDir: string;
  source?: { repository: string; revision: string };
  assets: Array<{ id: string; path: string; sha256: string; sizeBytes: number }>;
  manifestSha256: string;
  verification: { passed: boolean; output?: string };
  dependencyLock: string[];
  installedAt: string;
  verifiedAt: string;
  status: "ready";
}

interface InstallStateFile {
  schemaVersion: 1;
  installations: InstalledModel[];
}

function statePath(paths: MoldeskPaths): string {
  return path.join(paths.state, "installed-models.json");
}

function isInstalledModel(value: unknown): value is InstalledModel {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item["schemaVersion"] === 1 &&
    typeof item["installationId"] === "string" &&
    typeof item["model"] === "string" &&
    typeof item["displayName"] === "string" &&
    typeof item["modelVersion"] === "string" &&
    typeof item["adapterVersion"] === "string" &&
    !!item["runtime"] && typeof item["runtime"] === "object" &&
    ((item["runtime"] as Record<string, unknown>)["kind"] === "python" || (item["runtime"] as Record<string, unknown>)["kind"] === "docker") &&
    typeof (item["runtime"] as Record<string, unknown>)["fingerprint"] === "string" &&
    typeof item["environmentFingerprint"] === "string" &&
    typeof item["installDir"] === "string" &&
    Array.isArray(item["dependencyLock"]) &&
    item["dependencyLock"].every((entry) => typeof entry === "string") &&
    typeof item["installedAt"] === "string" &&
    typeof item["verifiedAt"] === "string" &&
    item["status"] === "ready" &&
    Array.isArray(item["assets"]) && item["assets"].every((asset) => {
      if (!asset || typeof asset !== "object") return false;
      const record = asset as Record<string, unknown>;
      return typeof record["id"] === "string" && typeof record["path"] === "string" &&
        typeof record["sha256"] === "string" && typeof record["sizeBytes"] === "number";
    }) &&
    typeof item["manifestSha256"] === "string" &&
    !!item["verification"] && typeof item["verification"] === "object" &&
    (item["verification"] as Record<string, unknown>)["passed"] === true;
}

function validManagedRecord(record: InstalledModel, recordDir: string, paths: MoldeskPaths): boolean {
  try {
    const expected = modelInstallDir(record.model, record.modelVersion, record.runtime.fingerprint, { MOLDESK_HOME: paths.home });
    return path.resolve(record.installDir) === path.resolve(expected) && path.resolve(recordDir) === path.resolve(expected);
  } catch {
    return false;
  }
}

function scanInstallationRecords(paths: MoldeskPaths): InstalledModel[] {
  if (!fs.existsSync(paths.models)) return [];
  const records: InstalledModel[] = [];
  for (const model of fs.readdirSync(paths.models, { withFileTypes: true })) {
    if (!model.isDirectory()) continue;
    const modelDir = path.join(paths.models, model.name);
    for (const version of fs.readdirSync(modelDir, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const versionDir = path.join(modelDir, version.name);
      for (const runtime of fs.readdirSync(versionDir, { withFileTypes: true })) {
        if (!runtime.isDirectory() || runtime.name.includes(".partial-") || runtime.name.includes(".backup-")) continue;
        const recordDir = path.join(versionDir, runtime.name);
        const file = path.join(recordDir, "installation.json");
        if (!fs.existsSync(file)) continue;
        try {
          const record = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
          if (isInstalledModel(record) && validManagedRecord(record, recordDir, paths)) records.push(record);
        } catch {
          // A directory alone never counts as installed; skip invalid records.
        }
      }
    }
  }
  return records.sort((a, b) => a.installationId.localeCompare(b.installationId));
}

export function rebuildInstallState(paths: MoldeskPaths): InstallStateFile {
  const rebuilt = { schemaVersion: 1 as const, installations: scanInstallationRecords(paths) };
  writeInstallState(rebuilt, paths);
  return rebuilt;
}

export function readInstallState(paths: MoldeskPaths = getMoldeskPaths()): InstallStateFile {
  const file = statePath(paths);
  if (!fs.existsSync(file)) {
    if (!fs.existsSync(paths.models)) return { schemaVersion: 1, installations: [] };
    return rebuildInstallState(paths);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return rebuildInstallState(paths);
  }
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>)["schemaVersion"] !== 1) {
    return rebuildInstallState(paths);
  }
  const installations = (raw as Record<string, unknown>)["installations"];
  if (!Array.isArray(installations) || !installations.every(isInstalledModel)) {
    return rebuildInstallState(paths);
  }
  for (const record of installations) {
    const expected = modelInstallDir(record.model, record.modelVersion, record.runtime.fingerprint, { MOLDESK_HOME: paths.home });
    if (path.resolve(record.installDir) !== path.resolve(expected)) {
      return rebuildInstallState(paths);
    }
  }
  return { schemaVersion: 1, installations };
}

export function writeInstallState(state: InstallStateFile, paths: MoldeskPaths = getMoldeskPaths()): void {
  fs.mkdirSync(paths.state, { recursive: true });
  const file = statePath(paths);
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function listInstalledModels(paths: MoldeskPaths = getMoldeskPaths()): InstalledModel[] {
  const state = readInstallState(paths);
  const valid = state.installations.filter((record) => {
    const file = path.join(record.installDir, "installation.json");
    if (!fs.existsSync(file)) return false;
    try {
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return isInstalledModel(onDisk) && onDisk.installationId === record.installationId && validManagedRecord(onDisk, record.installDir, paths);
    } catch {
      return false;
    }
  });
  const installations = valid.length === state.installations.length ? valid : rebuildInstallState(paths).installations;
  return installations.sort((a, b) => a.model.localeCompare(b.model));
}
