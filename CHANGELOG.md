# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- DiffDock-L and BindCraft2 are now `beta`, so `moldesk install diffdock` and
  `moldesk install bindcraft2` work on Linux/NVIDIA. Verified live on an A40
  (DiffDock-L) and on RTX 3090 and A40 (BindCraft2). Cancellation behaviour and
  BindCraft2's no-GPU refusal path are not yet verified. BindCraft2 is
  source-available with a hosting restriction: local use and your own rented GPU
  only. See `models/bindcraft2/README.md`.

### Added

- Runpod cloud execution (`moldesk run --compute runpod`, `moldesk cloud ...`) for Boltz-2 and
  ProteinMPNN. `ephemeral` caching is supported; `persistent` caching is experimental (it ran live
  but was slower than `ephemeral` on standard network volumes). Validated live on RTX 3090, A40 and
  RTX A5000 Pods, including the in-Pod watchdog. Shutdown is still best effort and every run requires
  explicit acknowledgment that a Pod may keep charging if MoleculeDesk closes or disconnects. Other
  models are not enabled for cloud execution yet. Adds `better-sqlite3` and `@napi-rs/keyring` as
  runtime dependencies. See `docs/cloud-execution.md`.
- Cloud GPU choice: a price range with fallback (`--max-gpu-price`) instead of waiting on one GPU,
  digest-pinned stock Runpod images with `--gpu-image` / `--cpu-image` overrides, and an optional
  `cloud.gpuAllowList` in a model's manifest so a fallback never lands on a GPU generation the
  model's pinned framework cannot run (ProteinMPNN's torch 2.2.1 has no kernels for Blackwell GPUs).
- Cloud runs record the peak GPU memory and disk the worker observed in `run.json`
  (`compute.usage`), so a model's cloud sizes can be set from measured runs.
- Offline molecular reports (`@moldesk/visualizer`): self-contained HTML with a
  fullscreen, always-dark Mol* 3D view, a floating toolbox, and a colored sequence
  strip in blocks of ten, no network access.
  `moldesk view <file>` for PDB/mmCIF, an automatic report (`artifacts/viewer.html`)
  for successful Boltz, OpenDDE, BindCraft2, and DiffDock runs (`--no-visualize` to
  skip; `--output` also copies it), and `moldesk visualizer update <report>` to
  replace a report's viewer with the installed one, with confirmation and a backup.
  Report problems are warnings and never change a run's result. See
  `docs/visualizer.md`.
- Initial monorepo scaffold: `apps/cli`, `packages/core`, `packages/runtime`,
  `packages/registry`, `models/boltz`.
- `moldesk --version`, `moldesk doctor`, `moldesk list` commands.
