import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { getMoldeskPaths, type MoldeskPaths } from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import type { WorkflowPlan } from "./compiler.js";
import { parseWorkflowDocument } from "./schema.js";
import type { WorkflowValueType } from "./operations.js";

/**
 * Workflow journal in `<state>/workflows.sqlite`. It records durable plans, one-use
 * approvals, run/step ownership and append-only events. Scientific files live in each
 * run directory; this database is the status source of truth.
 */

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "cached"
  | "failed"
  | "cancelled"
  | "skipped";

export interface WorkflowErrorInfo {
  code: string;
  message: string;
}

export interface WorkflowRunRecord {
  runId: string;
  planId: string;
  status: WorkflowRunStatus;
  ownerId: string | null;
  ownerPid: number | null;
  ownerHost: string | null;
  cancelRequested: boolean;
  error: WorkflowErrorInfo | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface WorkflowStepOutput {
  type: WorkflowValueType;
  format?: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface WorkflowAttemptOutputs {
  outputs: Record<string, WorkflowStepOutput>;
  childRunId?: string;
  fingerprints?: Record<string, string>;
}

export interface WorkflowAttemptRecord {
  attemptId: string;
  runId: string;
  stepId: string;
  attemptNumber: number;
  status: WorkflowStepStatus;
  ownerId: string | null;
  cacheKey: string | null;
  error: WorkflowErrorInfo | null;
  outputs: WorkflowAttemptOutputs | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkflowArtifactRecord {
  id: string;
  runId: string;
  stepId: string;
  producerStepId: string;
  type: WorkflowValueType;
  format: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface WorkflowEventRecord {
  id: number;
  runId: string;
  runStatus: WorkflowRunStatus | null;
  stepId: string | null;
  attemptId: string | null;
  status: string | null;
  message: string | null;
  at: string;
}

export interface WorkflowPlanRecord {
  planId: string;
  schemaVersion: number;
  workflowSha256: string;
  source: string;
  plan: WorkflowPlan;
  cacheEnabled: boolean;
  createdAt: string;
}

export interface WorkflowApprovalRecord {
  approvalId: string;
  planId: string;
  runId: string | null;
  createdAt: string;
  consumedAt: string | null;
}

export interface WorkflowCacheFile {
  output: string;
  relativeName: string;
  type: WorkflowValueType;
  format: string;
  sha256: string;
  sizeBytes: number;
}

export interface WorkflowCacheRecord {
  cacheKey: string;
  files: WorkflowCacheFile[];
  createdAt: string;
}

export interface NewWorkflowArtifact {
  id: string;
  runId: string;
  stepId: string;
  producerStepId: string;
  type: WorkflowValueType;
  format: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface RunOwner {
  id: string;
  pid: number;
  host: string;
}

const SCHEMA_VERSION = 1;

/** Loaded lazily so a platform without a better-sqlite3 binary only breaks workflow commands. */
function loadDatabase(): typeof Database {
  return createRequire(import.meta.url)("better-sqlite3") as typeof Database;
}

function nowIso(): string {
  return new Date().toISOString();
}

type Row = Record<string, unknown>;

function toPlan(row: Row): WorkflowPlanRecord {
  return {
    planId: row["plan_id"] as string,
    schemaVersion: row["schema_version"] as number,
    workflowSha256: row["workflow_sha256"] as string,
    source: row["source_yaml"] as string,
    plan: JSON.parse(row["plan_json"] as string) as WorkflowPlan,
    cacheEnabled: row["cache_enabled"] === 1,
    createdAt: row["created_at"] as string,
  };
}

function toApproval(row: Row): WorkflowApprovalRecord {
  return {
    approvalId: row["approval_id"] as string,
    planId: row["plan_id"] as string,
    runId: (row["run_id"] as string | null) ?? null,
    createdAt: row["created_at"] as string,
    consumedAt: (row["consumed_at"] as string | null) ?? null,
  };
}

function toRun(row: Row): WorkflowRunRecord {
  return {
    runId: row["run_id"] as string,
    planId: row["plan_id"] as string,
    status: row["status"] as WorkflowRunStatus,
    ownerId: (row["owner_id"] as string | null) ?? null,
    ownerPid: (row["owner_pid"] as number | null) ?? null,
    ownerHost: (row["owner_host"] as string | null) ?? null,
    cancelRequested: row["cancel_requested"] === 1,
    error: row["error_code"]
      ? { code: row["error_code"] as string, message: row["error_message"] as string }
      : null,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    finishedAt: (row["finished_at"] as string | null) ?? null,
  };
}

function toAttempt(row: Row): WorkflowAttemptRecord {
  return {
    attemptId: row["attempt_id"] as string,
    runId: row["run_id"] as string,
    stepId: row["step_id"] as string,
    attemptNumber: row["attempt_number"] as number,
    status: row["status"] as WorkflowStepStatus,
    ownerId: (row["owner_id"] as string | null) ?? null,
    cacheKey: (row["cache_key"] as string | null) ?? null,
    error: row["error_code"]
      ? { code: row["error_code"] as string, message: row["error_message"] as string }
      : null,
    outputs: row["output_json"] ? (JSON.parse(row["output_json"] as string) as WorkflowAttemptOutputs) : null,
    startedAt: (row["started_at"] as string | null) ?? null,
    finishedAt: (row["finished_at"] as string | null) ?? null,
  };
}

function toArtifact(row: Row): WorkflowArtifactRecord {
  return {
    id: row["artifact_id"] as string,
    runId: row["run_id"] as string,
    stepId: row["step_id"] as string,
    producerStepId: row["producer_step_id"] as string,
    type: row["type"] as WorkflowValueType,
    format: row["format"] as string,
    relativePath: row["relative_path"] as string,
    sha256: row["sha256"] as string,
    sizeBytes: row["size_bytes"] as number,
    createdAt: row["created_at"] as string,
  };
}

function missing(code: string, message: string, remediation: string): MoldeskError {
  return new MoldeskError({ code, message, remediation });
}

export class WorkflowStore {
  private constructor(
    private readonly db: Database.Database,
    private readonly now: () => string,
  ) {}

  static open(paths: MoldeskPaths = getMoldeskPaths(), options: { now?: () => string } = {}): WorkflowStore {
    fs.mkdirSync(paths.state, { recursive: true });
    return WorkflowStore.openFile(path.join(paths.state, "workflows.sqlite"), options);
  }

  static openFile(file: string, options: { now?: () => string } = {}): WorkflowStore {
    const db = new (loadDatabase())(file);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    WorkflowStore.migrate(db);
    return new WorkflowStore(db, options.now ?? nowIso);
  }

  private static migrate(db: Database.Database): void {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `workflows.sqlite schema version ${version} is newer than this MoleculeDesk supports (${SCHEMA_VERSION}).`,
      );
    }
    if (version === SCHEMA_VERSION) return;
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plans (
          plan_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          workflow_sha256 TEXT NOT NULL,
          source_yaml TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          cache_enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS approvals (
          approval_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES plans(plan_id),
          run_id TEXT,
          created_at TEXT NOT NULL,
          consumed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES plans(plan_id),
          status TEXT NOT NULL,
          owner_id TEXT,
          owner_pid INTEGER,
          owner_host TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS runs_plan ON runs (plan_id);
        CREATE TABLE IF NOT EXISTS step_attempts (
          attempt_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          step_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          status TEXT NOT NULL,
          owner_id TEXT,
          cache_key TEXT,
          error_code TEXT,
          error_message TEXT,
          output_json TEXT,
          started_at TEXT,
          finished_at TEXT,
          UNIQUE(run_id, step_id, attempt_number)
        );
        CREATE TABLE IF NOT EXISTS artifacts (
          artifact_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          step_id TEXT NOT NULL,
          producer_step_id TEXT NOT NULL,
          type TEXT NOT NULL,
          format TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(run_id, step_id, type, format)
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          run_status TEXT,
          step_id TEXT,
          attempt_id TEXT,
          status TEXT,
          message TEXT,
          at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_run ON events (run_id, id);
        CREATE TABLE IF NOT EXISTS cache_entries (
          cache_key TEXT PRIMARY KEY,
          files_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  close(): void {
    this.db.close();
  }

  // --- plans and approvals ------------------------------------------------------------------

  recordPlan(source: string, plan: WorkflowPlan): WorkflowPlanRecord {
    const parsed = parseWorkflowDocument(source);
    if (!parsed.valid || !parsed.workflow) {
      throw missing("WORKFLOW_INVALID", "Cannot persist an invalid workflow plan.", "Validate the workflow first.");
    }
    this.db
      .prepare(
        `INSERT INTO plans (plan_id, schema_version, workflow_sha256, source_yaml, plan_json, cache_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_id) DO NOTHING`,
      )
      .run(
        plan.planId,
        plan.schemaVersion,
        plan.workflowSha256,
        source,
        JSON.stringify(plan),
        parsed.workflow.spec.execution.cache ? 1 : 0,
        this.now(),
      );
    const record = this.getPlan(plan.planId);
    if (!record) throw missing("WORKFLOW_PLAN_NOT_FOUND", `Plan "${plan.planId}" was not stored.`, "Retry planning.");
    return record;
  }

  getPlan(planId: string): WorkflowPlanRecord | undefined {
    const row = this.db.prepare("SELECT * FROM plans WHERE plan_id = ?").get(planId) as Row | undefined;
    return row ? toPlan(row) : undefined;
  }

  createApproval(planId: string): WorkflowApprovalRecord {
    if (!this.getPlan(planId)) {
      throw missing(
        "WORKFLOW_PLAN_NOT_FOUND",
        `Unknown workflow plan "${planId}".`,
        "Plan the workflow again and approve the new plan ID.",
      );
    }
    const approvalId = randomUUID();
    this.db
      .prepare("INSERT INTO approvals (approval_id, plan_id, created_at) VALUES (?, ?, ?)")
      .run(approvalId, planId, this.now());
    return this.getApproval(approvalId)!;
  }

  getApproval(approvalId: string): WorkflowApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  /** Atomically consumes an approval and claims one run. A second call returns the first run ID. */
  claimRun(approvalId: string, runId: string, stepIds: readonly string[]): { runId: string; created: boolean } {
    const claim = this.db.transaction((id: string, claimedRunId: string, steps: readonly string[]) => {
      const approval = this.getApproval(id);
      if (!approval) {
        throw missing(
          "WORKFLOW_APPROVAL_NOT_FOUND",
          `Unknown approval "${id}".`,
          "Approve the plan first with `moldesk workflow approve`.",
        );
      }
      if (approval.runId) return { runId: approval.runId, created: false };
      if (approval.consumedAt) {
        throw missing(
          "WORKFLOW_APPROVAL_USED",
          `Approval "${id}" was already used.`,
          "Create a new approval for another run.",
        );
      }
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO runs (run_id, plan_id, status, created_at, updated_at)
           VALUES (?, ?, 'queued', ?, ?)`,
        )
        .run(claimedRunId, approval.planId, at, at);
      const insertAttempt = this.db.prepare(
        `INSERT INTO step_attempts (attempt_id, run_id, step_id, attempt_number, status)
         VALUES (?, ?, ?, 1, 'pending')`,
      );
      for (const stepId of steps) insertAttempt.run(randomUUID(), claimedRunId, stepId);
      this.db
        .prepare("UPDATE approvals SET run_id = ?, consumed_at = ? WHERE approval_id = ?")
        .run(claimedRunId, at, id);
      this.insertEvent(claimedRunId, { runStatus: "queued", status: "queued" }, at);
      return { runId: claimedRunId, created: true };
    });
    return claim.immediate(approvalId, runId, stepIds);
  }

  // --- runs, attempts and events -------------------------------------------------------------

  getRun(runId: string): WorkflowRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Claims execution only when no live owner is running this run. */
  acquireRun(runId: string, owner: RunOwner): { acquired: boolean; run?: WorkflowRunRecord } {
    const claim = this.db.transaction((id: string, nextOwner: RunOwner) => {
      const run = this.getRun(id);
      if (!run) return { acquired: false };
      if (run.status === "succeeded" || run.status === "cancelled") return { acquired: false, run };
      if (run.status === "running" && this.isOwnerAlive(run)) return { acquired: false, run };
      const at = this.now();
      this.db
        .prepare(
          `UPDATE runs SET status = 'running', owner_id = ?, owner_pid = ?, owner_host = ?, updated_at = ?
           WHERE run_id = ?`,
        )
        .run(nextOwner.id, nextOwner.pid, nextOwner.host, at, id);
      this.insertEvent(id, { runStatus: "running", status: "running", message: "Executor claimed the run." }, at);
      return { acquired: true, run: this.getRun(id) };
    });
    return claim.immediate(runId, owner);
  }

  /** True when the recorded owner is on a different host: its liveness cannot be checked from here. */
  isOwnerOnForeignHost(run: WorkflowRunRecord): boolean {
    return Boolean(run.ownerId && run.ownerPid) && run.ownerHost !== os.hostname();
  }

  isOwnerAlive(run: WorkflowRunRecord): boolean {
    if (!run.ownerId || !run.ownerPid) return false;
    // A foreign-host owner cannot be probed; treat it as alive so it is never stolen.
    if (this.isOwnerOnForeignHost(run)) return true;
    try {
      process.kill(run.ownerPid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  markInterrupted(runId: string, message = "The previous executor is no longer running."): void {
    const interrupt = this.db.transaction((id: string, text: string) => {
      const at = this.now();
      const result = this.db
        .prepare(
          `UPDATE runs SET status = 'interrupted', owner_id = NULL, owner_pid = NULL, owner_host = NULL, updated_at = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(at, id);
      if (result.changes > 0) this.insertEvent(id, { runStatus: "interrupted", status: "interrupted", message: text }, at);
    });
    interrupt.immediate(runId, message);
  }

  /** Throws WORKFLOW_OWNER_LOST unless `runs.owner_id` is still `ownerId`. Call inside a transaction. */
  private assertOwner(runId: string, ownerId: string): void {
    const row = this.db.prepare("SELECT owner_id FROM runs WHERE run_id = ?").get(runId) as
      | { owner_id: string | null }
      | undefined;
    if (!row || row.owner_id !== ownerId) {
      throw missing(
        "WORKFLOW_OWNER_LOST",
        `This executor no longer owns workflow run "${runId}".`,
        "Another process took over the run. Use `moldesk workflow status` to follow it.",
      );
    }
  }

  finishRun(runId: string, status: WorkflowRunStatus, error?: WorkflowErrorInfo, ownerId?: string): void {
    const finish = this.db.transaction((id: string, nextStatus: WorkflowRunStatus, nextError?: WorkflowErrorInfo) => {
      if (ownerId !== undefined) this.assertOwner(id, ownerId);
      const at = this.now();
      this.db
        .prepare(
          `UPDATE runs SET status = ?, error_code = ?, error_message = ?, owner_id = NULL, owner_pid = NULL,
             owner_host = NULL, updated_at = ?, finished_at = ? WHERE run_id = ?`,
        )
        .run(nextStatus, nextError?.code ?? null, nextError?.message ?? null, at, at, id);
      this.insertEvent(id, { runStatus: nextStatus, status: nextStatus, message: nextError?.message ?? null }, at);
    });
    finish.immediate(runId, status, error);
  }

  /**
   * Requests cancellation. A run with a live owner keeps a durable request flag the owner polls.
   * A run with no live owner (queued, interrupted, failed, or running under a dead owner) goes
   * straight to `cancelled`, and its pending/running attempts are closed, in one transaction.
   */
  requestCancel(runId: string): WorkflowRunRecord {
    const cancel = this.db.transaction((id: string) => {
      const run = this.getRun(id);
      if (!run) {
        throw missing("WORKFLOW_RUN_NOT_FOUND", `Unknown workflow run "${id}".`, "Check the run ID.");
      }
      if (run.status === "succeeded" || run.status === "cancelled") return run;
      const at = this.now();
      const liveOwner = run.status === "running" && this.isOwnerAlive(run);
      if (liveOwner) {
        this.db.prepare("UPDATE runs SET cancel_requested = 1, updated_at = ? WHERE run_id = ?").run(at, id);
        this.insertEvent(id, { status: "cancel_requested", message: "Cancellation requested." }, at);
        return this.getRun(id)!;
      }
      this.insertEvent(id, { status: "cancel_requested", message: "Cancellation requested." }, at);
      const open = this.db
        .prepare("SELECT * FROM step_attempts WHERE run_id = ? AND status IN ('pending', 'running') ORDER BY rowid")
        .all(id) as Row[];
      for (const row of open) {
        const attempt = toAttempt(row);
        if (attempt.status === "pending") {
          this.db
            .prepare("UPDATE step_attempts SET status = 'skipped', finished_at = ? WHERE attempt_id = ?")
            .run(at, attempt.attemptId);
          this.insertEvent(
            id,
            { stepId: attempt.stepId, attemptId: attempt.attemptId, status: "skipped", message: "The run was cancelled." },
            at,
          );
        } else {
          this.db
            .prepare(
              `UPDATE step_attempts SET status = 'cancelled', error_code = 'WORKFLOW_RUN_CANCELLED',
                 error_message = ?, finished_at = ? WHERE attempt_id = ?`,
            )
            .run("The run was cancelled.", at, attempt.attemptId);
          this.insertEvent(
            id,
            { stepId: attempt.stepId, attemptId: attempt.attemptId, status: "cancelled", message: "The run was cancelled." },
            at,
          );
        }
      }
      this.db
        .prepare(
          `UPDATE runs SET status = 'cancelled', cancel_requested = 1, owner_id = NULL, owner_pid = NULL,
             owner_host = NULL, updated_at = ?, finished_at = ? WHERE run_id = ?`,
        )
        .run(at, at, id);
      this.insertEvent(id, { runStatus: "cancelled", status: "cancelled", message: "Cancelled while no executor was running." }, at);
      return this.getRun(id)!;
    });
    return cancel.immediate(runId);
  }

  isCancelRequested(runId: string): boolean {
    const row = this.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(runId) as
      | { cancel_requested: number }
      | undefined;
    return row?.cancel_requested === 1;
  }

  listAttempts(runId: string): WorkflowAttemptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM step_attempts WHERE run_id = ? ORDER BY rowid")
      .all(runId) as Row[];
    return rows.map(toAttempt);
  }

  latestAttempt(runId: string, stepId: string): WorkflowAttemptRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM step_attempts WHERE run_id = ? AND step_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(runId, stepId) as Row | undefined;
    return row ? toAttempt(row) : undefined;
  }

  beginAttempt(attemptId: string, owner: RunOwner): WorkflowAttemptRecord {
    const begin = this.db.transaction((id: string) => {
      const existing = this.attemptById(id);
      if (!existing) throw missing("WORKFLOW_RUN_STATE_DAMAGED", `Unknown step attempt "${id}".`, "Start a new run.");
      this.assertOwner(existing.runId, owner.id);
      const at = this.now();
      this.db
        .prepare("UPDATE step_attempts SET status = 'running', owner_id = ?, started_at = ? WHERE attempt_id = ?")
        .run(owner.id, at, id);
      this.insertEvent(existing.runId, { stepId: existing.stepId, attemptId: id, status: "running" }, at);
      return this.attemptById(id)!;
    });
    return begin.immediate(attemptId);
  }

  createAttempt(
    runId: string,
    stepId: string,
    attemptNumber: number,
    owner: RunOwner,
  ): WorkflowAttemptRecord {
    const create = this.db.transaction(() => {
      this.assertOwner(runId, owner.id);
      const attemptId = randomUUID();
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO step_attempts (attempt_id, run_id, step_id, attempt_number, status, owner_id, started_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(attemptId, runId, stepId, attemptNumber, owner.id, at);
      this.insertEvent(runId, { stepId, attemptId, status: "running" }, at);
      return this.attemptById(attemptId)!;
    });
    return create.immediate();
  }

  /**
   * Writes an attempt's terminal status, its event and (for succeeded/cached) its artifact rows in
   * one transaction, so an attempt that never reached this call has no visible artifacts. If a
   * cancellation was requested before the transaction, the attempt becomes `cancelled` and
   * publishes nothing.
   */
  finishAttempt(
    attemptId: string,
    status: WorkflowStepStatus,
    options: {
      outputs?: WorkflowAttemptOutputs;
      error?: WorkflowErrorInfo;
      cacheKey?: string;
      artifacts?: NewWorkflowArtifact[];
      ownerId?: string;
    } = {},
  ): WorkflowAttemptRecord {
    const finish = this.db.transaction((id: string) => {
      const existing = this.attemptById(id);
      if (!existing) throw missing("WORKFLOW_RUN_STATE_DAMAGED", `Unknown step attempt "${id}".`, "Start a new run.");
      if (options.ownerId !== undefined) this.assertOwner(existing.runId, options.ownerId);
      let nextStatus = status;
      let nextOutputs = options.outputs;
      let nextError = options.error;
      let artifacts = options.artifacts ?? [];
      if ((nextStatus === "succeeded" || nextStatus === "cached") && this.isCancelRequested(existing.runId)) {
        nextStatus = "cancelled";
        nextOutputs = undefined;
        artifacts = [];
        nextError = {
          code: "WORKFLOW_RUN_CANCELLED",
          message: "The run was cancelled before outputs were published.",
        };
      }
      if (nextStatus !== "succeeded" && nextStatus !== "cached") artifacts = [];
      const at = this.now();
      this.db
        .prepare(
          `UPDATE step_attempts SET status = ?, error_code = ?, error_message = ?, output_json = ?,
             cache_key = COALESCE(?, cache_key), finished_at = ? WHERE attempt_id = ?`,
        )
        .run(
          nextStatus,
          nextError?.code ?? null,
          nextError?.message ?? null,
          nextOutputs ? JSON.stringify(nextOutputs) : null,
          options.cacheKey ?? null,
          at,
          id,
        );
      for (const artifact of artifacts) this.insertArtifact(artifact, at);
      const attempt = this.attemptById(id)!;
      this.insertEvent(
        attempt.runId,
        { stepId: attempt.stepId, attemptId: id, status: nextStatus, message: nextError?.message ?? null },
        at,
      );
      return attempt;
    });
    return finish.immediate(attemptId);
  }

  skipStep(runId: string, stepId: string, message: string, ownerId?: string): void {
    const skip = this.db.transaction(() => {
      if (ownerId !== undefined) this.assertOwner(runId, ownerId);
      const at = this.now();
      const latest = this.latestAttempt(runId, stepId);
      if (latest && (latest.status === "pending" || latest.status === "running")) {
        this.db
          .prepare("UPDATE step_attempts SET status = 'skipped', finished_at = ? WHERE attempt_id = ?")
          .run(at, latest.attemptId);
        this.insertEvent(runId, { stepId, attemptId: latest.attemptId, status: "skipped", message }, at);
      } else {
        this.insertEvent(runId, { stepId, status: "skipped", message }, at);
      }
    });
    skip.immediate();
  }

  listEvents(runId: string): WorkflowEventRecord[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id").all(runId) as Row[];
    return rows.map((row) => ({
      id: row["id"] as number,
      runId: row["run_id"] as string,
      runStatus: (row["run_status"] as WorkflowRunStatus | null) ?? null,
      stepId: (row["step_id"] as string | null) ?? null,
      attemptId: (row["attempt_id"] as string | null) ?? null,
      status: (row["status"] as string | null) ?? null,
      message: (row["message"] as string | null) ?? null,
      at: row["at"] as string,
    }));
  }

  private attemptById(attemptId: string): WorkflowAttemptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM step_attempts WHERE attempt_id = ?").get(attemptId) as Row | undefined;
    return row ? toAttempt(row) : undefined;
  }

  private insertEvent(
    runId: string,
    event: { runStatus?: WorkflowRunStatus; stepId?: string; attemptId?: string; status?: string; message?: string | null },
    at = this.now(),
  ): void {
    this.db
      .prepare(
        "INSERT INTO events (run_id, run_status, step_id, attempt_id, status, message, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        event.runStatus ?? null,
        event.stepId ?? null,
        event.attemptId ?? null,
        event.status ?? null,
        event.message ?? null,
        at,
      );
  }

  // --- artifacts and cache -------------------------------------------------------------------

  /** Inserts an artifact row. Only called from inside a `finishAttempt` transaction. */
  private insertArtifact(artifact: NewWorkflowArtifact, at: string): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, run_id, step_id, producer_step_id, type, format, relative_path, sha256, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_id, type, format) DO UPDATE SET
           artifact_id = excluded.artifact_id, producer_step_id = excluded.producer_step_id,
           relative_path = excluded.relative_path, sha256 = excluded.sha256,
           size_bytes = excluded.size_bytes, created_at = excluded.created_at`,
      )
      .run(
        artifact.id,
        artifact.runId,
        artifact.stepId,
        artifact.producerStepId,
        artifact.type,
        artifact.format,
        artifact.relativePath,
        artifact.sha256,
        artifact.sizeBytes,
        at,
      );
  }

  listArtifacts(runId: string): WorkflowArtifactRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY rowid")
      .all(runId) as Row[];
    return rows.map(toArtifact);
  }

  getCache(cacheKey: string): WorkflowCacheRecord | undefined {
    const row = this.db.prepare("SELECT * FROM cache_entries WHERE cache_key = ?").get(cacheKey) as Row | undefined;
    if (!row) return undefined;
    return {
      cacheKey: row["cache_key"] as string,
      files: JSON.parse(row["files_json"] as string) as WorkflowCacheFile[],
      createdAt: row["created_at"] as string,
    };
  }

  putCache(cacheKey: string, files: WorkflowCacheFile[]): void {
    this.db
      .prepare(
        `INSERT INTO cache_entries (cache_key, files_json, created_at) VALUES (?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET files_json = excluded.files_json, created_at = excluded.created_at`,
      )
      .run(cacheKey, JSON.stringify(files), this.now());
  }
}

/** Persists a validated plan so its ID can be approved and executed later. */
export function storeWorkflowPlan(
  source: string,
  plan: WorkflowPlan,
  options: { paths?: MoldeskPaths } = {},
): WorkflowPlanRecord {
  const store = WorkflowStore.open(options.paths ?? getMoldeskPaths());
  try {
    return store.recordPlan(source, plan);
  } finally {
    store.close();
  }
}

export function getWorkflowPlan(
  planId: string,
  options: { paths?: MoldeskPaths } = {},
): WorkflowPlanRecord | undefined {
  const store = WorkflowStore.open(options.paths ?? getMoldeskPaths());
  try {
    return store.getPlan(planId);
  } finally {
    store.close();
  }
}

export function createWorkflowApproval(
  planId: string,
  options: { paths?: MoldeskPaths } = {},
): WorkflowApprovalRecord {
  const store = WorkflowStore.open(options.paths ?? getMoldeskPaths());
  try {
    return store.createApproval(planId);
  } finally {
    store.close();
  }
}
