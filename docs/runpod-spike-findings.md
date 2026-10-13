# Runpod provider spike: findings

Date: 2026-10-13. Phase 1 of `runpod-execution-implementation-plan.md`. Total spend: well under $0.50. All created resources were terminated/deleted and confirmed absent (`GET /v2/pods`, `GET /v2/network-volumes` empty).

## Verified

| Item | Result |
|---|---|
| Auth | `Authorization: Bearer <key>` works on `https://api.runpod.io/v2` (spec: `/v2/openapi.json`, version 2.0.0) and the older `https://rest.runpod.io/v1` |
| Catalog | `GET /v2/catalog/gpus?include=AVAILABILITY&product=POD` returns per-GPU price, `availability`, `cudaVersions`, and available `dataCenters`. `/v2/catalog/cpus` and `/v2/catalog/datacenters` (field `networkVolumeTypes`) also work |
| Network volumes | Create `POST /v2/network-volumes {name,size,dataCenter}` → 201; delete → 204. Only datacenters with a non-empty `networkVolumeTypes` support them |
| CPU Pod + volume | Works. `cpu3c`, 2 vCPU, `python:3.11-slim`, volume mounted via `mounts.network[{volumeId,path}]` in AP-JP-1; wrote a file and served it |
| Pod proxy | `https://<podId>-<port>.proxy.runpod.net` is reachable over HTTPS once the app listens (404 for ~20 s, then 200). **Requires a non-default User-Agent**: Python-urllib's default is blocked by Cloudflare (403, `error code: 1010`) |
| Terminate | `POST /v2/pods/{id}/action {"action":"terminate"}` → 204; repeating it → 404 `pod not found` (treat as success). Terminating a Pod does not delete an attached volume |
| GPU Pod + volume create | Succeeded in CA-MTL-1 (A5000, `HIGH_PERFORMANCE` volume) and EU-RO-1 (RTX PRO 4000 Blackwell, `STANDARD` volume); Pod immediately reports `RUNNING` before the container is ready |
| GPU volume persistence | Verified in EU-RO-1: GPU Pod 1 wrote `/vol/g.txt`, was terminated, GPU Pod 2 mounted the same volume and served the file |
| First-pull latency | `pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime`: proxy still 404 after ~97 s on a cold host; ~30 s on the second Pod (cached image) |

## Not verified / risks

0. **Container self-exit does NOT stop billing.** A Pod whose command exited after ~75 s was still `RUNNING` (`cost` 0.57/h, actions `stop/restart/terminate`) more than 5 minutes later. It is likely restarted by the platform. A process exiting inside the Pod is therefore not a lifetime guard; only an API terminate/stop is.
1. **No lifetime/deadline field exists on Pod create** (fields: `image`, `disk`, `env`, `ports`, `gpu`, `cpu`, `dataCenterIds`, `mounts`, `args/cmd/entrypoint`, `templateId`, `cloud`, ...). Self-exit was tested and fails (item 0). Decision (2026-10-13): no independent scheduler; enforcement is the client deadline while connected, the Pod-scoped-key watchdog where it works, cleanup journal and restart recovery, plus an explicit warning acknowledgment that automatic shutdown is not guaranteed (see the plan, section 9).
2. **GPU capacity is thin and volatile.** GPU Pod creation worked once and then returned 400 "no longer any instances available" on later attempts. At spike time the only datacenter offering a 24 GB+ GPU under $0.95 *and* network volumes was CA-MTL-1. Persistent mode requires the GPU in the volume's datacenter, so capacity failure after CPU preparation is a real, common case. The plan's "recheck GPU capacity before preparing" and clear failure path are mandatory.
3. **CPU-prepared volume remounted on GPU is still untested end to end.** CPU Pod+volume was proven in AP-JP-1 and GPU remount in EU-RO-1 (different volumes). EU-RO-1 had GPU capacity on both attempts; a CPU Pod there was not tried.
4. CPU capacity also varies by datacenter: all four CPU flavors failed in CA-MTL-1, while `cpu3c` worked in AP-JP-1.
5. `GET /v2/pods/{id}/logs` returned a response that did not terminate in the first spike. Clients must read it with a byte cap and deadline, or avoid it and use the worker's own log cursor.
6. Create errors are plain 400 for capacity; no `Retry-After` observed.
7. Billing endpoint shape differs by path (`/v2/billing` has `totals`, `/v2/billing/pods` did not); verify before relying on actual-cost reconciliation.

## Consequences for the plan

- Lifetime enforcement is best effort: client deadline while connected, in-Pod watchdog where supported, journal and restart recovery, and a mandatory risk acknowledgment before approval. There is no independent scheduler.
- Quote/preflight must query `availability` per datacenter and filter on `networkVolumeTypes`; both can change between quote and create.
- Worker transport through the Runpod HTTPS proxy is viable; add a User-Agent and treat 404 as "not up yet".
- Idempotent terminate/delete handling confirmed (404 = already gone).

## Pod-scoped key (watchdog research)

Docs ([environment variables](https://docs.runpod.io/pods/references/environment-variables)) say each Pod gets a `RUNPOD_API_KEY` described as "Pod-scoped". Account API keys offer only All / Restricted / Read Only, with per-endpoint scoping for Serverless only; no per-Pod scope and no automatic expiry ([api-keys](https://docs.runpod.io/get-started/api-keys)). The v2 OpenAPI has no key-management endpoints.

Empirical test (CPU Pod `cpu3c`, AP-JP-1, plus a decoy Pod; cost < $0.01), calls made from inside the Pod with the injected key:

| Call | Result |
|---|---|
| `POST /pods/{own id}/action terminate` | **Worked** (Pod gone ~150 s after start) |
| `POST /pods/{decoy id}/action terminate` | 404 `pod not found`; decoy remained alive (visible to the account key) |
| `GET /pods` | 403 |
| `GET /network-volumes` | 403 |
| `GET /account/secrets` | 403 |
| `POST /pods` (create) | 403 |
| `GET /catalog/gpus` | 200 (public data) |
| `GET /billing` | **200: returns account-wide billing totals/history**, so it is not fully isolated (read-only spend metadata) |

Key is 50 chars, prefix `rpa`, not a JWT, so no readable `exp` claim.

Assessment against required properties:
- Terminate only its own Pod: **yes** (other Pod not terminable, not even visible).
- Cannot access other resources: **mostly**; Pod list/volumes/secrets/create denied, but billing reads are allowed.
- Expires automatically: **unverified**. Not documented. Not tested whether it stops working after its Pod is terminated (it is then useless for termination anyway). Treat expiry as absent; the key's value is its narrow scope plus the Pod's own death.

Implication: a Pod-side watchdog using `RUNPOD_API_KEY` is a best-effort deadline mechanism that needs no account key in the Pod. Known limits, which are disclosed to the user rather than engineered away: (a) it only works after the container boots (an image pull failure or crash loop leaves a billable Pod); (b) it still has to be verified on a real GPU Pod, with the client offline, before being relied on even as best effort; (c) key expiry is unverified; (d) billing read exposure should be disclosed.
