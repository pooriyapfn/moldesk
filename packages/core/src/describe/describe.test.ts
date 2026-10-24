import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAdapter, validateParams, type ParamDescriptor } from "@moldesk/adapters";
import { getMoldeskPaths, type MoldeskPaths, type SystemReport } from "@moldesk/runtime";
import { listAvailableModels } from "@moldesk/registry";
import { evaluateCompatibility } from "../compatibility.js";
import { prepareRunParams } from "../run-lifecycle.js";
import { schemaForKind, validateEnvelope } from "../schemas/envelope.js";
import { describeModel } from "./describe.js";

const GB = 1024 ** 3;
const models = listAvailableModels();

const profile = (overrides: Partial<SystemReport>): SystemReport => ({
  capturedAt: "2026-01-01T00:00:00.000Z",
  platform: "linux",
  arch: "x64",
  cpu: { model: "Test CPU", logicalCores: 8 },
  memory: { totalBytes: 64 * GB },
  disk: { availableBytes: 500 * GB, path: "/tmp/moldesk-test" },
  appleSilicon: false,
  hostPython: { available: false, error: "no python" },
  docker: { available: true, running: true, version: "24.0.7", gpuAccess: "available" },
  nvidia: { available: true, driverVersion: "550.54.15", driverCudaVersion: "12.4", gpus: [{ index: 0, name: "NVIDIA A100", totalVramBytes: 80 * GB }] },
  ...overrides,
});

const PROFILES: Record<string, SystemReport> = {
  "Linux with an A100": profile({}),
  "Linux without a GPU": profile({ nvidia: { available: false, gpus: [], error: "no gpu" } }),
  "Linux with a small GPU": profile({ nvidia: { available: true, driverVersion: "550", driverCudaVersion: "12.4", gpus: [{ index: 0, name: "NVIDIA T4", totalVramBytes: 8 * GB }] } }),
  "Linux with little memory and disk": profile({ memory: { totalBytes: 4 * GB }, disk: { availableBytes: 2 * GB, path: "/tmp" } }),
  "Apple Silicon": profile({ platform: "darwin", arch: "arm64", appleSilicon: true, nvidia: { available: false, gpus: [], error: "no gpu" }, docker: { available: false, running: false, gpuAccess: "unknown" } }),
  "an unsupported platform": profile({ platform: "win32" as never, arch: "x64" }),
};

let dir: string;
let paths: MoldeskPaths;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-describe-"));
  paths = getMoldeskPaths({ MOLDESK_HOME: path.join(dir, "home") });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const describeIt = (name: string, report = PROFILES["Linux with an A100"], extra = {}) => describeModel(name, { report, paths, ...extra });

describe("the catalog", () => {
  it("has models to test", () => {
    expect(models.map((m) => m.name).sort()).toEqual(["bindcraft2", "boltz", "diffdock", "ligandmpnn", "opendde", "proteinmpnn"]);
  });
});

