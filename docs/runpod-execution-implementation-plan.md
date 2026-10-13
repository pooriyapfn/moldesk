# Runpod execution: minimal-change implementation plan

Date: 2026-10-13. Based on current MoleculeDesk source and `moldesk-runpod-execution-spec.md` v0.1.
Scope: implementation planning only; no cloud provisioning or feature implementation performed.

## Recommendation

Add cloud orchestration inside `@moldesk/core` and provider/worker transport inside `@moldesk/runtime`. Keep Python as the execution runtime; introduce `compute: local | runpod` separately. Reuse existing manifests, installers, adapters, run directories, output hashing and visualization. Ship Boltz with ephemeral caching first, then persistent caching. Do not introduce a new package, replace the local installer, or build desktop infrastructure as part of this feature.

The attached spec describes requirements, not instructions to execute paid operations. Suggested architecture and command syntax are adapted below to the actual repo. Deviations are explicit.

## 1. What already exists

| Source | Existing behavior | Implementation consequence |
|---|---|---|
| `packages/core/src/run.ts` → `runModel` | Requires a local installed Python variant; validates params/input; snapshots inputs; records logs/outputs; generates report; exports files | Cloud cannot be implemented solely by injecting `runtimeProvider`; installation lookup and host-path command construction happen first |
| `packages/runtime/src/providers.ts` → `RuntimeProvider` | Local runtime inspect/prepare/execute/remove contract; execution expects local executable/cwd and process PID | Keep unchanged; add separate scientific-job backend contract |
| `packages/registry/src/runtime-selection.ts` | Explicit platform runtime selection and source override resolution | Select `linux-x64` for remote execution even when client is macOS |
| `models/boltz/manifest.yaml` | Official Boltz 2.2.1, source revision `cb04aeccdd480fd4db707f0bbafde538397fa2ac`; three immutable/checksummed assets | No new Boltz downloader or floating installer needed |
| `packages/runtime/src/install/index.ts` | `cacheAsset`, `materializeAsset`, `preparePythonEnvironment`, managed uv, source revision checks, dependency freeze | Worker imports these functions; CPU stage invokes only asset functions |
| `packages/adapters/src/boltz/index.ts` | GPU/MPS defaults; structured CLI args; explicit `--cache`; output globs; CUDA verification | Reuse command/verification remotely and output collection locally |
| `packages/core/src/run-report.ts` | Local offline report from adapter description and collected files | Generate after download; no worker/browser/report rewrite |
| `packages/runtime/src/filesystem/paths.ts` | `MOLDESK_HOME`, `state`, `runs`, `locks`, content-addressed assets | Derive cloud paths under existing `paths.state`; no required `MoldeskPaths` additions |
| `apps/cli/src/commands/run.ts` | `run <model> <input>`, signal handling, JSON output and exit codes | Preserve positional input and existing behavior |
| `apps/desktop/README.md` | Desktop planned, not implemented | Desktop UI is future consumer of core APIs, not a small extension today |

Current scientific history is `run.json`, not SQLite. No existing Runpod connector, credential store, cloud resource database or remote worker was found in the inspected CLI/core/runtime paths. Boltz Linux/CUDA is structurally implemented but explicitly not live-verified in its manifest.

## 2. Limit edits to existing code

| Existing file | Precise change |
|---|---|
| `packages/core/src/run.ts` | Dispatch remote options before local installation resolution; add optional compute/provenance types; move shared snapshot/finalization code into helper |
| `packages/core/src/index.ts` | Export cloud planning, execution, resource/cache management and progress types |
| `packages/runtime/src/index.ts` | Export cloud provider/worker transport types and implementation |
| `packages/registry/src/schema.ts` | Optional strict `cloud` capability block, versioned independently; require immutable image identities and valid resource limits |
| `packages/registry/src/types.ts`, `src/index.ts` | Export cloud schema type |
| `models/boltz/manifest.yaml` | Add cloud eligibility, tested images/resource profile and asset-layout revision; reuse existing assets/runtime/source |
| `apps/cli/src/commands/run.ts` | Parse compute/cachePolicy/GPU/budget/lifetime, preview quote, obtain explicit approval, invoke core |
| `apps/cli/src/index.ts` | Register new `cloud` command group |
| `packages/core/package.json`, lockfile | Add Node-20-compatible SQLite driver only for cloud state |
| `packages/runtime/package.json`, lockfile | Add maintained system-keyring binding; transport dependency only if chosen secure transport requires it |

