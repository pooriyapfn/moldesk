<!-- Editorial metadata; omit this block when publishing.
Format: evidence report with a direct-answer summary, question-led sections and dated results.
GEO: generative engine optimization. Uses explicit product, GPU and datacenter names, units, a
results table, source links and stated limits. No ranking guarantees.
Suggested slug: runpod-molecular-ai-validation-findings
Meta description: What running Boltz-2, ProteinMPNN and DiffDock-L on Runpod GPUs showed in October 2026: timings, disk and GPU memory measured, a Blackwell GPU that crashed, Pod billing after exit, and a watchdog that worked.
Last reviewed: 2026-10-19
-->

# Runpod for molecular AI: provider findings and live validation (Boltz-2, ProteinMPNN, DiffDock-L)

**Short answer.** MoleculeDesk ran Boltz-2, ProteinMPNN and DiffDock-L on Runpod GPU Pods between 2026-10-14 and 2026-10-19 and returned verified results to a local machine. A Boltz-2 run took 235 s on an NVIDIA GeForce RTX 3090. ProteinMPNN took 63 to 95 s per run on an NVIDIA A40 and an NVIDIA RTX A5000, grew the Pod's disk by 10.7 GB and used under 400 MiB of GPU memory on a 46-residue protein. DiffDock-L took 515 s on an NVIDIA A40, grew the disk by 12.5 GB and peaked at 3.7 GiB of GPU memory on one small complex. Three things matter most for anyone building on Runpod: a Pod whose container exits keeps billing, a newer GPU generation can pass a memory check and still crash an older PyTorch build, and Runpod's HTTPS proxy sometimes returns a transient 404 right after a Pod reports healthy.

These are single-run observations on small inputs, not benchmarks. The first provider spike (2026-10-13) is kept below, unchanged, with dated updates where later runs answered its open questions. See also the [cloud execution documentation](./cloud-execution.md) and the [implementation plan](./runpod-execution-implementation-plan.md).

## Results at a glance

| Question | Answer | Evidence date |
|---|---|---|
| Does a Pod stop billing when its container command exits? | **No.** It stayed `RUNNING` and billable. Only an API terminate or stop ends it | 2026-10-13 |
| Does an in-Pod watchdog terminate an orphaned Pod? | **Yes**, on a GPU Pod, with the client killed mid-run | 2026-10-15 |
| How long does a Boltz-2 run take on Runpod? | **235 s** on an RTX 3090 (`ephemeral` caching) | 2026-10-14 |
| How much disk does ProteinMPNN need on Runpod? | **10.7 GB** of growth (PyTorch 2.2.1 and CUDA wheels); about half of a 20 GB container disk, which was not itself tested as a limit | 2026-10-15 |
| How much GPU memory does ProteinMPNN use? | **379 MiB** (A40) and **315 MiB** (RTX A5000) peak, on a 46-residue protein | 2026-10-15 |
| How long and how much disk does DiffDock-L need on Runpod? | **515 s** on an A40 (CA-MTL-1), **12.5 GB** of disk growth, **3,719 MiB** peak GPU memory on one small complex; its protein file is uploaded with the job | 2026-10-19 |
| Does a CPU-prepared network volume remount on a GPU Pod? | **Yes**, end to end, in the persistent Boltz-2 runs | 2026-10-14/15 |
| Is `persistent` caching faster than `ephemeral`? | **Not for one run.** The cold Boltz-2 run took about 43 min on a standard volume | 2026-10-14 |
| Do all GPUs with enough memory work? | **No.** An RTX PRO 4000 Blackwell failed with "no kernel image is available" under PyTorch 2.2.1 | 2026-10-15 |

## Does a Runpod Pod stop billing when its container exits?

No. In the first spike, a Pod whose command exited after about 75 s was still `RUNNING` (`cost` 0.57/h, actions `stop/restart/terminate`) more than five minutes later. The platform appears to restart it. A process exiting inside the Pod is therefore not a lifetime guard; only an API terminate or stop is. Runpod's Pod create call has no lifetime or deadline field, so MoleculeDesk combines a client-side deadline, automatic cleanup, an in-Pod watchdog and a cleanup journal, and tells users before each run that automatic shutdown is not guaranteed.

## Does the in-Pod watchdog terminate an orphaned Pod?

Yes, in the one test run. On 2026-10-15 the MoleculeDesk client was killed with SIGKILL partway through a GPU run, which left the Pod orphaned. The Pod terminated itself at 11:10:32 against a deadline of 11:10:25, about 7 s late. This used the Pod-scoped `RUNPOD_API_KEY` that Runpod injects, so no account key was placed in the Pod.

