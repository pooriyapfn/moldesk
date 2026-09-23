# Boltz-2 adapter

Dual-runtime: genuinely different upstream distributions per platform, both
pinned to a full immutable commit + PyPI version.

## Linux x64 / CUDA — official `boltz`

- Repository: https://github.com/jwohlwend/boltz (MIT)
- Pinned revision: `cb04aeccdd480fd4db707f0bbafde538397fa2ac` (tag `v2.2.1`,
  confirmed current — not superseded — as of 2026-09-23).
- PyPI `boltz==2.2.1`: `requires-python <3.13,>=3.10`; wheel sha256
  `b8c62bbdede1922931d9203118f62c858f11aa699bf91fd4c05a5ed6a6d8b4fc`
  (268390 bytes); sdist sha256
  `355a033ce2b49543a927470d585136794521d8639b2eeb5a1818d74dc3e513c3`.
- Console script: `boltz = "boltz.main:cli"` (`pyproject.toml`
  `[project.scripts]`).
- `boltz predict`'s `--accelerator` choice on this pinned CLI is
  `gpu|cpu|tpu` — **no `mps` choice** (verified directly against
  `src/boltz/main.py` at the pinned revision). The adapter rejects
  `--param accelerator=mps` on this install with an actionable
  `INVALID_RUN_PARAMS` error rather than silently falling back.
- `hardware`/runtime-entry accelerator requirement: `nvidiaGpu: required`,
  `cuda.level: required`. Not merely `recommended`: `verifyInstallation` runs
  a mandatory CUDA probe on every non-Darwin install with no CPU verification
  path implemented, so `recommended` would let a CPU-only Linux host pass
  compatibility checks only to fail install — declaring it `required` matches
  what's actually enforced. `--accelerator cpu` is a real choice on the
  pinned CLI, but this adapter doesn't yet implement a CPU-only install path.

## Darwin arm64 / MPS — `boltz-community` fork

- Repository: https://github.com/Novel-Therapeutics/boltz-community (MIT)
- Pinned revision: `401f18150cc7184b7e1bb37239a25035ef6b3a57` (tag
  `v2.10.12`, confirmed the latest tag as of 2026-09-23).
- PyPI `boltz-community==2.10.12`: `requires-python >=3.10` (no upper cap);
  wheel sha256 `cb8670fde72018fe904eb30b8d8cb4034be04c453ccb2a65d57ff5980898509b`
  (296137 bytes); sdist sha256
  `7dc5475087ce41ff97f2f788d9d441e633e75b3f6cc0b49f8edf00b055054beb`. It also
  exposes a `cuda` extra, which this platform's install deliberately does
  **not** use (plain `boltz-community`, no extras) — this platform has no
  CUDA requirement.
- Console scripts: `boltz = "boltz.main:cli"` and
  `boltz-fix-macos-libomp = "boltz.scripts.fix_macos_libomp:main"`
  (`pyproject.toml` `[project.scripts]`, verified at the pinned revision).
  The manifest's `postInstall: [boltz-fix-macos-libomp]` runs the latter via
  its installed console-script path (no shell, no manifest-controlled
  string) immediately after dependency install.
- `boltz predict`'s `--accelerator` choice on this pinned CLI is
  `gpu|cpu|tpu|mps` (verified directly against `src/boltz/main.py` at the
  pinned revision) — the superset that adds Apple Silicon MPS support. The
  adapter rejects `--param accelerator=gpu` on this install (the install has
  no CUDA) with an actionable `INVALID_RUN_PARAMS` error.
- This platform-runtime entry declares no `nvidiaGpu`/`cuda` block at all —
  it has no CUDA requirement, only MPS.