New modules:

```text
packages/core/src/run-lifecycle.ts       shared run snapshots and finalization
packages/core/src/cloud/run.ts           quote, approval checks, lifecycle, cleanup
packages/core/src/cloud/state.ts         SQLite cloud journal, leases, reconciliation
packages/runtime/src/cloud/types.ts      execution/provider/worker contracts
packages/runtime/src/cloud/runpod.ts     REST client + hardware/pricing normalization
packages/runtime/src/cloud/credentials.ts OS credential-store abstraction
packages/runtime/src/cloud/worker.ts     trusted preparation/execution service
packages/runtime/src/cloud/transfer.ts   authenticated worker client + verified transfer
apps/cli/src/commands/cloud.ts           connect/status/resources/cache/recovery
packages/runtime/scripts/build-worker.mjs reproducible generic worker release bundle
```

Add focused tests beside these modules. Keep adapters, local `RuntimeProvider`, installation state, visualizer and Python wrapper unchanged initially. A Boltz adapter edit is justified only if live tests reveal incompatible assumptions. Worker packaging needs its own entry point; avoid shipping a second Python implementation of existing TypeScript installation logic.

## 3. Shared run lifecycle without rewriting local execution

Extract existing blocks mechanically into `run-lifecycle.ts`:

1. `createRunSnapshot`: allocate ID/directories, copy/hash primary and declared companion inputs, construct initial record.
2. `writeRunRecord`: existing atomic temporary-file rename.
3. `finalizeRun`: collect/hash local outputs, generate local report, finish/write record and perform collision-safe `--output` copy.

Local installation lookup, defaults, adapter command and Python execution remain in `run.ts`. Local outcomes/exit codes remain unchanged. Preserve the existing rule: pre-allocation usage errors reject; after allocation, failures resolve a finalized `RunModelResult`. Review extraction against existing cancellation and report-warning tests. Snapshot/staging errors after allocation also need terminal records; current placement before the main try block should not be copied into the cloud path.

Cloud workflow validates adapter/input/params without requiring `listInstalledModels`. Supply the existing defaults hook a structural remote runtime descriptor `{ kind: "python", python: { platform: "linux-x64" } }`. Validate remote command on a Linux worker before paid inference. Never fake an installation entry in local install state.

Add `RunModelOptions.compute?: "local" | "runpod"`, `cloud?: CloudRunOptions`, `onProgress?: (event) => void`. Keep `runtime: "python"` in cloud records; provider belongs in new optional `record.compute`. `installationFingerprint` describes the actual remote Python runtime, not a fictitious local installation. Worker returns dependency freeze, Python version, selected source and GPU report.

Maintain existing record statuses. Store detailed stages in additive `compute.stage` and SQLite, rather than extending the top-level status union everywhere. Record local client `hardware` as before and remote hardware explicitly under `compute.hardware`; do not imply the client GPU performed inference. Record remote command cwd separately while keeping `record.command.cwd` local, since CLI prints it as the run directory.

## 4. Small contracts

```ts
interface CloudRunOptions {
  cachePolicy: "ephemeral" | "persistent";
  gpuId?: string;                    // absent = automatic eligible choice
  datacenterId?: string;
  maxBudgetUsd: number;
  maxLifetimeSeconds: number;
  approval: { quoteId: string; approvedAt: string };
}

interface ExecutionBackend {
  start(request: ApprovedJob): Promise<JobHandle>;
  observe(job: JobHandle, after?: string): Promise<JobSnapshot>;
  cancel(job: JobHandle): Promise<void>;
  collect(job: JobHandle, localOutputDir: string): Promise<ArtifactInventory>;
}
```

