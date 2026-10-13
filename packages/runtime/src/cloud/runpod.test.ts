import { describe, expect, it } from "vitest";
import { RunpodProvider, RUNPOD_USER_AGENT } from "./runpod.js";

const SECRET = "rpa_TESTSECRET0123456789";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

function setup(responses: Array<Response | Error | ((call: Call) => Response)>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  }) as unknown as typeof fetch;
  const provider = new RunpodProvider({
    getApiKey: async () => SECRET,
    fetch: fakeFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date("2026-10-13T12:00:00Z"),
  });
  return { provider, calls, sleeps };
}

const podBody = { id: "pod1", name: "n", status: "RUNNING", dataCenterId: "EU-RO-1", cost: 0.57, createdAt: "2026-10-13T11:55:45Z" };

describe("RunpodProvider", () => {
  it("sends bearer auth and an explicit User-Agent, and validates credentials read-only", async () => {
    const { provider, calls } = setup([json(200, { pods: [] })]);
    expect(await provider.validateCredentials()).toEqual({ ok: true, checkedAt: "2026-10-13T12:00:00.000Z" });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.runpod.io/v2/pods");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(calls[0]!.headers["User-Agent"]).toBe(RUNPOD_USER_AGENT);
  });

  it("normalizes the catalog", async () => {
    const { provider } = setup([
      json(200, {
        gpus: [
          {
            id: "NVIDIA A40",
            name: "A40",
            memory: 48,
            price: { secure: 0.59 },
            availability: "LOW",
            dataCenters: [{ id: "EU-SE-1", availability: "LOW" }],
            cudaVersions: [{ version: "12.8", available: true }, { version: "13.0", available: false }],
          },
        ],
      }),
      json(200, { cpus: [{ id: "cpu3c", name: "Compute", price: { securePerVcpu: 0.03 }, ramGbPerVcpu: 2, vcpu: { min: 2, max: 32 } }] }),
      json(200, { dataCenters: [{ id: "AP-JP-1", region: "ASIA", networkVolumeTypes: ["STANDARD"] }, { id: "X", region: "R" }] }),
    ]);
    const catalog = await provider.getCatalog();
    expect(catalog.gpus[0]).toMatchObject({ id: "NVIDIA A40", memoryGb: 48, priceUsdPerHour: 0.59, availability: "LOW", cudaVersions: ["12.8"] });
    expect(catalog.cpus[0]).toMatchObject({ id: "cpu3c", priceUsdPerVcpuHour: 0.03, minVcpu: 2, maxVcpu: 32 });
    expect(catalog.dataCenters.map((dc) => [dc.id, dc.networkVolumeTypes])).toEqual([["AP-JP-1", ["STANDARD"]], ["X", []]]);
  });

  it("creates a GPU pod with a volume mount using the verified request shape", async () => {
    const { provider, calls } = setup([json(201, podBody)]);
    const pod = await provider.createPod({
      name: "moldesk-run1-gpu",
      image: "img",
      containerDiskGb: 20,
      dataCenterId: "EU-RO-1",
      gpu: { id: "NVIDIA A40", count: 1 },
      volume: { id: "vol1", mountPath: "/workspace" },
      ports: ["8000/http"],
      entrypoint: ["/bin/bash", "-c"],
      cmd: ["run"],
    });
    expect(pod).toMatchObject({ id: "pod1", status: "RUNNING", costUsdPerHour: 0.57 });
    expect(calls[0]!.body).toEqual({
      name: "moldesk-run1-gpu",
      image: "img",
      disk: 20,
      dataCenterIds: ["EU-RO-1"],
      gpu: { id: "NVIDIA A40", count: 1 },
      mounts: { network: [{ volumeId: "vol1", path: "/workspace" }] },
      ports: ["8000/http"],
      args: JSON.stringify({ entrypoint: ["/bin/bash", "-c"], cmd: ["run"] }),
    });
  });

  it("rejects a pod request that is neither or both of gpu and cpu before any request", async () => {
    const { provider, calls } = setup([]);
    await expect(provider.createPod({ name: "n", image: "i", containerDiskGb: 1, dataCenterId: "d" })).rejects.toMatchObject({ code: "CLOUD_REQUEST_REJECTED" });
    expect(calls).toHaveLength(0);
  });

  it("maps capacity failure to CLOUD_CAPACITY_UNAVAILABLE without retrying a create", async () => {
    const { provider, calls } = setup([json(400, { detail: "There are no longer any instances available with the requested specifications.", status: 400 })]);
    await expect(
      provider.createPod({ name: "n", image: "i", containerDiskGb: 1, dataCenterId: "d", gpu: { id: "g", count: 1 } }),
    ).rejects.toMatchObject({ code: "CLOUD_CAPACITY_UNAVAILABLE" });
    expect(calls).toHaveLength(1);
  });

  it("treats a 5xx or network failure on create as ambiguous and never retries it", async () => {
    const first = setup([json(503, { detail: "boom" })]);
    await expect(first.provider.createVolume({ name: "v", sizeGb: 10, dataCenterId: "d" })).rejects.toMatchObject({ code: "CLOUD_AMBIGUOUS_CREATE" });
    expect(first.calls).toHaveLength(1);

    const second = setup([new Error("socket hang up")]);
    await expect(
      second.provider.createPod({ name: "n", image: "i", containerDiskGb: 1, dataCenterId: "d", cpu: { id: "cpu3c", vcpuCount: 2 } }),
    ).rejects.toMatchObject({ code: "CLOUD_AMBIGUOUS_CREATE" });
    expect(second.calls).toHaveLength(1);
  });

  it("treats terminate and delete of an absent resource as success", async () => {
    const { provider, calls } = setup([json(204, undefined), json(404, { detail: "pod not found" }), json(404, { detail: "nope" })]);
    expect(await provider.terminatePod("p")).toEqual({ id: "p", alreadyAbsent: false });
    expect(calls[0]!.body).toEqual({ action: "terminate" });
    expect(await provider.terminatePod("p")).toEqual({ id: "p", alreadyAbsent: true });
    expect(await provider.deleteVolume("v")).toEqual({ id: "v", alreadyAbsent: true });
  });

  it("returns null for a missing pod or volume", async () => {
    const { provider } = setup([json(404, {}), json(404, {})]);
    expect(await provider.getPod("x")).toBeNull();
    expect(await provider.getVolume("x")).toBeNull();
  });

  it("retries idempotent calls on 429 honoring Retry-After, then succeeds", async () => {
    const { provider, sleeps } = setup([json(429, { detail: "slow down" }, { "retry-after": "2" }), json(200, { pods: [podBody] })]);
    expect(await provider.listPods()).toHaveLength(1);
    expect(sleeps).toEqual([2000]);
  });

  it("gives up with CLOUD_RATE_LIMITED after bounded retries", async () => {
    const { provider, calls } = setup([json(429, {}), json(429, {}), json(429, {})]);
    await expect(provider.listVolumes()).rejects.toMatchObject({ code: "CLOUD_RATE_LIMITED" });
    expect(calls).toHaveLength(3);
  });

  it("maps auth, payment and permission failures and never leaks the key", async () => {
    for (const [status, code] of [[401, "CLOUD_AUTH_FAILED"], [402, "CLOUD_PAYMENT_REQUIRED"], [403, "CLOUD_FORBIDDEN"]] as const) {
      const { provider } = setup([json(status, { detail: "denied" })]);
      const error = await provider.listPods().then(() => undefined, (e: unknown) => e as Error & { code: string });
      expect(error?.code).toBe(code);
      expect(JSON.stringify({ message: error?.message, details: (error as { details?: unknown })?.details })).not.toContain(SECRET);
    }
  });

  it("flags malformed responses instead of returning partial data", async () => {
    const { provider } = setup([json(200, { pods: [{ id: "p", status: "WEIRD" }] })]);
    await expect(provider.listPods()).rejects.toMatchObject({ code: "CLOUD_BAD_RESPONSE" });
  });
});
