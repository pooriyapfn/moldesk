import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WireJob, WorkerClient, validateInventory, type JobInputFile } from "@moldesk/runtime";
import { createWorkerServer, type RunningWorker, type WorkerPipeline } from "./server.js";

const TOKEN = "job-token-0123456789abcdef";
const RUN = "run-1";
const dirs: string[] = [];
const workers: RunningWorker[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk worker "));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

async function boot(pipeline: WorkerPipeline, token = TOKEN) {
  const rootDir = tmp();
  const worker = createWorkerServer({ token, rootDir, pipeline });
  workers.push(worker);
  const port = await worker.listen(0, "127.0.0.1");
  const endpoint = `http://127.0.0.1:${port}`;
  const client = (overrides: Partial<ConstructorParameters<typeof WorkerClient>[0]> = {}) =>
    new WorkerClient({ endpoint, token: TOKEN, allowInsecureLoopback: true, sleep: async () => undefined, ...overrides });
  return { worker, rootDir, endpoint, client };
}

function inputFile(content = "job-bytes"): JobInputFile {
  const dir = tmp();
  const sourcePath = path.join(dir, "in.txt");
  fs.writeFileSync(sourcePath, content);
  return { role: "job", relativePath: "in.txt", sha256: sha(content), sizeBytes: Buffer.byteLength(content), sourcePath };
}

function wire(input: JobInputFile, runId = RUN): WireJob {
  const { sourcePath: _s, ...rest } = input;
  return {
    version: 1,
    runId,
    model: "m",
    modelVersion: "1",
    manifestDigest: "d",
    cachePolicy: "ephemeral",
    gpuId: "g",
    datacenterId: "dc",
    images: { gpu: "g", cpu: "c" },
    containerDiskGb: 10,
    volumeGb: 10,
    assetLayoutRevision: "1",
    cpuAssetPreparation: true,
    params: {},
    inputs: [rest],
    deadlineAt: "2099-01-01T00:00:00.000Z",
  };
}

const writes =
  (files: Record<string, string>, exitCode = 0): WorkerPipeline =>
  async ({ outputDir, log, setStage }) => {
    setStage("running");
    log("stdout", `token is ${TOKEN}\n`);
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(outputDir, name)), { recursive: true });
      fs.writeFileSync(path.join(outputDir, name), text);
    }
    return { exitCode, runtime: { dependencyFreeze: ["x==1"], pythonVersion: "3.11" } };
  };

