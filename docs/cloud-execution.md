# Cloud execution (Runpod)

Status: implemented behind explicit safety gates; **not enabled for any model and not releasable yet**.
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
moldesk cloud connect runpod           # hidden prompt, or --key-stdin; or set RUNPOD_API_KEY / .env
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

Credential lookup order: environment variable, `.env` in the working directory, then the OS keyring.
There is no plaintext fallback.

## Exit codes

`0` success, `2` usage, `3` unknown model, `4` unsupported, `5` not installed, `7` run failed, `8` cancelled,
`10` internal, `11` credential/auth, `12` provider (payment, capacity, rate limit, unavailable),
`13` cleanup pending or orphaned resources, `14` consent/safety refusal (approval mismatch or expiry,
re-quote required, guard or worker bundle unavailable).

## Guarantees the code enforces

- Quote before spend: a worst-case compute ceiling is checked against `--max-budget` before anything is
  provisioned. It is a guard on an estimate, not a provider-enforced cap. Storage rates are shown as unknown.
- Approval is bound to the quote id (inputs, model, GPU, datacenter, cache policy, images, limits), expires
  after 15 minutes, and a price rise above 10% or any location change requires a new approval.
- Intent is journaled before every create and delete; ambiguous creates are never blindly retried.
- Paid machines are terminated and independently verified gone before the report is generated;
  cleanup failure is reported as `CLOUD_CLEANUP_PENDING` without discarding a valid result.
- New paid work is refused while orphaned or owed resources exist.
- Downloads are verified per file (size and SHA-256), staged and promoted atomically; unsafe or duplicate
  paths are rejected; a transfer retry never reruns inference.
- The persistent volume is only deleted by `cloud cache delete`, after listing exactly what goes.