Limits that remain: the watchdog only works after the container boots (an image pull failure or crash loop leaves a billable Pod), behavior with the key absent was not tested, and key expiry is undocumented and untested.

## How long does a Boltz-2 run take on Runpod?

| Mode | Hardware | Result |
|---|---|---|
| `ephemeral` | NVIDIA GeForce RTX 3090 | **235 s** end to end, including Pod start, asset download, runtime install, prediction, download and cleanup |
| `persistent`, cold | CPU Pod prepares a standard network volume, then a GPU Pod runs | **About 43 min**; the CPU preparation took about 20 min on a slow EU-RO-1 volume (about 25 MB/s) |
| `persistent`, warm | GPU Pod mounts the prepared volume | Worked (run by the maintainer after the cache fix) |

Boltz-2 was run before MoleculeDesk measured peak disk and GPU memory, so there are no peak figures for it.

## How much disk and GPU memory does ProteinMPNN need on Runpod?

MoleculeDesk's worker samples used disk bytes and GPU memory every 250 ms and stores the peaks in `run.json` under `compute.usage`. Disk is reported as growth from the start of the job, because the image's own files count toward the filesystem.

| Run | GPU (datacenter) | Total time | Peak GPU memory | Disk growth |
|---|---|---|---|---|
| ProteinMPNN, pinned | NVIDIA A40 (CA-MTL-1) | 63 s | 379 MiB | 10.66 GB |
| ProteinMPNN, automatic choice | NVIDIA RTX A5000 (CA-MTL-1) | 95 s | 315 MiB | 10.66 GB |

Input was the 46-residue crambin structure (PDB 1CRN), so GPU memory is a floor: memory grows with chain length. Disk growth is dominated by installing PyTorch 2.2.1 and its CUDA 12.1 wheels, not by the input, and it matched across both GPUs. MoleculeDesk's manifest therefore sets a 20 GB container disk (about twice the measured growth) and keeps a conservative 16 GB GPU memory floor.

## How much disk and GPU memory does DiffDock-L need on Runpod?

Measured the same way as above (`compute.usage` in `run.json`), on the repository's Trp-cage example protein and aspirin, with 10 samples and 20 inference steps. The job file references the protein, so MoleculeDesk uploaded `protein.pdb` (38,965 bytes) next to `job.json` after an explicit `upload-files` acknowledgment.

| Run | GPU (datacenter) | Total time | Peak GPU memory | Disk growth |
|---|---|---|---|---|
| DiffDock-L, automatic choice | NVIDIA A40 (CA-MTL-1) | 515 s | 3,719 MiB | 12.50 GB |