`ApprovedJob`, `JobHandle`, `JobSnapshot` and inventory are JSON-serializable, versioned types. `RunpodExecutionBackend` composes provider and worker; core owns scientific history and consent. Contract is separate from local process execution; do not implement an otherwise-unused local backend wrapper in v0.1.

`CloudProvider` needs only catalog/quote, create/get/list/delete Pod and create/get/list/delete volume methods. Inject fetch, clock and credentials for tests. Worker transport needs prepare-assets, install-runtime, execute, status/log cursor, cancel and inventory/file retrieval. Start with bounded polling and resumable log offsets; SSE is unnecessary for MVP.

## 5. Manifest changes: reuse the current contract

Add optional `cloud` block with `schemaVersion`, `platform: linux-x64`, GPU/CPU image digests, minimum VRAM/RAM, ephemeral disk size, volume size, asset-layout revision and `cpuAssetPreparation: true`. Exact image digests and resource values must come from live Boltz validation, not placeholders shipped as defaults. Eligibility is explicit: other adapters are rejected before allocation/provisioning.

Map spec activities to existing functions:

| Activity | Actual implementation |
|---|---|
| `prepare_assets` | For each existing `manifest.assets`: `cacheAsset` then `materializeAsset`; verify prepared tree and commit READY metadata |
| `install_runtime` | `selectPythonRuntime(..., "linux-x64")`, source override, `preparePythonEnvironment`, adapter `verifyInstallation` |
| `execute` | Existing adapter `command(remoteContext)` then `PythonRuntimeProvider.execute` |

Do not add arbitrary shell command strings to manifests. Existing structured runtime and assets already encode the required work for Boltz. This narrows command execution and avoids three duplicate installer definitions.

Boltz already passes `--cache <assetsDir>/boltz-cache`. Set remote `assetsDir` appropriately; no `BOLTZ_CACHE` change required. CPU preparation must not call `verifyInstallation`: its non-Darwin probe requires CUDA. GPU verification runs after installing the ephemeral venv.

Existing asset bytes total 6,204,352,719 (~5.78 GiB), before extraction/runtime/jobs. Size persistent storage for raw object cache plus materialized assets, extraction peaks and headroom. Measure extracted CCD data; do not set volume size equal to compressed download size. Preserve source archive until pinned Boltz behavior proves it unnecessary. Dependency installation currently resolves transitive packages; save `uv pip freeze`, and do not claim full transitive reproducibility without a separately validated lock.

## 6. Worker and transfer

Use a generic Linux CPU image and generic CUDA GPU image, pinned by digest. Bootstrap a release-pinned, checksum-verified MoleculeDesk worker bundle including registry/runtime/adapters; it executes installed trusted adapter code, never an arbitrary client command or uploaded manifest. Ensure images supply Node 20+, git, tar/unzip, CA certificates and required OS dependencies; if Node is absent, bootstrap a pinned/checksummed Node archive. No image per model.

Worker readiness timeout is at least 5 minutes: spike observed ~97+ s of proxy 404 on a cold-image GPU host. The Runpod proxy rejects default Python/urllib User-Agents (Cloudflare 1010), so clients must send an explicit User-Agent. Use a per-job secret token over a verified HTTPS worker endpoint. Confirm Runpod proxy routing supports chosen service; if not, implement SSH tunnel transport before enabling cloud runs. No plaintext fallback. Runpod API key stays on client. Never place it in worker environment, release URLs or logs. Persist reconnect tokens only in system keyring; retain non-secret credential references in state.

Remote layout:

