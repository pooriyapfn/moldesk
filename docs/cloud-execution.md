# Cloud execution (Runpod)

Status: **Boltz-2 and ProteinMPNN are supported with `ephemeral` caching; `persistent` caching is
experimental.** Other models are not enabled for cloud execution. The code paths are tested with fakes and were
validated live on Runpod in October 2026 (evidence in [runpod-spike-findings.md](./runpod-spike-findings.md)).
Read [runpod-execution-implementation-plan.md](./runpod-execution-implementation-plan.md) and
[runpod-spike-findings.md](./runpod-spike-findings.md) for design and evidence.

## What a run requires

Cloud runs refuse to start unless all of these exist:

1. **A model that declares a validated `cloud` block** in its manifest (see [model-system.md](./model-system.md)).
   Boltz-2 and ProteinMPNN do; every other model is refused with an explanation. A block may list the GPUs the
   model can run on (`gpuAllowList`); ProteinMPNN's pinned torch has no kernels for Blackwell GPUs, so only
   Ampere, Ada and Hopper NVIDIA GPUs are quoted, tried as a fallback, or accepted with `--gpu`.
2. **A published worker bundle.** The worker is a small Node program that runs inside the Pod: it serves an
   authenticated endpoint, runs the manifest install/run pipeline and the in-Pod watchdog. `pnpm --filter
   @moldesk/core build:worker` builds `worker.tar` deterministically (same sources, same SHA-256). The CLI
   records the release asset URL and checksum in `packages/core/src/cloud/worker-release.ts`
   (`RELEASED_WORKER_BUNDLE`) and refuses to run a bundle that does not match. Maintain it with
   `node scripts/worker-release.mjs update --tag vX.Y.Z`; CI fails when the recorded checksum no longer matches
   the sources, and the release workflow attaches `worker.tar` to the GitHub Release before publishing to npm.
   For development, set `MOLDESK_WORKER_BUNDLE_URL` and `MOLDESK_WORKER_BUNDLE_SHA256`. End users do nothing:
   the URL and checksum ship inside the CLI they installed.

Which models are enabled, and why the others are not:

| Model | Cloud status |
|---|---|
| Boltz-2 | Supported (`ephemeral`); `persistent` experimental |
| ProteinMPNN | Supported (`ephemeral`), on the GPUs in its allow-list |
| LigandMPNN | Not enabled: its live run could not download the weights from the upstream host |
| DiffDock-L | Supported (`ephemeral`), on the Ampere GPUs in its allow-list. The protein file is uploaded, so the run needs `--accept-file-upload` (see below) |
| BindCraft2 | Not enabled yet: its job references extra files, which can now be uploaded (see below), but it has no cloud block or live run |
| RFD4-Proteina | Runs in `ephemeral` mode on the A100, H100/H200, L40S and RTX 6000 Ada GPUs in its allow-list. Live-validated on the RTX 6000 Ada (100-residue monomer, about 2.7 minutes, roughly $0.05) and the L40S (PD-L1 binder, four designs, about 4 minutes, roughly $0.07). The CIF next to the spec is uploaded, so it needs `--accept-file-upload` |
| OpenDDE | Supported (`ephemeral`), on the Ampere, Ada and Hopper GPUs in its allow-list with at least 24 GB. No `.pdb` copy of the structure is made in cloud runs (the mmCIF is returned). Jobs that reference ligand files have not been run |

## Cache policies

- **`ephemeral`** (supported): the GPU Pod downloads the model assets, installs the runtime, runs the model and is
  terminated. Nothing is kept. A live Boltz run took about 4 minutes end to end on an RTX 3090.
- **`persistent`** (experimental): a CPU Pod prepares the assets on a retained network volume, then a GPU Pod
  mounts it. The cold run worked and a warm run reused the cache, but on standard volumes preparation was slow
  (about 20 minutes of CPU time at ~25 MB/s, 43 minutes end to end for Boltz), so it is slower than `ephemeral`
  for a single run. The volume keeps billing until you delete it with `moldesk cloud cache delete`.

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
deleted. Jobs that upload extra files from your computer need `--accept-file-upload` too (see below). Without a terminal,
pass `--yes --accept-lifetime-risk` (and `--accept-storage-charges` for persistent); `--yes` alone is refused. Acknowledgments are recorded in `run.json` (`compute.acknowledgedRisks`).

## Using it

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

## Files your job file references

Some models take a job file that points at other files on your computer (DiffDock-L's protein structure, BindCraft2's
targets, OpenDDE's ligand files). MoleculeDesk finds them through the model's adapter and handles them like this:

- **You approve the upload explicitly.** The quote lists every such file (its role, exact local path, size and a
  short checksum) in a warning at the top, and the run needs a separate acknowledgment, `upload-files`: an answered
  prompt, or `--accept-file-upload` without a terminal. `--yes` and `--accept-lifetime-risk` do not cover it. The
  file you named on the command line is listed but does not need this extra acknowledgment. `--dry-run` shows the
  list and uploads nothing.
- **Nothing leaves before approval.** Planning only reads and hashes the files locally. They are copied into the run
  folder and uploaded only after the approval is checked, and each file's checksum is part of the quote id, so a file
  that changes after you approved stops the run and asks for a new approval.
- **A job cannot pull in other files.** A reference must be a regular file inside the job file's own folder; paths that
  escape it, symlinks that leave it, directories and devices are refused.
- **Limits:** at most 16 extra files and 4 GiB across everything uploaded (the worker also caps one file at 2 GiB);
  beyond that the quote is refused with `CLOUD_COMPANION_LIMIT`.
- On the machine the files sit under `input/<id>/<name>` and are given to the adapter by id, the same layout a local
  run uses. They are recorded in `run.json` (`input`, with each file's role and checksum) and the acknowledgment in
  `compute.acknowledgedRisks`.

## Exit codes

`0` success, `2` usage, `3` unknown model, `4` unsupported, `5` not installed, `7` run failed, `8` cancelled,
`10` internal, `11` credential/auth, `12` provider (payment, capacity, rate limit, unavailable),
`13` cleanup pending or orphaned resources, `14` consent/safety refusal (approval mismatch or expiry,
re-quote required, acknowledgment missing, worker bundle unavailable).

## What the code enforces (tested with fakes; the live runs are in the spike findings)

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

- Shutdown is best effort (see above). The in-Pod watchdog was verified live: with the client killed
  mid-run, the orphaned Pod terminated itself at its deadline. It cannot help if the container never boots.
- Runpod's proxy occasionally returns a transient 404 to the first calls after the Pod reports healthy (2 of 3
  live ProteinMPNN attempts). The client does not retry it yet; the run fails cleanly, cleanup is confirmed, and
  re-running works.
- Only ProteinMPNN restricts GPUs. The catalog also offers GPUs a model's framework may not support (AMD, and
  Blackwell for older torch builds); a model without `gpuAllowList` can be offered them if the price range allows.
- GPU memory and disk sizes in manifests come from short runs (a 46-residue ProteinMPNN input); larger inputs
  may need more. `run.json` records the peaks (`compute.usage`) so sizes can be revisited.
- Storage and egress costs are unknown for Runpod (no published rates); the budget does not cover them.
- Worker log retention is a bounded tail; loss is detected and reported, not prevented. Only the cumulative
  evicted byte count is known, not the content, and the oldest output of a very chatty job can be gone.
- Upload timeouts are a single overall limit (10 minutes), not idle-based.
