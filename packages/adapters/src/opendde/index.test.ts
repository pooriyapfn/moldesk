import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { stageCompanionInputs } from "@moldesk/runtime";
import type { RunContext } from "../index.js";
import { validateParams } from "../params.js";
import { openddeAdapter } from "./index.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-opendde-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const SDF_TEXT = "ligand\n  MoleculeDesk\n\n  1  0  0  0  0  0  0  0  0  0999 V2000\n    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\nM  END\n$$$$\n";
const A3M_TEXT = ">query\nACDEFGHIK\n";
const CIF_TEXT = "data_tiny\n#\nloop_\n_atom_site.group_PDB\n_atom_site.id\nATOM 1\n";

function protein(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { proteinChain: { sequence: "ACDEFGHIK", count: 1, ...extra } };
}

function writeJob(dir: string, jobs: unknown, name = "job.json"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(jobs));
  return file;
}

function tinyJob(dir: string): string {
  return writeJob(dir, [{ name: "tiny", modelSeeds: [101], sequences: [protein()] }]);
}

function defaults(params: Record<string, string> = {}): Record<string, unknown> {
  const result = validateParams(openddeAdapter.params ?? [], params);
  expect(result.errors).toEqual([]);
  return result.effective;
}

function runContext(dir: string, inputPath: string, overrides: Partial<RunContext> = {}): RunContext {
  const outputDir = path.join(dir, "run", "output");
  fs.mkdirSync(outputDir, { recursive: true });
  return {
    manifestName: "opendde",
    inputPath,
    outputDir,
    modelDir: path.join(dir, "model"),
    assetsDir: path.join(dir, "model", "assets"),
    params: defaults({ device: "mps" }),
    runtimeExecutable: path.join(dir, "model", ".venv", "bin", "python"),
    platform: "darwin-arm64",
    runner: fakePdbExporter(),
    ...overrides,
  };
}

/** Stands in for the venv's biotite conversion: writes a .pdb next to each .cif
 * passed as argv, except those listed in `failFor`. */