```text
/job/<run-id>/input/                       uploaded snapshot, hash verified
/job/<run-id>/output/                      scientific outputs
/job/<run-id>/runtime/.venv/               ephemeral environment
/workspace/moldesk-cache/<cache-key>/assets/ Persistent only
/workspace/moldesk-cache/<cache-key>/ready.json
```

Ephemeral uses ephemeral `/job/<run-id>/assets`. Persistent's raw object/download cache also resides on network volume. GPU venv stays ephemeral. Build adapter commands inside worker with POSIX paths; building remote paths on macOS or rewriting strings in local args is unnecessary.

Upload only approved input snapshots. Inventory includes every required output and supporting file needed by existing report descriptions, relative paths, sizes and SHA-256. Download to local staging, reject traversal/symlinks/duplicate targets, verify against inventory and promote into existing `output/`. Run existing local `collectOutputs`; missing required files are failures even after exit 0. Avoid unrestricted archive extraction; per-file streaming is adequate initially. Retry partial downloads by verified range where supported, otherwise restart only affected files. Never rerun inference as a transfer retry.

Boltz YAML may reference external files beyond current shallow validator. Initially reject file-reference job forms not safely staged by a validated worker preflight; document supported sequence-only examples. Supporting them later should use existing companion-input hook, not upload arbitrary local paths. Explicit MSA-server use also needs disclosure because it introduces another remote service.

## 7. Ephemeral and persistent cache flows

**Ephemeral:** validate → snapshot/quote → explicit approval → journal intent → create GPU Pod → worker readiness → upload → prepare assets → install/verify Linux runtime → run once → download/verify → local collection → terminate Pod → finalize/report. No network-volume creation. Report generation/export failures do not keep a paid Pod alive.

**Persistent cold:** validate/quote compatible datacenter → approve recurring storage → journal/create or reuse volume → acquire cache lease → create CPU Pod → prepare/check assets in staging → atomic READY publication → terminate CPU and confirm termination → recheck GPU capacity → create GPU attached to same volume → install/verify ephemeral runtime → upload/execute/download → terminate GPU → retain volume.

**Persistent warm:** inspect volume and on-volume READY metadata → validate revision/integrity → skip CPU Pod → GPU execution flow. Local READY alone is insufficient; a deleted volume or mutated cache must not be reused silently.

No capacity reservation is implied by quote. Prefer a compatible existing volume's datacenter; if GPU placement fails, terminate preparer and return actionable capacity failure. Do not silently create another region's volume or exceed approved price. Deleting cache/volume is a separate explicitly confirmed operation that checks active attachments and lists exactly what will be removed.

## 8. Cloud journal, locks and restart recovery

Use `paths.state/cloud.sqlite`, leaving all existing scientific JSON records intact. Node requirement is >=20, so do not assume built-in `node:sqlite`; choose a maintained Node-20-compatible driver after checking package/prebuild support. SQLite dependency belongs only to core cloud state.

Tables:

| Table | Minimum fields |
|---|---|
| `cloud_jobs` | run ID, account scope, quote/approval digest, cachePolicy, stage, status, GPU/datacenter, volume ID, deadline, manifest/runtime hashes, transfer state, error, timestamps |
| `cloud_resources` | intent UUID, owning run/client ID, role CPU/GPU/volume, provider ID, deterministic name, create/delete pending state, deadline, timestamps |
| `cloud_caches` | account/datacenter/volume/model/version/layout/manifest digest, cache path, size, checksum-manifest digest, state, lease owner/expiry, created/used timestamps |

Persist intent before creation, ID immediately after response, deletion intent before delete. Resource names include client-installation UUID + run UUID + role; names are discovery hints, not authorization. Match journal ownership before deletion. After ambiguous POST timeout, discover candidate resources before retry; absent API idempotency support, do not blindly POST again. DELETE treats confirmed absence as success.

Cache key = digest(model ID/version, selected source revision, canonical assets list including targets/checksums, asset-layout revision). Account/datacenter/volume are separate lookup dimensions. Persist full manifest digest for provenance; conservative invalidation on relevant changes. PREPARING → VERIFYING → READY; failed/interrupted writes stay FAILED, never READY.

