import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMoldeskPaths } from "@moldesk/runtime";
import { planWorkflow } from "./compiler.js";
import { WorkflowStore } from "./store.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EXAMPLES = path.join(REPO_ROOT, "examples/workflows");
const FIXTURE = path.join(REPO_ROOT, "packages/visualizer/test/fixtures/1CRN.pdb");

const temporaries: string[] = [];

function tempPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-workflow-store-"));
  temporaries.push(home);
  return getMoldeskPaths({ MOLDESK_HOME: home });
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function examplePlan(paths: ReturnType<typeof tempPaths>) {
  const source = fs.readFileSync(path.join(EXAMPLES, "structure-analysis.yaml"), "utf8");
  const result = planWorkflow(source, { inputs: { structure: FIXTURE }, paths });
  expect(result.valid, JSON.stringify(result.diagnostics)).toBe(true);
  return { source, plan: result.plan! };
}

describe("WorkflowStore", () => {
  it("persists plans, consumes one approval exactly once and appends ordered events", () => {
    const paths = tempPaths();
    const { source, plan } = examplePlan(paths);
    const approvalId = (() => {
      const store = WorkflowStore.open(paths);
      try {
        const stored = store.recordPlan(source, plan);
        expect(stored.planId).toBe(plan.planId);
        expect(stored.cacheEnabled).toBe(true);
        expect(store.recordPlan(source, plan).planId).toBe(plan.planId);

        const approval = store.createApproval(plan.planId);
        expect(store.getApproval(approval.approvalId)?.consumedAt).toBeNull();

        const first = store.claimRun(approval.approvalId, "2026-01-01T00-00-00-000Z-run", ["import", "analyze"]);
        expect(first).toEqual({ runId: "2026-01-01T00-00-00-000Z-run", created: true });
        const second = store.claimRun(approval.approvalId, "2026-01-01T00-00-00-000Z-other", ["import", "analyze"]);
        expect(second).toEqual({ runId: first.runId, created: false });

        expect(store.getRun(first.runId)?.status).toBe("queued");
        expect(store.listAttempts(first.runId).map((attempt) => attempt.status)).toEqual(["pending", "pending"]);
        expect(store.listEvents(first.runId).map((event) => event.status)).toEqual(["queued"]);

        // No executor owns a queued run, so cancellation is immediate and closes pending attempts.
        expect(store.requestCancel(first.runId).status).toBe("cancelled");
        expect(store.isCancelRequested(first.runId)).toBe(true);
        expect(store.listAttempts(first.runId).map((attempt) => attempt.status)).toEqual(["skipped", "skipped"]);
        expect(store.listEvents(first.runId).map((event) => event.status)).toEqual([
          "queued",
          "cancel_requested",
          "skipped",
          "skipped",
          "cancelled",
        ]);
        return approval.approvalId;
      } finally {
        store.close();
      }
    })();

    const reopened = WorkflowStore.open(paths);
    try {
      expect(reopened.getPlan(plan.planId)?.workflowSha256).toBe(plan.workflowSha256);
      expect(reopened.getApproval(approvalId)?.runId).toBe("2026-01-01T00-00-00-000Z-run");
    } finally {
      reopened.close();
    }
  });

  describe("transactions and ownership", () => {
    const live = () => ({ id: "owner-a", pid: process.pid, host: os.hostname() });

    function queuedRun(paths: ReturnType<typeof tempPaths>) {
      const { source, plan } = examplePlan(paths);
      const store = WorkflowStore.open(paths);
      store.recordPlan(source, plan);
      const approval = store.createApproval(plan.planId);
      const { runId } = store.claimRun(approval.approvalId, "run-1", ["import", "analyze"]);
      return { store, runId };
    }

    const artifact = (runId: string) => ({
      id: `${runId}:import:structure`,
      runId,
      stepId: "import",
      producerStepId: "import",
      type: "protein_structure" as const,
      format: "pdb",
      relativePath: "steps/import/attempt-1/structure.pdb",
      sha256: "a".repeat(64),
      sizeBytes: 1,
    });

    it("keeps a durable request flag for a running run with a live owner", () => {
      const { store, runId } = queuedRun(tempPaths());
      try {
        store.acquireRun(runId, live());
        const run = store.requestCancel(runId);
        expect(run).toMatchObject({ status: "running", cancelRequested: true, ownerId: "owner-a" });
        expect(store.listEvents(runId).at(-1)?.status).toBe("cancel_requested");
      } finally {
        store.close();
      }
    });

    it("cancels an interrupted or dead-owner run directly and closes its open attempts", () => {
      const { store, runId } = queuedRun(tempPaths());
      try {
        const owner = { id: "dead", pid: 2147483646, host: os.hostname() };
        store.acquireRun(runId, owner);
        const attempt = store.beginAttempt(store.latestAttempt(runId, "import")!.attemptId, owner);
        expect(store.isOwnerAlive(store.getRun(runId)!)).toBe(false);

        expect(store.requestCancel(runId)).toMatchObject({ status: "cancelled", ownerId: null });
        expect(store.listAttempts(runId).map((item) => [item.stepId, item.status])).toEqual([
          ["import", "cancelled"],
          ["analyze", "skipped"],
        ]);
        expect(store.listAttempts(runId)[0]!.attemptId).toBe(attempt.attemptId);
      } finally {
        store.close();
      }
    });

    it("never steals an owner on another host", () => {
      const { store, runId } = queuedRun(tempPaths());
      try {
        store.acquireRun(runId, { id: "remote", pid: 1, host: "another-host.invalid" });
        const run = store.getRun(runId)!;
        expect(store.isOwnerAlive(run)).toBe(true);
        expect(store.isOwnerOnForeignHost(run)).toBe(true);
        expect(store.acquireRun(runId, live()).acquired).toBe(false);
        expect(store.requestCancel(runId).status).toBe("running");
      } finally {
        store.close();
      }
    });

    it("records an interrupted event only when the update changed a row", () => {
      const { store, runId } = queuedRun(tempPaths());
      try {
        const before = store.listEvents(runId).length;
        store.markInterrupted(runId);
        expect(store.listEvents(runId)).toHaveLength(before);
        expect(store.getRun(runId)?.status).toBe("queued");

        store.acquireRun(runId, live());
        store.markInterrupted(runId);
        store.markInterrupted(runId);
        expect(store.listEvents(runId).filter((event) => event.status === "interrupted")).toHaveLength(1);
      } finally {
        store.close();
      }
    });

    it("rejects executor writes from an owner that no longer holds the run", () => {
      const { store, runId } = queuedRun(tempPaths());
      try {
        const owner = live();
        store.acquireRun(runId, owner);
        const pending = store.latestAttempt(runId, "import")!;
        const stranger = { ...owner, id: "stranger" };
        const events = store.listEvents(runId).length;

        expect(() => store.beginAttempt(pending.attemptId, stranger)).toThrow(/no longer owns/);
        expect(() => store.createAttempt(runId, "import", 2, stranger)).toThrow(/no longer owns/);
        expect(() => store.finishAttempt(pending.attemptId, "succeeded", { artifacts: [artifact(runId)], ownerId: "stranger" })).toThrow(
          expect.objectContaining({ code: "WORKFLOW_OWNER_LOST" }),
        );
        expect(() => store.finishRun(runId, "failed", undefined, "stranger")).toThrow(expect.objectContaining({ code: "WORKFLOW_OWNER_LOST" }));
        expect(() => store.skipStep(runId, "analyze", "x", "stranger")).toThrow(/no longer owns/);

        expect(store.getRun(runId)?.status).toBe("running");
        expect(store.latestAttempt(runId, "import")?.status).toBe("pending");
        expect(store.listArtifacts(runId)).toEqual([]);
        expect(store.listEvents(runId)).toHaveLength(events);
      } finally {
        store.close();
      }
    });

    it("commits the terminal status, event and artifacts together", () => {
      const { store, runId } = queuedRun(tempPaths());
      try {
        const owner = live();
        store.acquireRun(runId, owner);
        const attempt = store.beginAttempt(store.latestAttempt(runId, "import")!.attemptId, owner);
        expect(store.listArtifacts(runId)).toEqual([]);

        store.finishAttempt(attempt.attemptId, "succeeded", { artifacts: [artifact(runId)], ownerId: owner.id });
        expect(store.listArtifacts(runId).map((item) => item.id)).toEqual([`${runId}:import:structure`]);
        expect(store.listEvents(runId).at(-1)).toMatchObject({ attemptId: attempt.attemptId, status: "succeeded" });
      } finally {
        store.close();
      }
    });

    it("turns a success into a cancellation, publishing no artifact, when cancel was requested first", () => {
      const { store, runId } = queuedRun(tempPaths());
      try {
        const owner = live();
        store.acquireRun(runId, owner);
        const attempt = store.beginAttempt(store.latestAttempt(runId, "import")!.attemptId, owner);
        store.requestCancel(runId);

        const finished = store.finishAttempt(attempt.attemptId, "succeeded", {
          outputs: { outputs: {} },
          artifacts: [artifact(runId)],
          ownerId: owner.id,
        });
        expect(finished).toMatchObject({ status: "cancelled", outputs: null, error: { code: "WORKFLOW_RUN_CANCELLED" } });
        expect(store.listArtifacts(runId)).toEqual([]);
      } finally {
        store.close();
      }
    });
  });
});
