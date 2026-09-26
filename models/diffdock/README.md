# DiffDock-L adapter

Blind small-molecule docking: given a protein structure and a ligand (file or
SMILES), returns ranked 3D poses with a confidence score per pose. Not a
binding-affinity predictor — for that, see `models/boltz/`.

## Source

- Repository: https://github.com/gcorso/DiffDock (MIT — `LICENSE`, Copyright
  (c) 2022 Gabriele Corso, Hannes Stärk, Bowen Jing)
- Pinned revision: `85c49b60d3e0b0182a59ee43a34a6d7036981284`, HEAD of `main`
  as of 2026-09-23 (confirmed live via `git ls-remote`).
- `main` already ships **DiffDock-L**, not legacy DiffDock v1 — upstream's
  own README states: "By default the repository now runs the new model
  [DiffDock-L]... please use GitHub commit history to run the original
  DiffDock model." The legacy model is reachable only via a separate `v1.0`
  git tag, which this integration never touches.

## Platform / hardware: Linux + NVIDIA CUDA only

Upstream's pinned dependency stack (`torch==1.13.1+cu117` plus matching
`torch-scatter`/`torch-cluster`/`torch-sparse`/`torch-spline-conv` wheels
built specifically against that torch+CUDA combination) is CUDA/Linux-wheel
specific — verified live on 2026-09-23 by listing
`https://data.pyg.org/whl/torch-1.13.1+cu117.html`: no Apple Silicon build
exists at all for this combination. Upstream also exposes **no**
`--device`/`--cpu`/`--gpu` flag — device selection is DiffDock-L's own
unconditional `torch.device('cuda' if torch.cuda.is_available() else
'cpu')`. There is no genuine CPU-only path implemented in this pass. This
manifest declares `hardware.nvidiaGpu: required` and `hardware.cuda.level:
required`, and `verifyInstallation` runs a mandatory CUDA probe — an install
on a CUDA-less host fails verification rather than silently succeeding into
one that could fall back to CPU at run time. The probe doesn't just import
`torch_scatter`/`torch_cluster`/`torch_sparse` (some ABI/kernel mismatches
between the installed torch build and these CUDA-compiled extensions only
surface when a compiled kernel actually launches, not at import time) — it
executes one real minimal operator from each on a CUDA tensor, using call
signatures verified directly against each pinned version's real source. This
exact probe has not itself been run against real CUDA hardware (none was
available); spot-check it during the real live gate.

## Python version constraint (non-obvious)

The manifest pins `python: "3.10"`, not `"3.11"` (unlike Boltz). Verified
live on 2026-09-23: `torch==1.13.1+cu117`'s matching PyTorch Geometric
extension wheels (`torch-scatter`/`torch-cluster`/`torch-sparse`/
`torch-spline-conv` at the exact `+pt113cu117` build upstream's own
`requirements.txt` pins) are published on `data.pyg.org` only up through
`cp310` — no `cp311` build exists at this torch+CUDA combination. Python
3.11 would fail dependency resolution entirely.

## Package index, find-links, and binary-only enforcement (non-obvious, revised after review)

None of the pinned CUDA-specific wheels (`torch==1.13.1+cu117` and the four
PyG extension packages) are published on default PyPI, but ordinary packages
(pandas, scipy, rdkit, …) *are* — a first version of this manifest wrongly
set `UV_INDEX_URL` to PyTorch's cu117 index, which **replaces** the default
index rather than adding to it, breaking resolution of every ordinary
dependency. It also passed PyTorch Geometric's flat wheel-listing page as an
extra *index* even though upstream's own `environment.yml`/`requirements.txt`
both use `--find-links` for it — a different pip/uv mechanism, since that
page is a flat listing (verified live: no per-package subdirectory
structure), not a PEP-503 index.

Fixed: `packages/registry/src/schema.ts`'s `pythonRuntimeSchema` now has two
separate fields — `extraIndexUrls` (PEP-503-style, added *alongside* default
PyPI, never replacing it; wired to `UV_EXTRA_INDEX_URL`) and `findLinks`
(flat wheel-listing pages; wired to `UV_FIND_LINKS`) —
`packages/runtime/src/install/index.ts`'s `managedEnvironment`. This
manifest's runtime entry sets `extraIndexUrls: [https://download.pytorch.org/whl/cu117]`
and `findLinks: [https://data.pyg.org/whl/torch-1.13.1+cu117.html]` (the
canonical host `pytorch-geometric.com` redirects to, confirmed to serve the
identical listing).

Every ABI-sensitive CUDA extension package (`torch`, `torch-cluster`,
`torch-scatter`, `torch-sparse`, `torch-spline-conv`) now also carries a real
`hashes` entry — downloaded and verified byte-for-byte on 2026-09-24, mostly
straight from the PyTorch/PyG index pages' own `#sha256=...` href fragments
(PyPI's JSON API for `torch-geometric`, which is pure Python with no wheel at
all, only an sdist) — AND is listed in a new `binaryOnly` manifest field,
wired to `--only-binary <name>` on every `uv pip install` invocation
(`packages/registry/src/schema.ts`, `packages/runtime/src/install/index.ts`).
This makes "never silently build an ABI-sensitive package from source" a
structural, enforced property (install fails closed if wheel resolution ever
fails) rather than an incidental side effect of caching. `torch-geometric`
is deliberately excluded from `binaryOnly` since forcing wheel-only there
would make it uninstallable.