- **Pinned `torch` for this entry: `2.14.0`** (cp311 macOS arm64 wheel,
  `torch-2.14.0-cp311-cp311-macosx_14_0_arm64.whl`, sha256
  `ae530ddd3f3b94248b77f1fd3313c4f3405bd0d17283d505b81574816767133a`,
  127277244 bytes — from PyPI's `torch` release JSON, fetched 2026-09-23).
  `2.14.0` was the latest stable PyPI `torch` release as of 2026-09-23 and is
  the newest stable 2.x release, per the plan's "start with newest stable,
  fall back only on a confirmed MPS regression" rule. Note the wheel's own
  platform tag is `macosx_14_0_arm64` (requires macOS 14+), not
  `macosx_11_0_arm64` — PyPI no longer publishes an `11_0` tag for this
  version; this is a real constraint on the minimum macOS version for the
  Darwin/MPS runtime entry, recorded here rather than assumed.
  - Cross-checked against `boltz-community`'s own pinned `pyproject.toml`
    (`Novel-Therapeutics/boltz-community@401f18150cc7184b7e1bb37239a25035ef6b3a57`):
    its `[project.dependencies]` declares `torch>=2.2` (a lower bound, not an
    exact pin), which `2.14.0` satisfies; its README's "Compatible with
    PyTorch 2.6+" statement is also satisfied. Because `uv pip install`
    resolves both the top-level `torch==2.14.0` requirement and
    `boltz-community`'s transitive `torch>=2.2` constraint together against
    one dependency graph, there is no conflict: `2.14.0` is a valid solution
    for both, and the explicit top-level pin (with its `--hash` digest) is
    what actually gets installed — `boltz-community`'s own bound never asks
    for a different version.
  - MPS-regression research (2026-09-23, `pytorch/pytorch` GitHub issues +
    the 2.14 release blog/notes): no regression was found that blocks normal
    Boltz-style MPS usage on shipping macOS versions. The 2.14 cycle mostly
    *improves* MPS (further op migrations off `MPSGraph` onto hand-written
    Metal kernels, a five-part reductions rewrite, new native float32/complex64
    `torch.linalg` MPS implementations, allocator changes to bound memory
    growth on long-running workloads). Two issues were found that reference
    2.14.0-era MPS behavior, both scoped to the **macOS 27 beta** (the next,
    not-yet-shipping major OS version as of 2026-09-23), not any shipping
    macOS release: `pytorch/pytorch#197235` (`var`/`std`/`var_mean`
    intermittently wrong on large reductions, macOS 27 only, not reproducible
    on macOS 26) and `pytorch/pytorch#187280` (MPS-backend image-generation
    corruption, macOS 27 beta). Neither is a credible reason to fall back to
    an older release for this manifest, which targets shipping macOS/Darwin
    arm64 hosts; noted here so it can be revisited if macOS 27 ships and
    Boltz predictions start failing MPS verification.

Both distributions were checked flag-by-flag for the params the adapter
exposes (`--devices`, `--recycling_steps`, `--sampling_steps`,
`--diffusion_samples`, `--max_parallel_samples`, `--use_msa_server`,
`--no_kernels`, `--seed`, `--out_dir`, `--cache`) and define them
identically at both pinned revisions.

`--seed` is real on both pinned CLIs (`type=int, default=None`, i.e.
"no seeding" when omitted) — kept as an optional param with no default.

## Checkpoint/CCD provenance

Both pinned distributions' `download_boltz2()` fetches the CCD data and
model checkpoints from HuggingFace's *mutable* `resolve/main/...` URLs on
first prediction — that both defers population past install time (violating
the "checksum-pinned, installation-managed assets" requirement) and has no
fixed content upstream commits to verifying against.

Since upstream provides no immutable/checksum-pinned download path itself,
these three files are instead modeled as ordinary MoleculeDesk `assets:` in
the manifest, pinned to an exact HuggingFace repo commit
(`boltz-community/boltz-2 @ 6fdef46d763fee7fbb83ca5501ccceff43b85607`) with
sha256 digests read from that commit's `X-Linked-ETag` response header
(HuggingFace's convention for an LFS-tracked file's sha256) — and
independently confirmed by hashing a real download of every file
byte-for-byte on this machine:

| File | sha256 | Size |
| --- | --- | --- |
| `mols.tar` (CCD) | `39e076d96dbec6b4e86982bbda16f3a53a2a60c9bdc17828d88f6f9a0c7d1fd7` | 1,855,662,080 |
| `boltz2_conf.ckpt` | `090e82ac8c92f5e943fa1b39e7410a44027bea7243c0bbb3caa67a77fc1428e1` | 2,286,561,469 |
| `boltz2_aff.ckpt` | `dcc5cd3722b1c9eaa34267e4ae32f55cbbf1963f4c19319381ccfa30fdd2ca9e` | 2,062,139,170 |

These are materialized through the existing checksum-verified asset
pipeline (`cacheAsset`/`materializeAsset` — the same one ProteinMPNN's
checkpoint uses) into `assets/boltz-cache/`, the exact directory the
adapter passes as `--cache`. `mols.tar` uses a new `archive: tar` type
(plain, uncompressed tar — added to the asset schema/installer alongside
the existing `tar.gz`/`zip` support) and extracts to `boltz-cache/mols/`,
matching what `download_boltz2()` expects to find already present. Because
population and checksum verification happen during install (before
promotion), by the time any prediction runs, Boltz's own downloader finds
every file already there and performs no network access at all —
`verifyInstallation` also checks these three paths exist before passing.

This does not make MoleculeDesk immune to upstream publishing different
bytes at a *different* HF commit in the future — it does mean every install
made from this manifest version installs byte-identical, checksum-verified
checkpoint/CCD content, and a run can never silently execute against
partially-downloaded or corrupted cache contents.

## Accelerator default resolution

`accelerator` has **no static `ParamDescriptor.default`**: the correct
default depends on which platform-specific runtime entry was actually
installed, not `process.platform`. `boltzAdapter.resolveParamDefaults`
reads `installed.runtime.python.platform` (the installer's own record of
which entry it resolved and installed) and returns `{ accelerator: "mps" }`
for a `darwin-arm64` install or `{ accelerator: "gpu" }` otherwise. `run.ts`
calls this before `validateParams`, so `run.json`'s
`parameters.effective.accelerator` already shows the resolved value — an
explicit `--param accelerator=...` always overrides it, and an
incompatible explicit value (`mps` off Darwin, `gpu` on the CUDA-less
Darwin install) fails closed with `INVALID_RUN_PARAMS` before the process
is spawned.

## Outputs

Boltz writes `<out_dir>/boltz_results_<input_stem>/predictions/<record_id>/…`
(verified against `src/boltz/data/write/writer.py` at both pinned
revisions). The manifest declares precise, non-recursive globs (the shared
glob matcher only supports segment-wise `*`, not `**`):

- `structures` (required): `boltz_results_*/predictions/*/*.cif`
- `confidence` (required): `boltz_results_*/predictions/*/confidence_*.json`
- `affinity` (optional — only produced when an affinity checkpoint/config
  is used): `boltz_results_*/predictions/*/affinity_*.json`

## Input validation

Accepts `.yaml`/`.yml`/`.fasta`. YAML inputs get a minimal structural
check (non-empty, has a top-level `sequences:` key) — not a full Boltz
job-schema validator, just enough to reject an obviously-broken job before
a long run. `.fasta` inputs are only checked for non-emptiness.

## Status: `beta` — Darwin/MPS verified live; Linux/CUDA structurally implemented, live-unverified

### Darwin arm64 / MPS — verified live on 2026-09-23 (re-verified after review fixes)

Real end-to-end run on this machine, not mocks. This is the **second** live
verification pass: the first one caught (and this pass fixed) two P1 and
three P2 review findings — checkpoints were being downloaded unverified on
first run instead of install time, Linux hardware was declared
`recommended` while install enforced CUDA as mandatory, install
verification didn't assert exact distribution versions/absence of the
official package/CLI mps support, and YAML input validation used a regex
instead of a real parser. See "Bugs and gaps found and fixed" below for the
full list, including two from the *first* pass (relocatable venvs,
pre-promotion platform detection).

- **Host**: macOS (Darwin 25.6.0), Apple M3, 8 cores, 24.0 GB unified memory,
  arm64. Confirmed via `moldesk doctor` (`✓ Apple Silicon`, no NVIDIA GPU
  detected).
- **Clean install** (`moldesk install boltz --yes`, `~/.moldesk` models dir
  removed first): resolved the `darwin-arm64` runtime entry, installed
  `boltz-community==2.10.12` and `torch==2.14.0` (confirmed via
  `importlib.metadata.version(...)` inside the installed venv — not official
  `boltz`), and ran `boltz-fix-macos-libomp` during install (its stdout,
  captured in `installation.json`'s `runtime.python.postInstall`, shows it
  repointing `libtorch_cpu.dylib` and other duplicate `libomp.dylib` copies
  at one canonical `libomp.dylib` under
  `/opt/homebrew/Caskroom/miniforge/base/lib/libomp.dylib`).
- **Install-time verification** (`adapter.verifyInstallation`, run against
  the pre-promotion staging directory via the new `InstallContext.platform`
  field — see "Bugs found and fixed by this live run" below) passed with
  output `"mps ok: torch=2.14.0 boltz-community=2.10.12"`, from a probe that
  allocates a real tensor on `mps`, runs an op, and moves it back to `cpu`
  (not just `torch.backends.mps.is_available()`).
- **Real prediction**: `moldesk run boltz examples/boltz/protein.yaml
  --param accelerator=mps --param devices=1 --param recycling_steps=1
  --param sampling_steps=25 --param diffusion_samples=1`. Found the CCD and
  both checkpoints already present and checksum-verified in the
  installation-scoped cache (`<install>/assets/boltz-cache`, not `$HOME`) —
  see "Checkpoint/CCD provenance" below; log inspection confirms zero
  "Downloading" lines in stdout/stderr, i.e. genuinely no network access
  during this run. Completed in ~88s (vs. ~602s on the first verification
  pass, before checkpoints were install-time-populated — the entire
  difference is the eliminated first-run download). Process stderr shows
  PyTorch Lightning's own device banner: **`GPU available: True (mps), used:
  True`** — real accelerator selection reported by the running process, not
  merely pre-run detection. `run.json` status is `succeeded`.
- **Outputs**: `structures` → a well-formed mmCIF
  (`boltz_results_protein/predictions/protein/protein_model_0.cif`, sha256
  `10c77e95b4dfe27cb1146eeed2983b0c9530a89f18f33f57a66c53d749999734`, 79324
  bytes) and `confidence` → a parseable JSON with real metrics
  (`confidence_score: 0.659`, `ptm: 0.623`, `complex_plddt: 0.668`, sha256
  `0a3a0a12c76729db7f031ad976883dcd9377ae16c830d58dd143956249a1d4e1`, 655
  bytes), both checksummed in `run.json`. No orphan process after
  completion (`pgrep -f boltz` empty).
- **Negative test**: `--param accelerator=gpu` on this Darwin/no-CUDA
  install fails in 1 ms, before any process spawns, with
  `INVALID_RUN_PARAMS: "--param accelerator=gpu is not valid for this
  installation: the darwin-arm64 install uses boltz-community without CUDA
  support."` — an early, actionable failure, not a silent CPU fallback.

`torch==2.14.0` is therefore confirmed compatible with `boltz-community
==2.10.12` and real MPS inference on this host, not just by version-range
reasoning.

### Bugs and gaps found and fixed

#### First live-verification pass

Live verification surfaced two real defects that mocked `InstallContext`/
`runner` fixtures could not:

1. **`verifyInstallation` picked the CUDA probe on the first-ever install.**
   It read the installed platform from `installation.json`, but that file
   is written *after* `verifyInstallation` passes (staging → promotion is
   the next step) — so on a fresh install it was always absent, and the
   adapter fell back to the CUDA probe even on this Darwin host, failing
   with `torch.cuda.is_available() is False`. Fixed by adding a
   `platform?: PlatformId` field to `InstallContext`, populated by the core
   installer from its own already-resolved platform selection at both
   `verifyInstallation` call sites (pre-promotion staging verify and
   post-install re-verify); `installation.json` is now used only as a
   fallback for out-of-band callers. Same pattern as the existing
   `RunContext.platform` field.
2. **Console scripts broke after the atomic staging→target rename.** `uv
   venv` bakes the venv's absolute path into every generated console
   script's shebang. Because installs happen in a `.partial-<pid>-<uuid>`
   staging directory that gets renamed to its final target on success, the
   `boltz` console script's shebang pointed at a staging path that no
   longer existed post-rename (`exec: .../.partial-.../.venv/bin/python: No
   such file or directory`, exit 126) — this affects every python-runtime
   model that invokes a console script directly, not just Boltz. Fixed
   generically by adding `--relocatable` to the `uv venv` invocation in
   `packages/runtime/src/install/index.ts`, which makes `uv`-generated
   scripts resolve their interpreter relative to their own location instead
   of an absolute baked-in path — verified directly (created a relocatable
   venv, installed a package, moved the directory, confirmed the console
   script still ran).
3. Also fixed during this pass, before the live run: `uv pip install
   --require-hashes` requires the *entire* transitive dependency closure to
   be hashed, not just the manifest's declared top-level requirements
   (confirmed directly: it refused over an unhashed transitive `filelock`).
   Hand-pinning a full closure isn't practical for this manifest, so
   hash-declared requirements (`torch`) are now verified by artifact digest
   in a `--require-hashes --no-deps` pass first, then a second ordinary
   install pass resolves the full dependency closure normally. Also added
   an `extras?: string[]` field to `PythonRequirement` so the Linux/CUDA
   runtime entry can express `boltz[cuda]` (the milestone's required CUDA
   extra), which the original schema had no way to represent.

#### Second pass — external review findings (all fixed, then re-verified live)

An independent review of the first pass's implementation (not just its
live-run evidence) found five further defects — two P1, three P2 — none of
which the first live run's happy-path evidence would have surfaced:

