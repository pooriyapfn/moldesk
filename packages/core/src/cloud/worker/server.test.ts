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

async function boot(pipeline: WorkerPipeline, token = TOKEN, maxLogBytes?: number) {
  const rootDir = tmp();
  const worker = createWorkerServer({ token, rootDir, pipeline, ...(maxLogBytes ? { maxLogBytes } : {}) });
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
    cacheKey: "k".repeat(64),
    mode: "execute",
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

/** A body that yields `first` and then never delivers or ends (a stalled connection); like real fetch, aborting the request errors it. */
function stalledBody(first: Uint8Array, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    },
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return undefined;
      }
      return new Promise<void>(() => undefined); // never resolves
    },
  });
}

describe("timeouts and cancellation while streaming", () => {
  const payload = "0123456789".repeat(50);

  async function finishedJob(overrides: Partial<ConstructorParameters<typeof WorkerClient>[0]>, wrap?: (real: typeof fetch) => typeof fetch) {
    const { client } = await boot(writes({ "big.bin": payload }));
    const setup = client();
    const input = inputFile();
    await setup.uploadInput(RUN, input);
    await setup.start(wire(input));
    await untilDone(setup);
    const real = fetch;
    return client({ ...overrides, ...(wrap ? { fetch: wrap(real) } : {}) });
  }

  it("recovers from a stalled download by resuming from the bytes already received", async () => {
    const ranges: Array<string | null> = [];
    let stalled = false;
    const c = await finishedJob({ idleTimeoutMs: 400 }, (real) => async (input, init) => {
      if (String(input).includes("/files/big.bin")) ranges.push(new Headers(init?.headers).get("range"));
      const response = await real(input, init);
      if (String(input).includes("/files/big.bin") && !stalled) {
        stalled = true;
        const bytes = new Uint8Array(await response.arrayBuffer());
        return new Response(stalledBody(bytes.subarray(0, 100), init?.signal), { status: 200 });
      }
      return response;
    });
    const out = tmp();
    await c.collect(RUN, out);
    expect(fs.readFileSync(path.join(out, "big.bin"), "utf8")).toBe(payload);
    expect(ranges).toEqual([null, "bytes=100-"]);
  });

  it("gives up on a download that keeps stalling instead of hanging, and promotes nothing", async () => {
    const c = await finishedJob({ idleTimeoutMs: 40 }, (real) => async (input, init) => {
      const response = await real(input, init);
      if (!String(input).includes("/files/big.bin")) return response;
      return new Response(stalledBody(new Uint8Array(await response.arrayBuffer()).subarray(0, 10), init?.signal), { status: 200 });
    });
    const out = tmp();
    const started = Date.now();
    await expect(c.collect(RUN, out)).rejects.toMatchObject({ code: "CLOUD_TRANSFER_FAILED", message: expect.stringMatching(/stalled/) });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it("cancellation interrupts a stalled body immediately, not after the idle timeout", async () => {
    const controller = new AbortController();
    const c = await finishedJob({ idleTimeoutMs: 60_000 }, (real) => async (input, init) => {
      const response = await real(input, init);
      if (!String(input).includes("/files/big.bin")) return response;
      return new Response(stalledBody(new Uint8Array(await response.arrayBuffer()).subarray(0, 10), init?.signal), { status: 200 });
    });
    const out = tmp();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    await expect(c.collect(RUN, out, { signal: controller.signal })).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it("times out a JSON response whose body never finishes", async () => {
    const { client } = await boot(writes({}));
    const c = client({
      requestTimeoutMs: 50,
      fetch: async (_input, init) => new Response(stalledBody(new TextEncoder().encode('{"stage":'), init?.signal), { status: 200 }),
    });
    await expect(c.status(RUN)).rejects.toMatchObject({ code: "CLOUD_WORKER_TIMEOUT" });
  });

  it("a client-level signal cancels in-flight JSON requests too", async () => {
    const controller = new AbortController();
    const { client } = await boot(writes({}));
    const c = client({ signal: controller.signal, requestTimeoutMs: 60_000, fetch: async (_input, init) => new Response(stalledBody(new TextEncoder().encode("{"), init?.signal), { status: 200 }) });
    setTimeout(() => controller.abort(), 20);
    await expect(c.status(RUN)).rejects.toMatchObject({ code: "RUN_CANCELLED" });
  });
});

describe("bounded log tail", () => {
  const chatty: WorkerPipeline = async ({ log }) => {
    for (let i = 1; i <= 20; i += 1) log("stdout", `line-${String(i).padStart(2, "0")}-${"x".repeat(90)}\n`); // ~100 bytes each
    return { exitCode: 0 };
  };

  it("reports exactly how many chunks a late reader missed, and keeps the newest", async () => {
    const { client } = await boot(chatty, TOKEN, 450);
    const c = client();
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    await untilDone(c);

    const all = await c.status(RUN, 0);
    const retained = all.logs.stdout.split("\n").filter(Boolean);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(20);
    expect(retained.at(-1)).toContain("line-20");
    expect(all.logs.lostEntries).toBe(20 - retained.length);
    expect(all.logs.evictedBytes).toBeGreaterThanOrEqual((20 - retained.length) * 99);
    expect(all.logs.cursor).toBe(20);
  });

  it("reports nothing lost to a reader that kept up, or one that is partly behind", async () => {
    const { client } = await boot(chatty, TOKEN, 450);
    const c = client();
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    await untilDone(c);
    const retainedCount = (await c.status(RUN, 0)).logs.stdout.split("\n").filter(Boolean).length;
    expect((await c.status(RUN, 20)).logs.lostEntries).toBeUndefined();
    // A reader positioned exactly at the oldest retained chunk lost nothing.
    expect((await c.status(RUN, 20 - retainedCount)).logs.lostEntries).toBeUndefined();
    // One chunk earlier and exactly one chunk was missed.
    expect((await c.status(RUN, 20 - retainedCount - 1)).logs.lostEntries).toBe(1);
  });

  it("never reports loss when the buffer was not exceeded", async () => {
    const { client } = await boot(chatty, TOKEN, 1_000_000);
    const c = client();
    const input = inputFile();
    await c.uploadInput(RUN, input);
    await c.start(wire(input));
    await untilDone(c);
    const all = await c.status(RUN, 0);
    expect(all.logs.lostEntries).toBeUndefined();
    expect(all.logs.stdout.split("\n").filter(Boolean)).toHaveLength(20);
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
