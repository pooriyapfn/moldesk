# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- OpenDDE is now advertised on Linux x64 with NVIDIA CUDA. Verified on Runpod Pods (A40 and RTX 3090)
  with `examples/opendde/tiny.json`; a local Linux install, the no-GPU refusal path and ligand-file jobs
  are not yet verified.
- Cloud OpenDDE runs no longer fail when collecting results: the `.pdb` copy of each structure needs a
  local OpenDDE install, so it is skipped and recorded in `moldesk-pdb-export-errors.json` (the mmCIF is
  the result).
- DiffDock-L and BindCraft2 are now `beta`, so `moldesk install diffdock` and
  `moldesk install bindcraft2` work on Linux/NVIDIA. Verified live on an A40
  (DiffDock-L) and on RTX 3090 and A40 (BindCraft2). Cancellation behaviour and
  BindCraft2's no-GPU refusal path are not yet verified. BindCraft2 is
  source-available with a hosting restriction: local use and your own rented GPU
  only. See `models/bindcraft2/README.md`.

### Added

- `moldesk analyze` now reports `fullSequence` for polymer chains: the entity's complete sequence from the
  file (SEQRES / `entity_poly_seq`), including residues with no coordinates. `sequence` stays the modeled
  residues, and `--fasta` now writes the full sequences, since predicting the modeled-only sequence would
  silently drop missing loops (1M17: 312 modeled of 333 residues).
- Agent skill (`plugins/moldesk`, now 0.2.0): covers `fetch`, `analyze`, `inspect`, `view --highlight`,
  `compare`, `describe` and `schema`, adds ground rules for network fetches, building US-align and
  never inventing confidence, and two recipes (understand a structure; compare a Boltz prediction with an
  experimental structure, the EGFR kinase domain). `scripts/check-skill-commands.mjs` checks that every
  `moldesk` command and flag the skill mentions exists in the built CLI's `--help` and that `cli.md`
  documents every command; CI runs it.
- `moldesk describe <model> [--json]`: one document per model with its inputs, outputs, parameters (from the
  adapter's own list, with per-platform defaults such as Boltz's `accelerator`), runtimes and hardware
  needs, assets and licenses, cloud availability and the verdict for this machine (the same check as
  `list`/`install`, from the same report as `doctor`). See `docs/describe.md`.
- `moldesk schema <kind>` now prints the full `result` shape of every kind (JSON Schema draft-07, was
  draft 2020-12 with an open `result`); real output of every command is validated against it in tests.
- `moldesk fetch pdb:1M17 | afdb:P00533 | uniprot:P00533` (`--format`, `--output`, `--refresh`): downloads into
  `~/.moldesk/cache/fetch/<source>/<id>/` with a provenance sidecar (URL, retrieval time, SHA-256, source
  version, license). Ids are validated before any request; HTTPS to one allowed host per source, no
  cross-host redirects, size caps on the decompressed stream, content checks and atomic writes. The
  AlphaFold DB file URL is resolved through its API. A verified cache hit makes no request. See
  `docs/fetch.md`.
- `moldesk compare a b --report overlay.html [--deviation-threshold 2]`: an offline overlay report with
  both structures in one scene (B moved onto A through a column-major scene transform), the per-residue
  deviation as a line chart, and residues above the threshold highlighted. `mapping[].distance` is the
  new per-pair deviation in the compare result. The report viewer now draws `line` chart panels as SVG
  (other chart types still show their table). See `docs/compare.md`.
- `moldesk compare <a> <b>` (`--chain-a`, `--chain-b`, `--multimer`) with US-align: TM-score
  normalized by each structure, RMSD, aligned length, sequence identity, a 4x4 superposition
  transform and the residue mapping. `moldesk install usalign` builds the pinned release 20260527
  (SHA-256 checked, verified on its sample structures) with your own C++ compiler into
  `~/.moldesk/tools`; `moldesk uninstall usalign` removes it and `moldesk doctor` lists the
  compiler and install state. There is no fallback when it is not installed. See `docs/compare.md`.
- `moldesk view --highlight A:40-60 [--color '#ff5500'] [--color-by chain|plddt]` and
  `moldesk view --scene scene.json`: highlights and pLDDT-class coloring in offline reports, encoded
  with the existing v1 report fields (no schema bump, so older viewers still open the report).
  `--color-by plddt` needs a known pLDDT source. See `docs/visualizer.md`.
- `moldesk inspect <file> <selector>`: per-residue name, auth/label ids, secondary structure, pLDDT
  (when known) and heavy-atom count for a chain, residue or range, plus neighbouring residues within
  `--radius` Å (default 5) with the minimum distance and atom pair. A selector that matches nothing
  exits 2. See `docs/inspect.md`.
- `moldesk analyze <pdb|cif>`: chains with auth and label ids, entity types, sequences, numbering
  gaps, mmCIF unobserved residues, secondary structure (file records or DSSP), geometry and pLDDT
  only from a known source (ModelCIF metrics, a MoleculeDesk Boltz run, or `--bfactor-is-plddt`).
  `--fasta` writes the chain sequences; `--validate-fasta` checks a FASTA file. Runs Mol* in Node, so
  `@moldesk/core` now depends on `molstar` (about 95 MB installed). See `docs/analyze.md`.
- Analysis JSON contract: a versioned `--json` envelope for structure-intelligence commands,
  `moldesk schema [kind]` to print its JSON Schema, and a shared residue selector grammar
  (`A`, `A:45`, `A:40-60`, `A:52A`). See `docs/analysis-json.md`.
- Runpod cloud execution (`moldesk run --compute runpod`, `moldesk cloud ...`) for Boltz-2,
  ProteinMPNN, DiffDock-L and OpenDDE. `ephemeral` caching is supported; `persistent` caching is experimental (it ran live
  but was slower than `ephemeral` on standard network volumes). Validated live on RTX 3090, A40 and
  RTX A5000 Pods, including the in-Pod watchdog. Shutdown is still best effort and every run requires
  explicit acknowledgment that a Pod may keep charging if MoleculeDesk closes or disconnects. Other
  models are not enabled for cloud execution yet. Adds `better-sqlite3` and `@napi-rs/keyring` as
  runtime dependencies. See `docs/cloud-execution.md`.
- Cloud GPU choice: a price range with fallback (`--max-gpu-price`) instead of waiting on one GPU,
  digest-pinned stock Runpod images with `--gpu-image` / `--cpu-image` overrides, and an optional
  `cloud.gpuAllowList` in a model's manifest so a fallback never lands on a GPU generation the
  model's pinned framework cannot run (ProteinMPNN's torch 2.2.1 has no kernels for Blackwell GPUs).
- Cloud runs can upload the files a job file references (a protein structure, a ligand file, binder
  targets). The quote lists each file with its path and checksum and the run needs a separate
  `upload-files` acknowledgment (a prompt answer, or `--accept-file-upload` without a terminal);
  files must sit inside the job file's folder, with at most 16 extra files and 4 GiB in total. No
  model uses this today: DiffDock-L (its protein structure). BindCraft2 still needs a cloud block
  and a live run, and OpenDDE jobs that reference ligand files have not been run.
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
