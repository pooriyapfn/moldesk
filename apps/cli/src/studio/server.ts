import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  MAX_WORKFLOW_BYTES,
  MoldeskError,
  asMoldeskError,
  cancelWorkflowRun,
  createStandaloneReport,
  getMoldeskPaths,
  getWorkflowArtifacts,
  getWorkflowStatus,
  planWorkflow,
  startWorkflowResume,
  startWorkflowRun,
  storeWorkflowPlan,
  validateWorkflow,
} from "@moldesk/core";
import { studioPage } from "./page.js";

const LOOPBACK = "127.0.0.1";
const MAX_BODY_BYTES = MAX_WORKFLOW_BYTES + 64 * 1024;
const LOG_TAIL_BYTES = 8 * 1024;
const MAX_WORKSPACE_FILES = 200;
const SSE_POLL_MS = 300;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Artifact IDs are `<runId>:<stepId>:<output>`.
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const APPROVAL_ID = /^[A-Za-z0-9-]{8,64}$/;

type MoldeskPaths = ReturnType<typeof getMoldeskPaths>;

export interface StudioServerOptions {
  workspaceRoot: string;
  port?: number;
  paths?: MoldeskPaths;
  env?: NodeJS.ProcessEnv;
  sessionSecret?: string;
}

export interface StudioServer {
  url: string;
  workspaceRoot: string;
  sessionSecret: string;
  server: http.Server;
  close(): Promise<void>;
}

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  host: string;
  port: number;
}

function studioError(code: string, message: string, remediation: string): MoldeskError {
  return new MoldeskError({ code, message, remediation });
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalWorkspace(workspaceRoot: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(path.resolve(workspaceRoot));
  } catch {
    throw studioError(
      "STUDIO_WORKSPACE_NOT_FOUND",
      `Studio workspace not found: ${path.resolve(workspaceRoot)}.`,
      "Pass an existing directory with --workspace.",
    );
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw studioError("STUDIO_WORKSPACE_INVALID", `Not a directory: ${resolved}.`, "Pass a directory with --workspace.");
  }
  return resolved;
}

function workspaceFile(root: string, requested: string): string {
  const target = path.isAbsolute(requested) ? requested : path.resolve(root, requested);
  let real: string;
  try {
    real = fs.realpathSync.native(target);
  } catch {
    throw studioError("STUDIO_FILE_NOT_FOUND", `Workspace file not found: ${requested}.`, "Choose a YAML file inside the workspace.");
  }
  if (!isWithin(root, real)) {
    throw studioError("STUDIO_FILE_OUTSIDE_WORKSPACE", "The requested file is outside the workspace.", "Choose a YAML file inside the workspace.");
  }
  if (!/\.ya?ml$/i.test(real)) {
    throw studioError("STUDIO_FILE_TYPE", "Only YAML workflow files can be opened.", "Choose a .yaml or .yml file.");
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw studioError("STUDIO_FILE_TYPE", `Not a regular file: ${requested}.`, "Choose a file, not a directory.");
  if (stat.size > MAX_WORKFLOW_BYTES) {
    throw studioError(
      "STUDIO_FILE_TOO_LARGE",
      `Workflow file is too large (${stat.size} bytes; limit ${MAX_WORKFLOW_BYTES}).`,
      "Reduce the workflow file size.",
    );
  }
  return real;
}

function collectWorkspaceFiles(root: string): Array<{ path: string; sizeBytes: number }> {
  const files: Array<{ path: string; sizeBytes: number }> = [];
  const ignored = new Set([".git", "node_modules", "dist", ".moldesk"]);
  const walk = (directory: string, depth: number): void => {
    if (files.length >= MAX_WORKSPACE_FILES || depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_WORKSPACE_FILES || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(absolute, depth + 1);
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        try {
          const stat = fs.statSync(absolute);
          if (stat.size <= MAX_WORKFLOW_BYTES) files.push({ path: path.relative(root, absolute), sizeBytes: stat.size });
        } catch {
          // A file can disappear during the scan; it is not part of this listing.
        }
      }
    }
  };
  walk(root, 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw studioError("STUDIO_BODY_TOO_LARGE", `Request body exceeds ${MAX_BODY_BYTES} bytes.`, "Send a smaller draft or binding set.");
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw studioError("STUDIO_BODY_INVALID", "Request body is not valid JSON.", "Send a JSON object.");
  }
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw studioError("STUDIO_BODY_INVALID", `${label} must be an object of string values.`, "Send name/value pairs as strings.");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw studioError("STUDIO_BODY_INVALID", `${label}.${key} must be a string.`, "Send name/value pairs as strings.");
    }
    result[key] = item;
  }
  return result;
}