function fakePdbExporter(failFor: string[] = [], calls: Array<{ command: string; args: string[] }> = []) {
  return async (command: string, args: string[]) => {
    calls.push({ command, args });
    const errors: Record<string, string> = {};
    for (const cif of args.slice(2)) {
      if (failFor.some((suffix) => cif.endsWith(suffix))) errors[cif] = "ValueError: chain ID too long";
      else fs.writeFileSync(cif.replace(/\.cif$/, ".pdb"), "ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00 90.00           N\nEND\n");
    }
    return { code: 0, stdout: `${JSON.stringify(errors)}\n`, stderr: "" };
  };
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("openddeAdapter.validateInput", () => {
  it("accepts the checked-in examples", async () => {
    await expect(openddeAdapter.validateInput(path.join(repoRoot, "examples/opendde/tiny.json"))).resolves.toBeUndefined();
    await expect(openddeAdapter.validateInput(path.join(repoRoot, "examples/opendde/ligand-file.json"))).resolves.toBeUndefined();
  });

  it("rejects a missing file and a non-.json extension", async () => {
    const dir = tempDir();
    await expect(openddeAdapter.validateInput(path.join(dir, "missing.json"))).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
    const yaml = path.join(dir, "job.yaml");
    fs.writeFileSync(yaml, "[]");
    await expect(openddeAdapter.validateInput(yaml)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it.each([
    ["malformed JSON", "{ nope"],
    ["an object instead of a list", JSON.stringify({ name: "a", sequences: [] })],
    ["an empty list", "[]"],
    ["a job without sequences", JSON.stringify([{ name: "a" }])],
    ["empty sequences", JSON.stringify([{ name: "a", sequences: [] }])],
    ["an unknown entity key", JSON.stringify([{ name: "a", sequences: [{ peptide: { sequence: "A" } }] }])],
    ["two entity keys in one item", JSON.stringify([{ name: "a", sequences: [{ ...protein(), ion: { ion: "MG", count: 1 } }] }])],
    ["a non-integer modelSeed", JSON.stringify([{ name: "a", modelSeeds: [1.5], sequences: [protein()] }])],
    ["an out-of-range modelSeed", JSON.stringify([{ name: "a", modelSeeds: [2 ** 32], sequences: [protein()] }])],
    ["duplicate job names", JSON.stringify([{ name: "a", sequences: [protein()] }, { name: "a", sequences: [protein()] }])],
  ])("rejects %s", async (_label, text) => {
    const dir = tempDir();
    const file = path.join(dir, "job.json");
    fs.writeFileSync(file, text);
    await expect(openddeAdapter.validateInput(file)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it.each(["", "../escape", "a/b", ".hidden", "err", "ERR", "moldesk-resolved-job.json", "a\nb"])("rejects unsafe job name %j", async (name) => {
    const dir = tempDir();
    const file = writeJob(dir, [{ name, sequences: [protein()] }]);
    await expect(openddeAdapter.validateInput(file)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("accepts relative MSA/template/ligand references inside the job directory", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "msa"));
    fs.writeFileSync(path.join(dir, "msa", "pairing.a3m"), A3M_TEXT);
    fs.writeFileSync(path.join(dir, "msa", "non_pairing.a3m"), A3M_TEXT);
    fs.writeFileSync(path.join(dir, "hits.hhr"), "hits\n");
    fs.writeFileSync(path.join(dir, "lig.sdf"), SDF_TEXT);
    fs.writeFileSync(path.join(dir, "rna.a3m"), ">q\nGUAC\n");
    const file = writeJob(dir, [{
      name: "complex",
      sequences: [
        protein({ pairedMsaPath: "msa/pairing.a3m", unpairedMsaPath: "msa/non_pairing.a3m", templatesPath: "hits.hhr" }),
        { rnaSequence: { sequence: "GUAC", count: 1, unpairedMsaPath: "rna.a3m" } },
        { ligand: { ligand: "FILE_lig.sdf", count: 1 } },
        { ligand: { ligand: "CCD_ATP", count: 1 } },
      ],
    }]);
    await expect(openddeAdapter.validateInput(file)).resolves.toBeUndefined();
  });

  it("rejects references that escape the job directory (traversal or absolute)", async () => {
    const dir = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "x.a3m"), A3M_TEXT);
    for (const ref of [`../${path.basename(outside)}/x.a3m`, path.join(outside, "x.a3m")]) {
      const file = writeJob(dir, [{ name: "a", sequences: [protein({ unpairedMsaPath: ref })] }]);
      await expect(openddeAdapter.validateInput(file)).rejects.toMatchObject({ code: "UNSAFE_COMPANION_INPUT_PATH" });
    }
  });

  it("rejects missing, empty, directory, and wrong-extension references", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "dir.a3m"));
    fs.writeFileSync(path.join(dir, "empty.a3m"), "");
    fs.writeFileSync(path.join(dir, "lig.txt"), SDF_TEXT);
    const cases = [
      protein({ unpairedMsaPath: "missing.a3m" }),
      protein({ unpairedMsaPath: "empty.a3m" }),
      protein({ unpairedMsaPath: "dir.a3m" }),
      protein({ pairedMsaPath: "lig.txt" }),
      { ligand: { ligand: "FILE_lig.txt", count: 1 } },
      { ligand: { ligand: "FILE_", count: 1 } },
      protein({ templatesPath: 42 }),
    ];
    for (const entity of cases) {
      const file = writeJob(dir, [{ name: "a", sequences: [entity] }]);
      await expect(openddeAdapter.validateInput(file)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
    }
  });

  it("rejects the legacy directory-valued proteinChain.msa field", async () => {
    const dir = tempDir();
    const file = writeJob(dir, [{ name: "a", sequences: [protein({ msa: { precomputed_msa_dir: "./msa", pairing_db: "uniref100" } })] }]);
    await expect(openddeAdapter.validateInput(file)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });
});

describe("openddeAdapter.resolveCompanionInputs", () => {
  it("returns no companions for a pure sequence/SMILES/CCD job (single-file behavior)", async () => {
    const dir = tempDir();
    const file = writeJob(dir, [{ name: "a", sequences: [protein(), { ligand: { ligand: "CCO", count: 1 } }, { ligand: { ligand: "CCD_ATP", count: 1 } }] }]);
    await expect(openddeAdapter.resolveCompanionInputs!(file)).resolves.toEqual([]);
  });

  it("returns one uniquely-id'd ref per referenced file, with FILE_ stripped", async () => {
    const dir = tempDir();
    const file = writeJob(dir, [
      { name: "a", sequences: [protein({ pairedMsaPath: "p.a3m", unpairedMsaPath: "u.a3m" }), { ligand: { ligand: "FILE_lig.sdf", count: 1 } }] },
      { name: "b", sequences: [{ rnaSequence: { sequence: "GUAC", count: 1, unpairedMsaPath: "u.a3m" } }] },
    ]);
    await expect(openddeAdapter.resolveCompanionInputs!(file)).resolves.toEqual([
      { id: "j0-s0-paired-msa", sourcePath: "p.a3m" },
      { id: "j0-s0-unpaired-msa", sourcePath: "u.a3m" },
      { id: "j0-s1-ligand-file", sourcePath: "lig.sdf" },
      { id: "j1-s0-unpaired-msa", sourcePath: "u.a3m" },
    ]);
  });
});

describe("openddeAdapter params and defaults", () => {
  it("defaults to a bounded, offline smoke-test configuration", () => {
    expect(defaults()).toEqual({ samples: 1, steps: 200, cycles: 10, use_msa: false, use_template: false, use_rna_msa: false, deterministic: false });
  });

  it("resolves the device default from the installed runtime platform, not the host", () => {
    const ctx = (platform?: "darwin-arm64" | "linux-x64") => ({ manifestName: "opendde", installed: { runtime: { kind: "python", python: { platform } } } });
    expect(openddeAdapter.resolveParamDefaults!(ctx("darwin-arm64"))).toEqual({ device: "mps" });
    expect(openddeAdapter.resolveParamDefaults!(ctx("linux-x64"))).toEqual({ device: "cuda" });
    expect(openddeAdapter.resolveParamDefaults!(ctx(undefined))).toEqual({});
  });

  it("rejects out-of-range and unknown params", () => {
    const params = openddeAdapter.params ?? [];
    const cases: Array<Record<string, string>> = [{ samples: "0" }, { steps: "0" }, { cycles: "-1" }, { seed: "-1" }, { seed: String(2 ** 32) }, { device: "tpu" }, { use_msa: "yes" }, { dtype: "bf16" }];
    for (const bad of cases) {
      expect(validateParams(params, bad).errors.length).toBeGreaterThan(0);
    }
  });
});

describe("openddeAdapter.command", () => {
  it("builds the exact MPS command for a pure sequence job, running the stored input directly", async () => {
    const dir = tempDir();
    const input = tinyJob(dir);
    const context = runContext(dir, input);
    const spec = await openddeAdapter.command(context);
    const rootDir = path.join(context.assetsDir, "opendde-root");
    expect(spec.executable).toBe(path.join(dir, "model", ".venv", "bin", "opendde"));
    expect(spec.args).toEqual([
      "pred",
      "-i", input,
      "-o", context.outputDir,
      "-n", "opendde_v1",
      "--load_checkpoint_path", path.join(rootDir, "checkpoint", "opendde.pt"),
      "--device", "mps",
      "--dtype", "fp32",
      "--sample", "1",
      "--step", "200",
      "--cycle", "10",
      "--use_msa", "false",
      "--use_template", "false",
      "--use_rna_msa", "false",
      "--deterministic", "false",
    ]);
    expect(spec.env).toEqual({
      OPENDDE_ROOT_DIR: rootDir,
      OPENDDE_DEPENDENCY_URL: "https://downloads-disabled.moldesk.invalid",
      OPENDDE_COMMON_URL: "https://downloads-disabled.moldesk.invalid",
      OPENDDE_SEARCH_DATABASE_URL: "https://downloads-disabled.moldesk.invalid",
    });
    expect(fs.existsSync(path.join(context.outputDir, "moldesk-resolved-job.json"))).toBe(false);
  });

  it("maps user params onto the pinned CLI flags, including --seeds", async () => {
    const dir = tempDir();
    const context = runContext(dir, tinyJob(dir), {
      params: defaults({ device: "mps", samples: "3", steps: "50", cycles: "4", seed: "7", use_msa: "true", deterministic: "true" }),
    });
    const { args } = await openddeAdapter.command(context);
    expect(argValue(args, "--sample")).toBe("3");
    expect(argValue(args, "--step")).toBe("50");
    expect(argValue(args, "--cycle")).toBe("4");
    expect(argValue(args, "--seeds")).toBe("7");
    expect(argValue(args, "--use_msa")).toBe("true");
    expect(argValue(args, "--deterministic")).toBe("true");
  });

  it("builds a CUDA command on the linux-x64 install", async () => {
    const dir = tempDir();
    const context = runContext(dir, tinyJob(dir), { platform: "linux-x64", params: defaults({ device: "cuda" }) });
    expect(argValue((await openddeAdapter.command(context)).args, "--device")).toBe("cuda");
  });

  it("allows an explicit CPU run on either platform", async () => {
    const dir = tempDir();
    for (const platform of ["darwin-arm64", "linux-x64"] as const) {
      const context = runContext(dir, tinyJob(dir), { platform, params: defaults({ device: "cpu" }) });
      expect(argValue((await openddeAdapter.command(context)).args, "--device")).toBe("cpu");
    }
  });

  it("resolves device=auto to the installed accelerator, never to upstream's CPU-falling-back auto", async () => {
    const dir = tempDir();
    const mac = runContext(dir, tinyJob(dir), { params: defaults({ device: "auto" }) });
    expect(argValue((await openddeAdapter.command(mac)).args, "--device")).toBe("mps");
    const linux = runContext(dir, tinyJob(dir), { platform: "linux-x64", params: defaults({ device: "auto" }) });
    expect(argValue((await openddeAdapter.command(linux)).args, "--device")).toBe("cuda");
    const unknown = runContext(dir, tinyJob(dir), { platform: undefined, params: defaults({ device: "auto" }) });
    await expect(openddeAdapter.command(unknown)).rejects.toMatchObject({ code: "INVALID_RUN_PARAMS" });
  });

  it("rejects device/platform mismatches before execution", async () => {
    const dir = tempDir();
    const cudaOnMac = runContext(dir, tinyJob(dir), { params: defaults({ device: "cuda" }) });
    await expect(openddeAdapter.command(cudaOnMac)).rejects.toMatchObject({ code: "INVALID_RUN_PARAMS" });
    const mpsOnLinux = runContext(dir, tinyJob(dir), { platform: "linux-x64", params: defaults({ device: "mps" }) });
    await expect(openddeAdapter.command(mpsOnLinux)).rejects.toMatchObject({ code: "INVALID_RUN_PARAMS" });
  });

  it("rejects non-integer numeric params", async () => {
    const dir = tempDir();
    const cases: Array<Record<string, string>> = [{ samples: "1.5" }, { steps: "2.5" }, { cycles: "1.5" }, { seed: "3.2" }];
    for (const bad of cases) {
      const context = runContext(dir, tinyJob(dir), { params: defaults({ device: "mps", ...bad }) });
      await expect(openddeAdapter.command(context)).rejects.toMatchObject({ code: "INVALID_RUN_PARAMS" });
    }
  });

  it("rejects use_template=true (no template databases provisioned)", async () => {
    const dir = tempDir();
    const context = runContext(dir, tinyJob(dir), { params: defaults({ device: "mps", use_template: "true" }) });
    await expect(openddeAdapter.command(context)).rejects.toMatchObject({ code: "INVALID_RUN_PARAMS" });
  });

  it("allows use_rna_msa=true only when every rnaSequence has a precomputed MSA", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "rna.a3m"), ">q\nGUAC\n");
    const without = writeJob(dir, [{ name: "a", sequences: [{ rnaSequence: { sequence: "GUAC", count: 1 } }] }], "without.json");
    await expect(openddeAdapter.command(runContext(dir, without, { params: defaults({ device: "mps", use_rna_msa: "true" }) })))
      .rejects.toMatchObject({ code: "INVALID_RUN_PARAMS" });

    const withMsa = writeJob(dir, [{ name: "a", sequences: [{ rnaSequence: { sequence: "GUAC", count: 1, unpairedMsaPath: "rna.a3m" } }] }], "with.json");
    const inputDir = path.join(dir, "run", "input");
    fs.mkdirSync(inputDir, { recursive: true });
    const staged = stageCompanionInputs({ jobFilePath: withMsa, refs: await openddeAdapter.resolveCompanionInputs!(withMsa), inputDir });
    const context = runContext(dir, withMsa, {
      params: defaults({ device: "mps", use_rna_msa: "true" }),
      companionInputs: staged.map((s) => ({ id: s.id, path: s.storedPath })),
    });
    expect(argValue((await openddeAdapter.command(context)).args, "--use_rna_msa")).toBe("true");
  });

  it("rewrites every companion reference to its staged copy and runs the rewritten job", async () => {
    const dir = tempDir();
    const jobDir = path.join(dir, "submitted");
    fs.mkdirSync(jobDir);
    fs.writeFileSync(path.join(jobDir, "p.a3m"), A3M_TEXT);
    fs.writeFileSync(path.join(jobDir, "u.a3m"), A3M_TEXT);
    fs.writeFileSync(path.join(jobDir, "lig.sdf"), SDF_TEXT);
    const original = writeJob(jobDir, [{
      name: "complex",
      sequences: [protein({ pairedMsaPath: "p.a3m", unpairedMsaPath: "./u.a3m" }), { ligand: { ligand: "FILE_lig.sdf", count: 1 } }],
    }]);

    // Mirror core's run flow: snapshot the job, then stage its companions.
    const inputDir = path.join(dir, "run", "input");
    fs.mkdirSync(inputDir, { recursive: true });
    const storedInput = path.join(inputDir, "job.json");
    fs.copyFileSync(original, storedInput);
    const staged = stageCompanionInputs({ jobFilePath: original, refs: await openddeAdapter.resolveCompanionInputs!(original), inputDir });
    // The run must not depend on the submitted files afterwards.
    fs.rmSync(jobDir, { recursive: true, force: true });

    const context = runContext(dir, storedInput, { companionInputs: staged.map((s) => ({ id: s.id, path: s.storedPath })) });
    const { args } = await openddeAdapter.command(context);
    const resolved = path.join(context.outputDir, "moldesk-resolved-job.json");
    expect(argValue(args, "-i")).toBe(resolved);

    const doc = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const chain = doc[0].sequences[0].proteinChain;
    expect(chain.pairedMsaPath).toBe(path.join(inputDir, "j0-s0-paired-msa", "p.a3m"));
    expect(chain.unpairedMsaPath).toBe(path.join(inputDir, "j0-s0-unpaired-msa", "u.a3m"));
    expect(doc[0].sequences[1].ligand.ligand).toBe(`FILE_${path.join(inputDir, "j0-s1-ligand-file", "lig.sdf")}`);
    for (const p of [chain.pairedMsaPath, chain.unpairedMsaPath]) expect(fs.existsSync(p)).toBe(true);
    // The stored job snapshot itself is left untouched.
    expect(JSON.parse(fs.readFileSync(storedInput, "utf8"))[0].sequences[0].proteinChain.pairedMsaPath).toBe("p.a3m");
  });

  it("fails clearly when a declared companion was not staged", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "u.a3m"), A3M_TEXT);
    const input = writeJob(dir, [{ name: "a", sequences: [protein({ unpairedMsaPath: "u.a3m" })] }]);
    await expect(openddeAdapter.command(runContext(dir, input))).rejects.toMatchObject({ code: "COMPANION_INPUT_NOT_STAGED" });
  });

  it("stageCompanionInputs rejects a symlink escaping the job directory", async () => {
    const dir = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "secret.a3m"), A3M_TEXT);
    fs.symlinkSync(path.join(outside, "secret.a3m"), path.join(dir, "link.a3m"));
    const input = writeJob(dir, [{ name: "a", sequences: [protein({ unpairedMsaPath: "link.a3m" })] }]);
    const inputDir = path.join(dir, "run", "input");
    fs.mkdirSync(inputDir, { recursive: true });
    expect(() => stageCompanionInputs({ jobFilePath: input, refs: [{ id: "j0-s0-unpaired-msa", sourcePath: "link.a3m" }], inputDir }))
      .toThrowError(expect.objectContaining({ code: "UNSAFE_COMPANION_INPUT_PATH" }));
  });
});