async function untilDone(client: WorkerClient, runId = RUN) {
  for (let i = 0; i < 200; i += 1) {
    const snapshot = await client.status(runId);
    if (snapshot.state !== "running") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not finish");
}

describe("worker server + client", () => {
  it("requires the job token on every route and refuses plaintext non-loopback endpoints", async () => {
    const { client, endpoint } = await boot(writes({}));
    await expect(client({ token: "wrong-token-wrong-token" }).health()).rejects.toMatchObject({ code: "CLOUD_WORKER_AUTH_FAILED" });
    await expect(client().health()).resolves.toMatchObject({ contract: 1 });
    expect(() => new WorkerClient({ endpoint: "http://example.com", token: TOKEN })).toThrow(/HTTPS/);
    expect(() => new WorkerClient({ endpoint: endpoint, token: TOKEN })).toThrow(/HTTPS/); // loopback http only when explicitly allowed
  });

  it("runs the full flow: verified upload, status with log cursor, inventory and verified collection", async () => {
    const { client } = await boot(writes({ "boltz_results_in/predictions/a/a_model_0.cif": "CIF-DATA", "conf.json": "{}" }));
    const c = client();
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    const done = await untilDone(c);
    expect(done).toMatchObject({ state: "succeeded", exitCode: 0, runtime: { pythonVersion: "3.11" } });
    expect(done.logs.stdout).not.toContain(TOKEN);
    expect(done.logs.stdout).toContain("[REDACTED]");
    expect((await c.status(RUN, done.logs.cursor)).logs.stdout).toBe("");

    const out = tmp();
    const inventory = await c.collect(RUN, out);
    expect(inventory.files.map((file) => file.path)).toEqual(["boltz_results_in/predictions/a/a_model_0.cif", "conf.json"]);
    expect(fs.readFileSync(path.join(out, "boltz_results_in/predictions/a/a_model_0.cif"), "utf8")).toBe("CIF-DATA");
    expect(fs.readdirSync(out).filter((name) => name.startsWith(".moldesk-staging"))).toEqual([]);
  });

  it("rejects an upload whose bytes do not match the declared SHA-256 and a start with missing inputs", async () => {
    const { client } = await boot(writes({}));
    const c = client();
    const input = inputFile();
    await expect(c.uploadInput(RUN, { ...input, sha256: sha("something else") })).rejects.toMatchObject({ code: "CLOUD_WORKER_ERROR" });
    await expect(c.start(wire(input))).rejects.toThrow(/was not uploaded/);
  });

  it("serves one job per worker", async () => {
    const { client } = await boot(writes({ "o.txt": "x" }));
    const c = client();
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    await expect(c.start(wire(input))).rejects.toThrow(/already started/);
    await expect(c.status("other-run")).rejects.toThrow(/different job/);
  });

  it("reports a failing pipeline with its error and nonzero exit", async () => {
    const { client } = await boot(async () => {
      throw Object.assign(new Error(`boom ${TOKEN}`), { code: "INSTALL_VERIFICATION_FAILED" });
    });
    const c = client();
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    const done = await untilDone(c);
    expect(done.state).toBe("failed");
    expect(done.error?.code).toBe("INSTALL_VERIFICATION_FAILED");
    expect(done.error?.message).not.toContain(TOKEN);
  });

  it("cancels a running job", async () => {
    const { client } = await boot(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const c = client();
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    await c.cancel(RUN);
    expect((await untilDone(c)).state).toBe("cancelled");
  });

  it("withholds results until the job finishes", async () => {
    const { client } = await boot(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("x")))));
    const c = client();
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    await expect(c.inventory(RUN)).rejects.toThrow(/has not finished/);
  });

  it("does not follow symlinks out of the output directory", async () => {
    const secret = path.join(tmp(), "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET");
    const { client, endpoint } = await boot(async ({ outputDir }) => {
      fs.writeFileSync(path.join(outputDir, "ok.txt"), "fine");
      fs.symlinkSync(secret, path.join(outputDir, "leak.txt"));
      return { exitCode: 0 };
    });
    const c = client();
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    await untilDone(c);
    expect((await c.inventory(RUN)).files.map((file) => file.path)).toEqual(["ok.txt"]);
    for (const route of ["leak.txt", "..%2F..%2Fetc%2Fpasswd"]) {
      const response = await fetch(`${endpoint}/v1/jobs/${RUN}/files/${route}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect([400, 404]).toContain(response.status);
      expect(await response.text()).not.toContain("TOP SECRET");
    }
  });

  it("rejects corrupted downloads instead of accepting them, and promotes nothing", async () => {
    const { client } = await boot(writes({ "a.txt": "AAAA", "b.txt": "BBBB" }));
    const corrupting: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).includes("/files/b.txt")) return new Response("XXXX", { status: 200, headers: { "Content-Length": "4" } });
      return response;
    };
    const c = client({ fetch: corrupting });
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    await untilDone(c);
    const out = tmp();
    await expect(c.collect(RUN, out)).rejects.toMatchObject({ code: "CLOUD_TRANSFER_CORRUPT" });
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it("resumes an interrupted download by byte range and re-verifies the whole file", async () => {
    const payload = "0123456789".repeat(50);
    const { client } = await boot(writes({ "big.bin": payload }));
    let interrupted = false;
    let sentFirst = false;
    const ranges: Array<string | null> = [];
    const flaky: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (String(input).includes("/files/big.bin")) ranges.push(headers.get("range"));
      const response = await fetch(input, init);
      if (String(input).includes("/files/big.bin") && !interrupted) {
        interrupted = true;
        const bytes = Buffer.from(await response.arrayBuffer());
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (!sentFirst) {
                sentFirst = true;
                controller.enqueue(bytes.subarray(0, 100));
              } else {
                await new Promise((resolve) => setTimeout(resolve, 30)); // let the reader consume the first chunk
                controller.error(new Error("connection reset"));
              }
            },
          }),
          { status: 200 },
        );
      }
      return response;
    };
    const c = client({ fetch: flaky });
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    await untilDone(c);
    const out = tmp();
    await c.collect(RUN, out);
    expect(fs.readFileSync(path.join(out, "big.bin"), "utf8")).toBe(payload);
    expect(ranges).toEqual([null, "bytes=100-"]);
  });

  it("refuses to overwrite an existing local output", async () => {
    const { client } = await boot(writes({ "a.txt": "A" }));
    const c = client();
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    await untilDone(c);
    const out = tmp();
    fs.writeFileSync(path.join(out, "a.txt"), "existing");
    await expect(c.collect(RUN, out)).rejects.toMatchObject({ code: "CLOUD_OUTPUT_COLLISION" });
    expect(fs.readFileSync(path.join(out, "a.txt"), "utf8")).toBe("existing");
  });
});

describe("validateInventory", () => {
  const entry = (p: string) => ({ path: p, sizeBytes: 1, sha256: "a".repeat(64) });
  it("rejects traversal, absolute, backslash, duplicate and malformed entries", () => {
    for (const bad of ["../x", "/abs", "a\\b", "a//b", "./a", ""]) {
      expect(() => validateInventory({ version: 1, files: [entry(bad)] })).toThrow(/unsafe or malformed/);
    }
    expect(() => validateInventory({ version: 1, files: [entry("A.txt"), entry("a.TXT")] })).toThrow(/more than once/);
    expect(() => validateInventory({ version: 1, files: [{ path: "a", sizeBytes: -1, sha256: "a".repeat(64) }] })).toThrow();
    expect(() => validateInventory({ version: 2 as 1, files: [] })).toThrow(/invalid inventory/);
    expect(() => validateInventory({ version: 1, files: [entry("ok/a.txt"), entry("b")] })).not.toThrow();
  });
});