describe.each(models.map((m) => [m.name, m] as const))("describe %s", (name, manifest) => {
  it("validates against the moldesk.model schema (an independent JSON Schema validator) and the envelope validator", async () => {
    const envelope = JSON.parse(JSON.stringify(await describeIt(name)));
    const validate = new Ajv({ allErrors: true }).compile(schemaForKind("moldesk.model"));
    expect(validate(envelope), JSON.stringify(validate.errors)).toBe(true);
    validateEnvelope(envelope, "moldesk.model");
  });

  it("lists exactly the --param names that run-time validation accepts, with the same types, ranges and requirements", async () => {
    const { result } = await describeIt(name);
    const declared = getAdapter(name)?.params ?? [];
    expect(result.parameters.map((p) => p.name)).toEqual(declared.map((p) => p.name));
    expect(new Set(result.parameters.map((p) => p.name)).size).toBe(result.parameters.length);

    const sample = (p: ParamDescriptor): string => {
      if (p.enum) return String(p.enum[0]);
      if (p.type === "boolean") return "true";
      if (p.type === "number") return String(p.min ?? p.max ?? 1);
      return "x";
    };
    const required = Object.fromEntries(result.parameters.filter((p) => p.required).map((p) => [p.name, sample(declared.find((d) => d.name === p.name)!)]));
    for (const p of result.parameters) {
      const d = declared.find((x) => x.name === p.name)!;
      expect(p).toMatchObject({ type: d.type, required: d.required === true });
      expect(p.min).toBe(d.min);
      expect(p.max).toBe(d.max);
      expect(p.enum).toEqual(d.enum);
      // accepted: a valid value for exactly this parameter (plus any required ones)
      expect(validateParams(declared, { ...required, [p.name]: sample(d) }).errors, p.name).toEqual([]);
      // refused: a value outside what describe says
      if (p.min !== undefined) expect(validateParams(declared, { ...required, [p.name]: String(p.min - 1) }).errors.length, `${p.name} below min`).toBeGreaterThan(0);
      if (p.max !== undefined) expect(validateParams(declared, { ...required, [p.name]: String(p.max + 1) }).errors.length, `${p.name} above max`).toBeGreaterThan(0);
      if (p.enum) expect(validateParams(declared, { ...required, [p.name]: "__not_allowed__" }).errors.length, `${p.name} not in enum`).toBeGreaterThan(0);
      if (p.required) {
        const { [p.name]: _omitted, ...rest } = required;
        expect(validateParams(declared, rest).errors.some((e) => e.includes(p.name)), `${p.name} required`).toBe(true);
      }
    }
    // refused: any name describe does not list
    expect(validateParams(declared, { ...required, definitely_not_a_param: "1" }).errors.join()).toMatch(/Unknown parameter "definitely_not_a_param"/);
  });

  it("reports the defaults a real run would use, static and per platform", async () => {
    const { result } = await describeIt(name);
    const adapter = getAdapter(name)!;
    for (const p of result.parameters) {
      if (p.default !== undefined) expect(validateParams(adapter.params ?? [], {}).effective[p.name], p.name).toBe(p.default);
      for (const [platform, value] of Object.entries(p.defaultsByPlatform ?? {})) {
        const installed = { runtime: { kind: "python", python: { platform: platform as never, platformSelected: true } } };
        let effective: Record<string, unknown> | undefined;
        try {
          effective = prepareRunParams(adapter, name, installed, {}).effectiveParams;
        } catch {
          effective = undefined; // another parameter is required; fall back to the adapter's own hook
        }
        const fromHook = adapter.resolveParamDefaults?.({ manifestName: name, installed })[p.name];
        expect(effective?.[p.name] ?? fromHook, `${p.name} on ${platform}`).toBe(value);
      }
    }
  });

  it.each(Object.entries(PROFILES))("gives the same verdict as the compatibility check on %s", async (_label, report) => {
    const { result } = await describeIt(name, report);
    expect(result.compatibility).toEqual(evaluateCompatibility(manifest, report));
    expect(result.verdict.startsWith(result.compatibility.status === "compatible" ? "compatible" : result.compatibility.status === "warning" ? "warning:" : "")).toBe(true);
  });

  it("states cloud availability, hardware, runtimes, assets and license from the manifest", async () => {
    const { result } = await describeIt(name);
    expect(result.cloud.available).toBe(manifest.cloud !== undefined);
    if (manifest.cloud && result.cloud.available) {
      expect(result.cloud).toMatchObject({ platform: manifest.cloud.platform, minVramGb: manifest.cloud.minVramGb, minRamGb: manifest.cloud.minRamGb, ephemeralDiskGb: manifest.cloud.ephemeralDiskGb, volumeGb: manifest.cloud.volumeGb });
      expect(result.cloud.gpuAllowList).toEqual(manifest.cloud.gpuAllowList);
    }
    expect(result.capabilities.cloud).toBe(manifest.cloud !== undefined);
    expect(result.runtimes.map((r) => r.kind)).toEqual(manifest.runtimes.map((r) => r.kind));
    expect(result.input).toEqual({ formats: manifest.input.formats, required: manifest.input.required });
    expect(result.outputs.map((o) => o.id)).toEqual(manifest.outputs.map((o) => o.id));
    expect(result.assets.map((a) => a.id)).toEqual((manifest.assets ?? []).map((a) => a.id));
    expect(result.license).toBe(manifest.license);
    expect(result.hardware).toEqual(manifest.hardware);
    expect(result.capabilities).toMatchObject({ category: manifest.category, installable: true, installed: false });
  });
});

