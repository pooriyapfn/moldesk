# Cloud execution (Runpod)

Status: **work in progress, disabled by default, not releasable.** The code paths exist and are tested with
mocks and local fixtures only; nothing has been validated against real paid compute.
Read [runpod-execution-implementation-plan.md](./runpod-execution-implementation-plan.md) and
[runpod-spike-findings.md](./runpod-spike-findings.md) for design and evidence.

## What is gated

Cloud runs refuse to start until all of these exist (release gates; live validation has not been done):

1. **A model that declares a validated `cloud` block** in its manifest (see [model-system.md](./model-system.md)).
   No shipped manifest declares one: image digests and sizes must come from a live validation.
2. **A published worker bundle.** The worker is a small Node program that runs inside the Pod: it serves an
   authenticated endpoint, runs the manifest install/run pipeline and the in-Pod watchdog. `pnpm --filter
   @moldesk/core build:worker` builds `worker.tar` deterministically (same sources, same SHA-256). The CLI
   records the release asset URL and checksum in `packages/core/src/cloud/worker-release.ts`
   (`RELEASED_WORKER_BUNDLE`) and refuses to run a bundle that does not match. Maintain it with
   `node scripts/worker-release.mjs update --tag vX.Y.Z`; CI fails when the recorded checksum no longer matches
   the sources, and the release workflow attaches `worker.tar` to the GitHub Release before publishing to npm.
   For development, set `MOLDESK_WORKER_BUNDLE_URL` and `MOLDESK_WORKER_BUNDLE_SHA256`. End users do nothing:
   the URL and checksum ship inside the CLI they installed.
3. **Passing live validation** of the items listed in the plan's release gates, including the in-Pod watchdog.

## Images and GPU selection

- **Images.** A Pod boots from a container image. The manifest names a digest-pinned default per role (stock
  Runpod images, e.g. `runpod/pytorch`), and the worker installs a pinned Node.js at boot when the image has
  none. Override with `--gpu-image <ref>` / `--cpu-image <ref>`; the quote shows the exact images and flags any
  that are not digest-pinned. The bootstrap fails fast, before downloading anything, if the image lacks curl,
  tar, sha256sum or (for the GPU role) `nvidia-smi`.
- **GPU range, not one GPU.** The quote covers every eligible GPU up to a price ceiling (`--max-gpu-price`,
  default twice the cheapest eligible GPU, capped by `--max-budget`). At provisioning time the backend re-reads the
  catalog and tries each available GPU in range, cheapest first, moving on when one rejects for capacity; the
  GPU actually used is recorded in `run.json`. Pin one with `--gpu` and nothing else is substituted. Persistent
  runs stay in the volume's datacenter; an unpinned ephemeral run may upload to any datacenter with capacity
  (pin with `--datacenter`), which the quote says.

## Shutdown is not guaranteed

There is **no independent scheduler** and no provider-enforced lifetime. Runpod has no lifetime field on Pod
creation, and a Pod whose process exits keeps billing. Shutdown is enforced on a best-effort basis by:

- the **client-side deadline**, while MoleculeDesk is running and connected;
- **automatic cleanup** after success, failure, cancellation or transfer failure, confirmed with the provider;
- the **in-Pod watchdog** where the Pod-scoped key is injected (it cannot help if the container never boots;
  key expiry and GPU Pod injection are unverified);
- the **cleanup journal and restart recovery**: the next start refuses new paid work while owed or orphaned
  resources exist, and `moldesk cloud recover <run-id>` finishes cleanup without restarting inference.

Before you approve a run, MoleculeDesk shows this warning prominently and requires explicit acknowledgment:

> If MoleculeDesk closes or loses connection, your Runpod Pod may keep running and charging. Automatic shutdown
> is not guaranteed. Check your Runpod dashboard and terminate any remaining Pod.

Persistent caching additionally requires acknowledging that storage charges continue until the volume is
deleted. Without a terminal, pass `--yes --accept-lifetime-risk` (and `--accept-storage-charges` for persistent);
`--yes` alone is refused. Acknowledgments are recorded in `run.json` (`compute.acknowledgedRisks`).

## Using it (once enabled)

