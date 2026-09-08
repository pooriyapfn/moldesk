import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MoldeskError } from "@moldesk/registry";
import { getMoldeskHome, getMoldeskPaths, modelInstallDir, uvToolDir } from "./paths.js";

describe("moldesk paths", () => {
  it("honors MOLDESK_HOME override", () => {
    const p = getMoldeskPaths({ MOLDESK_HOME: "/tmp/custom-home" });
    expect(p.home).toBe(path.resolve("/tmp/custom-home"));
    expect(p.downloads).toBe(path.join(p.home, "cache", "downloads"));
    expect(p.locks).toBe(path.join(p.home, "state", "locks"));
  });

  it("defaults to ~/.moldesk", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(getMoldeskHome(env)).toBe(path.join(os.homedir(), ".moldesk"));
  });

  it("nests one model version with multiple runtime fingerprints", () => {
    const a = modelInstallDir("boltz", "2.2.1", "python-aaaaaaaaaaaaaaaa", { MOLDESK_HOME: "/tmp/h" });
    const b = modelInstallDir("boltz", "2.2.1", "docker-bbbbbbbbbbbbbbbb", { MOLDESK_HOME: "/tmp/h" });
    expect(a).toContain(path.join("models", "boltz", "2.2.1", "python-aaaaaaaaaaaaaaaa"));
    expect(b).toContain(path.join("models", "boltz", "2.2.1", "docker-bbbbbbbbbbbbbbbb"));
    expect(a).not.toBe(b);
  });

  it("rejects traversal and malformed installation path segments", () => {
    const env = { MOLDESK_HOME: "/tmp/h" };
    expect(() => modelInstallDir("../escape", "1.0.0", "python-aaaaaaaaaaaaaaaa", env)).toThrowError(MoldeskError);
    expect(() => modelInstallDir("boltz", "../../escape", "python-aaaaaaaaaaaaaaaa", env)).toThrowError(MoldeskError);
    expect(() => modelInstallDir("boltz", "1.0.0", "../../escape", env)).toThrowError(MoldeskError);
    expect(() => uvToolDir("../../escape", env)).toThrowError(MoldeskError);
  });

  it("rejects filesystem root and the user home as MOLDESK_HOME", () => {
    expect(() => getMoldeskHome({ MOLDESK_HOME: path.parse(path.resolve(path.sep)).root })).toThrowError(MoldeskError);
    expect(() => getMoldeskHome({ MOLDESK_HOME: os.homedir() })).toThrowError(MoldeskError);
  });
});