The 515 s include Pod start, downloading the weights, installing the runtime (which builds DiffDock-L's lookup tables), 10 poses of inference, download and cleanup. Ten ranked poses and a summary came back. Disk growth is dominated by the runtime and weights, not the input. MoleculeDesk's manifest sets a 25 GB container disk (about twice the measured growth, not itself tested as a limit), keeps a 16 GB GPU memory floor (an earlier local run on an A40 peaked at 8.3 GiB), and lists only Ampere GPUs: its PyTorch 1.13.1 (CUDA 11.7) build has no native kernels for Hopper or Blackwell. Only the A40 has been run live.

## Which GPUs can run ProteinMPNN on Runpod?

Not every GPU that passes a memory check. ProteinMPNN is pinned to PyTorch 2.2.1 (CUDA 12.1 build), which supports only CUDA capabilities `sm_50 sm_60 sm_70 sm_75 sm_80 sm_86 sm_90`. A run that fell back to an **NVIDIA RTX PRO 4000 Blackwell** in EU-RO-1 (compute capability `sm_120`) installed fine, passed MoleculeDesk's post-install verification and then failed at inference with `RuntimeError: CUDA error: no kernel image is available for execution on the device`.

What this implies for anyone selecting Runpod GPUs automatically:

- Filtering by memory and price alone is not enough when the framework is pinned to an older build.
- Runpod's catalog on 2026-10-15 also listed consumer Blackwell cards (RTX 5080, RTX 5090), data-center Blackwell (B200, B300), AMD Instinct MI300X and MI350X, and a placeholder `unknown` GPU with price 0. Several of these pass a memory check.
- MoleculeDesk now lets a model's manifest list the validated GPU ids (`cloud.gpuAllowList`). ProteinMPNN lists 26 NVIDIA Ampere, Ada and Hopper GPUs. Only the A40 and RTX A5000 have been run; the others are listed by architecture. Boltz-2 does not restrict GPUs yet.

## Why did some Runpod runs fail with a 404 right after the Pod started?

Two of three automatic-choice ProteinMPNN attempts on the final worker build failed within 30 s with `Worker error 404`: one on the input upload (RTX A5000, CA-MTL-1), one on the start call (RTX 3090, EU-CZ-1). In both, the worker's health check had just passed. The third attempt, on the RTX A5000 in CA-MTL-1, succeeded.

The worker cannot return that 404 for those routes, and the same worker bundle answered health and accepted an upload when run locally, so this looks like the Runpod HTTPS proxy dropping its route briefly (the first spike also saw the proxy answer 404 for about 20 s before 200). MoleculeDesk does not retry it yet: the run fails, cleanup is confirmed, and running again works. Three attempts are too few to give a rate.

The first DiffDock-L attempts on the final worker build failed the same way three times in a row before the fourth succeeded: `Worker error 404` on the `job.json` upload (A40, CA-MTL-1), on the companion `protein.pdb` upload (RTX A5000, US-IL-1; the `job.json` upload had just succeeded on the same Pod) and on the `job.json` upload again (RTX 3090, EU-CZ-1). Each failed within about a minute, before any inference, and cleanup was confirmed every time. Counting the ProteinMPNN attempts above (a different worker build), five of seven automatic-choice attempts hit the 404; every attempt that got past it succeeded.

## Why is persistent caching slower than ephemeral for one run?

`persistent` caching adds a CPU Pod, a billed network volume and a second Pod start. On a standard (not high-performance) volume the CPU Pod prepared Boltz-2's assets at about 25 MB/s, so preparation took about 20 min and the cold run about 43 min, against 235 s for `ephemeral`. A warm run avoids the preparation, so the benefit appears only across repeated runs, and the volume bills until it is deleted. MoleculeDesk therefore treats `ephemeral` as supported and `persistent` as experimental.

## Can a CPU-prepared network volume be remounted on a GPU Pod?

Yes. The first spike proved the two halves separately (CPU Pod with volume in AP-JP-1; GPU remount in EU-RO-1). The persistent Boltz-2 runs on 2026-10-14/15 then did it end to end: a CPU Pod prepared the volume, a GPU Pod in the same datacenter mounted it, and the next run reused the cache with no CPU Pod.

## What did the live runs break, and what was fixed?

| Problem found live | Fix |
|---|---|
| Worker crashed on start (ES-module handling in the worker bundle) | Worker bundle carries an ES-module marker (`be9e3a0`) |
| GPU price ceiling did not match the approved range | The worker job uses the ceiling the user approved (`be9e3a0`) |
| CPU Pod rejected a container disk above Runpod's limit | CPU Pod disk capped at 20 GB (`be9e3a0`) |
| Persistent runs picked a datacenter with no affordable GPU or no CPU capacity | Budget-aware datacenter choice and CPU availability per datacenter (`8d2c9ea`) |
| The model could write into the shared cache on the volume | The model runs on a verified local copy, never the volume (`6fc50c7`) |
| Billed network volumes were forgotten after a run: the journal was reconciled against Pods only | Reconcile against volumes as well (`da64c92`) |
| Rebuild watch window was too short | Lengthened |
| Fallback chose an unsupported GPU generation | `cloud.gpuAllowList` (`62907b5`) |

Observed and not fixed: the worker's `[assets] Downloading` progress writes about 1,600 lines (about 86 KB) to stderr per run, and a failed download reports only `fetch failed` without the URL or cause. One LigandMPNN attempt on an A40 (CA-MTL-1) failed with exactly that message because its weights host, `files.ipd.uw.edu`, timed out; it also timed out from the maintainer's own machine. LigandMPNN is therefore not enabled for cloud runs.

## What is still unverified?

- Behavior of the Pod-scoped key after expiry, and the watchdog with the key absent.
- Real stall and timeout behavior on large proxy transfers (unit-tested only).
- A billing audit after terminate. Pods and volumes were confirmed absent through the API after each run, but actual charges were not reconciled, and the spend figure (about $1.5 before the ProteinMPNN and LigandMPNN runs, plus a few cents each, out of a $10 cap) is an estimate.
- Real container-disk and network-volume rates; Runpod's catalog publishes none.
- Larger inputs: ProteinMPNN sizes come from a 46-residue protein and DiffDock-L's from one small complex, so GPU memory is a floor for both.
- The local 3D report was not created for the cloud DiffDock-L run (`VISUALIZATION_RECEPTOR_MISSING`: the staged receptor was not available); the poses themselves were downloaded.
- DiffDock-L on any GPU other than the A40.
- The worker bundle attached to a GitHub Release; development bundles hosted by the maintainer were used and verified by SHA-256.

## How these runs were made

MoleculeDesk CLI `0.0.6` on macOS, with the user's own Runpod account and a spend cap of $10. Stock `runpod/pytorch` and `runpod/base` images pinned by digest; the worker bootstraps its own Node.js. Worker bundles were deterministic builds hosted at an HTTPS URL and verified by SHA-256 before use. ProteinMPNN used its manifest's pinned source revision and PyTorch 2.2.1 on Python 3.11. Catalog prices on 2026-10-15 were about $0.27/h (RTX A5000), $0.50/h (RTX 3090) and $0.59/h (A40).

---

# Provider spike, 2026-10-13

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
1. **No lifetime/deadline field exists on Pod create** (fields: `image`, `disk`, `env`, `ports`, `gpu`, `cpu`, `dataCenterIds`, `mounts`, `args/cmd/entrypoint`, `templateId`, `cloud`, ...). Self-exit was tested and fails (item 0). Decision (2026-10-13): no independent scheduler; enforcement is the client deadline while connected, the Pod-scoped-key watchdog where it works, cleanup journal and restart recovery, plus an explicit warning acknowledgment that automatic shutdown is not guaranteed (see the plan, section 9). *Update 2026-10-15: the watchdog was verified on a real GPU Pod; see above.*
2. **GPU capacity is thin and volatile.** GPU Pod creation worked once and then returned 400 "no longer any instances available" on later attempts. At spike time the only datacenter offering a 24 GB+ GPU under $0.95 *and* network volumes was CA-MTL-1. Persistent mode requires the GPU in the volume's datacenter, so capacity failure after CPU preparation is a real, common case. The plan's "recheck GPU capacity before preparing" and clear failure path are mandatory. *Update 2026-10-15: MoleculeDesk now tries each available GPU in a price range, cheapest first; the live runs landed on different GPUs and datacenters (A40, RTX A5000, RTX 3090, RTX PRO 4000 Blackwell) depending on availability.*
3. **CPU-prepared volume remounted on GPU is still untested end to end.** CPU Pod+volume was proven in AP-JP-1 and GPU remount in EU-RO-1 (different volumes). EU-RO-1 had GPU capacity on both attempts; a CPU Pod there was not tried. *Update 2026-10-15: verified end to end by the persistent Boltz-2 runs; see above.*
4. CPU capacity also varies by datacenter: all four CPU flavors failed in CA-MTL-1, while `cpu3c` worked in AP-JP-1. *Update 2026-10-15: the persistent Boltz-2 run prepared on a CPU Pod in EU-RO-1; MoleculeDesk now checks CPU availability per datacenter and falls back across CPU types.*
5. `GET /v2/pods/{id}/logs` returned a response that did not terminate in the first spike. Clients must read it with a byte cap and deadline, or avoid it and use the worker's own log cursor.
6. Create errors are plain 400 for capacity; no `Retry-After` observed.
7. Billing endpoint shape differs by path (`/v2/billing` has `totals`, `/v2/billing/pods` did not); verify before relying on actual-cost reconciliation. *Update 2026-10-15: still unverified; no billing audit was done.*

## Consequences for the plan

- Lifetime enforcement is best effort: client deadline while connected, in-Pod watchdog where supported, journal and restart recovery, and a mandatory risk acknowledgment before approval. There is no independent scheduler.
- Quote/preflight must query `availability` per datacenter and filter on `networkVolumeTypes`; both can change between quote and create.
- Worker transport through the Runpod HTTPS proxy is viable; add a User-Agent and treat 404 as "not up yet". *Update 2026-10-15: a 404 can also appear after the first health check passed; retries are not built yet.*
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

Implication: a Pod-side watchdog using `RUNPOD_API_KEY` is a best-effort deadline mechanism that needs no account key in the Pod. Known limits, which are disclosed to the user rather than engineered away: (a) it only works after the container boots (an image pull failure or crash loop leaves a billable Pod); (b) it still has to be verified on a real GPU Pod, with the client offline, before being relied on even as best effort; (c) key expiry is unverified; (d) billing read exposure should be disclosed. *Update 2026-10-15: (b) is done: on a GPU Pod with the client killed mid-run, the Pod terminated itself at its deadline. (a), (c) and (d) stand.*
