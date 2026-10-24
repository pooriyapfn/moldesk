import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MoldeskError } from "@moldesk/core";
import { registerInstallCommand } from "./install.js";
import { registerUninstallCommand } from "./uninstall.js";

const state = vi.hoisted(() => ({
  plan: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  requireCompiler: vi.fn(),
  confirm: vi.fn(),
  uninstallModel: vi.fn(),
  tty: false,
}));

vi.mock("@moldesk/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moldesk/core")>();
  return {
    ...actual,
    planUsalignInstall: state.plan,
    installUsalign: state.install,
    uninstallUsalign: state.uninstall,
    requireCompiler: state.requireCompiler,
    uninstallModel: state.uninstallModel,
  };
});
vi.mock("../utils/confirm.js", () => ({ confirm: state.confirm }));

const PLAN = {
  alreadyInstalled: false,
  version: "20260527",
  downloadBytes: 263_246,
  source: { url: "https://codeload.github.com/pylelab/USalign/tar.gz/abc", sha256: "c".repeat(64) },
  compiler: { command: "c++", version: "Apple clang" },
};
const RECEIPT = { tool: "usalign", version: "20260527" };

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  for (const fn of Object.values(state)) if (typeof fn === "function") (fn as ReturnType<typeof vi.fn>).mockReset();
  state.plan.mockResolvedValue(PLAN);
  state.requireCompiler.mockResolvedValue(PLAN.compiler);
  state.install.mockResolvedValue({ status: "installed", installation: { receipt: RECEIPT } });
  state.uninstall.mockResolvedValue(true);
  state.confirm.mockResolvedValue(true);
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function install(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerInstallCommand(program);
  await program.parseAsync(["install", "usalign", ...args], { from: "user" });
}

async function uninstall(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerUninstallCommand(program);
  await program.parseAsync(["uninstall", "usalign", ...args], { from: "user" });
}

describe("moldesk install usalign", () => {
  it("never builds downloaded code without a yes, even for a tiny download", async () => {
    await install("--json");
    expect(JSON.parse(out[0])).toMatchObject({ tool: "usalign", status: "confirmation-required", downloadBytes: 263_246 });
    expect(process.exitCode).toBe(1);
    expect(state.install).not.toHaveBeenCalled();
  });

  it("installs with --yes and shows the plan: source, checksum, compiler", async () => {
    await install("--yes");
    expect(state.install).toHaveBeenCalledOnce();
    const text = out.join("\n");
    expect(text).toContain("https://codeload.github.com/pylelab/USalign/tar.gz/abc");
    expect(text).toContain(`SHA-256 ${"c".repeat(64)}`);
    expect(text).toContain("Build it with c++ (Apple clang)");
    expect(text).toContain("US-align 20260527: installed.");
  });

  it("emits a JSON result with the installation record", async () => {
    await install("--yes", "--json");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ status: "installed", installation: RECEIPT });
  });

  it("asks interactively and honors a no", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    state.confirm.mockResolvedValueOnce(false);
    await install();
    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.install).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("Installation cancelled");
  });

  it("fails before asking when there is no compiler", async () => {
    state.requireCompiler.mockRejectedValue(new MoldeskError({ code: "COMPILER_NOT_FOUND", message: "No C++ compiler found", remediation: "Install g++" }));
    await install("--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "COMPILER_NOT_FOUND" });
    expect(process.exitCode).toBe(2);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.install).not.toHaveBeenCalled();
  });

  it("is a no-op when installed, unless --reinstall", async () => {
    state.plan.mockResolvedValue({ ...PLAN, alreadyInstalled: true });
    state.install.mockResolvedValue({ status: "already-installed", installation: { receipt: RECEIPT } });
    await install();
    expect(out.join("\n")).toContain("already installed");
    expect(state.confirm).not.toHaveBeenCalled();

    state.install.mockClear();
    await install("--reinstall", "--yes");
    expect(state.install).toHaveBeenCalledWith(expect.objectContaining({ reinstall: true }));
  });

  it("reports a failed build as an error and exit 10", async () => {
    state.install.mockRejectedValue(new MoldeskError({ code: "USALIGN_BUILD_FAILED", message: "Building failed", remediation: "x" }));
    await install("--yes", "--json");
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ status: "error", code: "USALIGN_BUILD_FAILED" });
    expect(process.exitCode).toBe(10);
  });
});

describe("moldesk uninstall usalign", () => {
  it("removes the tool and does not touch model installs", async () => {
    await uninstall("--yes", "--json");
    expect(JSON.parse(out[0])).toEqual({ tool: "usalign", status: "uninstalled" });
    expect(state.uninstallModel).not.toHaveBeenCalled();
  });

  it("says when it is not installed", async () => {
    state.uninstall.mockResolvedValue(false);
    await uninstall("--yes");
    expect(out[0]).toBe("US-align is not installed.");
  });
});
