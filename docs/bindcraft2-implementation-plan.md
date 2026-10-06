# BindCraft2 implementation plan

Scope: milestone 4 of `model-expansion-agent-prompt.md`. Implement and verify
locally before renting a Linux/NVIDIA GPU. Keep lifecycle status `planned`
until the real accelerator gates pass. No GPU execution claim from mocks.

Implementation added on 2026-10-06 using existing contracts, with no changes to
core, runtime, registry schema or installer. Official archive/checkpoint hashes
and Linux accelerator wheel hashes are verified; live CUDA gates remain pending.

## Upstream findings (2026-10-06)

- Canonical source: https://github.com/PacesaLab/BindCraft2
- Reviewed commit: `5bac63cd2d4e7ed3d5077ba4fc5966e0352038e4`.
- Package metadata: `bindcraft` 1.0.3; Python >=3.12.
- CUDA 12 and CUDA 13 pip extras exist. Start with one explicit Linux x64
  NVIDIA/CUDA 12 runtime, subject to dependency-resolution verification.
  CUDA 13, AMD, multi-GPU and macOS support are outside this first integration.
- License: BindCraft2 Source-Available License (Hosting-Restricted).
  Preserve the upstream license and local/internal-use notice; do not describe
  it as OSI open source or offer hosted third-party execution.
- CLI: `bindcraft design <campaign.json>`; finite campaign bound is
  `max_trajectories`, separate from `number_of_final_designs`.
- AlphaFold parameters download lazily by default. Explicit
  `BINDCRAFT_AF2_PARAMS` bypasses that download path. ProteinMPNN/HyperMPNN
  neutral, negative and positive weights ship in the pinned source tree.
- Upstream presets live outside the Python package, under repository-root
  `settings/`. Ordinary wheel installation does not package that directory.
- Upstream can spawn multiple worker processes automatically. Existing
  MoleculeDesk cancellation signals the immediate child, not its process group.

## Keep existing architecture

Use the current manifest, managed Python installer, atomic staging/promotion,
asset cache/extraction, companion-input staging, params, output collector and
`run.json` engine. No model-name branches in core/runtime; no general shell
hook, upstream `install.sh`, new runtime provider or editable installation.

Install the package from the exact git commit using existing requirement
`source`, `revision` and `extras` fields. Pin direct dependencies and CUDA/JAX
packages to resolved compatible versions; record the dependency freeze through
the existing installer. Execute the installed CLI with `PYTHONPATH` pointing
only to the managed pinned source checkout, preserving its presets and shipped
weights without an editable-install path tied to a staging directory. Recompute
paths from the final installation at run time. Verify this after relocation.

## Implementation order

1. **Manifest and provenance.** Add `models/bindcraft2/manifest.yaml` and README.
   Use `category: sequence-design`, `status: planned`, Linux x64, required NVIDIA
   GPU/CUDA and explicit disk/download estimates. Verify dependency wheels and
   driver requirements before setting compatibility minima. Obtain the real
   AlphaFold archive size and SHA-256 before declaring it as a managed `tar`
   asset; never insert a guessed digest. Check all seven required AlphaFold
   checkpoints plus the three shipped MPNN variants. Record their provenance,
   hashes and licenses. Account for cached archive, extraction and environment
   space; upstream estimates roughly 20 GB installation headroom.

2. **Adapter.** Add `packages/adapters/src/bindcraft2/index.ts`, following
   OpenDDE/DiffDock contracts: `validateInput`, `resolveCompanionInputs`,
   `installPlan`, `command`, `collectOutputs`, `verifyInstallation`.
   Validate explicit campaign targets and stage PDB/mmCIF/FASTA plus custom
   scaffold references through existing confinement checks. Write a declared,
   checksummed resolved campaign under the run output directory. Rewrite all
   external file references to staged copies and `project_folder` to run output.
   Restrict the initial campaign surface to supported fields and shipped preset
   identifiers; reject arbitrary preset paths and unsupported file references.

3. **Bounded execution.** Expose modality, final-design count, trajectory budget,
   binder-length bounds and resume flag through existing params. Require positive
   integer design/attempt bounds after overrides, validate length ranges and
   reject unsupported modality combinations before launching. Force
   `auto_multi_gpu=false` and one worker; neutralize environment overrides that
   could re-enable workers. Reject resume in this first version: each invocation
   starts a fresh run, and finalized prior runs cannot be mutated. Document this
   limit rather than inventing incomplete cross-run campaign copying.

4. **Managed assets/cache.** Set `BINDCRAFT_AF2_PARAMS`, `BINDCRAFT_MPNN_WEIGHTS`,
   `BINDCRAFT_WEIGHTS`, `XDG_CACHE_HOME` and the pinned-source import path to
   managed locations. Reuse one environment builder for verification/execution.
   Validate assets before execution; missing parameters must fail instead of
   invoking first-run downloads. Keep compilation/cache files under managed
   installation/run paths. Launch executable plus argv, never shell strings.

5. **Verification and results.** Check CLI/version, upstream
   `python -m bindcraft.selfcheck cuda12`, actual JAX GPU tensor execution,
   checkpoint integrity and disk. Collect trajectory/refolded/ranked CSVs and
   structures plus campaign metadata. Validate outputs structurally and add a
   summary recording attempted/accepted counts and budget exhaustion. A completed
   bounded campaign with zero accepted designs is valid computation, explicitly
   reported as zero; accepted structures must not be required in that case.

6. **Registration and docs.** Update adapter catalog, registry/catalog tests,
   packaging expected-model list, README, website navigation/compatibility and
   a BindCraft2 model page. Add a tiny redistributable target and campaign with
   one requested final design and one trajectory. Record exact unrun GPU commands.

## Files and change budget

New: model manifest/README; adapter/tests; bounded example/README/target;
website model page. Existing edits: catalog, existing registration/packaging
expectations, website navigation/compatibility and README. Aim for no registry
schema, core, installer or process-runner changes. Add a shared capability only
if a concrete requirement cannot be satisfied by existing contracts.

## Gates before commit and push

Focused tests: malformed campaigns, finite bounds, modality/length validation,
safe staging and rewritten paths, source relocation/presets, exact argv/env,
CPU rejection, missing/corrupt checkpoints, output confinement, zero-design
results, worker suppression and cancellation. Follow with `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm pack:verify`, sequentially; inspect diff for
generated/downloaded artifacts, credentials and machine-specific paths.

## Gates on rented Linux/NVIDIA GPU

Clean install and self-check; bounded example; prove GPU execution; verify
output hashes and finite zero-accepted outcome; cancel an active campaign and
confirm no orphan workers. Capture hardware, driver/runtime, package/source
pins, elapsed time and checksums. Run Boltz, DiffDock-L and OpenDDE CUDA gates
in separate managed environments during the same rental. Promote lifecycle
status only after corresponding evidence is recorded.