function sourceString(body: Record<string, unknown>): string {
  if (typeof body.source !== "string") {
    throw studioError("STUDIO_BODY_INVALID", "The request must include the workflow YAML as `source`.", "Send the draft text.");
  }
  if (Buffer.byteLength(body.source, "utf8") > MAX_WORKFLOW_BYTES) {
    throw studioError("STUDIO_FILE_TOO_LARGE", `Workflow source exceeds ${MAX_WORKFLOW_BYTES} bytes.`, "Reduce the draft size.");
  }
  return body.source;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

const CONFLICT_CODES = new Set([
  "WORKFLOW_APPROVAL_USED",
  "WORKFLOW_RUN_CANCELLED",
  "WORKFLOW_OWNER_BUSY",
  "WORKFLOW_INPUT_CHANGED",
  "STUDIO_ARTIFACT_DAMAGED",
]);

function statusForError(code: string): number {
  if (/_NOT_FOUND$/.test(code)) return 404;
  if (CONFLICT_CODES.has(code)) return 409;
  if (code === "WORKFLOW_APPROVAL_REQUIRES_CONFIRMATION") return 403;
  if (code.startsWith("STUDIO_") || code === "WORKFLOW_INVALID" || code === "VALIDATION_FAILED") return 400;
  return 500;
}

function sendError(res: http.ServerResponse, error: unknown): void {
  const err = asMoldeskError(error);
  sendJson(res, statusForError(err.code), {
    status: "error",
    code: err.code,
    message: err.message,
    ...(err.remediation ? { remediation: err.remediation } : {}),
    ...(err.details ? { details: err.details } : {}),
  });
}

function pathId(raw: string, label: string, pattern: RegExp = SAFE_ID): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw studioError("STUDIO_ID_INVALID", `Invalid ${label}.`, `Use a ${label} from the run listing.`);
  }
  if (!pattern.test(decoded)) {
    throw studioError("STUDIO_ID_INVALID", `Invalid ${label}.`, `Use a ${label} from the run listing.`);
  }
  return decoded;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function hostAllowed(ctx: RequestContext): boolean {
  return ctx.host === `${LOOPBACK}:${ctx.port}`;
}

