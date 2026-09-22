import { describe, expect, it } from "vitest";
import { MoldeskError } from "./errors.js";
import { parseManifest } from "./loader.js";
import { commandSpecSchema } from "./schema.js";

function baseManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "test-model",
    displayName: "Test Model",
    modelVersion: "1.0.0",
    adapterVersion: "0.1.0",
    description: "A test model",
    category: "other",
    status: "planned",
    runtimes: [
      { kind: "python", python: "3.11", installer: "uv", requirements: [{ name: "torch" }] },
    ],
    hardware: { platforms: ["darwin-arm64"] },
    input: { formats: [".pdb"], required: true },
    outputs: [{ id: "out", glob: "*.fa", required: true }],
  };
}

describe("parseManifest", () => {
  it("accepts a minimal valid v1 manifest", () => {
    const m = parseManifest(baseManifest(), "test/manifest.yaml");
    expect(m.name).toBe("test-model");
    expect(m.modelVersion).toBe("1.0.0");
  });

  it("rejects unknown schema versions with a typed error", () => {
    try {
      parseManifest({ ...baseManifest(), schemaVersion: 99 }, "test/manifest.yaml");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MoldeskError);
      const e = error as MoldeskError;
      expect(e.code).toBe("UNKNOWN_SCHEMA_VERSION");
      expect(e.message).toContain("test/manifest.yaml");
      expect(e.remediation).toMatch(/schemaVersion/i);
    }
  });

  it("accepts per-platform download/disk estimates on a python runtime", () => {
    const raw = baseManifest();
    (raw["runtimes"] as Array<Record<string, unknown>>)[0] = {
      kind: "python",
      python: "3.11",
      installer: "uv",
      requirements: [{ name: "torch" }],
      estimatedDownloadBytesByPlatform: { "darwin-arm64": 73712057, "linux-x64": 2786973382 },
      estimatedDiskBytesByPlatform: { "darwin-arm64": 147424114, "linux-x64": 5573946764 },
    };
    const m = parseManifest(raw, "test/manifest.yaml");
    const runtime = m.runtimes[0] as { estimatedDownloadBytesByPlatform?: Record<string, number> };
    expect(runtime.estimatedDownloadBytesByPlatform?.["linux-x64"]).toBe(2786973382);
  });

  it("rejects a platform key outside the PlatformId enum in a per-platform estimate", () => {
    const raw = baseManifest();
    (raw["runtimes"] as Array<Record<string, unknown>>)[0] = {
      kind: "python",
      python: "3.11",
      installer: "uv",
      requirements: [{ name: "torch" }],
      estimatedDownloadBytesByPlatform: { "windows-x64": 1 },
    };
    expect(() => parseManifest(raw, "test/manifest.yaml")).toThrow();
  });

  it("rejects legacy top-level version without modelVersion", () => {
    const raw = baseManifest() as Record<string, unknown>;
    delete raw["modelVersion"];
    (raw as Record<string, unknown>)["version"] = "1.0.0";
    try {
      parseManifest(raw, "models/x/manifest.yaml");
      expect.unreachable();
    } catch (error) {
      const e = error as MoldeskError;
      expect(e.code).toBe("INVALID_MANIFEST");
      expect(e.message).toContain("modelVersion");
      expect(e.details?.["field"]).toBe("version");
    }
  });

  it.each(["modelVersion", "adapterVersion"])("rejects missing %s", (field) => {
    const raw = baseManifest();
    delete raw[field];
    expect(() => parseManifest(raw, "m.yaml")).toThrowError(MoldeskError);
  });

  it("rejects unsafe model versions and invalid adapter semver", () => {
    expect(() => parseManifest({ ...baseManifest(), modelVersion: "../../escape" }, "m.yaml")).toThrowError(MoldeskError);
    expect(() => parseManifest({ ...baseManifest(), adapterVersion: "latest" }, "m.yaml")).toThrowError(MoldeskError);
  });

  it("rejects unsafe asset target paths", () => {
    for (const target of ["../evil.bin", "/abs/path.bin", "a\\b.bin", "a/./b.bin"]) {
      const raw = baseManifest();
      raw["assets"] = [
        { id: "w", url: "https://example.com/w.bin", sha256: "a".repeat(64), target },
      ];
      try {
        parseManifest(raw, "m.yaml");
        expect.unreachable(`target ${target} should fail`);
      } catch (error) {
        expect((error as MoldeskError).code).toBe("INVALID_MANIFEST");
      }
    }
  });

  it("rejects duplicate model-relevant ids conservatively", () => {
    const raw = baseManifest();
    raw["outputs"] = [
      { id: "dup", glob: "*.a", required: true },
      { id: "dup", glob: "*.b", required: false },
    ];
    expect(() => parseManifest(raw, "m.yaml")).toThrowError(MoldeskError);
  });

  it("rejects unknown keys in high-risk runtime sections", () => {
    const raw = baseManifest();
    raw["runtimes"] = [
      { kind: "python", python: "3.11", installer: "uv", requirements: [{ name: "torch" }], installScript: "curl | sh" },
    ];
    try {
      parseManifest(raw, "m.yaml");
      expect.unreachable();
    } catch (error) {
      const e = error as MoldeskError;
      expect(e.code).toBe("INVALID_MANIFEST");
      expect(e.message).toContain("m.yaml");
    }
  });

  it("accepts only known command tokens without applying shell restrictions", () => {
    const valid = {
      executable: "/Applications/MoleculeDesk (Preview)/python#1",
      args: ["--input={{input}}", "{{outputDir}}"],
      env: { MODEL_DIR: "{{modelDir}}" },
    };
    expect(commandSpecSchema.parse(valid)).toEqual(valid);
    expect(() => commandSpecSchema.parse({ executable: "tool", args: ["{{unknown}}"] })).toThrow();
    expect(() => commandSpecSchema.parse({ executable: "tool", args: ["{{input"] })).toThrow();
    expect(() => commandSpecSchema.parse({ executable: "{{modelDir}}/tool", args: [] })).toThrow();
  });

  it("validates output globs by path segment", () => {
    expect(() => parseManifest({ ...baseManifest(), outputs: [{ id: "out", glob: "foo..bar/*.cif", required: true }] }, "m.yaml")).not.toThrow();
    for (const glob of ["../*.cif", "/tmp/*.cif", "dir\\*.cif", "dir//*.cif"]) {
      expect(() => parseManifest({ ...baseManifest(), outputs: [{ id: "out", glob, required: true }] }, "m.yaml")).toThrowError(MoldeskError);
    }
  });

  it("requires provenance, verification, and pinned dependencies for available models", () => {
    expect(() => parseManifest({ ...baseManifest(), status: "available" }, "m.yaml")).toThrowError(MoldeskError);

    const available = baseManifest();
    available["status"] = "available";
    available["source"] = {
      repository: "https://example.com/model.git",
      revision: "a".repeat(40),
    };
    available["adapterVerification"] = {
      lastVerifiedAt: "2026-09-07T00:00:00Z",
      platforms: ["darwin-arm64"],
    };
    available["runtimes"] = [
      { kind: "python", python: "3.11", installer: "uv", requirements: [{ name: "torch", version: "2.2.1" }] },
    ];
    expect(() => parseManifest(available, "m.yaml")).not.toThrow();
  });

  it("requires nvidiaGpu whenever minVramGb is set", () => {
    const raw = baseManifest();
    raw["hardware"] = { platforms: ["darwin-arm64"], minVramGb: 16 };
    expect(() => parseManifest(raw, "m.yaml")).toThrowError(MoldeskError);

    raw["hardware"] = { platforms: ["darwin-arm64"], minVramGb: 16, nvidiaGpu: "recommended" };
    expect(() => parseManifest(raw, "m.yaml")).not.toThrow();
  });

  it("validates cuda.minDriverCudaVersion as major.minor", () => {
    const raw = baseManifest();
    raw["hardware"] = {
      platforms: ["darwin-arm64"],
      nvidiaGpu: "required",
      cuda: { level: "required", minDriverCudaVersion: "12.1" },
    };
    expect(() => parseManifest(raw, "m.yaml")).not.toThrow();

    raw["hardware"] = {
      platforms: ["darwin-arm64"],
      nvidiaGpu: "required",
      cuda: { level: "required", minDriverCudaVersion: "12.1.0" },
    };
    expect(() => parseManifest(raw, "m.yaml")).toThrowError(MoldeskError);
  });

  it("corrupt fixtures name manifest, field, and remediation", () => {
    try {
      parseManifest({ schemaVersion: 1, name: "Bad Name!" }, "models/bad/manifest.yaml");
      expect.unreachable();
    } catch (error) {
      const e = error as MoldeskError;
      expect(e.message).toContain("models/bad/manifest.yaml");
      expect(e.remediation).toBeTruthy();
      expect(e.details?.["manifestPath"]).toBe("models/bad/manifest.yaml");
    }
  });
});