SQLite transactional leases protect same-client concurrent commands. On-volume atomic directory lock with owner/expiry protects separate computers in the same account. Renew during preparation; reclaim only after verifying old Pod is terminated. Existing per-download locks do not protect the entire extracted cache or coordinate GPU readers. Publish staging tree + per-file extracted hashes atomically; verify warm tree before inference, including symlink and safe-path checks.

Before new paid work, reconciliation lists owned resources and compares journal. `cloud resources` exposes orphaned/cleanup-pending machines and retained-volume charges. Add `cloud recover <run-id>` to resume transfer/cleanup without starting inference again; require confirmation for newly incurred rental or orphan deletion. Refresh provider state on recovery; restarting CLI alone must not recreate Pods.

## 9. Cleanup, costs and credentials are MVP requirements

Successful verification triggers Pod termination; failed runtime/preparation and cancellation also terminate. Cleanup uses a separate bounded signal, not the cancelled inference signal. Persist retries; do not report resource cleanup complete until provider confirms termination. Scientific success and cleanup failure are separate: retain verified results and surface `CLOUD_CLEANUP_PENDING`, with CLI nonzero exit and exact owned resource IDs.

Transfer failure preserves a bounded recovery window, never an unlimited running GPU. At deadline terminate with disclosed risk of losing Ephemeral outputs. Persistent outputs persist only if approved recovery policy authorizes storage in the volume. Never retain additional storage silently. GPU/CPU termination must not invoke volume deletion.

**Release blocker:** validate a provider-enforced expiration/termination mechanism covering boot, installation and client offline time. Worker timeout alone cannot terminate a billable Pod without provider authorization and does not cover failed worker bootstrap. Spike evidence: container/process exit provides **no billing protection** (a Pod whose command exited stayed `RUNNING` at full rate), and Runpod has no lifetime field on Pod create. A local timer, worker exit or stopped Pod is not proof of stopped billing.

**Chosen guard (pending verification):** Runpod injects a Pod-scoped `RUNPOD_API_KEY` into every Pod; spike showed it can terminate only its own Pod and is denied Pod listing, volumes, secrets and creation (billing reads are allowed; no documented expiry). A deadline watchdog inside the worker image uses it, never the account key. Because the watchdog cannot cover failures before the container boots (image pull, crash loop), an independent external scheduler is also required: the deadline is registered before paid compute starts, and it retries termination and verifies deletion independent of the client. A client-only deadline plus manual `cloud recover` (offline-unsafe) is not allowed in the released MVP. If API lacks independent deadline enforcement, choose and disclose another independently running cleanup mechanism with narrow authorization before release; do not claim acceptance criterion 8 is satisfied. No API key in worker, no fabricated lifetime field.

Quote uses current catalog/billing data with retrieval time, GPU/CPU hourly rates, temporary storage and recurring volume rate. Show preparation/inference/transfer time ranges separately, unknown estimates explicitly. Hard budget rejection before provisioning; bind approval to quote/input/manifest/resource/cachePolicy hashes and reapprove material price/location changes. Max budget is an estimate guard, not a guaranteed provider spend cap unless supported/enforced. Track observed stage timings and actual billing where available.

Credential abstraction: `set/get/delete(provider, accountRef)`, backed by OS store. Mask connect input; validate via minimum read-only API calls. No plaintext fallback. Store account identity if provider exposes it; otherwise stable keyed fingerprint of credential as conservative scope, with key-rotation reassociation explicitly verified. Secrets absent from run.json/SQLite/errors/command arguments. Avoid macOS `security ... -w <key>` subprocess arguments; use keyring API. Apply token-aware redaction to worker logs, beyond existing environment redaction.

## 10. CLI and future desktop integration

Preserve current syntax:

```bash
moldesk cloud connect runpod
moldesk cloud status
moldesk run boltz complex.yaml --compute runpod --cache-policy ephemeral
moldesk run boltz complex.yaml --compute runpod --cache-policy persistent
moldesk cloud resources
moldesk cloud cache list
moldesk cloud cache delete boltz --provider runpod
moldesk cloud recover <run-id>
```

`--input` from spec is not supported today; do not redesign arguments solely for cloud. Add `--gpu`, `--datacenter`, `--max-budget`, `--max-lifetime`, `--yes`, `--dry-run`. Local remains default. Reject cloud-only flags for local, Docker runtime for cloud, missing cache policy/budget/lifetime and unsupported models before any charge. Interactive quote approval covers exact upload, region, maximum lifetime, ordinary ephemeral cleanup and recurring storage. Cache deletion remains separate. Noninteractive requires explicit flags/approval; JSON stdout remains machine-readable, logs/progress go to stderr. Map new usage/auth/capacity/recovery errors consistently alongside current 0/7/8 run outcomes.

Core exposes serializable plan, approve/start, observe/cancel/recover and resource/cache APIs. Future desktop can consume these for provider/cachePolicy/GPU/cost/stage UI. Building Tauri/React shell is a separate project because there is currently no desktop application to modify.

## 11. Delivery order and verification

1. **Provider spike:** pin current API schema; prove account validation, quote/catalog lookup, GPU Pod create/delete, authenticated worker transfer, independent lifetime enforcement. Separately prove CPU Pod + network volume + GPU remount. Document observed behavior; no CLI launch until lifecycle guard works.
2. **Shared lifecycle extraction:** keep local tests green; add regression for post-allocation snapshot failure. No cloud behavior yet.
3. **Ephemeral:** add credential store, journal, provider, worker, cloud commands, manifest block and quote approval. Real Boltz Linux/CUDA run retrieves existing report-compatible outputs and confirms Pod gone. Orphan discovery/recovery, budget/lifetime and cleanup failures included here.
4. **Persistent:** add volume lifecycle/cache leases, CPU-only preparation, READY integrity, warm reuse and confirmed explicit deletion. Test two sequential real runs; second creates zero CPU Pods and downloads zero model assets.
5. **Hardening:** additional interruption/range-transfer cases, multiple client contention, retained-storage UX and packaging checks. No batch scheduling, warm GPU pools or model-specific images.

Focused automated checks:

- Existing core/adapter tests: local defaults, execution result, output collection, report warnings and export collision unchanged.
- Provider fixtures against pinned OpenAPI: auth rejection, 402, 429/Retry-After, capacity loss, malformed response, ambiguous create, repeated delete.
- Ephemeral cloud run without any local install; macOS client selects Linux official Boltz and GPU defaults.
- Consent refused/expired/mismatched → zero upload/resource creation; secrets absent from all persisted records/log fixtures.
- Download corruption/traversal/missing required output → no success; transfer retry does not repeat inference.
- CPU asset stage invokes no Python/CUDA install/probe; extraction failure leaves no READY and terminates CPU.
- Warm cache mismatch/deleted volume/concurrent preparers → fail safely or prepare once; ordinary cleanup never deletes volume.
- Cancellation/client crash at every resource boundary → reconstruct IDs/intents, reconcile, bounded cleanup; independent deadline tested with client offline and worker startup failure.
- SQLite driver and worker bundle tested on supported Node versions; install archived release bundle in clean CPU/GPU environment.

Run `pnpm typecheck`, affected package tests, `pnpm build`, `pnpm pack:verify` after implementation. Live runs require explicitly approved Runpod spending; this plan performs none. Unit mocks alone cannot establish CUDA compatibility, CPU volume capability, billing termination or GPU availability.

## 12. Current external evidence and remaining unknowns

Checked official sources during planning:

