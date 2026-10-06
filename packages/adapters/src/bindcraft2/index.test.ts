import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { modelManifestV1Schema } from "@moldesk/registry";
import { stageCompanionInputs } from "@moldesk/runtime";
import type { RunContext } from "../index.js";
import { bindcraft2Adapter as adapter } from "./index.js";

let root: string;
let input: string;
let context: RunContext;
const job = () => ({ targets: [{ name: "target", target_path: "target.pdb", chains: "A" }], modality: "binder", binder_lengths: [50, 60], number_of_final_designs: 1, max_trajectories: 2 });
function writeJob(value: unknown) { fs.writeFileSync(input, JSON.stringify(value)); }
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bindcraft2-test-"));
  input = path.join(root, "campaign.json");
  fs.writeFileSync(path.join(root, "target.pdb"), "ATOM target\n");
  writeJob(job());
  context = { manifestName: "bindcraft2", inputPath: input, outputDir: path.join(root, "run/output"), modelDir: path.join(root, "model"), assetsDir: path.join(root, "model/assets"), runtimeExecutable: "python3", platform: "linux-x64", params: {} };
  fs.mkdirSync(context.outputDir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
async function stage() {
  const inputDir = path.join(root, "run/input");
  fs.mkdirSync(inputDir, { recursive: true });
  const paths = stageCompanionInputs({ jobFilePath: input, refs: await adapter.resolveCompanionInputs!(input), inputDir });
  const copied = path.join(inputDir, "campaign.json");
  fs.copyFileSync(input, copied);
  context.inputPath = copied;
  context.companionInputs = paths.map((p) => ({ id: p.id, path: p.storedPath }));
}
function output(relative: string, text: string) {
  const file = path.join(context.outputDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function results(accepted = 0, attempted = 2) {
  output("moldesk-campaign.json", JSON.stringify({ ...job(), project_folder: context.outputDir }));
  output("campaign_metadata.json", "{}");
  output("1_Trajectories/!_Trajectories.csv", 'design,trajectory,Timing\nfirst,1,"compile,design"\nsecond,2,"compile,design"\n');
  output("summary.csv", `campaign,scope,metric,samples,mean,std,min,max\nx,campaign,trajectories,1,${attempted},0,${attempted},${attempted}\nx,campaign,accepted_designs,1,${accepted},0,${accepted},${accepted}\n`);
}

describe("BindCraft2 inputs and staging", () => {
  it("accepts the checked-in bounded campaign", async () => {
    await adapter.validateInput(fileURLToPath(new URL("../../../../examples/bindcraft2/campaign.json", import.meta.url)));
  });
  it.each([null, [], {}, { targets: [] }, { ...job(), arbitrary_file: "outside" }, { ...job(), target: "hPDL1" }, { ...job(), resume: true }, { ...job(), auto_multi_gpu: true }, { ...job(), design_workers: 2 }, { ...job(), campaign_seed: -1 }, { ...job(), binder_scaffold: "scaffold.exe" }, { ...job(), targets: [{ name: "../bad", target_path: "target.pdb" }] }, { ...job(), targets: [{ name: "target", target_path: "target.pdb", arbitrary_file: "outside" }] }, { ...job(), targets: [job().targets[0], job().targets[0]] }])("rejects malformed/unsupported campaign %#", async (value) => {
    writeJob(value);
    await expect(adapter.validateInput(input)).rejects.toBeDefined();
  });
  it.each(["missing.pdb", "../escape.pdb", "/etc/passwd", "target.exe"])('rejects unsafe/missing target "%s"', async (target_path) => {
    writeJob({ ...job(), targets: [{ name: "target", target_path }] });
    await expect(adapter.validateInput(input)).rejects.toBeDefined();
  });
  it("rejects empty files and ancestor symlinks escaping the job tree", async () => {
    fs.writeFileSync(path.join(root, "target.pdb"), "");
    await expect(adapter.validateInput(input)).rejects.toBeDefined();
    fs.symlinkSync(os.tmpdir(), path.join(root, "outside"));
    writeJob({ ...job(), targets: [{ name: "target", target_path: `outside/${path.basename(root)}/target.pdb` }] });
    // A symlink to the same input tree is allowed; this target remains empty.
    await expect(adapter.validateInput(input)).rejects.toBeDefined();
    const escaped = path.join(os.tmpdir(), `escape-${path.basename(root)}.pdb`);
    fs.writeFileSync(escaped, "ATOM outside\n");
    try {
      writeJob({ ...job(), targets: [{ name: "target", target_path: `outside/${path.basename(escaped)}` }] });
      await expect(adapter.validateInput(input)).rejects.toBeDefined();
    } finally { fs.unlinkSync(escaped); }
  });
  it("stages every target and custom scaffold; command survives deleting originals", async () => {
    fs.writeFileSync(path.join(root, "scaffold.cif"), "data_scaffold\n");
    writeJob({ ...job(), binder_lengths: undefined, binder_scaffold: "scaffold.cif" });
    await stage();
    fs.unlinkSync(input); fs.unlinkSync(path.join(root, "target.pdb")); fs.unlinkSync(path.join(root, "scaffold.cif"));
    await adapter.command(context);
    const resolved = JSON.parse(fs.readFileSync(path.join(context.outputDir, "moldesk-campaign.json"), "utf8"));
    expect(resolved.targets[0].target_path).toBe(context.companionInputs![0]!.path);
    expect(resolved.binder_scaffold).toBe(context.companionInputs![1]!.path);
    expect(resolved.project_folder).toBe(context.outputDir);
  });
});

describe("BindCraft2 command", () => {
  it("runs installed CLI module against managed source/assets with bounded single-worker settings", async () => {
    await stage();
    context.params = { max_trajectories: 1, number_of_final_designs: 2, min_length: 60, max_length: 70 };
    const command = await adapter.command(context);
    expect(command.executable).toBe(context.runtimeExecutable);
    expect(command.args.slice(0, 1)).toEqual(["-c"]);
    expect(command.args.slice(-2)).toEqual(["design", path.join(context.outputDir, "moldesk-campaign.json")]);
    expect(command.args[1]).toContain("from bindcraft.cli import main");
    expect(command.args[1]).toContain("del os.environ[key]");
    expect(command.args[1]).toContain("model_weights(download=False)");
    expect(command.args[1]).toContain("CPU fallback refused");
    expect(command.env?.PYTHONPATH).toBe(path.join(context.modelDir, "source"));
    expect(command.env?.JAX_PLATFORMS).toBe("cuda");
    expect(command.env?.BINDCRAFT_AF2_PARAMS).toBe(path.join(context.assetsDir, "alphafold"));
    const resolved = JSON.parse(fs.readFileSync(command.args.at(-1)!, "utf8"));
    expect(resolved).toMatchObject({ max_trajectories: 1, number_of_final_designs: 2, binder_lengths: [60, 70], resume: false, auto_multi_gpu: false, design_workers: 1 });
  });
  it.each([{}, { max_trajectories: 0 }, { max_trajectories: 1.5 }, { max_trajectories: Number.MAX_SAFE_INTEGER + 1 }, { max_trajectories: 1, number_of_final_designs: -1 }, { max_trajectories: 1, modality: "binder,VHH" }, { max_trajectories: 1, min_length: 10 }, { max_trajectories: 1, min_length: 70, max_length: 60 }, { max_trajectories: 1, resume: true }])("rejects invalid effective params %#", async (params) => {
    writeJob({ ...job(), max_trajectories: undefined }); await stage(); context.params = params;
    await expect(adapter.command(context)).rejects.toBeDefined();
    expect(fs.existsSync(path.join(context.outputDir, "moldesk-campaign.json"))).toBe(false);
  });
  it("rejects non-Linux installs and missing staged files", async () => {
    await expect(adapter.command(context)).rejects.toBeDefined();
    await stage(); context.platform = "darwin-arm64";
    await expect(adapter.command(context)).rejects.toBeDefined();
  });
  it("rejects a staged reference whose ancestor symlink escapes immutable input", async () => {
    await stage();
    const link = path.join(path.dirname(context.inputPath), "escape");
    fs.symlinkSync(root, link);
    context.companionInputs![0]!.path = path.join(link, "target.pdb");
    await expect(adapter.command(context)).rejects.toBeDefined();
  });
  it("accepts a shipped VHH scaffold and rejects conflicting lengths", async () => {
    writeJob({ ...job(), modality: "VHH", binder_lengths: undefined }); await stage();
    await expect(adapter.command(context)).resolves.toBeDefined();
    fs.unlinkSync(path.join(context.outputDir, "moldesk-campaign.json")); context.params = { min_length: 50, max_length: 60 };
    await expect(adapter.command(context)).rejects.toBeDefined();
  });
  it("uses final installation paths after atomic relocation", async () => {
    await stage(); context.modelDir = path.join(root, "promoted-install"); context.assetsDir = path.join(context.modelDir, "assets");
    const command = await adapter.command(context);
    expect(command.env?.PYTHONPATH).toBe(path.join(root, "promoted-install/source"));
    expect(Object.values(command.env!)).not.toContain(".partial");
  });
});

describe("BindCraft2 manifest", () => {
  const manifest = modelManifestV1Schema.parse(parseYaml(fs.readFileSync(fileURLToPath(new URL("../../../../models/bindcraft2/manifest.yaml", import.meta.url)), "utf8")));
  it("stays planned, restricts Linux/NVIDIA and preserves exact hosting-restricted license", () => {
    expect(manifest.status).toBe("planned");
    expect(manifest.hardware.platforms).toEqual(["linux-x64"]);
    expect(manifest.hardware.nvidiaGpu).toBe("required");
    expect(manifest.license).toBe("BindCraft2 Source-Available License (Hosting-Restricted)");
    expect(manifest.adapterVerification).toBeUndefined();
  });
  it("pins source, full dependency closure, binary accelerator artifacts and official archive", () => {
    expect(manifest.source?.revision).toMatch(/^[0-9a-f]{40}$/);
    const runtime = manifest.runtimes[0]!;
    expect(runtime.kind).toBe("python");
    if (runtime.kind !== "python") throw new Error("expected Python runtime");
    expect(runtime.python).toBe("3.12");
    for (const requirement of runtime.requirements) expect(requirement.version ?? requirement.revision).toBeTruthy();
    for (const name of runtime.binaryOnly!) expect(runtime.requirements.find((r) => r.name === name)?.hashes).toHaveLength(1);
    expect(runtime.requirements.find((r) => r.name === "bindcraft")).toMatchObject({ revision: manifest.source!.revision, extras: ["cuda12"] });
    expect(manifest.assets).toEqual([expect.objectContaining({ archive: "tar", target: "alphafold", sizeBytes: 5587968000, sha256: "36d4b0220f3c735f3296d301152b738c9776d16981d054845a68a1370b26cfe3" })]);
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;
describe.skipIf(!hasPython)("BindCraft2 real result parser (stdlib Python)", () => {
  it("accepts finite zero-design results and parses quoted CSV fields", async () => {
    results();
    const collected = await adapter.collectOutputs(context);
    expect(collected.some((o) => o.id === "accepted_structures")).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(context.outputDir, "moldesk-summary.json"), "utf8"))).toMatchObject({ attempted: 2, accepted: 0, budgetExhausted: true, goalReached: false });
  });
  it.each(["missing metadata", "invalid metadata", "malformed csv", "over budget", "early stop", "missing accepted structure", "symlink ranked output"])("rejects %s", async (kind) => {
    results();
    if (kind === "missing metadata") fs.unlinkSync(path.join(context.outputDir, "campaign_metadata.json"));
    if (kind === "invalid metadata") output("campaign_metadata.json", "[]");
    if (kind === "malformed csv") output("1_Trajectories/!_Trajectories.csv", "design,trajectory\nx,1,extra\n");
    if (kind === "over budget") results(0, 3);
    if (kind === "early stop") { results(0, 1); output("1_Trajectories/!_Trajectories.csv", "design,trajectory\nx,1\n"); }
    if (kind === "missing accepted structure") { results(1); output("3_Ranked/!_Ranked.csv", "design,rank\nx,1\n"); }
    if (kind === "symlink ranked output") { fs.mkdirSync(path.join(context.outputDir, "3_Ranked")); fs.symlinkSync(input, path.join(context.outputDir, "3_Ranked/!_Ranked.csv")); }
    await expect(adapter.collectOutputs(context)).rejects.toBeDefined();
    expect(fs.existsSync(path.join(context.outputDir, "moldesk-summary.json"))).toBe(false);
  });
});

describe("BindCraft2 installation verification", () => {
  it("rejects unsupported platform or missing installation files before running a probe", async () => {
    const runner = vi.fn();
    expect((await adapter.verifyInstallation({ ...context, manifestName: "bindcraft2", platform: "darwin-arm64", runner })).passed).toBe(false);
    expect((await adapter.verifyInstallation({ ...context, manifestName: "bindcraft2", runner })).passed).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
  it("checks pinned package, MPNN digests, AlphaFold integrity, real CUDA operation, CLI and upstream self-check", async () => {
    for (const relative of [".venv/bin/python", ".venv/bin/bindcraft", "source/settings/core/default.json",
      ...[1, 2, 3, 4, 5].map((i) => `assets/alphafold/params_model_${i}_multimer_v3.npz`),
      ...[1, 2].map((i) => `assets/alphafold/params_model_${i}_ptm.npz`),
      ...["neutral", "negative", "positive"].map((v) => `source/bindcraft/weights/proteinmpnn/weights_${v}/v_48_020.npz`)]) {
      const file = path.join(context.modelDir, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "stub");
    }
    const runner = vi.fn(async () => ({ code: 0, stdout: "cuda ok", stderr: "" }));
    expect((await adapter.verifyInstallation({ ...context, manifestName: "bindcraft2", runner })).passed).toBe(true);
    const call = runner.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(call[1][1]).toContain("version('bindcraft') == '1.0.3'");
    expect(call[1][1]).toContain("digest.hexdigest() == expected['sha256']");
    expect(call[1][1]).toContain("default_backend() == 'gpu'");
    expect(call[1][1]).toContain("bindcraft.selfcheck");
    expect(call[2].env.JAX_PLATFORMS).toBe("cuda");
    runner.mockResolvedValue({ code: 1, stdout: "", stderr: "no GPU" });
    expect((await adapter.verifyInstallation({ ...context, manifestName: "bindcraft2", runner })).passed).toBe(false);
    runner.mockClear();
    fs.unlinkSync(path.join(context.assetsDir, "alphafold/params_model_1_ptm.npz"));
    expect((await adapter.verifyInstallation({ ...context, manifestName: "bindcraft2", runner })).passed).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
});