describe("describe", () => {
  it("shows Boltz's platform-dependent accelerator default instead of a single value", async () => {
    const { result } = await describeIt("boltz");
    const accelerator = result.parameters.find((p) => p.name === "accelerator")!;
    expect(accelerator.default).toBeUndefined();
    expect(accelerator.defaultsByPlatform).toEqual({ "linux-x64": "gpu", "darwin-arm64": "mps" });
    expect(accelerator.enum).toEqual(["gpu", "mps", "cpu"]);
  });

  it("judges only the requested runtime", async () => {
    const { result } = await describeIt("boltz", PROFILES["Linux with an A100"], { requestedRuntime: "docker" });
    expect(result.compatibility.status).toBe("unsupported");
    expect(result.compatibility.reasons[0].code).toBe("RUNTIME_NOT_AVAILABLE");
    expect(result.verdict).toMatch(/^unsupported: RUNTIME_NOT_AVAILABLE/);
  });

  it("says a model is installed once an installation record exists", async () => {
    const dirName = path.join(paths.models, "proteinmpnn", "v_48_020", "python-0123456789abcdef");
    fs.mkdirSync(dirName, { recursive: true });
    const record = { schemaVersion: 1, installationId: "x", model: "proteinmpnn", displayName: "ProteinMPNN", modelVersion: "v_48_020", adapterVersion: "0.1.0", runtime: { kind: "python", fingerprint: "python-0123456789abcdef" }, environmentFingerprint: "e", installDir: dirName, source: { repository: "https://example.test/r", revision: "0".repeat(40) }, assets: [], manifestSha256: "m", verification: { passed: true }, dependencyLock: [], installedAt: "2026-01-01T00:00:00.000Z", verifiedAt: "2026-01-01T00:00:00.000Z", status: "ready" };
    fs.writeFileSync(path.join(dirName, "installation.json"), JSON.stringify(record));
    expect((await describeIt("proteinmpnn")).result.capabilities.installed).toBe(true);
    expect((await describeIt("boltz")).result.capabilities.installed).toBe(false);
  });

  it("rejects an unknown model without probing anything", async () => {
    await expect(describeModel("nope", { report: PROFILES["Apple Silicon"], paths })).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
    await expect(describeModel("../boltz", { report: PROFILES["Apple Silicon"], paths })).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
  });

  it("fails the schema when a required field is dropped or mistyped", async () => {
    const validate = new Ajv({ allErrors: true }).compile(schemaForKind("moldesk.model"));
    const good = JSON.parse(JSON.stringify(await describeIt("boltz")));
    expect(validate(good)).toBe(true);
    for (const mutate of [
      (e: any) => delete e.result.parameters[0].name,
      (e: any) => (e.result.parameters[1].type = "integer"),
      (e: any) => delete e.result.compatibility.status,
      (e: any) => (e.result.cloud = { available: true }),
      (e: any) => (e.result.status = "stable"),
      (e: any) => (e.kind = "moldesk.fetch"),
    ]) {
      const bad = JSON.parse(JSON.stringify(good));
      mutate(bad);
      expect(validate(bad)).toBe(false);
    }
  });
});
