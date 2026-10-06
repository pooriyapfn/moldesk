import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMoldeskPaths, type InstallCommandRunner } from "@moldesk/runtime";
import { listAvailableModels, type ModelManifestV1, type RuntimeSpec } from "@moldesk/registry";
import { listInstalledModels } from "./install-state.js";
import {
  createInstallationPlan,
  installModel,
  requiresInstallConfirmation,
  uninstallModel,
  INSTALL_CONFIRMATION_DISK_BYTES,
  INSTALL_CONFIRMATION_DOWNLOAD_BYTES,
} from "./installation.js";

const homes: string[] = [];

function tempPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-core-install-"));
  homes.push(home);
  return getMoldeskPaths({ MOLDESK_HOME: home });
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function successfulRunner(revision: string): InstallCommandRunner {
  return async (command, args) => {
    if (command === "git" && args[0] === "init") {
      const source = args[1]!;
      fs.mkdirSync(path.join(source, "vanilla_model_weights"), { recursive: true });
      fs.mkdirSync(path.join(path.dirname(source), "assets", "vanilla_model_weights"), { recursive: true });
      fs.writeFileSync(path.join(source, "protein_mpnn_run.py"), "# pinned source\n");
      fs.writeFileSync(path.join(source, "vanilla_model_weights", "v_48_020.pt"), "weights");
      fs.writeFileSync(path.join(path.dirname(source), "assets", "vanilla_model_weights", "v_48_020.pt"), "weights");
    }
    if (command === "git" && args.includes("rev-parse")) return { code: 0, stdout: `${revision}\n`, stderr: "" };
    if (command === "uv" && args[0] === "venv") fs.mkdirSync(path.join(args.at(-1)!, "bin"), { recursive: true });
    if (command === "uv" && args.includes("freeze")) return { code: 0, stdout: "numpy==1.26.4\ntorch==2.2.1\n", stderr: "" };
    if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("model installation lifecycle", () => {
  it("installs atomically, persists state, is idempotent, reinstalls, and uninstalls", async () => {
    const paths = tempPaths();
    const manifest = { ...listAvailableModels().find((item) => item.name === "proteinmpnn")!, assets: [] };
    const runtime = manifest.runtimes.find((item) => item.kind === "python")!;
    const planned = await createInstallationPlan(manifest, runtime, paths);
    const runner = successfulRunner(manifest.source!.revision);

    const installed = await installModel(planned, { paths, runner, uvExecutable: "uv" });
    expect(installed.status).toBe("installed");
    expect(fs.existsSync(path.join(planned.targetDir, "installation.json"))).toBe(true);
    expect(listInstalledModels(paths)).toHaveLength(1);

    fs.writeFileSync(path.join(paths.state, "installed-models.json"), "not json");
    expect(listInstalledModels(paths)).toHaveLength(1);

    await expect(installModel(planned, { paths, runner, uvExecutable: "uv" })).resolves.toMatchObject({ status: "already-installed" });
    const sentinel = path.join(planned.targetDir, "keep-on-failed-reinstall");
    fs.writeFileSync(sentinel, "keep");
    const failingRunner: InstallCommandRunner = async (command, args, options) => {
      if (command === "uv" && args[0] === "pip" && args[1] === "install") return { code: 2, stdout: "", stderr: "resolver failed" };
      return runner(command, args, options);
    };
    await expect(installModel(planned, { paths, runner: failingRunner, uvExecutable: "uv", reinstall: true })).rejects.toMatchObject({ code: "INSTALL_COMMAND_FAILED" });
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    fs.rmSync(path.join(planned.targetDir, "assets", "vanilla_model_weights", "v_48_020.pt"));
    await expect(installModel(planned, { paths, runner, uvExecutable: "uv" })).rejects.toMatchObject({ code: "INSTALLATION_DAMAGED" });
    await expect(installModel(planned, { paths, runner, uvExecutable: "uv", reinstall: true })).resolves.toMatchObject({ status: "reinstalled" });

    const removed = await uninstallModel("proteinmpnn", { paths });
    expect(removed).toHaveLength(1);
    expect(fs.existsSync(planned.targetDir)).toBe(false);
    expect(listInstalledModels(paths)).toEqual([]);
  });

  it("lets two runtime fingerprints of the same model version coexist and be selected independently", async () => {
    const paths = tempPaths();
    const base = listAvailableModels().find((item) => item.name === "proteinmpnn")!;
    const manifest = { ...base, assets: [] };
    const pythonRuntime = manifest.runtimes.find((item) => item.kind === "python")!;
    const otherRuntime = { ...pythonRuntime, python: "3.12" };
    const runner = successfulRunner(manifest.source!.revision);

    const plannedA = await createInstallationPlan(manifest, pythonRuntime, paths);
    const plannedB = await createInstallationPlan(manifest, otherRuntime, paths);
    expect(plannedA.runtimeFingerprint).not.toBe(plannedB.runtimeFingerprint);
    expect(plannedA.targetDir).not.toBe(plannedB.targetDir);

    const installedA = await installModel(plannedA, { paths, runner, uvExecutable: "uv" });
    const installedB = await installModel(plannedB, { paths, runner, uvExecutable: "uv" });
    expect(installedA.status).toBe("installed");
    expect(installedB.status).toBe("installed");
    expect(fs.existsSync(plannedA.targetDir)).toBe(true);
    expect(fs.existsSync(plannedB.targetDir)).toBe(true);

    const installed = listInstalledModels(paths);
    expect(installed).toHaveLength(2);
    expect(new Set(installed.map((record) => record.runtime.fingerprint)).size).toBe(2);

    // Neither variant may be removed by an unqualified uninstall while more than one exists.
    await expect(uninstallModel("proteinmpnn", { paths })).rejects.toMatchObject({ code: "RUNTIME_SELECTION_REQUIRED" });

    const removedAll = await uninstallModel("proteinmpnn", { paths, all: true });
    expect(removedAll).toHaveLength(2);
    expect(fs.existsSync(plannedA.targetDir)).toBe(false);
    expect(fs.existsSync(plannedB.targetDir)).toBe(false);
    expect(listInstalledModels(paths)).toEqual([]);
  });

  it("rolls back a failed fresh installation", async () => {
    const paths = tempPaths();
    const manifest = { ...listAvailableModels().find((item) => item.name === "proteinmpnn")!, assets: [] };
    const runtime = manifest.runtimes.find((item) => item.kind === "python")!;
    const planned = await createInstallationPlan(manifest, runtime, paths);
    const base = successfulRunner(manifest.source!.revision);
    const runner: InstallCommandRunner = async (command, args, options) => {
      if (command === "uv" && args[0] === "pip" && args[1] === "install") return { code: 2, stdout: "", stderr: "resolver failed" };
      return base(command, args, options);
    };
    await expect(installModel(planned, { paths, runner, uvExecutable: "uv" })).rejects.toMatchObject({ code: "INSTALL_COMMAND_FAILED" });
    expect(fs.existsSync(planned.targetDir)).toBe(false);
    expect(listInstalledModels(paths)).toEqual([]);
    expect(fs.existsSync(path.dirname(planned.targetDir)) ? fs.readdirSync(path.dirname(planned.targetDir)).some((name) => name.includes(".partial-")) : false).toBe(false);
  });
});

/** A synthetic two-platform manifest built on the registered "proteinmpnn" adapter
 * (so `installPlan`/`verifyInstallation` resolve) but with two platform-scoped
 * python runtime entries and distinct per-entry `source` overrides, exactly the
 * shape a future dual-runtime manifest (e.g. Boltz) will use. */
function dualPlatformManifest(): ModelManifestV1 {
  const base = listAvailableModels().find((item) => item.name === "proteinmpnn")!;
  const darwinSource = { repository: "https://github.com/example/darwin-fork", revision: "a".repeat(40) };
  const linuxSource = { repository: "https://github.com/example/linux-official", revision: "b".repeat(40) };
  const runtimes: RuntimeSpec[] = [
    {
      kind: "python",
      python: "3.11",
      installer: "uv",
      platforms: ["darwin-arm64"],
      source: darwinSource,
      postInstall: ["boltz-fix-macos-libomp"],
      requirements: [{ name: "torch", version: "2.6.0" }],
    },
    {
      kind: "python",
      python: "3.11",
      installer: "uv",
      platforms: ["linux-x64"],
      source: linuxSource,
      requirements: [{ name: "torch", version: "2.2.1" }],
    },
  ];
  return { ...base, source: undefined, assets: [], runtimes };
}

function dualPlatformRunner(): InstallCommandRunner {
  // Tracks the revision most recently fetched, so `rev-parse HEAD` can echo it back
  // correctly regardless of which of the two entries' distinct revisions is being
  // installed in a given call.
  let lastFetchedRevision = "";
  return async (command, args) => {
    if (command === "git" && args[0] === "init") {
      const source = args[1]!;
      fs.mkdirSync(path.join(source, "vanilla_model_weights"), { recursive: true });
      fs.mkdirSync(path.join(path.dirname(source), "assets", "vanilla_model_weights"), { recursive: true });
      fs.writeFileSync(path.join(source, "protein_mpnn_run.py"), "# pinned source\n");
      fs.writeFileSync(path.join(source, "vanilla_model_weights", "v_48_020.pt"), "weights");
      fs.writeFileSync(path.join(path.dirname(source), "assets", "vanilla_model_weights", "v_48_020.pt"), "weights");
    }
    if (command === "git" && args.includes("fetch")) {
      lastFetchedRevision = args.at(-1)!;
    }
    if (command === "git" && args.includes("rev-parse")) return { code: 0, stdout: `${lastFetchedRevision}\n`, stderr: "" };
    if (command === "uv" && args[0] === "venv") fs.mkdirSync(path.join(args.at(-1)!, "bin"), { recursive: true });
    if (command === "uv" && args.includes("freeze")) return { code: 0, stdout: "torch==2.2.1\n", stderr: "" };
    if (args[0] === "--version") return { code: 0, stdout: "Python 3.11.9\n", stderr: "" };
    if (command.endsWith("boltz-fix-macos-libomp")) return { code: 0, stdout: "fixed libomp\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("platform-aware runtime selection", () => {
  it("resolves the darwin-arm64 entry's source/fingerprint/postInstall, and the linux-x64 entry's separately, for the same manifest", async () => {
    const paths = tempPaths();
    const manifest = dualPlatformManifest();

    const darwinPlanned = await createInstallationPlan(manifest, manifest.runtimes[0]!, paths, { platform: "darwin-arm64" });
    expect(darwinPlanned.effectiveSource).toEqual({ repository: "https://github.com/example/darwin-fork", revision: "a".repeat(40) });
    expect(darwinPlanned.resolvedPlatform).toBe("darwin-arm64");
    expect((darwinPlanned.runtime as { platforms?: string[] }).platforms).toEqual(["darwin-arm64"]);

    const linuxPlanned = await createInstallationPlan(manifest, manifest.runtimes[1]!, paths, { platform: "linux-x64" });
    expect(linuxPlanned.effectiveSource).toEqual({ repository: "https://github.com/example/linux-official", revision: "b".repeat(40) });
    expect(linuxPlanned.resolvedPlatform).toBe("linux-x64");

    expect(darwinPlanned.targetDir).not.toBe(linuxPlanned.targetDir);
    expect(darwinPlanned.runtimeFingerprint).not.toBe(linuxPlanned.runtimeFingerprint);
  });

  it("resolves the correct entry regardless of which same-kind candidate the caller passed in (core re-derives from the manifest, not caller identity)", async () => {
    const paths = tempPaths();
    const manifest = dualPlatformManifest();
    // Pass the LINUX entry as `runtime` while requesting the DARWIN platform — core
    // must still resolve the darwin entry, proving selection is platform-driven.
    const planned = await createInstallationPlan(manifest, manifest.runtimes[1]!, paths, { platform: "darwin-arm64" });
    expect(planned.effectiveSource.repository).toBe("https://github.com/example/darwin-fork");
  });

  it("fails closed with RUNTIME_PLATFORM_UNSUPPORTED before creating any staging directory on an unsupported OS/arch", async () => {
    const paths = tempPaths();
    const manifest = dualPlatformManifest();
    manifest.runtimes = [manifest.runtimes[1]!]; // only the linux-x64 entry remains
    await expect(createInstallationPlan(manifest, manifest.runtimes[0]!, paths, { platform: "darwin-arm64" }))
      .rejects.toMatchObject({ code: "RUNTIME_PLATFORM_UNSUPPORTED" });
    expect(fs.existsSync(paths.models) ? fs.readdirSync(paths.models) : []).toEqual([]);
  });


  it("fails closed with RUNTIME_SELECTION_AMBIGUOUS when two entries both match the same platform", async () => {
    const paths = tempPaths();
    const manifest = dualPlatformManifest();
    manifest.runtimes = [
      manifest.runtimes[0]!,
      { ...(manifest.runtimes[0] as RuntimeSpec & { kind: "python" }), python: "3.12" },
    ];
    await expect(createInstallationPlan(manifest, manifest.runtimes[0]!, paths, { platform: "darwin-arm64" }))
      .rejects.toMatchObject({ code: "RUNTIME_SELECTION_AMBIGUOUS" });
  });

  it("runs postInstall only for the platform entry that declares it, and records platform/postInstall/source provenance", async () => {
    const paths = tempPaths();
    const manifest = dualPlatformManifest();
    const runner = dualPlatformRunner();

    const darwinPlanned = await createInstallationPlan(manifest, manifest.runtimes[0]!, paths, { platform: "darwin-arm64" });
    const darwinInstalled = await installModel(darwinPlanned, { paths, runner, uvExecutable: "uv" });
    expect(darwinInstalled.installation.runtime.python?.platform).toBe("darwin-arm64");
    expect(darwinInstalled.installation.runtime.python?.platformSelected).toBe(true);
    expect(darwinInstalled.installation.runtime.python?.postInstall).toEqual([
      { hook: "boltz-fix-macos-libomp", stdout: "fixed libomp\n", stderr: "" },
    ]);
    expect(darwinInstalled.installation.source).toEqual({ repository: "https://github.com/example/darwin-fork", revision: "a".repeat(40) });

    const linuxPlanned = await createInstallationPlan(manifest, manifest.runtimes[1]!, paths, { platform: "linux-x64" });
    const linuxInstalled = await installModel(linuxPlanned, { paths, runner, uvExecutable: "uv" });
    expect(linuxInstalled.installation.runtime.python?.platform).toBe("linux-x64");
    expect(linuxInstalled.installation.runtime.python?.postInstall).toEqual([]);
    expect(linuxInstalled.installation.source).toEqual({ repository: "https://github.com/example/linux-official", revision: "b".repeat(40) });
  });

  it("keeps legacy single-entry, no-platforms manifests fully unaffected: the passed-in runtime is trusted as-is, no selection is performed", async () => {
    const paths = tempPaths();
    const manifest = { ...listAvailableModels().find((item) => item.name === "proteinmpnn")!, assets: [] };
    // A synthetic runtime variant not literally present in manifest.runtimes (mirrors
    // the pre-existing "two fingerprints coexist" test) — since this manifest has
    // exactly one python entry with no `platforms` field, it must be trusted as-is,
    // not re-derived from manifest.runtimes.
    const runtime = { ...manifest.runtimes.find((item) => item.kind === "python")!, python: "3.12" };
    const planned = await createInstallationPlan(manifest, runtime, paths, { platform: "linux-x64" });
    expect(planned.runtime).toBe(runtime);
    expect(planned.effectiveSource).toEqual(manifest.source);
    expect(planned.resolvedPlatform).toBe("linux-x64");
  });
});

describe("requiresInstallConfirmation", () => {
  const knownSmall = { downloadBytes: 180_000_000, downloadSizeUnknown: false, diskBytes: 1_100_000_000, diskSizeUnknown: false };

  it("does not require confirmation for a known small install", () => {
    expect(requiresInstallConfirmation(knownSmall)).toBe(false);
  });

  it("requires confirmation at/above the download threshold", () => {
    expect(requiresInstallConfirmation({ ...knownSmall, downloadBytes: INSTALL_CONFIRMATION_DOWNLOAD_BYTES })).toBe(true);
    expect(requiresInstallConfirmation({ ...knownSmall, downloadBytes: INSTALL_CONFIRMATION_DOWNLOAD_BYTES - 1 })).toBe(false);
  });

  it("requires confirmation at/above the disk threshold", () => {
    expect(requiresInstallConfirmation({ ...knownSmall, diskBytes: INSTALL_CONFIRMATION_DISK_BYTES })).toBe(true);
    expect(requiresInstallConfirmation({ ...knownSmall, diskBytes: INSTALL_CONFIRMATION_DISK_BYTES - 1 })).toBe(false);
  });

  it("treats an unknown size as confirmation-worthy even when the known bytes are small", () => {
    expect(requiresInstallConfirmation({ ...knownSmall, downloadSizeUnknown: true })).toBe(true);
    expect(requiresInstallConfirmation({ ...knownSmall, diskSizeUnknown: true })).toBe(true);
  });

  it("always requires confirmation for a destructive replacement, regardless of size", () => {
    expect(requiresInstallConfirmation(knownSmall, { destructive: true })).toBe(true);
    expect(requiresInstallConfirmation({ downloadBytes: 0, downloadSizeUnknown: false, diskBytes: 0, diskSizeUnknown: false }, { destructive: true })).toBe(true);
  });
});