1. **[P1] Checkpoints were downloaded unverified on first run, not at
   install time.** `download_boltz2()` lazily populated `--cache` during
   the first `predict` call, so identical installs weren't guaranteed to
   execute identical checkpoint bytes, and nothing checksummed the result.
   Fixed by modeling the CCD tarball and both checkpoints as ordinary
   MoleculeDesk `assets:` in the manifest — pinned to an exact HuggingFace
   repo commit (`boltz-community/boltz-2 @
   6fdef46d763fee7fbb83ca5501ccceff43b85607`) with sha256 digests, verified
   through the existing `cacheAsset`/`materializeAsset` pipeline before
   promotion. See "Checkpoint/CCD provenance" above. Required adding a new
   `archive: "tar"` type (plain, uncompressed) to the asset schema and
   installer alongside the existing `tar.gz`/`zip` support, since
   `mols.tar` isn't gzipped.
2. **[P1] Linux hardware declared `nvidiaGpu`/`cuda: recommended` while
   `verifyInstallation` ran a mandatory CUDA probe with no CPU verification
   path.** A CPU-only Linux host would have passed compatibility checks
   only to fail install. Fixed by declaring both `required` on the
   Linux/CUDA runtime entry, matching what's actually enforced; a genuine
   CPU-only Linux install path is not implemented in this pass.