## OpenFold install ordering (non-obvious, revised after review)

Upstream's `requirements.txt` lists every dependency (including `openfold`)
for a single combined `pip install` — but upstream's own `environment.yml`
(the more carefully maintained, explicitly-sequenced recipe; verified live
on 2026-09-24) does three separate, ordered install stages with explicit
rationale comments: (1) conda-install a pinned older `setuptools==69.5.1`
first — comment: *"Need older setuptools for openfold"* (`openfold`'s build
is incompatible with modern setuptools, which removed distutils); (2) `pip
install` torch plus every other pinned dependency — comment: *"Need to
install torch in order to build openfold, so install it first"*; (3) `pip
install openfold` alone, in its own separate later invocation. `openfold`'s
own `setup.py` imports `torch` at build time to select CUDA architecture
flags for its compiled extension, so a single combined resolver invocation
cannot reliably guarantee that ordering.

Two new reusable manifest fields capture this (`packages/registry/src/schema.ts`,
wired into a genuinely staged install in
`packages/runtime/src/install/index.ts`'s `preparePythonEnvironment`):
`preInstall` (requirements installed first, each in its own separate
invocation — this manifest: `setuptools==69.5.1`) and `buildAfter` (requirement
names deferred to their own final separate invocation, strictly after every
other requirement including `preInstall` — this manifest: `openfold`).

## Every network-fetch path is pinned, not just the obvious one

Three real download paths were found by reading the pinned revision's
source, not assumed from the README:

1. `inference.py` downloads `diffdock_models.zip` (the score + confidence
   model weights) from a GitHub release when `--model_dir` doesn't already
   exist. Pinned as manifest asset `diffdock-l-weights`
   (`https://github.com/gcorso/DiffDock/releases/download/v1.1/diffdock_models.zip`,
   129,825,226 bytes, sha256 downloaded and verified byte-for-byte on
   2026-09-23), extracted into `assets/diffdock-weights/{score_model,
   confidence_model}/`, always passed via `--model_dir`/
   `--confidence_model_dir` so the existence check short-circuits the
   download.
2. **Every run unconditionally computes ESM2 language-model embeddings** —
   `utils/inference_utils.py`'s `InferenceDataset` is always constructed
   with `lm_embeddings=True`, not just on some batch-mode branch — which
   downloads the `esm2_t33_650M_UR50D` checkpoint (2,604,537,549 bytes) plus
   its small contact-regression file into `torch.hub`'s cache dir on first
   use. Both pinned as manifest assets (`esm2-t33-650m-ur50d`,
   `esm2-t33-650m-ur50d-contact-regression`; MIT, Meta Platforms), sha256
   downloaded and verified on 2026-09-23, extracted into
   `assets/torch-home/hub/checkpoints/`. The adapter always sets
   `env.TORCH_HOME` to that pre-populated directory.
3. `dllogger` is a git-sourced dependency upstream itself pins **unpinned**
   (`dllogger@git+https://github.com/NVIDIA/dllogger.git`, no `@revision` —
   a real upstream laxity). This manifest pins the commit that was
   `dllogger`'s HEAD when verified on 2026-09-23
   (`0478734ff7be75adde8d160e04872664d1c62e5f`); re-check whether upstream
   has since adopted its own pin before reusing this value indefinitely.

`openfold`'s pinned commit
(`4b41059694619831a7db195b7e0988fc4ff3a307`) was independently confirmed to
exist via a real `git fetch` on 2026-09-23.

**`requirements.txt` vs `environment.yml` discrepancy**: the two files
disagree on `e3nn` (`0.5.0` vs `0.5.1`) and `environment.yml` additionally
pins `pytorch-lightning==1.9.5`, entirely absent from `requirements.txt`.
Verified live on 2026-09-24 that `environment.yml` is the more carefully
maintained, explicitly-sequenced recipe (see the OpenFold ordering section
below), so this manifest follows its pins (`e3nn==0.5.1`,
`pytorch-lightning==1.9.5` added) rather than `requirements.txt`'s.

## Job format and confirmed checkpoint filenames

`moldesk run diffdock <job.json>` accepts:

```json
{ "jobName": "optional-safe-identifier", "proteinPath": "protein.pdb", "ligand": { "path": "ligand.sdf" } }
```

(or `"ligand": { "smiles": "CCO" }` instead of `path`). `jobName` becomes a
literal path segment under DiffDock-L's `--out_dir` with **no upstream
sanitization at all** — the adapter validates it against a safe-identifier
allowlist before any run starts.