describe("openddeAdapter.collectOutputs", () => {
  function writePrediction(outputDir: string, job: string, seed: number, options: { cif?: string; summary?: string } = {}): void {
    const dir = path.join(outputDir, job, `seed_${seed}`, "predictions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${job}_sample_0.cif`), options.cif ?? CIF_TEXT);
    fs.writeFileSync(path.join(dir, `${job}_summary_confidence_sample_0.json`), options.summary ?? JSON.stringify({ plddt: 80.1, ptm: 0.5, ranking_score: 0.4 }));
    fs.writeFileSync(path.join(dir, `${job}_full_data_sample_0.json`), JSON.stringify({ atom_plddt: [1] }));
  }

  it("collects structures, confidence, and atom confidence per job", async () => {
    const dir = tempDir();
    const context = runContext(dir, tinyJob(dir));
    writePrediction(context.outputDir, "tiny", 101);
    const outputs = await openddeAdapter.collectOutputs(context);
    expect(outputs.map((o) => [o.id, path.relative(context.outputDir, o.path)])).toEqual([
      ["structures", "tiny/seed_101/predictions/tiny_sample_0.cif"],
      ["confidence", "tiny/seed_101/predictions/tiny_summary_confidence_sample_0.json"],
      ["atom_confidence", "tiny/seed_101/predictions/tiny_full_data_sample_0.json"],
      ["structures_pdb", "tiny/seed_101/predictions/tiny_sample_0.pdb"],
    ]);
  });

  it("exports PDB via the installed runtime's python, passing mmCIF paths as argv (no shell/interpolation)", async () => {
    const dir = tempDir();
    const calls: Array<{ command: string; args: string[] }> = [];
    const context = runContext(dir, tinyJob(dir), { runner: fakePdbExporter([], calls) });
    writePrediction(context.outputDir, "tiny", 101);
    await openddeAdapter.collectOutputs(context);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(context.runtimeExecutable);
    expect(calls[0]!.args[0]).toBe("-c");
    expect(calls[0]!.args[1]).toContain("include_bonds=True");
    expect(calls[0]!.args[1]).toContain('extra_fields=["b_factor"]');
    expect(calls[0]!.args[1]).not.toContain(context.outputDir);
    expect(calls[0]!.args.slice(2)).toEqual([path.join(context.outputDir, "tiny/seed_101/predictions/tiny_sample_0.cif")]);
  });

  it("records per-structure PDB export failures without failing a valid prediction", async () => {
    const dir = tempDir();
    const input = writeJob(dir, [{ name: "a", sequences: [protein()] }, { name: "b", sequences: [protein()] }]);
    const context = runContext(dir, input, { runner: fakePdbExporter(["b_sample_0.cif"]) });
    writePrediction(context.outputDir, "a", 1);
    writePrediction(context.outputDir, "b", 1);
    const outputs = await openddeAdapter.collectOutputs(context);
    expect(outputs.filter((o) => o.id === "structures_pdb").map((o) => path.basename(o.path))).toEqual(["a_sample_0.pdb"]);
    const errorsFile = outputs.find((o) => o.id === "pdb_export_errors")!.path;
    expect(JSON.parse(fs.readFileSync(errorsFile, "utf8"))).toEqual({ "b/seed_1/predictions/b_sample_0.cif": "ValueError: chain ID too long" });
  });

  it("records a crashed PDB export process for every structure", async () => {
    const dir = tempDir();
    const context = runContext(dir, tinyJob(dir), { runner: async () => ({ code: 1, stdout: "", stderr: "ModuleNotFoundError: biotite" }) });
    writePrediction(context.outputDir, "tiny", 101);
    const outputs = await openddeAdapter.collectOutputs(context);
    expect(outputs.some((o) => o.id === "structures_pdb")).toBe(false);
    const errors = JSON.parse(fs.readFileSync(path.join(context.outputDir, "moldesk-pdb-export-errors.json"), "utf8"));
    expect(errors["tiny/seed_101/predictions/tiny_sample_0.cif"]).toContain("ModuleNotFoundError: biotite");
  });

  it("does not accept unrelated .cif/.json files elsewhere under output", async () => {
    const dir = tempDir();
    const context = runContext(dir, tinyJob(dir));
    fs.mkdirSync(path.join(context.outputDir, "tiny", "other"), { recursive: true });
    fs.writeFileSync(path.join(context.outputDir, "stale.cif"), CIF_TEXT);
    fs.writeFileSync(path.join(context.outputDir, "tiny", "other", "tiny_sample_0.cif"), CIF_TEXT);
    fs.writeFileSync(path.join(context.outputDir, "tiny", "other", "tiny_summary_confidence_sample_0.json"), "{}");
    await expect(openddeAdapter.collectOutputs(context)).rejects.toMatchObject({ code: "MISSING_REQUIRED_OUTPUT" });
  });

  it("fails when any job in a multi-job file produced nothing", async () => {
    const dir = tempDir();
    const input = writeJob(dir, [{ name: "a", sequences: [protein()] }, { name: "b", sequences: [protein()] }]);
    const context = runContext(dir, input);
    writePrediction(context.outputDir, "a", 1);
    await expect(openddeAdapter.collectOutputs(context)).rejects.toMatchObject({ code: "MISSING_REQUIRED_OUTPUT" });
  });

  it("rejects an empty or non-mmCIF structure and an unparseable confidence summary", async () => {
    const dir = tempDir();
    const context = runContext(dir, tinyJob(dir));
    writePrediction(context.outputDir, "tiny", 101, { cif: "" });
    await expect(openddeAdapter.collectOutputs(context)).rejects.toMatchObject({ code: "INVALID_RUN_OUTPUT" });

    const dir2 = tempDir();
    const context2 = runContext(dir2, tinyJob(dir2));
    writePrediction(context2.outputDir, "tiny", 101, { summary: "not json" });
    await expect(openddeAdapter.collectOutputs(context2)).rejects.toMatchObject({ code: "INVALID_RUN_OUTPUT" });
  });

  it("collects the resolved job copy when one was written", async () => {
    const dir = tempDir();
    const context = runContext(dir, tinyJob(dir));
    writePrediction(context.outputDir, "tiny", 101);
    fs.writeFileSync(path.join(context.outputDir, "moldesk-resolved-job.json"), "[]");
    const outputs = await openddeAdapter.collectOutputs(context);
    expect(outputs.find((o) => o.id === "resolved_job")).toBeDefined();
  });
});

describe("openddeAdapter.verifyInstallation", () => {
  const ASSETS = [
    { rel: "checkpoint/opendde.pt", size: 2_625_249_069 },
    { rel: "common/components.cif", size: 490_777_362 },
    { rel: "common/components.cif.rdkit_mol.pkl", size: 142_498_117 },
  ];

  function install(dir: string, options: { skip?: string; wrongSize?: string } = {}) {
    const modelDir = path.join(dir, "model");
    const assetsDir = path.join(modelDir, "assets");
    const bin = path.join(modelDir, ".venv", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "python"), "");
    fs.writeFileSync(path.join(bin, "opendde"), "");
    for (const asset of ASSETS) {
      if (asset.rel === options.skip) continue;
      const file = path.join(assetsDir, "opendde-root", asset.rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "");
      // Sparse file of the exact published size: size check passes, digest check can't.
      fs.truncateSync(file, asset.rel === options.wrongSize ? 10 : asset.size);
    }
    return { modelDir, assetsDir };
  }

  const helpOk = "Usage: opendde pred --device [auto|cpu|cuda|mps] --load_checkpoint_path --use_msa --seeds";

  it("fails when an asset is missing", async () => {
    const dir = tempDir();
    const { modelDir, assetsDir } = install(dir, { skip: "common/components.cif" });
    const result = await openddeAdapter.verifyInstallation({ manifestName: "opendde", modelDir, assetsDir, platform: "darwin-arm64", runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("components.cif");
  });

  it("fails on a wrong-sized asset before spawning anything", async () => {
    const dir = tempDir();
    const { modelDir, assetsDir } = install(dir, { wrongSize: "checkpoint/opendde.pt" });
    const calls: string[] = [];
    const result = await openddeAdapter.verifyInstallation({ manifestName: "opendde", modelDir, assetsDir, platform: "darwin-arm64", runner: async (cmd) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; } });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("expected 2625249069 bytes");
    expect(calls).toEqual([]);
  });

  function recordingRunner(help = helpOk, probe = { code: 0, stdout: "ok", stderr: "" }) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return args[0] === "-c" ? probe : { code: 0, stdout: help, stderr: "" };
    };
    return { calls, runner };
  }

  it("on darwin-arm64 runs the MPS probe (real MPS tensor op + pinned versions) and checks the CLI advertises mps", async () => {
    const dir = tempDir();
    const { modelDir, assetsDir } = install(dir);
    const { calls, runner } = recordingRunner();
    const result = await openddeAdapter.verifyInstallation({ manifestName: "opendde", modelDir, assetsDir, platform: "darwin-arm64", runner });
    const probe = calls[0]!.args[1]!;
    for (const needle of ['platform.system() == "Darwin"', 'platform.machine() == "arm64"', "torch.backends.mps.is_built()", "torch.backends.mps.is_available()", 'device="mps"', 'version("opendde")', '"1.1.1"', '"2.7.1"']) {
      expect(probe).toContain(needle);
    }
    expect(probe).not.toContain("cuda");
    expect(calls[1]).toEqual({ command: path.join(modelDir, ".venv", "bin", "opendde"), args: ["pred", "--help"] });
    // Placeholder sparse assets reach the final digest check and fail it.
    expect(result.passed).toBe(false);
    expect(result.output).toContain("expected sha256 7b826620390afad877ee2babc6a4d0df81b94d3a0be030959853d6a7da0807cc");
  }, 60_000);

  it("on linux-x64 runs the CUDA probe (CUDA build, device, cuEquivariance, real CUDA op)", async () => {
    const dir = tempDir();
    const { modelDir, assetsDir } = install(dir);
    const { calls, runner } = recordingRunner(helpOk.replace("mps", ""), { code: 1, stdout: "", stderr: "AssertionError: torch.cuda.is_available() is False" });
    const result = await openddeAdapter.verifyInstallation({ manifestName: "opendde", modelDir, assetsDir, platform: "linux-x64", runner });
    const probe = calls[0]!.args[1]!;
    for (const needle of ["torch.version.cuda", "torch.cuda.is_available()", "torch.cuda.device_count()", "cuequivariance_torch", 'device="cuda"', 'version("opendde")']) {
      expect(probe).toContain(needle);
    }
    expect(probe).not.toContain("mps");
    expect(result).toEqual({ passed: false, output: "AssertionError: torch.cuda.is_available() is False" });
  });

  it("fails when the installed CLI does not advertise the expected device", async () => {
    const dir = tempDir();
    const { modelDir, assetsDir } = install(dir);
    const { runner } = recordingRunner("Usage: opendde pred --device [auto|cpu|cuda] --load_checkpoint_path --use_msa --seeds");
    const result = await openddeAdapter.verifyInstallation({ manifestName: "opendde", modelDir, assetsDir, platform: "darwin-arm64", runner });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("did not advertise mps");
  });

  it("fails closed when the installed platform cannot be determined", async () => {
    const dir = tempDir();
    const { modelDir, assetsDir } = install(dir);
    const { calls, runner } = recordingRunner();
    const result = await openddeAdapter.verifyInstallation({ manifestName: "opendde", modelDir, assetsDir, runner });
    expect(result.passed).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("opendde manifest consistency", () => {
  const manifest = parseYaml(fs.readFileSync(path.join(repoRoot, "models/opendde/manifest.yaml"), "utf8")) as Record<string, any>;

  it("stays beta and advertises only live-verified platforms", () => {
    expect(manifest.status).toBe("beta");
    expect(manifest.hardware.platforms).toEqual(["darwin-arm64"]);
  });

  it("pins opendde 1.1.1 and torch 2.7.1 by artifact hash on every runtime, CUDA via the closed torchBackend field", () => {
    for (const runtime of manifest.runtimes) {
      const opendde = runtime.requirements.find((r: any) => r.name === "opendde");
      const torch = runtime.requirements.find((r: any) => r.name === "torch");
      expect(opendde.version).toBe("1.1.1");
      expect(opendde.hashes).toEqual(["94b193bd360e017c9cfab08d199ec9333cb2919a49fe1d9270c659c4b2efe544"]);
      expect(String(torch.version).split("+")[0]).toBe("2.7.1");
      expect(torch.hashes).toHaveLength(1);
    }
    const linux = manifest.runtimes.find((r: any) => r.platforms.includes("linux-x64"));
    expect(linux.torchBackend).toBe("cu126");
    expect(linux.requirements.find((r: any) => r.name === "opendde").extras).toEqual(["gpu"]);
    const mac = manifest.runtimes.find((r: any) => r.platforms.includes("darwin-arm64"));
    expect(mac.torchBackend).toBeUndefined();
    expect(mac.nvidiaGpu).toBeUndefined();
  });

  it("installs exactly the general checkpoint and CCD files under the adapter's OPENDDE_ROOT_DIR", () => {
    expect(manifest.assets.map((a: any) => [a.target, a.sha256, a.sizeBytes])).toEqual([
      ["opendde-root/checkpoint/opendde.pt", "7b826620390afad877ee2babc6a4d0df81b94d3a0be030959853d6a7da0807cc", 2625249069],
      ["opendde-root/common/components.cif", "bb31ae5cf6c8bc669924313077cb4231ee5ffefd3a20118cd14f3ec89f8bb6a5", 490777362],
      ["opendde-root/common/components.cif.rdkit_mol.pkl", "d1cfb71f5993a3ebea7c47877022d7f597bbfbaf86e28a4770e957da6c50cd35", 142498117],
    ]);
    for (const asset of manifest.assets) {
      expect(asset.url).toMatch(/^https:\/\/huggingface\.co\/aurekaresearch\/OpenDDE\/resolve\/eddd563ce96571f784012edd8f045181c8f8627d\//);
    }
  });

  it("declares the same outputs the adapter collects", () => {
    expect(manifest.outputs.map((o: any) => [o.id, o.glob, o.required])).toEqual([
      ["structures", "*/seed_*/predictions/*_sample_*.cif", true],
      ["confidence", "*/seed_*/predictions/*_summary_confidence_sample_*.json", true],
      ["atom_confidence", "*/seed_*/predictions/*_full_data_sample_*.json", false],
      ["structures_pdb", "*/seed_*/predictions/*_sample_*.pdb", false],
      ["pdb_export_errors", "moldesk-pdb-export-errors.json", false],
      ["resolved_job", "moldesk-resolved-job.json", false],
    ]);
  });
});
