import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { MoldeskError } from "../providers.js";
import type { ArtifactInventory, InventoryFile, JobInputFile, JobSnapshot, WireJob } from "./execution.js";
import { EXECUTION_CONTRACT_VERSION } from "./execution.js";

export const WORKER_USER_AGENT = "moldesk-worker-client/1";
const MAX_JSON_BYTES = 8 * 1024 * 1024;

export interface WorkerClientOptions {
  /** HTTPS base URL of the worker (the provider proxy), no trailing slash required. */
  endpoint: string;
  /** Per-job bearer token. Never logged, persisted in the journal or sent anywhere else. */
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  /** Test-only: permit plain http (loopback). Production endpoints must be https. */
  allowInsecureLoopback?: boolean;
  /** A stream that delivers no bytes for this long is aborted (and retried by range). Default 60 s. */
  idleTimeoutMs?: number;
  /** Cancels every in-flight request, including bodies still streaming. */
  signal?: AbortSignal;
}

interface Guard {
  signal: AbortSignal;
  arm(ms: number): void;
  release(): void;
  cancelled(): boolean;
  timedOut(): boolean;
}

function workerError(code: string, message: string, remediation: string, details?: Record<string, unknown>, cause?: unknown): MoldeskError {
  return new MoldeskError({ code, message, remediation, details, cause });
}