```bash
moldesk cloud connect runpod           # hidden prompt, or --key-stdin
moldesk cloud status
moldesk run boltz complex.yaml --compute runpod --cache-policy ephemeral \
  --max-budget 2 --max-lifetime 3600 --dry-run      # print the quote only (add --max-gpu-price, --gpu-image to tune)
moldesk run boltz complex.yaml --compute runpod --cache-policy persistent \
  --max-budget 2 --max-lifetime 3600                 # prompts for each acknowledgment, then approval
# without a terminal, acknowledge explicitly (--yes alone is refused):
moldesk run boltz complex.yaml --compute runpod --cache-policy ephemeral \
  --max-budget 2 --max-lifetime 3600 --yes --accept-lifetime-risk
moldesk cloud resources
moldesk cloud recover <run-id>
moldesk cloud cache list
moldesk cloud cache delete boltz
```

Credentials: the OS keyring is the default. An explicit `RUNPOD_API_KEY` environment variable is accepted as
a development override and takes precedence when set. `.env` files are never read, and there is no
plaintext fallback.

## Exit codes

`0` success, `2` usage, `3` unknown model, `4` unsupported, `5` not installed, `7` run failed, `8` cancelled,
`10` internal, `11` credential/auth, `12` provider (payment, capacity, rate limit, unavailable),
`13` cleanup pending or orphaned resources, `14` consent/safety refusal (approval mismatch or expiry,
re-quote required, acknowledgment missing, worker bundle unavailable).

## What the code enforces (tested with fakes only)

- **Quote before spend, with explicit coverage.** The quote lists what `--max-budget` is compared against and
  what it is not: GPU (and preparation-CPU) compute at catalog rates for the lifetime limit is counted;
  container-disk charges are counted only if the provider publishes a rate; retained network-volume storage
  (billed monthly) is shown separately and never folded into the one-run budget; transfer and other provider
  fees are not counted. Runpod's catalog API publishes **no disk or volume rates**, so those costs are shown
  as *unknown* rather than estimated. The budget is a guard on an estimate, not a provider-enforced cap.
- Approval is bound to the quote id (inputs, model, GPU, datacenter, cache policy, images, limits) and expires
  after 15 minutes. It is re-checked against a fresh quote before provisioning: a location change, a price rise
  above 10%, any change in **what the budget covers** (an unknown storage rate becoming known, or the reverse,
  different disk/volume sizes or machine counts), or a material rise in container-disk, recurring-storage or
  counted-total cost (above 10% and above a small absolute floor) requires a new approval. Decreases and
  in-tolerance moves with the same coverage do not.
- Intent is journaled before every create and delete; ambiguous creates are never blindly retried.
- Paid machines are terminated and independently verified gone before the report is generated;
  cleanup failure is reported as `CLOUD_CLEANUP_PENDING` without discarding a valid result.
- New paid work is refused while orphaned or owed resources exist or the provider cannot be listed.
- **Logs are saved locally.** Worker stdout/stderr are appended to `stdout.log` / `stderr.log` in the run
  directory as they arrive (also with `--json`), referenced by `run.json`, and drained once more before
  cleanup, so they survive Pod termination. **Complete logs are not guaranteed:** the worker keeps only a
  bounded in-memory tail (4 MiB). It numbers chunks and reports exactly how many a reader missed; the client then
  writes a marker into both local logs, adds a `CLOUD_LOGS_INCOMPLETE` warning to the run and records
  `compute.logs = { complete: false, lostChunks }` (also during `cloud recover`). The run itself still succeeds
  or fails on its own merits.
- **Transfers are bounded and cancellable.** Timeouts and cancellation stay active while response bodies
  stream: a stalled download is aborted after the idle timeout and resumed by byte range, cancellation aborts
  immediately, and a JSON response that never finishes times out. Downloads are verified per file (size and
  SHA-256), staged and promoted atomically; unsafe or duplicate paths are rejected; a transfer retry never
  reruns inference.
- The persistent volume is only deleted by `cloud cache delete`, after listing exactly what goes.

## Known gaps (do not treat cloud execution as complete)

- Shutdown is best effort (see above); live validation and real-provider behavior are open: plan section 13.
- Storage and egress costs are unknown for Runpod (no published rates); the budget does not cover them.
- Worker log retention is a bounded tail; loss is detected and reported, not prevented. Only the cumulative
  evicted byte count is known, not the content, and the oldest output of a very chatty job can be gone.
- Upload timeouts are a single overall limit (10 minutes), not idle-based.
