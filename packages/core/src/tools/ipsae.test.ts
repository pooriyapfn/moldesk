import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMoldeskPaths, type AssetFetch, type InstallCommandRunner } from "@moldesk/runtime";
import { IPSAE_SOURCE, IPSAE_REQUIREMENTS, installIpsae, ipsaeDir, requireIpsae, uninstallIpsae } from "./ipsae.js";
import { IPSAE_TABLE } from "../testSupport/interface.js";

vi.mock("@moldesk/runtime", async (original) => ({ ...await original<typeof import("@moldesk/runtime")>(),
  prepareManagedPython: vi.fn(async (o: { targetDir: string }) => {
    const executable = path.join(o.targetDir, ".venv/bin/python");
    fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, "fake managed python");
    return { executable, uv: "/managed/uv", env: { UV_PYTHON_PREFERENCE: "only-managed" } };
  }),
}));
let root: string;
const originalSource = { ...IPSAE_SOURCE };
const bytes = Buffer.from("# fake pinned scorer for lifecycle tests\n");
const fakeSha = createHash("sha256").update(bytes).digest("hex");
const fetcher: AssetFetch = async () => new Response(bytes);
const runner: InstallCommandRunner = async (_cmd, args, options) => {
  if (args.some((a) => a.endsWith("ipsae.py"))) fs.writeFileSync(path.join(options!.cwd!, "prediction_15_15.txt"), IPSAE_TABLE);
  return { code: 0, stdout: "3.11.13\n", stderr: "" };
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-ipsae-tool-"));
  Object.assign(IPSAE_SOURCE, { sha256: fakeSha, sizeBytes: bytes.length });
});
afterEach(() => { Object.assign(IPSAE_SOURCE, originalSource); fs.rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
const paths = () => getMoldeskPaths({ MOLDESK_HOME: root });
describe("managed ipSAE lifecycle", () => {
  it("installs, verifies receipt/source/environment, remains offline/idempotent, uninstalls", async () => {
    const fetch = vi.fn(fetcher), calls: string[][] = [];
    const installed = await installIpsae({ paths: paths(), fetch, runner: async (cmd, args, o) => { calls.push(args); return runner(cmd, args, o); } });
    expect(installed.status).toBe("installed"); expect(installed.installation.receipt.sourceSha256).toBe(fakeSha);
    expect(calls.find((a) => a.includes("--require-hashes"))).toEqual(expect.arrayContaining(["--no-deps", "--only-binary", ":all:"]));
    expect(IPSAE_REQUIREMENTS).toContain("numpy==2.2.6");
    expect(await requireIpsae(paths())).toMatchObject({ executable: path.join(ipsaeDir(paths()), ".venv/bin/python") });
    expect((await installIpsae({ paths: paths(), runner, fetch: async () => { throw new Error("network forbidden"); } })).status).toBe("already-installed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await uninstallIpsae({ paths: paths() })).toBe(true); expect(await uninstallIpsae({ paths: paths() })).toBe(false);
    await expect(requireIpsae(paths())).rejects.toMatchObject({ code: "IPSAE_NOT_INSTALLED" });
  });
  it("rejects checksum failures and preserves the earlier installation on a failed reinstall", async () => {
    await expect(installIpsae({ paths: paths(), runner, fetch: async () => new Response(Buffer.alloc(bytes.length)) })).rejects.toMatchObject({ code: "ASSET_CHECKSUM_MISMATCH" });
    await installIpsae({ paths: paths(), runner, fetch: fetcher });
    await expect(installIpsae({ paths: paths(), fetch: fetcher, reinstall: true, runner: async () => ({ code: 1, stdout: "", stderr: "install failed" }) })).rejects.toMatchObject({ code: "IPSAE_INSTALL_FAILED" });
    expect((await requireIpsae(paths())).receipt.sourceSha256).toBe(fakeSha);
    expect(fs.readdirSync(path.dirname(ipsaeDir(paths())))).toHaveLength(1);
  });
  it.each(["ipsae.py", ".venv/bin/python", "validate.py", "requirements.txt"])("detects damaged %s", async (file) => {
    await installIpsae({ paths: paths(), runner, fetch: fetcher });
    fs.appendFileSync(path.join(ipsaeDir(paths()), file), "tamper");
    await expect(requireIpsae(paths())).rejects.toMatchObject({ code: "IPSAE_DAMAGED" });
  });
});