3. **[P2] `verifyInstallation` didn't assert the exact pinned distribution
   version, absence of the other platform's package, or CLI mps support.**
   Fixed: the MPS probe now asserts `boltz-community==2.10.12` exactly and
   that no separate `boltz` distribution is also installed; the CUDA probe
   asserts `boltz==2.2.1` exactly; `verifyInstallation` separately invokes
   `boltz predict --help` on Darwin and checks the output advertises `mps`.
4. **[P2] YAML input validation used a regex
   (`/^sequences\s*:/m`) instead of a real parser** — a malformed document
   like `sequences: [` would match the regex and start an expensive run
   before failing deep inside Boltz. Fixed by parsing with the `yaml`
   package (already a workspace dependency) and requiring a non-empty
   top-level `sequences` array; confirmed live (`sequences: [` now fails
   with `INVALID_RUN_INPUT` before any process spawns).
5. **[P2] Package provenance was misleading**: because both `boltz` and
   `boltz-community` requirements declare `source`+`revision`, the
   installer installs from git — the `hashes` field on those requirements
   (which only applies to a PyPI-resolved artifact) was never actually
   enforced, so the manifest's wheel digests were informational only. Fixed
   by explicitly asserting the installed distribution's exact version at
   verify time (finding 3 above) as the real integrity mechanism for
   git-sourced requirements, and documenting that `hashes` only applies to
   `torch` (a genuinely PyPI-version-pinned requirement).

