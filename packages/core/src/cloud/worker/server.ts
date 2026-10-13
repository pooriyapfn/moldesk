import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import {
  EXECUTION_CONTRACT_VERSION,
  isSafeRelativePath,
  redactSecrets,
  type ArtifactInventory,
  type InventoryFile,
  type JobSnapshot,
  type JobStage,
  type RemoteRuntimeReport,
  type WireJob,
} from "@moldesk/runtime";

export const WORKER_VERSION = "1";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 2 * 1024 ** 3;
const MAX_LOG_BYTES = 4 * 1024 * 1024;

export interface PipelineContext {
  job: WireJob;
  jobDir: string;
  inputDir: string;
  outputDir: string;
  signal: AbortSignal;
  setStage(stage: JobStage): void;
  log(stream: "stdout" | "stderr", text: string): void;
}

export interface PipelineResult {
  exitCode: number;
  runtime?: RemoteRuntimeReport;
}

/** The real work (assets, runtime, command, execution). Injected so the HTTP surface is testable on its own. */
export type WorkerPipeline = (context: PipelineContext) => Promise<PipelineResult>;

export interface WorkerServerOptions {
  /** Per-job bearer token; every route, including health, requires it. */
  token: string;
  /** Jobs live under `<rootDir>/<runId>/{input,output}`. */
  rootDir: string;
  pipeline: WorkerPipeline;
  /** Extra secrets to scrub from logs (the token itself is always scrubbed). */
  secrets?: string[];
}

interface JobState {
  job?: WireJob;
  stage: JobStage;
  state: JobSnapshot["state"];
  exitCode?: number;
  error?: { code: string; message: string };
  runtime?: RemoteRuntimeReport;
  logs: Array<{ seq: number; stream: "stdout" | "stderr"; text: string; bytes: number }>;
  logBytes: number;
  seq: number;
  controller: AbortController;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > MAX_JSON_BYTES) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("malformed JSON"), { status: 400 });
  }
}

/** Real path of `target` must stay inside `root`; symlinks are refused. */
function confined(root: string, relative: string): string | undefined {
  if (!isSafeRelativePath(relative)) return undefined;
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relative.split("/"));
  return target.startsWith(`${resolvedRoot}${path.sep}`) ? target : undefined;
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function buildInventory(outputDir: string): Promise<ArtifactInventory> {
  const files: InventoryFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(full, relative);
      else if (stat.isFile()) files.push({ path: relative, sizeBytes: stat.size, sha256: await sha256Of(full) });
    }
  };
  if (fs.existsSync(outputDir)) await walk(outputDir, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { version: EXECUTION_CONTRACT_VERSION, files };
}

export interface RunningWorker {
  server: http.Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  /** Terminal state reached; used by tests and the idle watchdog. */
  isFinished(): boolean;
}