- [Runpod REST v2 overview](https://docs.runpod.io/api-reference-v2/overview): base URL `https://api.runpod.io/v2`; catalog, Pods, volumes and billing resources. Prefer small typed fetch client over a CLI dependency.
- [Create a Pod](https://docs.runpod.io/api-reference-v2/pods/create-a-pod): GPU/CPU provisioning; v2 examples use nested `gpu`, `image`, `dataCenterIds` and `disk`. Bind implementation to pinned OpenAPI rather than copying v1 field names.
- [Enhanced CPU Pods](https://www.runpod.io/blog/enhanced-cpu-pods-docker-network): CPU Docker/network-volume support announced September 2026. Announcement does not prove selected API fields, regional capacity or lifetime enforcement.

Still unverified: chosen CPU deployment/volume request shape; provider termination deadlines; secure worker endpoint behavior; exact image digests, CUDA/Python compatibility and VRAM; extracted asset size; billed cleanup semantics; live first/warm-run timings. Resolve in spike and store evidence before turning cloud eligibility on. Spec timing examples are not benchmarks.

Explicit spec adaptations: replace Normal/Efficient modes with `cachePolicy: "ephemeral" | "persistent"` and CLI `--cache-policy`; positional CLI input retained; SQLite added only for cloud journal; no desktop implementation until shell exists; structured manifest installer reused instead of new command DSL; timeout/cost/orphan safeguards moved into initial Ephemeral release, not deferred to hardening.


## 13. Implementation status and deviations (updated 2026-10-13, work in progress)

**Not complete and not releasable.** Code exists for the pieces below and is covered by unit and local
integration tests using fakes; no paid validation has been performed since the provider spike. See
[cloud-execution.md](./cloud-execution.md).

Present in code: manifest `cloud` block, credential store, Runpod provider client, SQLite cloud journal,
quote/approval, orchestrator, worker server/client, manifest pipeline, persistent cache logic,
`RunpodExecutionBackend`, recovery, cache management, CLI flags and commands, worker bundle build script.

Deviations from the sections above:

- The worker lives in `packages/core/src/cloud/worker/` (not `packages/runtime`): it must import adapters, and
  adapters depend on runtime. Transfer client, provider and backend are in `packages/runtime/src/cloud/`.
- `ExecutionBackend` gained `release` (terminate and confirm) and an optional `reconnect`; `collect` takes an
  optional cancellation signal. The journal reaches backends through `ResourceLedger` and `CacheLedger`.
- One bundled worker pipeline replaces separate `prepare_assets`/`install_runtime`/`execute` endpoints; a
  `prepare-assets` worker mode serves the CPU stage.
- Credentials: the OS keyring is the default. An explicit `RUNPOD_API_KEY` environment variable is a documented
  development override. `.env` files are **not** read (an earlier iteration did; removed after review).
- The quote counts compute (and container disk only when a rate is published). Runpod's catalog publishes no
  disk or volume rates, so storage is reported as unknown and listed as not covered by the budget.

Still open (not claimed as done):

1. **Lifetime guard (release blocker):** no independent scheduler exists or has been authorized; Pod-key
   expiry and GPU Pod key injection are unverified. `resolveDeadlineGuard()` refuses by design.
2. **Live validation (release blocker):** no real Boltz Linux/CUDA run, no real image digests/sizes, no
   published worker bundle, no measured asset extraction size or timings; the Boltz manifest has no `cloud` block.
3. **Untested against the real provider:** the container bootstrap script, the proxy path for uploads and large
   downloads (including real stall/timeout behavior), CPU Pod + volume then GPU remount in one datacenter,
   billing after terminate, and the actual cost of container disk and volumes.
4. Worker logs are a bounded in-memory tail (4 MiB); upload has an overall rather than idle timeout.
5. Cross-machine cache lock reclamation relies on the client confirming the previous owner is gone;
   multi-client contention is only covered by unit tests.
6. SQLite driver (`better-sqlite3` ~12.11) and the keyring binding were verified on macOS/Node 22 only.
