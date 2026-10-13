# Cloud execution (Runpod)

Status: **work in progress, disabled by default, not releasable.** The code paths exist and are tested with
mocks and local fixtures only; nothing has been validated against real paid compute.
Read [runpod-execution-implementation-plan.md](./runpod-execution-implementation-plan.md) and
[runpod-spike-findings.md](./runpod-spike-findings.md) for design and evidence.

## What is gated

Cloud runs refuse to start until all of these exist:

1. **A model that declares a validated `cloud` block** in its manifest (see [model-system.md](./model-system.md)).
   No shipped manifest declares one: image digests and sizes must come from a live validation.
2. **A published worker bundle.** `pnpm --filter @moldesk/core build:worker` produces `worker.tgz` and its
   SHA-256. Record the URL and checksum in `packages/core/src/cloud/worker-release.ts`
   (`RELEASED_WORKER_BUNDLE`), or set `MOLDESK_WORKER_BUNDLE_URL` and `MOLDESK_WORKER_BUNDLE_SHA256` for
   development. The generic worker images must provide Node 20+, curl, tar and sha256sum.
3. **An independent lifetime guard.** `resolveDeadlineGuard()` currently refuses with
   `CLOUD_GUARD_UNAVAILABLE`. Container exit does not stop billing, there is no lifetime field on Pod
   creation, and Runpod's Pod-scoped key (used by the in-Pod watchdog) cannot cover failures before the
   container boots. A verified external scheduler, authorized with narrow credentials, is a release blocker.

## Using it (once enabled)

```bash
moldesk cloud connect runpod           # hidden prompt, or --key-stdin
moldesk cloud status
moldesk run boltz complex.yaml --compute runpod --cache-policy ephemeral \
  --max-budget 2 --max-lifetime 3600 --dry-run      # print the quote only
moldesk run boltz complex.yaml --compute runpod --cache-policy persistent \
  --max-budget 2 --max-lifetime 3600                 # prompts; --yes approves exactly the shown quote
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
re-quote required, guard or worker bundle unavailable).

## What the code enforces (tested with fakes only)

- **Quote before spend, with explicit coverage.** The quote lists what `--max-budget` is compared against and
  what it is not: GPU (and preparation-CPU) compute at catalog rates for the lifetime limit is counted;
  container-disk charges are counted only if the provider publishes a rate; retained network-volume storage
  (billed monthly) is shown separately and never folded into the one-run budget; transfer and other provider
  fees are not counted. Runpod's catalog API publishes **no disk or volume rates**, so those costs are shown
  as *unknown* rather than estimated. The budget is a guard on an estimate, not a provider-enforced cap.
- Approval is bound to the quote id (inputs, model, GPU, datacenter, cache policy, images, limits), expires
  after 15 minutes, and a price rise above 10% or any location change requires a new approval.
- Intent is journaled before every create and delete; ambiguous creates are never blindly retried.
- Paid machines are terminated and independently verified gone before the report is generated;
  cleanup failure is reported as `CLOUD_CLEANUP_PENDING` without discarding a valid result.
- New paid work is refused while orphaned or owed resources exist or the provider cannot be listed.
- **Logs are saved locally.** Worker stdout/stderr are appended to `stdout.log` / `stderr.log` in the run
  directory as they arrive (also with `--json`), referenced by `run.json`, and drained once more before
  cleanup, so they survive Pod termination. The worker keeps only a bounded in-memory tail (4 MiB), so a very
  chatty job can lose its oldest output.
- **Transfers are bounded and cancellable.** Timeouts and cancellation stay active while response bodies
  stream: a stalled download is aborted after the idle timeout and resumed by byte range, cancellation aborts
  immediately, and a JSON response that never finishes times out. Downloads are verified per file (size and
  SHA-256), staged and promoted atomically; unsafe or duplicate paths are rejected; a transfer retry never
  reruns inference.
- The persistent volume is only deleted by `cloud cache delete`, after listing exactly what goes.

## Known gaps (do not treat cloud execution as complete)

- Lifetime guard, live validation and real-provider behavior: see the list above and plan section 13.
- Storage and egress costs are unknown for Runpod (no published rates); the budget does not cover them.
- Worker log retention is a bounded tail; the full stream is not guaranteed for very large outputs.
- Upload timeouts are a single overall limit (10 minutes), not idle-based.
