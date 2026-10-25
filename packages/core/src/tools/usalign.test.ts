import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallCommandRunner, RunResult } from "@moldesk/runtime";
import { usalignHome } from "../testSupport/usalign.js";
import {
  detectCompiler,
  getUsalignStatus,
  installUsalign,
  planUsalignInstall,
  requireUsalign,
  uninstallUsalign,
  USALIGN_SOURCE,
  USALIGN_VERSION,
  usalignDir,
} from "./usalign.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-usalign-tool-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const withCompiler: InstallCommandRunner = async (command) => (command === "g++" ? ok("g++ (GCC) 13.2.0\nmore") : { code: 127, stdout: "", stderr: "not found" });
const noCompiler: InstallCommandRunner = async () => ({ code: 127, stdout: "", stderr: "not found" });

describe("pinned source", () => {
  it("is an https URL pinned to an immutable commit, with a SHA-256 and a size", () => {
    expect(USALIGN_SOURCE.url).toMatch(/^https:\/\/codeload\.github\.com\/pylelab\/USalign\/tar\.gz\/[0-9a-f]{40}$/);
    expect(USALIGN_SOURCE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(USALIGN_SOURCE.sizeBytes).toBe(263_246);
    expect(USALIGN_SOURCE.archive).toBe("tar.gz");
  });
});

describe("detectCompiler / status / plan", () => {
  it("returns the first compiler that answers, with its version line", async () => {
    expect(await detectCompiler(withCompiler)).toEqual({ command: "g++", version: "g++ (GCC) 13.2.0" });
    expect(await detectCompiler(noCompiler)).toBeNull();
    const throwing: InstallCommandRunner = async () => { throw new Error("ENOENT"); };
    expect(await detectCompiler(throwing)).toBeNull();
  });

  it("reports not installed, installed, and damaged", async () => {
    const empty = usalignHome(path.join(dir, "a"));
    expect(await getUsalignStatus({ paths: empty, runner: noCompiler })).toEqual({ installed: false, compiler: null });

    const installed = usalignHome(path.join(dir, "b"), { installed: true });
    const status = await getUsalignStatus({ paths: installed, runner: withCompiler });
    expect(status).toMatchObject({ installed: true, compiler: { command: "g++" }, installation: { version: USALIGN_VERSION } });
    expect(requireUsalign(installed).executable).toBe(path.join(usalignDir(installed), "bin", "USalign"));

    fs.appendFileSync(path.join(usalignDir(installed), "bin", "USalign"), "x");
    expect(await getUsalignStatus({ paths: installed, runner: noCompiler })).toMatchObject({ installed: false, problem: "the USalign binary changed after installation" });
    expect(() => requireUsalign(installed)).toThrow(expect.objectContaining({ code: "USALIGN_DAMAGED" }));

    fs.rmSync(path.join(usalignDir(installed), "bin", "USalign"));
    expect(() => requireUsalign(installed)).toThrow(expect.objectContaining({ code: "USALIGN_DAMAGED" }));
    fs.writeFileSync(path.join(usalignDir(installed), "installation.json"), "{");
    expect(() => requireUsalign(installed)).toThrow(expect.objectContaining({ code: "USALIGN_DAMAGED" }));
  });

  it("plans the install with the download size and source", async () => {
    const plan = await planUsalignInstall({ paths: usalignHome(path.join(dir, "c")), runner: withCompiler });
    expect(plan).toMatchObject({ alreadyInstalled: false, version: USALIGN_VERSION, downloadBytes: 263_246, source: { sha256: USALIGN_SOURCE.sha256 } });
  });
});

describe("installUsalign failures leave nothing behind", () => {
  const nothingLeft = (paths: ReturnType<typeof usalignHome>) => {
    expect(fs.existsSync(path.join(paths.tools, "usalign")) ? fs.readdirSync(path.join(paths.tools, "usalign")) : []).toEqual([]);
  };

  it("stops before downloading when there is no C++ compiler", async () => {
    const paths = usalignHome(dir);
    let fetched = 0;
    const error = await installUsalign({ paths, runner: noCompiler, fetch: async () => { fetched++; throw new Error("no"); } }).catch((e) => e);
    expect(error).toMatchObject({ code: "COMPILER_NOT_FOUND" });
    expect(error.remediation).toMatch(/xcode-select|g\+\+/);
    expect(fetched).toBe(0);
    nothingLeft(paths);
  });

  it.each([
    ["wrong content of the right size", () => Buffer.alloc(263_246, 1)],
    ["wrong size", () => Buffer.alloc(1000, 1)],
  ])("rejects a download with %s and keeps nothing", async (_name, bytes) => {
    const paths = usalignHome(dir);
    const fetch = async () => new Response(bytes(), { headers: { "content-length": String(bytes().length) } }) as never;
    await expect(installUsalign({ paths, runner: withCompiler, fetch })).rejects.toMatchObject({ code: expect.stringMatching(/^ASSET_/) });
    nothingLeft(paths);
    expect(fs.existsSync(paths.objects) ? fs.readdirSync(paths.objects) : []).toEqual([]);
  });

  it("reports a failed download", async () => {
    const paths = usalignHome(dir);
    await expect(installUsalign({ paths, runner: withCompiler, fetch: async () => new Response("nope", { status: 404 }) as never })).rejects.toMatchObject({ code: "ASSET_DOWNLOAD_FAILED" });
    nothingLeft(paths);
  });

  it("does nothing when it is already installed", async () => {
    const paths = usalignHome(dir, { installed: true });
    const result = await installUsalign({ paths, runner: noCompiler });
    expect(result.status).toBe("already-installed");
  });
});

describe("uninstallUsalign", () => {
  it("removes the installation once", async () => {
    const paths = usalignHome(dir, { installed: true });
    expect(await uninstallUsalign({ paths })).toBe(true);
    expect(fs.existsSync(usalignDir(paths))).toBe(false);
    expect(await uninstallUsalign({ paths })).toBe(false);
  });
});