`proteinPath`/`ligand.path` are staged via the shared, generic
`packages/runtime/src/filesystem/companion-inputs.ts` (used by any model
whose job file references separate companion files). Its confinement check
canonicalizes the *entire* resolved path with `realpathSync` before the
boundary check, not just the final path component — an earlier version only
checked whether the leaf itself was a symlink, which misses a reference like
`sub/file.pdb` where `sub` (an ancestor directory, not the leaf) is a symlink
pointing outside the allowed root: the OS silently resolves that ancestor
symlink during ordinary path traversal, so `lstat` on the leaf alone would
report a plain regular file and never reveal the symlink at all. Covered by
a dedicated regression test in `companion-inputs.test.ts`.

Confirmed by inspecting the actual `diffdock_models.zip` contents (not
assumed from CLI `--help` defaults, which are wrong): the confidence
checkpoint file is `best_model_epoch75.pt`, not the CLI's own
`--confidence_ckpt` default of `best_model.pt`. The score checkpoint
(`best_ema_inference_epoch_model.pt`) does match its CLI default.

## `--config` merge behavior (non-obvious, load-bearing)

`inference.py`'s `main()` loads `--config default_inference_args.yaml` and
then unconditionally overwrites `args.__dict__[key] = value` for **every**
key present in that YAML — including keys already set from explicit CLI
flags. That means passing `--model_dir`/`--samples_per_complex`/etc.
alongside upstream's own config file would be silently clobbered back to
its baked-in `./workdir/v1.1/...` relative paths and tuned defaults
(verified directly against `main()`'s source). The adapter's `command()`
derives a run-scoped config at run time (`buildRunScopedConfig` in
`packages/adapters/src/diffdock/index.ts`): it reads the *installed pinned
source's own* `default_inference_args.yaml` fresh on every run and strips
exactly the five keys that must be MoleculeDesk/param-controlled
(`model_dir`, `confidence_model_dir`, `samples_per_complex`,
`inference_steps`, and `actual_steps` — which would otherwise silently
override `--inference_steps` per `main()`'s own fallback logic). Every
other tuned sampling hyperparameter (`temp_*`, `sigma_schedule`,
`initial_noise_std_proportion`, `old_filtering_model`, checkpoint
filenames, …) is carried over byte-for-byte from whatever the pinned source
ships, so model behavior never independently drifts from upstream and
there is no hand-maintained adapter-side copy that could go stale.

## Params

- `samples_per_complex` (default 10, min 1)
- `inference_steps` (default 20, min 1)
- `batch_size` (default 10, min 1)

No `device`/`seed` param exists: upstream exposes neither. Reproducibility
across repeated runs with identical params is therefore **not** guaranteed
by a seed — DiffDock-L's diffusion sampling draws from global RNG state
with no exposed control. A future live-gate run should document the actual
observed reproducibility behavior rather than assume determinism.

## Outputs

- `top_pose`: `<complex>/rank1.sdf` — the single highest-confidence pose.
- `ranked_poses`: `<complex>/rank*_confidence*.sdf` — every sampled pose,
  filename-encoded rank + confidence, upstream-sorted descending.
- `poses_summary`: an adapter-authored (not upstream) `poses_summary.json`
  synthesized from those filenames — structured rank/confidence/atom-count
  per pose, plus `topPoseFile`, so `run.json` carries a checksummed,
  structured record rather than only filename-encoded metadata.

Every pose file (`rank1.sdf` and each `poses_summary` entry) is required to
be a real, non-empty, parseable SDF with a positive atom count
(`requireValidSdfPose` in `packages/adapters/src/diffdock/index.ts`) — a
correctly-named file alone does not count as a valid output; an empty or
malformed pose fails the whole run (`INVALID_RUN_OUTPUT`) rather than
silently reporting success. Output collection (the shared
`packages/adapters/src/outputs.ts`, used by every model) also never follows
symlinks at any level — a matched candidate is checked with `lstat`, not
`stat`, so a model process could not point a `rank1.sdf`-named symlink (or a
symlinked complex-name directory) outside `outputDir` and have it silently
collected and checksummed.

## Verification status

`pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm pack:verify` all pass
with `diffdock` registered. On this development machine (Darwin/arm64, no
NVIDIA GPU), `moldesk list` correctly reports `diffdock` as
`planned`/`not installable`, and `moldesk install diffdock` fails closed
immediately (`MODEL_PLANNED`) rather than attempting an install that could
never succeed on this hardware.

**The real live gate has not been run** — it requires a Linux host with a
real NVIDIA GPU, which was unavailable throughout this pass. Per the
model-expansion rules, `status` stays `planned` until that run completes.
The exact commands a future run should use:

```bash
moldesk install diffdock
moldesk run diffdock examples/diffdock/job.json
```

Expected outcome once run: at least one parseable `.sdf` pose with finite
coordinates, an atom count matching the input ligand, confidence/rank
metadata in `poses_summary.json`, and complete input/output hashes in
`run.json`. Repeat the run once and record whether coordinates/confidence
are bit-identical (see Params above — likely not, given no exposed seed).
If CUDA is genuinely unavailable, the run should fail closed at install
verification with an actionable error, not silently fall back to CPU.
