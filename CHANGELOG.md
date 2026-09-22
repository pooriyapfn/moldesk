# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial monorepo scaffold: `apps/cli`, `packages/core`, `packages/runtime`,
  `packages/registry`, `packages/adapters`.
- `moldesk --version`, `moldesk doctor`, `moldesk list` commands, with
  compatibility explanations for Python, Docker, CUDA, GPU, RAM, and disk.
- Atomic install/uninstall/reinstall engine with per-installation locking,
  content-addressed download cache, and a rebuildable install-state index.
- ProteinMPNN and LigandMPNN install adapters, verified end-to-end on real
  hardware.
- Boltz-2 install/run adapter — checksum-pinned assets (verified via
  Hugging Face's blob API, since upstream provides none), GPU required by
  default given a confirmed upstream CPU-inference bug in the pinned
  revision. Not yet verified on a real CUDA host.
- `moldesk run <model> <input>` execution engine: live log streaming,
  checksummed output collection, a stable CLI exit-code contract
  (0/2/3/4/5/6/7/8/10), and a full reproducibility record (`run.json`)
  per run — hardware report, manifest/install fingerprints, parameters,
  command, timing, process info, output checksums.
- Deterministic Python dependency resolution (`uv pip compile`) at install
  time, recorded on the installation record for drift detection.
- A generic per-adapter contract test that automatically covers any new
  model adapter.
- Migrated the monorepo from pnpm to npm workspaces.

### Fixed

- LigandMPNN install failing with `ModuleNotFoundError: No module named
  'pkg_resources'` (missing `setuptools` pin).
- A confirmation-mutation regression where `moldesk install` could
  download/install managed `uv` and write cache files during plan preview,
  before the user had confirmed anything — dependency resolution now only
  happens after confirmation.
- Archive-asset extraction (used by Boltz's `mols.tar`) double-nesting
  into `assets/mols/mols/...` instead of `assets/mols/...`.
- Python install-cost estimates undercounting Linux downloads: `torch`'s
  Linux wheel mandatorily pulls ~1.9 GiB of NVIDIA CUDA + triton packages
  that its macOS ARM64 wheel doesn't need, so a single cross-platform
  estimate wrongly let Linux installs skip cost-aware confirmation.
  Manifests now declare real, per-platform (`darwin-arm64`/`linux-x64`)
  download/disk estimates.
- The Docker image failing at runtime with `Cannot find package
  'commander'` — the final stage now copies the full dependency closure,
  not just the CLI's own `dist/`.
