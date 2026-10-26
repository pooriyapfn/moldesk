import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseManifest } from "@moldesk/registry";
import { stageCompanionInputs } from "@moldesk/runtime";
import { validateDescription } from "@moldesk/visualizer";
import { validateParams } from "../params.js";
import type { CollectedOutput, RunContext } from "../index.js";
import { hydraValue, rfd4ProteinaAdapter as adapter } from "./index.js";
import { readSpec } from "./spec.js";
import { assertValidMmcif } from "./structure.js";

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const CIF = `data_x
loop_
_atom_site.group_PDB
_atom_site.label_atom_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
ATOM "C1'" 1.0 2.0 3.0
ATOM CA 4.5 -5.5 6.0
`;

let root: string;
let spec: string;
let context: RunContext;
const SPEC = `a:
  input: target.cif
  contig: "A1-10, /0, 20-30"
  conditions:
    C_SEQ: {true: [{select: "sel('A')"}]}
    C_HOT: {true: [{select: "sel('A/*/5')"}]}
b:
  input: [target.cif, other/extra.cif.gz]
`;
function write(text: string, file = spec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rfd4-test-"));
  spec = path.join(root, "design.yaml");
  write(SPEC);
  write(CIF, path.join(root, "target.cif"));
  write("gz", path.join(root, "other/extra.cif.gz"));
  context = {
    manifestName: "rfd4-proteina",
    inputPath: spec,
    outputDir: path.join(root, "run/output"),
    modelDir: path.join(root, "model"),
    assetsDir: path.join(root, "model/assets"),
    runtimeExecutable: path.join(root, "model/.venv/bin/python"),
    platform: "linux-x64",
    params: { seed: 7 },
  };
  fs.mkdirSync(context.outputDir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function stage() {
  const inputDir = path.join(root, "run/input");
  fs.mkdirSync(inputDir, { recursive: true });
  const staged = stageCompanionInputs({ jobFilePath: spec, refs: await adapter.resolveCompanionInputs!(spec), inputDir });
  const copied = path.join(inputDir, path.basename(spec));
  fs.copyFileSync(spec, copied);
  context.inputPath = copied;
  context.companionInputs = staged.map((s) => ({ id: s.id, path: s.storedPath }));
}

describe("spec validation", () => {
  it("accepts the checked-in example and the test spec", async () => {
    await adapter.validateInput(here("../../../../examples/rfd4-proteina/monomer.yaml"));
    await adapter.validateInput(spec);
  });

  it.each([
    ["empty file", ""],
    ["a list", "- a: 1"],
    ["no designs", "global_args: {input: target.cif}"],
    ["scalar design", "a: 3"],
    ["unknown design field", "a: {input: target.cif, out_dir: x}"],
    ["legacy field", "a: {input: target.cif, unindex: A1}"],
    ["no input", "a: {contig: 'A1-5'}"],
    ["unknown global field", "global_args: {select_fixed_atoms: x}\na: {input: target.cif}"],
    ["global_args scalar", "global_args: 3\na: {input: target.cif}"],
    ["bad design name", "'../x': {input: target.cif}"],
    ["design name with dot", "a.b: {input: target.cif}"],
    ["case-insensitive duplicate names", "a: {input: target.cif}\nA: {input: target.cif}"],
    ["duplicate keys", "a: {input: target.cif}\na: {input: target.cif}"],
    ["YAML alias", "x: &x {input: target.cif}\na: *x"],
    ["merge key", "base: &b {input: target.cif}\na:\n  <<: *b"],
    ["custom tag", "a: {input: !!python/object/apply:os.system [id]}"],
    ["absolute input", "a: {input: /etc/passwd.cif}"],
    ["tilde input", "a: {input: '~/x.cif'}"],
    ["traversal input", "a: {input: ../x.cif}"],
    ["nested traversal", "a: {input: sub/../../x.cif}"],
    ["backslash input", "a: {input: 'sub\\\\x.cif'}"],
    ["windows drive input", "a: {input: 'C:/x.cif'}"],
    ["empty segment", "a: {input: sub//x.cif}"],
    ["pdb input", "a: {input: target.pdb}"],
    ["empty input list", "a: {input: []}"],
    ["duplicate in input list", "a: {input: [target.cif, target.cif]}"],
    ["non-boolean flag", "a: {input: target.cif, input_as_annotated_cif: 'yes'}"],
    ["empty contig", "a: {input: target.cif, contig: ''}"],
    ["huge contig", `a: {input: target.cif, contig: '${"A".repeat(600)}'}`],
    ["conditions as list", "a: {input: target.cif, conditions: []}"],
    ["bad annotation name", "a: {input: target.cif, conditions: {'../x': {true: [{select: A}]}}}"],
    ["entry with extra field", "a: {input: target.cif, conditions: {C_SEQ: {true: [{select: A, evil: 1}]}}}"],
    ["entry without select", "a: {input: target.cif, conditions: {C_SEQ: {true: [{group: A}]}}}"],
    ["empty select", "a: {input: target.cif, conditions: {C_SEQ: {true: [{select: ''}]}}}"],
    ["select not a string", "a: {input: target.cif, conditions: {C_SEQ: {true: [{select: 3}]}}}"],
    ["__proto__ value key", "a: {input: target.cif, conditions: {C_SEQ: {__proto__: [{select: A}]}}}"],
    ["value mapped to a scalar", "a: {input: target.cif, conditions: {C_SEQ: {true: A}}}"],
    ["too many designs", Array.from({ length: 9 }, (_, i) => `d${i}: {input: target.cif}`).join("\n")],
    ["NUL byte", "a: {input: target.cif}\u0000"],
  ])("rejects %s", async (_label, text) => {
    write(text);
    await expect(adapter.validateInput(spec)).rejects.toBeDefined();
  });

  it("rejects non-spec extensions and oversized files", async () => {
    const txt = path.join(root, "design.txt");
    write(SPEC, txt);
    await expect(adapter.validateInput(txt)).rejects.toBeDefined();
    write(`a: {input: target.cif, contig: x}\n#${"x".repeat(1024 * 1024)}`);
    await expect(adapter.validateInput(spec)).rejects.toBeDefined();
  });

  it("merges global_args shallowly, per-design values winning, and validates the merged design", () => {
    write("global_args: {input: target.cif, contig: 'A1-5'}\na: {}\nb: {contig: 'A1-9'}");
    const parsed = readSpec(spec);
    expect(parsed.designs.map((d) => [d.name, d.input, d.contig])).toEqual([["a", "target.cif", "A1-5"], ["b", "target.cif", "A1-9"]]);
    write("global_args: {contig: 'A1-5'}\na: {}");
    expect(() => readSpec(spec)).toThrow(/needs an "input"/);
  });

  it.each(["missing.cif", "empty.cif"])("rejects a missing or empty referenced structure (%s)", async (name) => {
    write(`a: {input: ${name}}`);
    if (name === "empty.cif") write("", path.join(root, name));
    await expect(adapter.validateInput(spec)).rejects.toBeDefined();
  });

  it("rejects a leaf symlink and an ancestor symlink that escape the spec's folder", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rfd4-outside-"));
    try {
      write(CIF, path.join(outside, "secret.cif"));
      fs.symlinkSync(path.join(outside, "secret.cif"), path.join(root, "leaf.cif"));
      write("a: {input: leaf.cif}");
      await expect(adapter.validateInput(spec)).rejects.toBeDefined();
      fs.symlinkSync(outside, path.join(root, "ancestor"));
      write("a: {input: ancestor/secret.cif}");
      await expect(adapter.validateInput(spec)).rejects.toBeDefined();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a sibling directory whose name shares the spec folder's prefix", async () => {
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling);
    try {
      write(CIF, path.join(sibling, "x.cif"));
      fs.symlinkSync(path.join(sibling, "x.cif"), path.join(root, "x.cif"));
      write("a: {input: x.cif}");
      await expect(adapter.validateInput(spec)).rejects.toBeDefined();
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("accepts every upstream CIF suffix, case-insensitively", () => {
    for (const suffix of [".cif", ".CIF", ".cif.gz", ".cif.gzip", ".cif.zst", ".bcif", ".bcif.gz", ".bcif.zst"]) {
      write(`a: {input: sub/x${suffix}}`);
      expect(readSpec(spec).designs[0]!.input).toBe(`sub/x${suffix}`);
    }
  });

  it("accepts tab-indented JSON", () => {
    write('{\n\t"a": {\n\t\t"input": "target.cif"\n\t}\n}\n', path.join(root, "design.json"));
    expect(readSpec(path.join(root, "design.json")).designs[0]!.name).toBe("a");
  });
});

describe("companion inputs", () => {
  it("declares each distinct file once, in first-appearance order, with deterministic ids", async () => {
    expect(await adapter.resolveCompanionInputs!(spec)).toEqual([
      { id: "input-0", sourcePath: "target.cif" },
      { id: "input-1", sourcePath: "other/extra.cif.gz" },
    ]);
  });

  it("includes files named only in global_args and shares one staged copy across designs", async () => {
    write("global_args: {input: target.cif}\na: {}\nb: {contig: 'A1-5'}");
    expect(await adapter.resolveCompanionInputs!(spec)).toEqual([{ id: "input-0", sourcePath: "target.cif" }]);
    await stage();
    fs.unlinkSync(spec);
    fs.unlinkSync(path.join(root, "target.cif"));
    await adapter.command(context);
    const resolved = JSON.parse(fs.readFileSync(path.join(context.outputDir, "moldesk-spec.json"), "utf8"));
    expect(resolved.a.input).toBe(context.companionInputs![0]!.path);
    expect(resolved.b.input).toBe(context.companionInputs![0]!.path);
    expect(resolved.global_args).toBeUndefined();
  });
});

describe("command", () => {
  it("runs the installed CLI with an exact, allow-listed Hydra override set", async () => {
    await stage();
    const command = await adapter.command(context);
    expect(command.executable).toBe(path.join(root, "model/.venv/bin/rfd4-generate"));
    const specPath = path.join(context.outputDir, "moldesk-spec.json");
    expect(command.args).toEqual([
      "inference_experiment=quickstart",
      `inputs=${hydraValue(specPath, "x")}`,
      `out_dir=${hydraValue(context.outputDir, "x")}`,
      `hydra.run.dir=${hydraValue(path.join(context.outputDir, "hydra"), "x")}`,
      `hf_ckpt_path=${hydraValue(path.join(context.assetsDir, "rfd4-proteina-bundle"), "x")}`,
      "hf_ckpt_revision=null",
      "num_replicates=1",
      "batch_size=1",
      "seed=7",
      "recycle_strategy=thinking_medium",
      "compile_lengths=null",
      "compress_outputs=false",
      "skip_existing=false",
      "prevalidate_inputs=true",
      "num_workers=0",
      "verbose=false",
    ]);
    // No shell, no `--key value`, nothing user-controlled beyond the validated params.
    expect(command.args.every((a) => /^[A-Za-z_.]+=/.test(a))).toBe(true);
    expect(command.env).toMatchObject({ CLUSTER: "local", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", WANDB_MODE: "disabled", PYTHONNOUSERSITE: "1" });
    expect(command.env!.XDG_CACHE_HOME).toBe(path.join(root, "run/cache"));
    expect(command.env!.TRITON_CACHE_DIR!.startsWith(path.join(root, "run/cache"))).toBe(true);
  });

  it("passes explicit params through and emits the upstream compile list only when compile=true", async () => {
    await stage();
    context.params = { numReplicates: 3, batchSize: 2, seed: 4294967295, recycle: "thinking_low", compile: true };
    const args = (await adapter.command(context)).args;
    expect(args).toContain("num_replicates=3");
    expect(args).toContain("batch_size=2");
    expect(args).toContain("seed=4294967295");
    expect(args).toContain("recycle_strategy=thinking_low");
    expect(args).toContain("compile_lengths=[128,160,192,224,256,288,320,352,384,448,512,640,768,896,1024]");
  });

  it("writes a resolved JSON spec with staged inputs, preserving declaration order and typed keys", async () => {
    write(`a:
  input: target.cif
  conditions:
    C_CRDGRP: {2: [{select: "sel('A/*/[1-5]')"}], 1: [{select: "sel('A/*/[3-9]')"}]}
    C_SEQ_PROB_CYS: {0.0: [{select: "sel('A')"}]}
    C_IDX: {false: [{select: "sel('A')", group: g1}]}
`);
    await stage();
    await adapter.command(context);
    const text = fs.readFileSync(path.join(context.outputDir, "moldesk-spec.json"), "utf8");
    // A plain JS object would sort the integer-like keys 1 then 2; upstream applies them in file order.
    expect(text.indexOf('"2"')).toBeLessThan(text.indexOf('"1"'));
    const resolved = JSON.parse(text);
    expect(resolved.a.input).toBe(context.companionInputs![0]!.path);
    expect(path.isAbsolute(resolved.a.input)).toBe(true);
    expect(resolved.a.conditions.C_SEQ_PROB_CYS["0"]).toEqual([{ select: "sel('A')" }]);
    expect(resolved.a.conditions.C_IDX.false).toEqual([{ select: "sel('A')", group: "g1" }]);
    expect(Object.keys(resolved)).toEqual(["a"]);
  });

  it.each([
    [{ seed: 7, numReplicates: 0 }],
    [{ seed: 7, numReplicates: 33 }],
    [{ seed: 7, numReplicates: 1.5 }],
    [{ seed: 7, batchSize: 9 }],
    [{ seed: 7, batchSize: 0.5 }],
    [{ seed: 1.5 }],
    [{ seed: -1 }],
    [{ seed: 4294967296 }],
    [{ seed: Number.MAX_SAFE_INTEGER + 1 }],
    [{ seed: "7" }],
    [{}],
    [{ seed: 7, recycle: "medium/front_loaded" }],
    [{ seed: 7, compile: "true" }],
  ])("rejects invalid effective params %j before writing anything", async (params) => {
    await stage();
    context.params = params;
    await expect(adapter.command(context)).rejects.toBeDefined();
    expect(fs.existsSync(path.join(context.outputDir, "moldesk-spec.json"))).toBe(false);
  });

  it("refuses non-Linux installs and missing, symlinked or escaped staged files", async () => {
    await stage();
    context.platform = "darwin-arm64";
    await expect(adapter.command(context)).rejects.toBeDefined();
    context.platform = "linux-x64";
    const original = context.companionInputs![0]!.path;
    context.companionInputs = context.companionInputs!.slice(1);
    await expect(adapter.command(context)).rejects.toBeDefined();
    context.companionInputs = [{ id: "input-0", path: path.join(root, "target.cif") }, { id: "input-1", path: original }];
    await expect(adapter.command(context)).rejects.toBeDefined();
    const link = path.join(path.dirname(context.inputPath), "link.cif");
    fs.symlinkSync(original, link);
    context.companionInputs = [{ id: "input-0", path: link }, ...(await stageSecond())];
    await expect(adapter.command(context)).rejects.toBeDefined();
  });

  async function stageSecond() {
    return context.companionInputs?.slice(1) ?? [];
  }

  it("refuses to overwrite an existing resolved spec", async () => {
    await stage();
    await adapter.command(context);
    await expect(adapter.command(context)).rejects.toBeDefined();
  });
});

describe("Hydra value serialization", () => {
  it.each([
    ["/plain/path-1.0/x_y.json", "/plain/path-1.0/x_y.json"],
    ["/with space/a,b/[c]/d=e", "'/with space/a,b/[c]/d=e'"],
    ["/home/ünï/x", "'/home/ünï/x'"],
  ])("serializes %s", (value, expected) => {
    expect(hydraValue(value, "p")).toBe(expected);
  });
  it.each(["/a'b", '/a"b', "/a\\b", "/a/${HOME}", "/a/$b", "/a\nb", "/a\u0000b", ""])("fails closed on %j", (value) => {
    expect(() => hydraValue(value, "p")).toThrow();
  });
  it("refuses an output path Hydra cannot carry before writing anything", async () => {
    const odd = path.join(root, "o'brien");
    fs.mkdirSync(odd);
    await stage();
    context.outputDir = odd;
    await expect(adapter.command(context)).rejects.toBeDefined();
  });
});

describe("params", () => {
  const supply = (supplied: Record<string, string>) => validateParams(adapter.params!, supplied);
  it("defaults, and a seed default is supplied by resolveParamDefaults", () => {
    const defaults = adapter.resolveParamDefaults!({ manifestName: "rfd4-proteina", installed: { runtime: { kind: "python" } } });
    expect(Number.isSafeInteger(defaults.seed)).toBe(true);
    expect(supply({}).effective).toEqual({ numReplicates: 1, batchSize: 1, recycle: "thinking_medium", compile: false });
    expect(supply({ seed: String(defaults.seed) }).errors).toEqual([]);
  });
  it.each([["numReplicates", "1.5"], ["numReplicates", "0"], ["numReplicates", "33"], ["batchSize", "9"], ["batchSize", "2.5"], ["seed", "-1"], ["seed", "4294967296"], ["recycle", "medium"], ["compile", "maybe"], ["hydra", "x=1"], ["ckpt_path", "/etc"]])("rejects --param %s=%s", (name, value) => {
    expect(supply({ [name]: value }).errors.length).toBeGreaterThan(0);
  });
  it("draws a different random seed each time", () => {
    const seeds = new Set(Array.from({ length: 8 }, () => adapter.resolveParamDefaults!({ manifestName: "rfd4-proteina", installed: { runtime: { kind: "python" } } }).seed));
    expect(seeds.size).toBeGreaterThan(1);
  });
});

function result(id: string, kind: "generated" | "input" = "generated", text = CIF) {
  const file = path.join(context.outputDir, "inference_samples", id, `${id}_${kind}.cif`);
  write(text, file);
  return file;
}

describe("collectOutputs (no model runtime: the cloud client path)", () => {
  beforeEach(() => {
    context.runtimeExecutable = "";
    context.modelDir = path.join(root, "nonexistent-model");
    context.assetsDir = path.join(root, "nonexistent-assets");
    write("{}", path.join(context.outputDir, "moldesk-spec.json"));
  });

  it("collects exactly designs x replicates valid structures and writes a summary", async () => {
    context.params = { numReplicates: 2, seed: 7 };
    for (const id of ["a_0", "a_1", "b_0", "b_1"]) result(id);
    result("a_0", "input");
    const outputs = await adapter.collectOutputs(context);
    expect(outputs.filter((o) => o.id === "generated_structures")).toHaveLength(4);
    expect(outputs.filter((o) => o.id === "input_structures")).toHaveLength(1);
    const summary = JSON.parse(fs.readFileSync(path.join(context.outputDir, "moldesk-summary.json"), "utf8"));
    expect(summary.structures).toHaveLength(4);
    expect(summary.structures[0]).toMatchObject({ id: "a_0", design: "a", replicate: 0, atoms: 2 });
    expect(summary.parameters).toMatchObject({ numReplicates: 2, seed: 7 });
    // Collection is repeatable (recovery collects twice).
    await expect(adapter.collectOutputs(context)).resolves.toBeDefined();
  });

  it("works without a seed (older records) and from a stored copy of the spec", async () => {
    context.params = { numReplicates: 1 };
    result("a_0");
    result("b_0");
    await expect(adapter.collectOutputs(context)).resolves.toBeDefined();
  });

  it.each([
    ["a missing replicate", (): void => void fs.rmSync(path.join(context.outputDir, "inference_samples/b_0"), { recursive: true })],
    ["an unexpected extra structure", (): void => void result("c_0")],
    ["an out-of-range replicate", (): void => void result("a_1")],
    ["an empty structure", (): void => void result("a_0", "generated", "")],
    ["a structure with no atoms", (): void => void result("a_0", "generated", "data_x\n#\n")],
    ["a non-finite coordinate", (): void => void result("a_0", "generated", CIF.replace("1.0", "nan"))],
    ["a partial atom row", (): void => void result("a_0", "generated", `${CIF}ATOM CA 1.0\n`)],
    ["a file in the wrong design directory", (): void => void write(CIF, path.join(context.outputDir, "inference_samples/a_0/b_0_generated.cif"))],
  ])("fails on %s", async (_label, mutate) => {
    context.params = { numReplicates: 1, seed: 7 };
    result("a_0");
    result("b_0");
    mutate();
    await expect(adapter.collectOutputs(context)).rejects.toBeDefined();
  });

  it("fails when the resolved spec or every structure is missing", async () => {
    context.params = { numReplicates: 1, seed: 7 };
    await expect(adapter.collectOutputs(context)).rejects.toThrow(/Required output/);
    result("a_0");
    result("b_0");
    fs.rmSync(path.join(context.outputDir, "moldesk-spec.json"));
    await expect(adapter.collectOutputs(context)).rejects.toThrow(/Required output/);
  });

  it("ignores a symlinked structure instead of following it", async () => {
    context.params = { numReplicates: 1, seed: 7 };
    result("a_0");
    const real = result("b_0");
    fs.rmSync(real);
    const elsewhere = path.join(root, "elsewhere.cif");
    write(CIF, elsewhere);
    fs.symlinkSync(elsewhere, real);
    await expect(adapter.collectOutputs(context)).rejects.toBeDefined();
  });

  it("describes one scene per generated structure in spec then replicate order", async () => {
    context.params = { numReplicates: 2, seed: 7 };
    for (const id of ["b_1", "a_1", "b_0", "a_0"]) result(id);
    const outputs = (await adapter.collectOutputs(context)) as CollectedOutput[];
    const report = (await adapter.describeVisualization!(context, outputs))!;
    expect(report.scenes.map((s) => s.title)).toEqual(["a · replicate 1", "a · replicate 2", "b · replicate 1", "b · replicate 2"]);
    expect(report.scenes.every((s) => s.rank === undefined)).toBe(true);
    validateDescription(report);
  });

  it("has no report when nothing was generated", async () => {
    expect(await adapter.describeVisualization!(context, [])).toBeUndefined();
  });
});

describe("assertValidMmcif", () => {
  const file = () => path.join(root, "x.cif");
  it("handles quoted values, text fields and comments in other categories", () => {
    write(`data_x\n# comment\n_entry.id 'a b'\n_note.text\n;multi\nline # not a comment\n;\n${CIF.split("\n").slice(1).join("\n")}`, file());
    expect(assertValidMmcif(file())).toBe(2);
  });
  it("ignores non-atom loops and requires a real atom_site loop", () => {
    write("data_x\nloop_\n_other.a\n_other.b\n1 2\n3 4\n", file());
    expect(() => assertValidMmcif(file())).toThrow(/no _atom_site/);
  });
  it("rejects a missing data block and unterminated quotes", () => {
    write(CIF.replace("data_x\n", ""), file());
    expect(() => assertValidMmcif(file())).toThrow(/no data_/);
    write("data_x\nloop_\n_atom_site.Cartn_x\n'oops\n", file());
    expect(() => assertValidMmcif(file())).toThrow();
  });
});

describe("manifest", () => {
  const manifestPath = here("../../../../models/rfd4-proteina/manifest.yaml");
  const manifest = parseManifest(parseYaml(fs.readFileSync(manifestPath, "utf8")), manifestPath);

  it("pins the exact closure with hashes, the managed weights, and a Linux/CUDA-only runtime", () => {
    const runtime = manifest.runtimes[0]!;
    if (runtime.kind !== "python") throw new Error("expected python runtime");
    expect(runtime).toMatchObject({ python: "3.12", platforms: ["linux-x64"], torchBackend: "cu126", nvidiaGpu: "required" });
    expect(runtime.requirements.length).toBe(167);
    for (const requirement of runtime.requirements) {
      expect(requirement.version, requirement.name).toBeDefined();
      expect(requirement.hashes?.length, requirement.name).toBeGreaterThan(0);
    }
    expect(runtime.requirements.find((r) => r.name === "torch")?.version).toBe("2.14.1+cu126");
    expect(runtime.requirements.find((r) => r.name === "rfd4-proteina")).toMatchObject({ version: "0.0.3", extras: ["all-cuda12"] });
    for (const name of runtime.binaryOnly ?? []) expect(runtime.requirements.some((r) => r.name === name), name).toBe(true);
    expect(manifest.assets?.map((a) => a.target).sort()).toEqual(["rfd4-proteina-bundle/config.json", "rfd4-proteina-bundle/model.safetensors"]);
    expect(manifest.hardware.platforms).toEqual(["linux-x64"]);
    expect(manifest.status).toBe("available");
    // Cloud runs only on the GPUs upstream lists as tested: no Blackwell (cu126 wheels), no consumer/workstation Ampere.
    expect(manifest.cloud?.gpuAllowList).toEqual(expect.arrayContaining(["NVIDIA L40S", "NVIDIA H100 80GB HBM3"]));
    expect(manifest.cloud?.gpuAllowList?.some((id) => /Blackwell|RTX 50|B200|A40|3090|4090/.test(id))).toBe(false);
  });

  it("declares exactly the output ids the adapter collects", () => {
    expect(manifest.outputs.map((o) => [o.id, o.glob, o.required])).toEqual([
      ["resolved_spec", "moldesk-spec.json", true],
      ["generated_structures", "inference_samples/*/*_generated.cif", true],
      ["input_structures", "inference_samples/*/*_input.cif", false],
      ["summary", "moldesk-summary.json", false],
    ]);
  });
});

describe("verifyInstallation", () => {
  const ctx = () => ({ manifestName: "rfd4-proteina", modelDir: path.join(root, "model"), assetsDir: path.join(root, "model/assets"), platform: "linux-x64" as const });
  it("fails closed off Linux and when the venv is missing", async () => {
    expect((await adapter.verifyInstallation({ ...ctx(), platform: "darwin-arm64" })).passed).toBe(false);
    expect((await adapter.verifyInstallation(ctx())).passed).toBe(false);
  });
  it("runs the probe in the managed venv with the offline environment", async () => {
    for (const bin of ["python", "rfd4-generate"]) write("", path.join(root, "model/.venv/bin", bin));
    const calls: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> }> = [];
    const runner = async (command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
      calls.push({ command, args, env: options?.env });
      return { code: 0, stdout: "RFD4-Proteina verified", stderr: "" };
    };
    const verdict = await adapter.verifyInstallation({ ...ctx(), runner: runner as never });
    expect(verdict.passed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[1]).toContain("CPU fallback refused");
    expect(calls[0]!.args[1]).toContain("2.14.1+cu126");
    expect(calls[0]!.args[1]).toContain("5b549dd61adb2f6c6b5cb95bda13f40f5e31556b4e6c755edc0ca6f011c68fb0");
    expect(calls[0]!.args[2]).toBe(path.join(root, "model/assets/rfd4-proteina-bundle"));
    expect(calls[0]!.env).toMatchObject({ HF_HUB_OFFLINE: "1", CLUSTER: "local" });
    const failing = await adapter.verifyInstallation({ ...ctx(), runner: (async () => ({ code: 1, stdout: "", stderr: "no CUDA" })) as never });
    expect(failing).toMatchObject({ passed: false, output: "no CUDA" });
  });
});
