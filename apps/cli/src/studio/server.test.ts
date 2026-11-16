import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorkflowStore,
  approveWorkflowPlan,
  getMoldeskPaths,
  getWorkflowStatus,
  submitWorkflowRun,
} from "@moldesk/core";
import { startStudioServer, type StudioServer } from "./server.js";

const example = fileURLToPath(new URL("../../../../examples/workflows/structure-analysis.yaml", import.meta.url));
const fixture = fileURLToPath(new URL("../../../../packages/visualizer/test/fixtures/1CRN.pdb", import.meta.url));

let studio: StudioServer;
let temporary: string;
let workflowSource: string;
let paths: ReturnType<typeof getMoldeskPaths>;
const TERMINAL = ["succeeded", "failed", "cancelled", "interrupted"];

async function call(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-studio-session", studio.sessionSecret);
  if (init.method === "POST") {
    headers.set("origin", studio.url);
    headers.set("content-type", "application/json");
  }
  return fetch(`${studio.url}${pathname}`, { ...init, headers });
}

async function json<T = any>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await call(pathname, init);
  const body = (await response.json()) as T;
  expect(response.ok).toBe(true);
  return body;
}

/** Plans through the Studio API, then approves the way a terminal would (core policy, test confirmer). */
async function plannedAndApproved(): Promise<{ planId: string; approvalId: string }> {
  const planned = await json<{ plan: { planId: string } }>("/api/plan", {
    method: "POST",
    body: JSON.stringify({ source: workflowSource, inputs: { structure: "1CRN.pdb" } }),
  });
  const { approval } = await approveWorkflowPlan(planned.plan.planId, { paths, confirm: () => true });
  return { planId: planned.plan.planId, approvalId: approval.approvalId };
}

/** An approved run that has been submitted but not started, so tests control its lifecycle. */
async function submittedRun(): Promise<string> {
  const { approvalId } = await plannedAndApproved();
  return submitWorkflowRun(approvalId, { paths }).runId;
}

async function waitTerminal(runId: string): Promise<any> {
  let snapshot: any;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    snapshot = await json(`/api/runs/${runId}`);
    if (TERMINAL.includes(snapshot.runStatus)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return snapshot;
}

function parseSse(text: string): Array<{ id?: number; event: string; data: any }> {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const fields: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const index = line.indexOf(": ");
        if (index > 0) fields[line.slice(0, index)] = line.slice(index + 2);
      }
      return {
        ...(fields["id"] ? { id: Number(fields["id"]) } : {}),
        event: fields["event"] ?? "message",
        data: JSON.parse(fields["data"] ?? "null"),
      };
    });
}

function rawGet(pathname: string, headers: Record<string, string>): Promise<number> {
  const port = Number(new URL(studio.url).port);
  return new Promise<number>((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: pathname, headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
  });
}

beforeAll(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-studio-test-"));
  const workspace = path.join(temporary, "workspace");
  fs.mkdirSync(workspace);
  fs.copyFileSync(example, path.join(workspace, "structure-analysis.yaml"));
  fs.copyFileSync(fixture, path.join(workspace, "1CRN.pdb"));
  workflowSource = fs.readFileSync(example, "utf8");
  paths = getMoldeskPaths({ MOLDESK_HOME: path.join(temporary, "home") });
  studio = await startStudioServer({
    workspaceRoot: workspace,
    paths,
  });
});