All five were fixed, the full test suite extended (`archive: "tar"`
coverage, malformed-YAML rejection, missing-cache-file rejection, CLI
mps-advertisement rejection, exact-version-mismatch probe assertions), and
the entire Darwin/MPS live verification above was re-run from a clean
install afterward — it is not a claim made without re-running the real
gate.

### Linux x64 / CUDA — structurally implemented, live-unverified

This machine has no NVIDIA GPU (`moldesk doctor` confirms no CUDA device),
so the CUDA path cannot be exercised here. It is fully implemented and
unit-tested (schema, runtime selection, `boltz[cuda]` extra, adapter
`command`/`verifyInstallation`'s CUDA probe), and its upstream facts are
verified the same way as the Darwin path (pinned commit, PyPI wheel
digest). Per rule 13, do not treat this as verified. Exact commands to run
on real Linux/NVIDIA hardware:

```bash
nvidia-smi                          # capture GPU/driver details
moldesk doctor                      # confirm CUDA compatibility
moldesk install boltz               # clean install, verify boltz[cuda] resolves
moldesk run boltz examples/boltz/protein.yaml --param accelerator=gpu --param devices=1
# then, to prove no silent CPU fallback:
CUDA_VISIBLE_DEVICES= moldesk run boltz examples/boltz/protein.yaml --param accelerator=gpu --param devices=1
```

`examples/boltz/protein.yaml` (a minimal single-chain job adapted from
Boltz's own upstream example, `msa: empty` so it needs no MSA-server
network call — see `examples/boltz/README.md` for exact provenance and
license) is the same example used for the Darwin live run above.
