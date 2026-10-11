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