/** Rejects absolute paths, traversal, backslashes, empty/`.` segments and control characters. */
export function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > 1024 || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || /[\u0000-\u001f]/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export class WorkerClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly idleMs: number;

  constructor(private readonly options: WorkerClientOptions) {
    const url = new URL(options.endpoint);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(options.allowInsecureLoopback && loopback && url.protocol === "http:")) {
      throw workerError("CLOUD_WORKER_INSECURE_ENDPOINT", "The worker endpoint must use HTTPS.", "There is no plaintext fallback; use the provider's HTTPS proxy.");
    }
    this.base = options.endpoint.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.requestTimeoutMs ?? 60_000;
    this.idleMs = options.idleTimeoutMs ?? 60_000;
  }

  /** Timeout + cancellation scope covering headers AND body streaming; the timer is only released by the caller. */
  private guard(ms: number, external?: AbortSignal): Guard {
    const controller = new AbortController();
    const source = external ?? this.options.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const onAbort = (): void => controller.abort();
    if (source?.aborted) controller.abort();
    else source?.addEventListener("abort", onAbort, { once: true });
    const arm = (next: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, next);
    };
    arm(ms);
    return {
      signal: controller.signal,
      arm,
      release: () => {
        clearTimeout(timer);
        source?.removeEventListener("abort", onAbort);
      },
      cancelled: () => source?.aborted === true,
      timedOut: () => timedOut,
    };
  }

  private failure(guard: Guard, route: string, cause: unknown): MoldeskError {
    if (guard.cancelled()) return workerError("RUN_CANCELLED", "Cancelled.", "None.", { route }, cause);
    if (guard.timedOut()) return workerError("CLOUD_WORKER_TIMEOUT", "The worker did not respond in time.", "Retry; the machine may be overloaded or the connection stalled.", { route }, cause);
    return workerError("CLOUD_WORKER_UNREACHABLE", "Could not reach the worker.", "Check the connection; the machine may still be booting.", { route }, cause);
  }

  private requestInit(method: string, init: { body?: RequestInit["body"]; headers?: Record<string, string>; json?: unknown; duplex?: boolean }, signal: AbortSignal): RequestInit {
    return {
      method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        "User-Agent": WORKER_USER_AGENT,
        ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.body !== undefined ? { body: init.body } : {}),
      ...(init.duplex ? ({ duplex: "half" } as Record<string, unknown>) : {}),
      signal,
    } as RequestInit;
  }

  /** Whole-request deadline: the body is read inside the same timeout/cancellation scope as the headers. */
  private async requestText(
    method: string,
    route: string,
    init: { body?: RequestInit["body"]; headers?: Record<string, string>; json?: unknown; timeoutMs?: number; duplex?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ status: number; ok: boolean; text: string }> {
    const guard = this.guard(init.timeoutMs ?? this.timeoutMs, init.signal);
    try {
      const response = await this.fetchFn(`${this.base}${route}`, this.requestInit(method, init, guard.signal));
      const text = await response.text();
      return { status: response.status, ok: response.ok, text };
    } catch (error) {
      throw this.failure(guard, route, error);
    } finally {
      guard.release();
    }
  }

  private parse<T>(result: { status: number; ok: boolean; text: string }, route: string): T {
    if (result.status === 401 || result.status === 403) {
      throw workerError("CLOUD_WORKER_AUTH_FAILED", "The worker rejected the job token.", "The worker belongs to a different job; do not retry with another token.", { route, status: result.status });
    }
    if (result.text.length > MAX_JSON_BYTES) throw workerError("CLOUD_BAD_RESPONSE", "Worker response too large.", "Retry.", { route });
    if (!result.ok) {
      let detail: string | undefined;
      try {
        detail = (JSON.parse(result.text) as { message?: string }).message;
      } catch {
        detail = result.text.slice(0, 200);
      }
      throw workerError("CLOUD_WORKER_ERROR", `Worker error ${result.status} on ${route}${detail ? `: ${detail}` : ""}.`, "Retry or inspect the run logs.", { route, status: result.status });
    }
    try {
      return JSON.parse(result.text) as T;
    } catch (error) {
      throw workerError("CLOUD_BAD_RESPONSE", "The worker returned malformed JSON.", "Retry.", { route }, error);
    }
  }

  async health(): Promise<{ contract: number; workerVersion: string }> {
    const result = this.parse<{ contract: number; workerVersion: string }>(await this.requestText("GET", "/v1/health", { timeoutMs: 15_000 }), "/v1/health");
    if (result.contract !== EXECUTION_CONTRACT_VERSION) {
      throw workerError("CLOUD_WORKER_VERSION_MISMATCH", `Worker speaks contract ${result.contract}; this client speaks ${EXECUTION_CONTRACT_VERSION}.`, "Use matching MoleculeDesk versions.");
    }
    return result;
  }

  /** Polls health until ready. 404/connection failures (proxy not routed yet, container booting) are expected. */
  async waitUntilReady(options: { timeoutMs: number; intervalMs?: number; abortIf?: () => Promise<string | undefined>; signal?: AbortSignal }): Promise<void> {
    const started = Date.now();
    let last: unknown;
    while (Date.now() - started < options.timeoutMs) {
      if (options.signal?.aborted) throw workerError("RUN_CANCELLED", "Cancelled while waiting for the worker.", "None.");
      try {
        await this.health();
        return;
      } catch (error) {
        last = error;
        if (error instanceof MoldeskError && (error.code === "CLOUD_WORKER_AUTH_FAILED" || error.code === "CLOUD_WORKER_VERSION_MISMATCH")) throw error;
      }
      const fatal = await options.abortIf?.();
      if (fatal) throw workerError("CLOUD_WORKER_BOOT_FAILED", fatal, "Inspect the Pod; it will be terminated.");
      await this.sleep(options.intervalMs ?? 5000);
    }
    throw workerError("CLOUD_WORKER_BOOT_TIMEOUT", `The worker did not become ready within ${Math.round(options.timeoutMs / 1000)}s.`, "Cold image pulls can be slow; retry, or check provider status.", undefined, last);
  }

  /** Streams one input file, verifying size and SHA-256 on both ends. */
  async uploadInput(runId: string, file: Pick<JobInputFile, "relativePath" | "sha256" | "sizeBytes" | "sourcePath">): Promise<void> {
    if (!isSafeRelativePath(file.relativePath)) throw workerError("CLOUD_UNSAFE_PATH", `Unsafe input path ${JSON.stringify(file.relativePath)}.`, "Use a simple file name.");
    const stat = fs.statSync(file.sourcePath);
    if (stat.size !== file.sizeBytes) throw workerError("CLOUD_INPUT_CHANGED", "The input changed size after it was quoted.", "Request a new quote.");
    const route = `/v1/jobs/${encodeURIComponent(runId)}/input/${file.relativePath.split("/").map(encodeURIComponent).join("/")}`;
    const body = Readable.toWeb(fs.createReadStream(file.sourcePath)) as unknown as RequestInit["body"];
    const response = await this.requestText("PUT", route, {
      body,
      duplex: true,
      timeoutMs: 10 * 60_000,
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(file.sizeBytes), "X-Moldesk-Sha256": file.sha256 },
    });
    this.parse<{ ok: true }>(response, route);
  }

  async start(job: WireJob): Promise<void> {
    const route = `/v1/jobs/${encodeURIComponent(job.runId)}/start`;
    this.parse<{ ok: true }>(await this.requestText("POST", route, { json: job }), route);
  }

  async status(runId: string, after = 0): Promise<JobSnapshot> {
    const route = `/v1/jobs/${encodeURIComponent(runId)}/status?after=${after}`;
    return this.parse<JobSnapshot>(await this.requestText("GET", route, { timeoutMs: 20_000 }), route);
  }

  async cancel(runId: string): Promise<void> {
    const route = `/v1/jobs/${encodeURIComponent(runId)}/cancel`;
    this.parse<{ ok: true }>(await this.requestText("POST", route, { timeoutMs: 20_000 }), route);
  }

  async inventory(runId: string, signal?: AbortSignal): Promise<ArtifactInventory> {
    const route = `/v1/jobs/${encodeURIComponent(runId)}/inventory`;
    const inventory = this.parse<ArtifactInventory>(await this.requestText("GET", route, { signal }), route);
    validateInventory(inventory);
    return inventory;
  }

  /**
   * Downloads every inventory file into a staging directory, verifies size and SHA-256 per file,
   * then promotes them into `localOutputDir`. Nothing is promoted unless everything verified, and a
   * partial file is resumed by byte range then re-verified in full. Never reruns inference.
   */
  async collect(runId: string, localOutputDir: string, options: { signal?: AbortSignal } = {}): Promise<ArtifactInventory> {
    const inventory = await this.inventory(runId, options.signal);
    const staging = path.join(localOutputDir, `.moldesk-staging-${randomUUID()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      for (const file of inventory.files) {
        const target = path.join(staging, ...file.path.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await this.downloadVerified(runId, file, target, options.signal);
      }
      for (const file of inventory.files) {
        const finalPath = path.join(localOutputDir, ...file.path.split("/"));
        if (fs.existsSync(finalPath)) {
          throw workerError("CLOUD_OUTPUT_COLLISION", `Output ${file.path} already exists locally.`, "Use an empty run output directory.");
        }
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.renameSync(path.join(staging, ...file.path.split("/")), finalPath);
      }
      return inventory;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  private async downloadVerified(runId: string, file: InventoryFile, target: string, signal?: AbortSignal): Promise<void> {
    const route = `/v1/jobs/${encodeURIComponent(runId)}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const have = fs.existsSync(target) ? fs.statSync(target).size : 0;
      const resume = have > 0 && have < file.sizeBytes;
      if (!resume && have > 0) fs.rmSync(target, { force: true });
      // One scope per attempt: it covers connecting, headers and every body chunk, and is re-armed on
      // each chunk so only a genuinely stalled stream times out. Cancellation aborts it immediately.
      const guard = this.guard(this.idleMs, signal);
      let response: Response;
      try {
        response = await this.fetchFn(`${this.base}${route}`, this.requestInit("GET", { headers: resume ? { Range: `bytes=${have}-` } : {} }, guard.signal));
      } catch (error) {
        guard.release();
        const failure = this.failure(guard, route, error);
        if (failure.code === "RUN_CANCELLED" || attempt === 3) throw failure.code === "RUN_CANCELLED" ? failure : workerError("CLOUD_TRANSFER_FAILED", `Could not download ${file.path}.`, "Retry recovery before the lifetime limit.", { path: file.path }, error);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        guard.release();
        throw workerError("CLOUD_WORKER_AUTH_FAILED", "The worker rejected the job token.", "Do not retry.");
      }
      const okStatus = resume ? response.status === 206 : response.status === 200;
      if (!okStatus || !response.body) {
        guard.release();
        if (resume && response.status === 200) fs.rmSync(target, { force: true }); // server ignored Range: restart this file only
        if (attempt === 3) throw workerError("CLOUD_TRANSFER_FAILED", `Could not download ${file.path} (status ${response.status}).`, "Retry recovery before the lifetime limit.");
        continue;
      }
      const sink = fs.createWriteStream(target, { flags: resume ? "a" : "w" });
      const closeSink = (): Promise<void> => new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => (error ? reject(error) : resolve())));
      try {
        for await (const chunk of Readable.fromWeb(response.body as never)) {
          guard.arm(this.idleMs);
          if (!sink.write(chunk)) await new Promise<void>((resolve) => sink.once("drain", resolve));
        }
        await closeSink();
      } catch (error) {
        // Flush what arrived so the next attempt can resume from it by byte range.
        await closeSink().catch(() => undefined);
        const cancelled = guard.cancelled();
        const stalled = guard.timedOut();
        guard.release();
        if (cancelled) throw workerError("RUN_CANCELLED", "Cancelled during download.", "None.", { path: file.path }, error);
        if (attempt === 3) {
          throw workerError("CLOUD_TRANSFER_FAILED", `The download of ${file.path} was ${stalled ? "stalled" : "interrupted"}.`, "Retry recovery before the lifetime limit.", { path: file.path }, error);
        }
        continue;
      }
      guard.release();
      // Verify the complete file regardless of how it was assembled.
      const size = fs.statSync(target).size;
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(target)) hash.update(chunk as Buffer);
      if (size === file.sizeBytes && hash.digest("hex") === file.sha256.toLowerCase()) return;
      fs.rmSync(target, { force: true });
      if (attempt === 3) throw workerError("CLOUD_TRANSFER_CORRUPT", `${file.path} failed size/SHA-256 verification.`, "The result was corrupted in transit; it is not accepted.", { path: file.path });
    }
  }
}

export function validateInventory(inventory: ArtifactInventory): void {
  if (inventory?.version !== EXECUTION_CONTRACT_VERSION || !Array.isArray(inventory.files)) {
    throw workerError("CLOUD_BAD_RESPONSE", "The worker returned an invalid inventory.", "Retry.");
  }
  const seen = new Set<string>();
  for (const file of inventory.files) {
    const key = file?.path?.toLowerCase();
    if (!file || !isSafeRelativePath(file.path) || !Number.isInteger(file.sizeBytes) || file.sizeBytes < 0 || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
      throw workerError("CLOUD_UNSAFE_PATH", `The inventory contains an unsafe or malformed entry: ${JSON.stringify(file?.path)}.`, "The result is rejected; nothing was written locally.");
    }
    if (seen.has(key)) throw workerError("CLOUD_UNSAFE_PATH", `The inventory lists ${file.path} more than once (case-insensitive).`, "The result is rejected.");
    seen.add(key);
  }
}
