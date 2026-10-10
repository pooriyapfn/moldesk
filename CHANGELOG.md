# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Offline molecular reports (`@moldesk/visualizer`): self-contained HTML with an
  interactive Mol* 3D view and synchronized sequence, no network access.
  `moldesk view <file>` for PDB/mmCIF, an automatic report (`artifacts/viewer.html`)
  for successful Boltz, OpenDDE, BindCraft2, and DiffDock runs (`--no-visualize` to
  skip; `--output` also copies it), and `moldesk visualizer update <report>` to
  replace a report's viewer with the installed one, with confirmation and a backup.
  Report problems are warnings and never change a run's result. See
  `docs/visualizer.md`.
- Initial monorepo scaffold: `apps/cli`, `packages/core`, `packages/runtime`,
  `packages/registry`, `models/boltz`.
- `moldesk --version`, `moldesk doctor`, `moldesk list` commands.