export function createWorkerServer(options: WorkerServerOptions): RunningWorker {
  const secrets = [options.token, ...(options.secrets ?? [])];
  let current: { runId: string; state: JobState } | undefined;

  const pushLog = (state: JobState, stream: "stdout" | "stderr", raw: string): void => {
    const text = redactSecrets(raw, secrets);
    const bytes = Buffer.byteLength(text);
    state.seq += 1;
    state.logs.push({ seq: state.seq, stream, text, bytes });
    state.logBytes += bytes;
    while (state.logBytes > MAX_LOG_BYTES && state.logs.length > 1) state.logBytes -= state.logs.shift()!.bytes;
  };

  const snapshot = (state: JobState, after: number): JobSnapshot => {
    const fresh = state.logs.filter((entry) => entry.seq > after);
    return {
      stage: state.stage,
      state: state.state,
      ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
      ...(state.error ? { error: state.error } : {}),
      logs: {
        cursor: state.seq,
        stdout: fresh.filter((entry) => entry.stream === "stdout").map((entry) => entry.text).join(""),
        stderr: fresh.filter((entry) => entry.stream === "stderr").map((entry) => entry.text).join(""),
      },
      ...(state.runtime ? { runtime: state.runtime } : {}),
    };
  };

  const startJob = (job: WireJob): void => {
    const jobDir = path.join(options.rootDir, job.runId);
    const state: JobState = { job, stage: "booting", state: "running", logs: [], logBytes: 0, seq: 0, controller: new AbortController() };
    current = { runId: job.runId, state };
    fs.mkdirSync(path.join(jobDir, "output"), { recursive: true });
    void (async () => {
      try {
        const result = await options.pipeline({
          job,
          jobDir,
          inputDir: path.join(jobDir, "input"),
          outputDir: path.join(jobDir, "output"),
          signal: state.controller.signal,
          setStage: (stage) => {
            state.stage = stage;
          },
          log: (stream, text) => pushLog(state, stream, text),
        });
        state.exitCode = result.exitCode;
        state.runtime = result.runtime;
        state.state = state.controller.signal.aborted ? "cancelled" : result.exitCode === 0 ? "succeeded" : "failed";
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
        const code = (error as { code?: unknown })?.code;
        state.error = { code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "WORKER_PIPELINE_FAILED", message };
        state.state = state.controller.signal.aborted ? "cancelled" : "failed";
      }
    })();
  };

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://worker");
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (!bearer || !constantTimeEqual(bearer, options.token)) return sendJson(response, 401, { message: "unauthorized" });
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/v1/health") {
      return sendJson(response, 200, { contract: EXECUTION_CONTRACT_VERSION, workerVersion: WORKER_VERSION });
    }

    const match = /^\/v1\/jobs\/([^/]+)\/(input|start|status|cancel|inventory|files)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return sendJson(response, 404, { message: "not found" });
    const runId = decodeURIComponent(match[1]!);
    const action = match[2]!;
    const rest = match[3] !== undefined ? match[3].split("/").map(decodeURIComponent).join("/") : undefined;
    if (!RUN_ID_PATTERN.test(runId)) return sendJson(response, 400, { message: "invalid run id" });
    if (current && current.runId !== runId) return sendJson(response, 409, { message: "this worker serves a different job" });
    const jobDir = path.join(options.rootDir, runId);

    if (action === "input" && method === "PUT") {
      if (current) return sendJson(response, 409, { message: "job already started" });
      const target = rest ? confined(path.join(jobDir, "input"), rest) : undefined;
      if (!target) return sendJson(response, 400, { message: "unsafe input path" });
      const declaredSha = String(request.headers["x-moldesk-sha256"] ?? "").toLowerCase();
      const declaredSize = Number(request.headers["content-length"]);
      if (!/^[0-9a-f]{64}$/.test(declaredSha) || !Number.isInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_INPUT_BYTES) {
        return sendJson(response, 400, { message: "missing or invalid sha256/length" });
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.part-${process.pid}`;
      const hash = createHash("sha256");
      let received = 0;
      request.on("data", (chunk: Buffer) => {
        received += chunk.length;
        hash.update(chunk);
      });
      try {
        await streamPipeline(request, fs.createWriteStream(temporary, { mode: 0o600 }));
      } catch {
        fs.rmSync(temporary, { force: true });
        return sendJson(response, 400, { message: "upload interrupted" });
      }
      if (received !== declaredSize || hash.digest("hex") !== declaredSha) {
        fs.rmSync(temporary, { force: true });
        return sendJson(response, 422, { message: "upload failed size/sha256 verification" });
      }
      fs.renameSync(temporary, target);
      return sendJson(response, 200, { ok: true });
    }

    if (action === "start" && method === "POST") {
      if (current) return sendJson(response, 409, { message: "job already started" });
      const body = (await readJson(request)) as WireJob;
      if (
        body?.version !== EXECUTION_CONTRACT_VERSION ||
        body.runId !== runId ||
        (body.mode !== "execute" && body.mode !== "prepare-assets") ||
        !Array.isArray(body.inputs) ||
        (body.mode === "execute" && body.inputs.length === 0)
      ) {
        return sendJson(response, 400, { message: "invalid job" });
      }
      for (const input of body.inputs) {
        const file = confined(path.join(jobDir, "input"), input.relativePath);
        if (!file || !fs.existsSync(file) || fs.statSync(file).size !== input.sizeBytes) {
          return sendJson(response, 422, { message: `input ${JSON.stringify(input.relativePath)} was not uploaded or does not match` });
        }
      }
      startJob(body);
      return sendJson(response, 200, { ok: true });
    }

    if (!current) return sendJson(response, 404, { message: "no such job" });
    const state = current.state;

    if (action === "status" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      return sendJson(response, 200, snapshot(state, Number.isInteger(after) && after >= 0 ? after : 0));
    }
    if (action === "cancel" && method === "POST") {
      state.controller.abort();
      return sendJson(response, 200, { ok: true });
    }
    const finished = state.state !== "running" && state.state !== "pending";
    if (action === "inventory" && method === "GET") {
      if (!finished) return sendJson(response, 409, { message: "job has not finished" });
      return sendJson(response, 200, await buildInventory(path.join(jobDir, "output")));
    }
    if (action === "files" && method === "GET") {
      if (!finished) return sendJson(response, 409, { message: "job has not finished" });
      const outputDir = path.join(jobDir, "output");
      const target = rest ? confined(outputDir, rest) : undefined;
      if (!target) return sendJson(response, 400, { message: "unsafe path" });
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(target);
      } catch {
        return sendJson(response, 404, { message: "no such file" });
      }
      if (!stat.isFile() || fs.realpathSync(target) !== path.join(fs.realpathSync(outputDir), ...rest!.split("/"))) return sendJson(response, 404, { message: "no such file" });
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ""));
      let start = 0;
      let end = stat.size - 1;
      let status = 200;
      if (range) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
          return void response.end();
        }
        status = 206;
      }
      response.writeHead(status, {
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size === 0 ? 0 : end - start + 1,
        ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
      });
      if (stat.size === 0) return void response.end();
      await streamPipeline(fs.createReadStream(target, { start, end }), response).catch(() => undefined);
      return;
    }
    return sendJson(response, 405, { message: "method not allowed" });
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: { status?: number; message?: string }) => {
      if (response.headersSent) return void response.destroy();
      sendJson(response, error.status ?? 500, { message: redactSecrets(error.message ?? "internal error", secrets) });
    });
  });

  return {
    server,
    listen: (port, host = "0.0.0.0") =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve((server.address() as { port: number }).port));
      }),
    close: () =>
      new Promise((resolve) => {
        current?.state.controller.abort();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
    isFinished: () => current !== undefined && current.state.state !== "running" && current.state.state !== "pending",
  };
}
