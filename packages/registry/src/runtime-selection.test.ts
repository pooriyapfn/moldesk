import { describe, expect, it } from "vitest";
import { MoldeskError } from "./errors.js";
import { detectHostPlatformId, effectiveRuntimeSource, selectPythonRuntime } from "./runtime-selection.js";
import type { RuntimeSpec } from "./schema.js";

function pythonRuntime(overrides: Partial<RuntimeSpec & { kind: "python" }> = {}): RuntimeSpec {
  return {
    kind: "python",
    python: "3.11",
    installer: "uv",
    requirements: [{ name: "torch" }],
    ...overrides,
  } as RuntimeSpec;
}

describe("detectHostPlatformId", () => {
  it("maps darwin/arm64 to darwin-arm64", () => {
    expect(detectHostPlatformId("darwin", "arm64")).toBe("darwin-arm64");
  });
  it("maps linux/x64 to linux-x64", () => {
    expect(detectHostPlatformId("linux", "x64")).toBe("linux-x64");
  });
  it("returns undefined for unsupported platform/arch combinations", () => {
    expect(detectHostPlatformId("win32", "x64")).toBeUndefined();
    expect(detectHostPlatformId("darwin", "x64")).toBeUndefined();
    expect(detectHostPlatformId("linux", "arm64")).toBeUndefined();
  });
});

describe("selectPythonRuntime", () => {
  it("resolves a legacy manifest with no platforms field on its one entry, on any platform", () => {
    const legacy = pythonRuntime();
    expect(selectPythonRuntime([legacy], "darwin-arm64")).toBe(legacy);
    expect(selectPythonRuntime([legacy], "linux-x64")).toBe(legacy);
    expect(selectPythonRuntime([legacy], undefined)).toBe(legacy);
  });

  it("resolves a single match among per-platform entries", () => {
    const darwin = pythonRuntime({ platforms: ["darwin-arm64"] });
    const linux = pythonRuntime({ platforms: ["linux-x64"] });
    expect(selectPythonRuntime([darwin, linux], "darwin-arm64")).toBe(darwin);
    expect(selectPythonRuntime([darwin, linux], "linux-x64")).toBe(linux);
  });

  it("fails closed with RUNTIME_PLATFORM_UNSUPPORTED on zero matches", () => {
    const linuxOnly = pythonRuntime({ platforms: ["linux-x64"] });
    try {
      selectPythonRuntime([linuxOnly], "darwin-arm64");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MoldeskError);
      expect((error as MoldeskError).code).toBe("RUNTIME_PLATFORM_UNSUPPORTED");
    }
  });

  it("fails closed with RUNTIME_PLATFORM_UNSUPPORTED when the host platform is undetected", () => {
    const linuxOnly = pythonRuntime({ platforms: ["linux-x64"] });
    expect(() => selectPythonRuntime([linuxOnly], undefined)).toThrowError(MoldeskError);
  });

  it("fails closed with RUNTIME_SELECTION_AMBIGUOUS when two entries both match the same platform", () => {
    const first = pythonRuntime({ platforms: ["darwin-arm64"] });
    const second = pythonRuntime({ platforms: ["darwin-arm64"], python: "3.12" });
    try {
      selectPythonRuntime([first, second], "darwin-arm64");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MoldeskError);
      expect((error as MoldeskError).code).toBe("RUNTIME_SELECTION_AMBIGUOUS");
    }
  });

  it("ignores non-python runtime entries entirely", () => {
    const docker: RuntimeSpec = { kind: "docker", image: "x", digest: `sha256:${"a".repeat(64)}`, gpu: "none" };
    const python = pythonRuntime();
    expect(selectPythonRuntime([docker, python], "linux-x64")).toBe(python);
  });
});

describe("effectiveRuntimeSource", () => {
  const manifestSource = { repository: "https://github.com/example/manifest-level", revision: "a".repeat(40) };
  const entrySource = { repository: "https://github.com/example/entry-level", revision: "b".repeat(40) };

  it("prefers the per-entry source override when present", () => {
    expect(effectiveRuntimeSource({ source: manifestSource }, { source: entrySource })).toEqual(entrySource);
  });

  it("falls back to the manifest-level source when the entry has none", () => {
    expect(effectiveRuntimeSource({ source: manifestSource }, {})).toEqual(manifestSource);
  });

  it("returns undefined when neither is set", () => {
    expect(effectiveRuntimeSource({}, {})).toBeUndefined();
  });
});
