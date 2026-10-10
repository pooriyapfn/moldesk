import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAdapter, type ModelAdapterDefinition } from "@moldesk/adapters";
import { decodeEnvelope, extractEnvelope } from "@moldesk/visualizer";
import { runModel } from "./run.js";
import { fakeProvider, homes, installFixture, tempPaths, writeInputFixture, writeSequenceOutput } from "./testSupport/run-fixture.js";

type Hook = NonNullable<ModelAdapterDefinition["describeVisualization"]>;
const adapter = getAdapter("proteinmpnn") as ModelAdapterDefinition;

afterEach(() => {
  delete adapter.describeVisualization;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const ok = (request: { cwd: string }) => ({
  exitCode: 0,
  stdoutPath: path.join(request.cwd, "stdout.log"),
  stderrPath: path.join(request.cwd, "stderr.log"),
});

/** Plumbing fixture: ProteinMPNN's real output file, described as a one-scene report. */
const describeSequences: Hook = async (_ctx, outputs) => {
  const seq = outputs.find((o) => o.id === "sequences")!;
  return {
    title: "Test report",
    resources: [{ id: "r1", source: { kind: "output", path: seq.path }, format: "pdb", label: "input.fa" }],
    scenes: [{ id: "s1", title: "S", structures: [{ id: "a", resourceId: "r1" }] }],
    panels: [],
  };
};

async function run(hook: Hook | undefined, options: Parameters<typeof runModel>[2] = {}, behavior = (r: { cwd: string }) => { writeSequenceOutput(r as never); return ok(r); }) {
  const paths = tempPaths();
  await installFixture(paths);
  const inputPath = writeInputFixture(paths.home);
  if (hook) adapter.describeVisualization = hook;
  return { paths, result: await runModel("proteinmpnn", inputPath, { paths, runtimeProvider: fakeProvider(behavior as never), ...options }) };
}

describe("runModel visualization", () => {
  it("adds a verified self-contained artifact without touching scientific outputs", async () => {
    const { result } = await run(describeSequences);
    expect(result.status).toBe("succeeded");
    const [artifact] = result.record.artifacts!;
    expect(artifact.path).toBe(path.join(result.record.command.cwd, "artifacts", "viewer.html"));
    expect(artifact.kind).toBe("molecular-report");
    expect(artifact.sourceSha256).toEqual([result.record.outputs[0].sha256]);
    expect(result.record.outputs.map((o) => o.id)).toEqual(["sequences"]);
    expect(result.record.warnings).toBeUndefined();

    const html = fs.readFileSync(artifact.path, "utf8");
    const report = decodeEnvelope(extractEnvelope(html));
    expect(Buffer.from(report.resources[0].data, "base64").toString()).toBe(">input\nMKV\n");
    expect(report.provenance).toMatchObject({ runId: result.record.id, model: "proteinmpnn" });
    const onDisk = JSON.parse(fs.readFileSync(path.join(result.record.command.cwd, "run.json"), "utf8"));
    expect(onDisk.artifacts[0].sha256).toBe(artifact.sha256);
  });

  it("allows staged input sources", async () => {
    const { result } = await run(async (ctx) => ({
      title: "t",
      resources: [{ id: "r1", source: { kind: "input", path: ctx.inputPath }, format: "pdb", label: "in.pdb" }],
      scenes: [{ id: "s1", title: "S", structures: [{ id: "a", resourceId: "r1" }] }],
      panels: [],
    }));
    expect(result.record.artifacts).toHaveLength(1);
  });

  it("keeps a successful run successful when the hook throws, with a warning", async () => {
    const { result } = await run(async () => {
      throw new Error("boom");
    });
    expect(result.status).toBe("succeeded");
    expect(result.record.error).toBeUndefined();
    expect(result.record.artifacts).toBeUndefined();
    expect(result.record.warnings).toEqual([{ code: "VISUALIZATION_FAILED", message: "Could not create the molecular report: boom" }]);
    expect(fs.existsSync(path.join(result.record.command.cwd, "artifacts"))).toBe(false);
  });

  it("surfaces a typed MoldeskError code from the hook as the warning code", async () => {
    const { MoldeskError } = await import("./errors.js");
    const { result } = await run(async () => {
      throw new MoldeskError({ code: "VISUALIZATION_RECEPTOR_MISSING", message: "no receptor", remediation: "x" });
    });
    expect(result.status).toBe("succeeded");
    expect(result.record.warnings![0].code).toBe("VISUALIZATION_RECEPTOR_MISSING");
  });

  it("treats undefined as 'no report applies': no artifact and no warning", async () => {
    const { result } = await run(async () => undefined);
    expect(result.record.artifacts).toBeUndefined();
    expect(result.record.warnings).toBeUndefined();
  });

  it("works for adapters without the hook", async () => {
    const { result } = await run(undefined);
    expect(result.status).toBe("succeeded");
    expect(result.record.artifacts).toBeUndefined();
    expect(result.record.warnings).toBeUndefined();
  });

  it("refuses sources the run did not record, writing nothing", async () => {
    const { result } = await run(async (ctx) => ({
      title: "t",
      resources: [{ id: "r1", source: { kind: "output", path: path.join(path.dirname(ctx.outputDir), "run.json") }, format: "json", label: "x" }],
      scenes: [],
      panels: [],
    }));
    expect(result.status).toBe("succeeded");
    expect(result.record.warnings![0].code).toBe("VISUALIZATION_SOURCE_NOT_ALLOWED");
    expect(fs.existsSync(path.join(result.record.command.cwd, "artifacts"))).toBe(false);
  });

  it("refuses a recorded output that was replaced by a symlink", async () => {
    const { result } = await run(async (ctx, outputs) => {
      const seq = outputs.find((o) => o.id === "sequences")!;
      const target = path.join(path.dirname(ctx.outputDir), "elsewhere.fa");
      fs.writeFileSync(target, ">input\nMKV\n");
      fs.rmSync(seq.path);
      fs.symlinkSync(target, seq.path);
      return describeSequences(ctx, outputs);
    });
    expect(result.record.warnings![0].code).toBe("VISUALIZATION_SOURCE_NOT_ALLOWED");
    expect(result.record.artifacts).toBeUndefined();
  });

  it("refuses a recorded output that changed after it was checksummed", async () => {
    const { result } = await run(async (ctx, outputs) => {
      fs.appendFileSync(outputs.find((o) => o.id === "sequences")!.path, ">tampered\n");
      return describeSequences(ctx, outputs);
    });
    expect(result.record.warnings![0].code).toBe("VISUALIZATION_SOURCE_CHANGED");
  });

  it("rejects an invalid description with a warning", async () => {
    const { result } = await run(async () => ({ title: "t", resources: [], scenes: [{ id: "s", title: "S", structures: [{ id: "a", resourceId: "missing" }] }], panels: [] }));
    expect(result.status).toBe("succeeded");
    expect(result.record.warnings![0].code).toBe("INVALID_REPORT");
  });

  it("skips the hook entirely with visualize: false", async () => {
    let called = false;
    const { result } = await run(async (...args) => {
      called = true;
      return describeSequences(...args);
    }, { visualize: false });
    expect(called).toBe(false);
    expect(result.record.artifacts).toBeUndefined();
  });

  it.each([
    ["failed", () => ({ exitCode: 1 })],
    ["cancelled", () => ({ exitCode: 0, cancelled: true })],
  ])("never describes a %s run", async (status, outcome) => {
    let called = false;
    const { result } = await run(async () => {
      called = true;
      return undefined;
    }, {}, (r) => ({ ...ok(r), ...outcome() }));
    expect(result.status).toBe(status);
    expect(called).toBe(false);
  });

  it("cancellation during report generation keeps the model outcome and writes nothing", async () => {
    const controller = new AbortController();
    const { result } = await run(async (...args) => {
      const d = await describeSequences(...args);
      controller.abort();
      return d;
    }, { signal: controller.signal });
    expect(result.status).toBe("succeeded");
    expect(result.record.warnings![0].code).toBe("VISUALIZATION_CANCELLED");
    expect(fs.existsSync(path.join(result.record.command.cwd, "artifacts"))).toBe(false);
  });

  it("copies the report to --output under a collision-resistant name, never overwriting", async () => {
    const paths = tempPaths();
    await installFixture(paths);
    adapter.describeVisualization = describeSequences;
    const outputDir = path.join(paths.home, "results");
    const exec = (inputName: string) =>
      runModel("proteinmpnn", writeInputFixture(paths.home, inputName), {
        paths,
        outputDir,
        runtimeProvider: fakeProvider((r) => {
          writeSequenceOutput(r);
          return ok(r);
        }),
      });
    const first = await exec("a.pdb");
    expect(first.exportError).toBeUndefined();
    const copied = path.join(outputDir, `moldesk-report-${first.record.id}.html`);
    expect(fs.readFileSync(copied).equals(fs.readFileSync(first.record.artifacts![0].path))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "input.fa"))).toBe(true);

    const second = await exec("b.pdb");
    expect(second.status).toBe("succeeded");
    expect(second.exportError?.code).toBe("OUTPUT_COLLISION");
  });
});