afterAll(async () => {
  await studio?.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe("Studio server", () => {
  it("serves the page and lists workspace YAML", async () => {
    const page = await fetch(studio.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("MoleDesk Studio");

    const workspace = await json<{ files: Array<{ path: string }> }>("/api/workspace");
    expect(workspace.files.map((file) => file.path)).toContain("structure-analysis.yaml");
  });

  it("rejects API reads without the session and mutations from another origin", async () => {
    const unauthenticated = await fetch(`${studio.url}/api/workspace`);
    expect(unauthenticated.status).toBe(403);

    const crossOrigin = await fetch(`${studio.url}/api/plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studio-session": studio.sessionSecret,
        origin: "http://evil.example",
      },
      body: JSON.stringify({ source: workflowSource, inputs: { structure: "1CRN.pdb" } }),
    });
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json()) as { code: string }).toMatchObject({ code: "STUDIO_ORIGIN_REJECTED" });
  });

  it("rejects an invalid Host header", async () => {
    const port = Number(new URL(studio.url).port);
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.get(
        { hostname: "127.0.0.1", port, path: "/api/workspace", headers: { host: "evil.example", "x-studio-session": studio.sessionSecret } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
    });
    expect(status).toBe(400);
  });

  it("refuses to read a YAML file outside the workspace", async () => {
    const outside = path.join(temporary, "outside.yaml");
    fs.writeFileSync(outside, "apiVersion: moldesk.ai/v1alpha1\n");
    const response = await call(`/api/file?path=${encodeURIComponent(outside)}`);
    expect(response.status).toBe(400);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "STUDIO_FILE_OUTSIDE_WORKSPACE" });
  });

  it("validates and plans, then runs the CPU workflow and serves verified artifacts", async () => {
    const validation = await json<{ valid: boolean; inputs: Array<{ name: string }> }>("/api/validate", {
      method: "POST",
      body: JSON.stringify({ source: workflowSource }),
    });
    expect(validation.valid).toBe(true);
    expect(validation.inputs.map((input) => input.name)).toEqual(["structure"]);

    const planned = await json<{ valid: boolean; plan: { planId: string; steps: Array<{ id: string }> } }>("/api/plan", {
      method: "POST",
      body: JSON.stringify({ source: workflowSource, inputs: { structure: "1CRN.pdb" } }),
    });
    expect(planned.valid).toBe(true);
    expect(planned.plan.steps.map((step) => step.id)).toEqual(["import", "analyze"]);

    const { approval } = await approveWorkflowPlan(planned.plan.planId, { paths, confirm: () => true });
    const started = await json<{ runId: string; duplicate: boolean }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ approvalId: approval.approvalId }),
    });
    expect(started.duplicate).toBe(false);

    const snapshot = await waitTerminal(started.runId);
    expect(snapshot.runStatus).toBe("succeeded");
    expect(snapshot.steps.map((step: { status: string }) => step.status)).toEqual(["succeeded", "succeeded"]);
    expect(snapshot.artifacts).toHaveLength(2);
    expect(snapshot.artifacts.every((artifact: { verified: boolean }) => artifact.verified)).toBe(true);

    const report = snapshot.artifacts.find((artifact: { type: string }) => artifact.type === "json");
    const download = await call(`/api/runs/${started.runId}/artifacts/${report.id}`);
    expect(download.status).toBe(200);
    const envelope = (await download.json()) as { kind: string };
    expect(envelope.kind).toBe("moldesk.analysis");

    const events = await call(`/api/runs/${started.runId}/events`, { headers: { "last-event-id": "0" } });
    const stream = await events.text();
    expect(stream).toContain("event: workflow");
    expect(stream).toContain("event: end");

    // The same approval cannot start a second run.
    const again = await json<{ runId: string; duplicate: boolean }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ approvalId: approval.approvalId }),
    });
    expect(again).toMatchObject({ runId: started.runId, duplicate: true });
  }, 20_000);
});

describe("Studio server hardening", () => {
  it("listens on 127.0.0.1 only", () => {
    const address = studio.server.address() as { address: string };
    expect(address.address).toBe("127.0.0.1");
    expect(studio.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("rejects a localhost Host and a localhost Origin", async () => {
    const port = Number(new URL(studio.url).port);
    expect(await rawGet("/api/workspace", { host: `localhost:${port}`, "x-studio-session": studio.sessionSecret })).toBe(400);
    const response = await fetch(`${studio.url}/api/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studio-session": studio.sessionSecret,
        origin: `http://localhost:${port}`,
      },
      body: JSON.stringify({ source: workflowSource }),
    });
    expect(response.status).toBe(403);
  });

  it("requires the session on the event stream and artifact routes", async () => {
    for (const route of [
      "/api/runs/some-run/events",
      "/api/runs/some-run/artifacts/some-artifact",
      "/api/runs/some-run/artifacts/some-artifact/preview",
    ]) {
      const response = await fetch(`${studio.url}${route}`);
      expect(response.status, route).toBe(403);
      expect(await response.json()).toMatchObject({ code: "STUDIO_SESSION_REJECTED" });
    }
  });

  it("never creates approvals: a planId alone, a bad ID or a forged approvalId is refused", async () => {
    const { planId, approvalId } = await plannedAndApproved();
    const post = (body: unknown) => call("/api/runs", { method: "POST", body: JSON.stringify(body) });

    const planOnly = await post({ planId });
    expect(planOnly.status).toBe(400);
    expect(await planOnly.json()).toMatchObject({ code: "STUDIO_BODY_INVALID" });

    expect((await post({ approvalId: planId.slice(0, 4) })).status).toBe(400);
    expect((await post({ approvalId: 7 })).status).toBe(400);

    const forged = await post({ approvalId: "00000000-0000-4000-8000-000000000000" });
    expect(forged.status).toBe(404);
    expect(await forged.json()).toMatchObject({ code: "WORKFLOW_APPROVAL_NOT_FOUND" });

    // The planId route cannot have produced any approval or run.
    const store = WorkflowStore.open(paths);
    try {
      expect(store.getApproval(approvalId)?.consumedAt).toBeNull();
    } finally {
      store.close();
    }
  });

  it("rejects unsafe run and artifact IDs before touching core", async () => {
    expect((await call("/api/runs/..%2F..%2Fetc")).status).toBe(400);
    expect((await call("/api/runs/..%2Fx/artifacts/y")).status).toBe(400);
    expect((await call("/api/runs/2026-01-01T00-00-00-000Z-x/artifacts/..%2Fsecret")).status).toBe(400);
    expect((await call("/api/runs/2026-01-01T00-00-00-000Z-x/artifacts/..%2Fsecret/preview")).status).toBe(400);
    expect((await call("/api/runs/..%2Fx/resume", { method: "POST", body: "{}" })).status).toBe(400);
  });

  it("serves no innerHTML-style sinks in the page", async () => {
    const page = await (await fetch(studio.url)).text();
    expect(page).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(page).toContain("moldesk workflow approve");
  });

  it("replays only newer events on reconnect, each once, followed by a snapshot", async () => {
    const { approvalId } = await plannedAndApproved();
    const started = await json<{ runId: string }>("/api/runs", { method: "POST", body: JSON.stringify({ approvalId }) });
    await waitTerminal(started.runId);

    const full = parseSse(await (await call(`/api/runs/${started.runId}/events`)).text());
    const ids = full.filter((item) => item.event === "workflow").map((item) => item.id!);
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
    expect(full[0]!.event).toBe("snapshot");

    const cursor = ids[Math.floor(ids.length / 2)]!;
    const resumed = parseSse(
      await (await call(`/api/runs/${started.runId}/events`, { headers: { "last-event-id": String(cursor) } })).text(),
    );
    const replayed = resumed.filter((item) => item.event === "workflow").map((item) => item.id!);
    expect(replayed).toEqual(ids.filter((id) => id > cursor));
    expect(resumed[0]!.event).toBe("snapshot");
    expect(resumed.some((item) => item.event === "snapshot" && item.data.runId === started.runId)).toBe(true);
    expect(resumed[resumed.length - 1]!.event).toBe("end");
  }, 20_000);

  it("cancels a queued run and refuses to resume a cancelled run", async () => {
    const runId = await submittedRun();
    const cancelled = await json<{ cancelRequested: boolean }>(`/api/runs/${runId}/cancel`, { method: "POST", body: "{}" });
    expect(cancelled.cancelRequested).toBe(true);
    expect(getWorkflowStatus(runId, { paths }).run.status).toBe("cancelled");

    const resume = await call(`/api/runs/${runId}/resume`, { method: "POST", body: "{}" });
    expect(resume.status).toBe(409);
    expect(await resume.json()).toMatchObject({ code: "WORKFLOW_RUN_CANCELLED" });
    expect(getWorkflowStatus(runId, { paths }).run.status).toBe("cancelled");
  });

  it("resumes an interrupted run and returns 404 for an unknown run", async () => {
    const runId = await submittedRun();
    const store = WorkflowStore.open(paths);
    try {
      store.acquireRun(runId, { id: "dead-owner", pid: 2147483646, host: os.hostname() });
    } finally {
      store.close();
    }
    expect(getWorkflowStatus(runId, { paths }).run.status).toBe("running");

    const resume = await call(`/api/runs/${runId}/resume`, { method: "POST", body: "{}" });
    expect(resume.status).toBe(202);
    const snapshot = await waitTerminal(runId);
    expect(snapshot.runStatus).toBe("succeeded");
    expect(getWorkflowStatus(runId, { paths }).run.status).toBe("succeeded");

    const unknown = await call("/api/runs/2026-01-01T00-00-00-000Z-nope/resume", { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND" });
  }, 20_000);

  it("returns 409 when a live owner is still running the run", async () => {
    const runId = await submittedRun();
    const store = WorkflowStore.open(paths);
    try {
      store.acquireRun(runId, { id: "live-owner", pid: process.pid, host: os.hostname() });
    } finally {
      store.close();
    }
    const resume = await call(`/api/runs/${runId}/resume`, { method: "POST", body: "{}" });
    expect(resume.status).toBe(409);
    expect(await resume.json()).toMatchObject({ code: "WORKFLOW_OWNER_BUSY" });
  });

  it("previews structures offline under a sandbox CSP and rejects other artifacts", async () => {
    const { approvalId } = await plannedAndApproved();
    const started = await json<{ runId: string }>("/api/runs", { method: "POST", body: JSON.stringify({ approvalId }) });
    const snapshot = await waitTerminal(started.runId);
    const structure = snapshot.artifacts.find((artifact: { type: string }) => artifact.type === "protein_structure");
    const report = snapshot.artifacts.find((artifact: { type: string }) => artifact.type === "json");

    const preview = await call(`/api/runs/${started.runId}/artifacts/${structure.id}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toContain("text/html");
    const csp = preview.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox");
    expect(csp).toContain("allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(await preview.text()).toMatch(/<html/i);

    const unsupported = await call(`/api/runs/${started.runId}/artifacts/${report.id}/preview`);
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ code: "STUDIO_PREVIEW_UNSUPPORTED" });

    const unknown = await call(`/api/runs/${started.runId}/artifacts/does-not-exist/preview`);
    expect(unknown.status).toBe(404);
  }, 30_000);
});