function sameOrigin(ctx: RequestContext): boolean {
  const origin = header(ctx.req, "origin");
  if (origin !== `http://${LOOPBACK}:${ctx.port}`) return false;
  const site = header(ctx.req, "sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}

function sessionAllowed(ctx: RequestContext, secret: string): boolean {
  const provided = header(ctx.req, "x-studio-session") ?? ctx.url.searchParams.get("session") ?? "";
  return safeEqual(provided, secret);
}

function isMutation(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function readLogTail(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "";
    const length = Math.min(stat.size, LOG_TAIL_BYTES);
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    return stat.size > length ? `…${text}` : text;
  } catch {
    return "";
  }
}

function childLogs(steps: Array<{ id: string; childRunId?: string }>, paths: MoldeskPaths): Record<string, unknown> {
  const logs: Record<string, unknown> = {};
  for (const step of steps) {
    if (!step.childRunId || !SAFE_ID.test(step.childRunId)) continue;
    const directory = path.join(paths.runs, step.childRunId);
    logs[step.id] = {
      childRunId: step.childRunId,
      stdout: readLogTail(path.join(directory, "stdout.log")),
      stderr: readLogTail(path.join(directory, "stderr.log")),
    };
  }
  return logs;
}

function contentTypeFor(artifact: { type: string; format: string }): string {
  if (artifact.type === "json" || artifact.format === "json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function wantedArtifact(artifacts: Awaited<ReturnType<typeof getWorkflowArtifacts>>, id: string) {
  const artifact = artifacts.find((item) => item.id === id);
  if (!artifact) {
    throw studioError("STUDIO_ARTIFACT_NOT_FOUND", `Unknown artifact "${id}" for this run.`, "Refresh the run and choose a listed artifact.");
  }
  if (!artifact.verified) {
    throw studioError("STUDIO_ARTIFACT_DAMAGED", `Artifact "${id}" is missing or its hash changed.`, "Resume or rerun the workflow and use the new artifact.");
  }
  return artifact;
}

export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const workspaceRoot = canonicalWorkspace(options.workspaceRoot);
  const paths = options.paths ?? getMoldeskPaths(options.env);
  const sessionSecret = options.sessionSecret ?? randomBytes(32).toString("hex");
  const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-studio-"));
  const eventStreams = new Set<() => void>();
  const runControllers = new Set<AbortController>();
  let port = options.port ?? 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      const host = header(req, "host") ?? "";
      const url = new URL(req.url ?? "/", `http://${host || LOOPBACK}`);
      const ctx: RequestContext = { req, res, url, host, port };
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      if (!hostAllowed(ctx)) {
        sendJson(res, 400, { status: "error", code: "STUDIO_HOST_REJECTED", message: "Invalid Host header." });
        return;
      }
      if (isMutation(req.method)) {
        if (!sameOrigin(ctx)) {
          sendJson(res, 403, { status: "error", code: "STUDIO_ORIGIN_REJECTED", message: "Mutation requires the exact Studio Origin." });
          return;
        }
        if (!sessionAllowed(ctx, sessionSecret)) {
          sendJson(res, 403, { status: "error", code: "STUDIO_SESSION_REJECTED", message: "The Studio session is missing or invalid." });
          return;
        }
      }

      const pathname = url.pathname;
      if (req.method === "GET" && pathname === "/") {
        const html = studioPage(sessionSecret);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
        });
        res.end(html);
        return;
      }

      if (!pathname.startsWith("/api/")) {
        sendJson(res, 404, { status: "error", code: "STUDIO_NOT_FOUND", message: "Not found." });
        return;
      }
      if (!sessionAllowed(ctx, sessionSecret)) {
        sendJson(res, 403, { status: "error", code: "STUDIO_SESSION_REJECTED", message: "The Studio session is missing or invalid." });
        return;
      }
      const site = header(req, "sec-fetch-site");
      if (site !== undefined && site !== "same-origin" && site !== "none") {
        sendJson(res, 403, { status: "error", code: "STUDIO_ORIGIN_REJECTED", message: "API access must be same-origin." });
        return;
      }

      if (req.method === "GET" && pathname === "/api/workspace") {
        sendJson(res, 200, { workspaceRoot, files: collectWorkspaceFiles(workspaceRoot) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/file") {
        const requested = url.searchParams.get("path");
        if (!requested) throw studioError("STUDIO_FILE_NOT_FOUND", "Missing `path` query parameter.", "Choose a workspace YAML file.");
        const file = workspaceFile(workspaceRoot, requested);
        sendJson(res, 200, { path: path.relative(workspaceRoot, file), content: fs.readFileSync(file, "utf8") });
        return;
      }

      if (req.method === "POST" && pathname === "/api/validate") {
        const body = await readBody(req);
        const record = body as Record<string, unknown>;
        const result = validateWorkflow(sourceString(record));
        const inputs = result.workflow
          ? Object.entries(result.workflow.spec.inputs).map(([name, declaration]) => ({
              name,
              type: declaration.type,
              required: declaration.required,
            }))
          : [];
        sendJson(res, 200, {
          status: "ok",
          valid: result.valid,
          order: result.steps.map((step) => step.id),
          edges: result.edges,
          diagnostics: result.diagnostics,
          inputs,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/plan") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const source = sourceString(body);
        const inputs = stringRecord(body.inputs, "inputs");
        const result = planWorkflow(source, { inputs, cwd: workspaceRoot, workspaceRoot, paths });
        if (!result.valid || !result.plan) {
          sendJson(res, 200, { status: "ok", valid: false, diagnostics: result.diagnostics });
          return;
        }
        storeWorkflowPlan(source, result.plan, { paths });
        sendJson(res, 200, { status: "ok", valid: true, plan: result.plan, diagnostics: [] });
        return;
      }

      if (req.method === "POST" && pathname === "/api/runs") {
        // Studio never creates approvals: a person approves in a terminal and pastes the receipt.
        const body = (await readBody(req)) as Record<string, unknown>;
        if (typeof body.approvalId !== "string" || !APPROVAL_ID.test(body.approvalId)) {
          throw studioError(
            "STUDIO_BODY_INVALID",
            "The request must include a valid `approvalId`.",
            "Run `moldesk workflow approve <plan-id> --json` in a terminal and paste the approvalId.",
          );
        }
        const controller = new AbortController();
        runControllers.add(controller);
        let started: ReturnType<typeof startWorkflowRun>;
        try {
          started = startWorkflowRun(body.approvalId, {
            paths,
            signal: controller.signal,
            onError: (error) => {
              console.error(`Studio workflow run stopped: ${asMoldeskError(error).message}`);
            },
          });
        } catch (error) {
          runControllers.delete(controller);
          throw error;
        }
        void started.settled.then(() => runControllers.delete(controller));
        sendJson(res, 202, { status: "ok", runId: started.runId, duplicate: started.duplicate });
        return;
      }

      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(pathname);
      if (req.method === "GET" && runMatch) {
        const runId = pathId(runMatch[1]!, "run ID");
        const status = getWorkflowStatus(runId, { paths });
        const artifacts = await getWorkflowArtifacts(runId, { paths });
        sendJson(res, 200, {
          status: "ok",
          runId: status.run.runId,
          planId: status.run.planId,
          runStatus: status.run.status,
          ...(status.run.error ? { error: status.run.error } : {}),
          runDir: status.runDir,
          steps: status.steps,
          artifacts,
          events: status.events,
          logs: childLogs(status.steps, paths),
        });
        return;
      }

      const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname);
      if (req.method === "GET" && eventsMatch) {
        const runId = pathId(eventsMatch[1]!, "run ID");
        const lastHeader = header(req, "last-event-id") ?? url.searchParams.get("lastEventId") ?? "";
        const parsed = Number.parseInt(lastHeader, 10);
        let cursor = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        let closed = false;
        let timer: NodeJS.Timeout | undefined;
        const stop = (): void => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          eventStreams.delete(stop);
          if (!res.writableEnded) res.end();
        };
        const writeEvent = (id: number | null, event: string, data: unknown): void => {
          if (closed) return;
          if (id !== null) res.write(`id: ${id}\n`);
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        eventStreams.add(stop);
        req.on("close", stop);
        res.on("close", stop);
        try {
          let snapshotSent = false;
          const tick = (): void => {
            if (closed) return;
            try {
              const status = getWorkflowStatus(runId, { paths });
              const snapshot = {
                status: "ok",
                runId: status.run.runId,
                planId: status.run.planId,
                runStatus: status.run.status,
                ...(status.run.error ? { error: status.run.error } : {}),
                runDir: status.runDir,
                steps: status.steps,
                artifacts: status.artifacts,
                events: status.events,
                logs: childLogs(status.steps, paths),
              };
              if (!snapshotSent) {
                writeEvent(null, "snapshot", snapshot);
                snapshotSent = true;
              }
              let wrote = false;
              for (const event of status.events) {
                if (event.id <= cursor) continue;
                writeEvent(event.id, "workflow", event);
                cursor = event.id;
                wrote = true;
              }
              if (wrote) writeEvent(null, "snapshot", snapshot);
              if (["succeeded", "failed", "cancelled", "interrupted"].includes(status.run.status) && !wrote) {
                writeEvent(null, "end", { runStatus: status.run.status });
                stop();
                res.end();
              }
            } catch (error) {
              writeEvent(null, "error", asMoldeskError(error));
              stop();
              res.end();
            }
          };
          tick();
          if (!closed) {
            timer = setInterval(tick, SSE_POLL_MS);
            timer.unref?.();
          }
        } catch (error) {
          stop();
          throw error;
        }
        return;
      }

      const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(pathname);
      if (req.method === "POST" && cancelMatch) {
        const runId = pathId(cancelMatch[1]!, "run ID");
        const run = cancelWorkflowRun(runId, { paths });
        sendJson(res, 200, { status: "ok", runId, runStatus: run.status, cancelRequested: true });
        return;
      }

      const resumeMatch = /^\/api\/runs\/([^/]+)\/resume$/.exec(pathname);
      if (req.method === "POST" && resumeMatch) {
        const runId = pathId(resumeMatch[1]!, "run ID");
        const controller = new AbortController();
        // Unknown, cancelled and owner-busy runs throw here, before any 202.
        const resumed = startWorkflowResume(runId, { paths, signal: controller.signal });
        runControllers.add(controller);
        resumed.done
          .catch((error: unknown) => {
            console.error(`Studio failed to resume ${runId}: ${asMoldeskError(error).message}`);
          })
          .finally(() => runControllers.delete(controller));
        sendJson(res, 202, { status: "ok", runId, resuming: true });
        return;
      }

      const previewMatch = /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)\/preview$/.exec(pathname);
      if (req.method === "GET" && previewMatch) {
        const runId = pathId(previewMatch[1]!, "run ID");
        const artifactId = pathId(previewMatch[2]!, "artifact ID", ARTIFACT_ID);
        const artifacts = await getWorkflowArtifacts(runId, { paths });
        const artifact = wantedArtifact(artifacts, artifactId);
        if (artifact.type !== "protein_structure") {
          throw studioError("STUDIO_PREVIEW_UNSUPPORTED", `Artifact "${artifactId}" is not a protein structure.`, "Download the artifact instead.");
        }
        const previewName = `${runId}-${artifactId}`.replace(/[^A-Za-z0-9._-]/g, "_");
        const previewPath = path.join(previewDir, `${previewName}.html`);
        if (!fs.existsSync(previewPath)) {
          await createStandaloneReport(artifact.path, { outputPath: previewPath });
        }
        const html = fs.readFileSync(previewPath);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": html.length,
          "content-security-policy": "sandbox allow-scripts",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(html);
        return;
      }

      const artifactMatch = /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
      if (req.method === "GET" && artifactMatch) {
        const runId = pathId(artifactMatch[1]!, "run ID");
        const artifactId = pathId(artifactMatch[2]!, "artifact ID", ARTIFACT_ID);
        const artifacts = await getWorkflowArtifacts(runId, { paths });
        const artifact = wantedArtifact(artifacts, artifactId);
        const stat = fs.statSync(artifact.path);
        const filename = `${artifact.id}.${artifact.format}`.replace(/[^A-Za-z0-9._-]/g, "_");
        res.writeHead(200, {
          "content-type": contentTypeFor(artifact),
          "content-length": stat.size,
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        fs.createReadStream(artifact.path).pipe(res);
        return;
      }

      sendJson(res, 404, { status: "error", code: "STUDIO_NOT_FOUND", message: "Not found." });
    })().catch((error: unknown) => {
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  port = address.port;
  const url = `http://${LOOPBACK}:${port}`;

  return {
    url,
    workspaceRoot,
    sessionSecret,
    server,
    async close(): Promise<void> {
      for (const stop of [...eventStreams]) stop();
      for (const controller of runControllers) controller.abort();
      runControllers.clear();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await closed;
      fs.rmSync(previewDir, { recursive: true, force: true });
    },
  };
}
