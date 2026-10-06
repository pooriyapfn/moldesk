# Code-agent prompt: implement Boltz-2, DiffDock-L, OpenDDE, and BindCraft2

You are working in the MoleculeDesk monorepo. Implement four production-quality model integrations in the exact order below. Treat each numbered section as a separate milestone and commit. Do not begin the next milestone until the current milestone's automated tests pass and its stated live verification has either passed or is explicitly recorded as blocked by unavailable hardware. Never claim live GPU support from mocks alone.

## Repository context

Read these files before editing:

- `docs/adding-a-model.md`
- `docs/model-system.md`
- `docs/step4-execution-engine.md`
- `packages/adapters/src/index.ts`
- `packages/adapters/src/catalog.ts`
- `packages/adapters/src/proteinmpnn/index.ts`
- `packages/adapters/src/proteinmpnn/index.test.ts`
- `packages/core/src/installation.ts`
- `packages/core/src/run.ts`
- `packages/runtime/src/install/index.ts`
- `packages/runtime/src/providers.ts`
- `packages/runtime/src/providers/python.ts`
- `packages/registry/src/schema.ts`
- `models/boltz/manifest.yaml`

Current architecture:

- Registry manifests define immutable source revisions, runtimes, hardware, assets, input formats, outputs, and lifecycle status.
- The core installer creates an atomic staging installation, fetches a pinned source revision, creates a managed Python environment with `uv`, installs manifest requirements, materializes checksum-pinned assets, invokes adapter verification, and only then promotes the installation.
- A model adapter implements `validateInput`, `installPlan`, `command`, `collectOutputs`, and `verifyInstallation`; params use `ParamDescriptor` and `validateParams`.
- Runs copy the primary input into a private run directory, execute without a shell through `CommandSpec`, collect only declared files under `output/`, and finalize `run.json` with checksums and provenance.
- Boltz already has a planned manifest and a stub adapter. ProteinMPNN and LigandMPNN are the reference implemented adapters.
- Generated `dist/` files must come from package builds; never edit generated files manually.

## Rules applying to all four milestones

1. Pin every upstream repository to a full immutable commit digest and every package to an exact version. Confirm that package version and source revision correspond.
2. Record the exact upstream license. Do not call source-available software open source.
3. Do not permit silent first-run downloads into `$HOME` or an untracked global cache. Checkpoints/runtime assets must be checksum-pinned and installed under MoleculeDesk-managed paths, or the adapter must deliberately point upstream at an installation-scoped cache whose contents are verified before a run.
4. Preserve atomic installation, reinstall rollback, cancellation, output confinement, path traversal protection, redaction, and run provenance.
5. Execute commands as executable/argument arrays—never shell strings. Do not use `shell: true`.
6. Never execute a user-supplied path or interpolate it into a shell command.
7. Inputs referenced by YAML/JSON/CSV must be copied into the immutable run input area. Do not leave runs dependent on arbitrary files outside the run directory. Implement the smallest generic, tested companion-input/bundle staging capability required by DiffDock-L and BindCraft2. It must:
   - resolve relative references against the submitted job file;
   - reject missing files, symlinks that escape the allowed source tree, traversal, duplicate destinations, unsupported types, and unsafe archive members;
   - copy files before execution and rewrite the staged job file or command arguments to staged paths;
   - record every staged input path and SHA-256 in `run.json`;
   - preserve existing single-file behavior and tests.
8. Keep model-specific translation in adapters. Extend registry/core/runtime only for reusable capabilities, not model-name conditionals.
9. `status: available` is allowed only after install and run are verified end-to-end on every advertised platform. Use `beta` where at least one advertised path is genuinely verified but still limited. Otherwise use `planned`.
10. Add focused unit tests for success and failure paths: missing/wrong inputs, params/defaults, exact command construction, install verification, output collection, catalog consistency, path safety, and hardware/runtime selection.
11. Add a minimal example and model README, plus website model docs and navigation/compatibility updates. Document inputs, outputs, hardware, license, limitations, and reproducible commands.
12. Do not weaken existing validation or tests to make a model pass.
13. After every milestone run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm pack:verify
```

Also run the milestone's real CLI smoke test. Preserve terminal logs and summarize exact OS, architecture, accelerator/backend, GPU or Apple chip, driver/CUDA runtime or macOS/PyTorch MPS status, Python, package version, source revision, command, elapsed time, and output checksums in the model README or verification notes. If required hardware is unavailable, stop at `planned`, provide the exact unrun command, and state that live verification remains incomplete.

---

## Milestone 1 — Finish Boltz-2 and prove Apple Silicon MPS plus NVIDIA CUDA execution

### Objective

Replace the planned Boltz stub with a complete dual-runtime Boltz-2 integration. Linux/NVIDIA must use the official, pinned Boltz v2.2.1 release; Darwin/arm64 must use pinned `boltz-community==2.10.12`, which supports PyTorch MPS. The existing official source pin is `cb04aeccdd480fd4db707f0bbafde538397fa2ac`; verify it against upstream before retaining it. Verify that `2.10.12` is still the intended release, then record its full immutable source commit and package artifact digest as separate provenance; if superseding it, document why and pin the replacement exactly. Both runtimes must install reproducibly and complete a real prediction on their claimed accelerator.

Upstreams:

- Official Linux/CUDA runtime: `https://github.com/jwohlwend/boltz`
- Apple Silicon/MPS runtime: `https://github.com/Novel-Therapeutics/boltz-community`

### Required implementation

- Replace `packages/adapters/src/boltz/index.ts` planned operations with a real adapter and add `packages/adapters/src/boltz/index.test.ts`.
- Correct `models/boltz/manifest.yaml` rather than trusting its current platform/runtime declarations.
- For Linux x64 + NVIDIA CUDA, install the official upstream CUDA extra for the pinned release (`boltz[cuda]`, after verifying current upstream packaging). Do not treat a CPU-only Torch build as CUDA support.
- For Darwin arm64, install an exact version of `boltz-community` without its CUDA extra. Select a compatible, exact PyTorch version with MPS support. Do not install official `boltz` in the same environment because both distributions expose the same `boltz` import and CLI.
- Run `boltz-fix-macos-libomp` during Darwin installation after all Python packages are present, and rerun it after any dependency repair/upgrade. Do not use `KMP_DUPLICATE_LIB_OK=TRUE`.
- Add reusable platform-aware runtime selection if the schema cannot represent distinct dependencies, source/package provenance, install hooks, verification, and defaults for Linux x64 vs Darwin arm64. Runtime selection must fail closed on unsupported OS/architecture/accelerator combinations.
- Ensure runtime selection is deterministic and covered by registry/core tests.
- Validate supported Boltz input suffixes and parse enough YAML to reject an empty/obviously invalid job before starting a long run.
- Build the run command from the installed Boltz entry point. At minimum expose validated params for:
  - `accelerator`: platform-constrained `gpu`, `mps`, or `cpu`; default to `gpu` for Linux CUDA and `mps` for Darwin arm64; reject `mps` outside Darwin and reject `gpu` when the selected runtime lacks CUDA;
  - `devices`: positive integer;
  - `recycling_steps`: nonnegative integer;
  - `sampling_steps`: positive integer;
  - `diffusion_samples`: positive integer;
  - `max_parallel_samples`: positive integer;
  - `use_msa_server`: boolean;
  - `no_kernels`: boolean fallback for unsupported CUDA kernels;
  - `seed`, if supported by the pinned CLI.
- Pass an installation-scoped `--cache` so model weights and CCD/runtime data are not placed in an uncontrolled home directory. Pin and verify assets where upstream provides stable immutable downloads; otherwise implement a verified installation-time population step with digests recorded in installed-model state.
- Collect the actual Boltz-2 structure and confidence/affinity artifacts. Required globs must be precise enough that stale or unrelated `.cif` files cannot satisfy verification.
- `verifyInstallation` must check the CLI/imports and checkpoint/runtime assets. On a declared CUDA path it must also execute a short Python probe that checks:
  - `torch.cuda.is_available()` is true;
  - at least one CUDA device is visible;
  - Torch's CUDA build is present;
  - Boltz imports successfully.
- On the Darwin arm64 path, `verifyInstallation` must also execute a short Python probe that checks:
  - `platform.system() == "Darwin"` and `platform.machine() == "arm64"`;
  - `torch.backends.mps.is_built()` is true;
  - `torch.backends.mps.is_available()` is true;
  - a real tensor operation can be allocated and completed on `mps` (detection alone is insufficient);
  - `boltz` imports successfully and installed distribution/version resolves to the pinned `boltz-community` release;
  - the CLI advertises `mps` as an accepted accelerator.
- Use float32 and single-device execution for MPS. Do not enable CUDA-only kernels or flags on Darwin. Treat documented individual MPS-to-CPU operator fallback warnings as warnings only when prediction succeeds and the fallback is explicitly recorded; never silently fall back the whole run to CPU.
- Surface failures as actionable MoleculeDesk errors rather than raw stack traces.
- Update `models/boltz/README.md`, `examples/boltz/`, root/website documentation, catalog tests, and manifest tests.

### Required live accelerator gates

On Linux with an NVIDIA GPU:

1. Run `nvidia-smi` and capture GPU/driver details.
2. Run `moldesk doctor` and confirm MoleculeDesk reports CUDA compatibility.
3. Install Boltz from a clean MoleculeDesk state.
4. Run the minimal checked-in Boltz example with `accelerator=gpu` and `devices=1`.
5. Prove GPU execution from the process logs plus Torch/Boltz device reporting; merely detecting a GPU before the run is insufficient.
6. Assert successful exit, at least one nonempty parseable mmCIF, expected confidence metadata, checksummed outputs in `run.json`, and no orphan process.
7. Run the same command with an intentionally unavailable GPU and verify an early actionable failure rather than silent CPU fallback.

On an Apple Silicon Mac:
1. Capture macOS version, Apple chip model, architecture, unified memory, Python, PyTorch, and `boltz-community` versions.
2. Run `moldesk doctor` and confirm MoleculeDesk reports Darwin arm64 and MPS availability.
3. Install Boltz from a clean MoleculeDesk state; prove the selected environment contains pinned `boltz-community`, not official `boltz`, and that the safe libomp repair completed.
4. Run the same minimal checked-in Boltz example with `accelerator=mps` and `devices=1`.
5. Prove MPS execution from process logs plus PyTorch/Lightning device reporting; merely checking `torch.backends.mps.is_available()` before the run is insufficient.
6. Assert successful exit, at least one nonempty parseable mmCIF, expected confidence metadata, checksummed outputs in `run.json`, and no orphan process.
7. Record any per-operator CPU fallback warning and confirm the whole prediction did not silently switch to CPU.
8. Run with MPS deliberately made unavailable or with an invalid accelerator/platform combination and verify an early actionable failure rather than silent CPU fallback.

Only after this passes may Boltz move from `planned` to `beta` or `available` according to the status rules.

### Milestone 1 done when

- Stub removed; unit/integration tests pass.
- Clean installs and real NVIDIA CUDA plus Apple Silicon MPS runs pass.
- CUDA use is proven and silent CPU fallback is prevented when `accelerator=gpu`.
- MPS use is proven and whole-run silent CPU fallback is prevented when `accelerator=mps`.
- Runtime/package provenance unambiguously records official Boltz on Linux and `boltz-community` on Darwin.
- Docs accurately state verified platforms, accelerator defaults, known operator fallbacks, and CUDA/MPS limitations.

---

## Milestone 2 — Add DiffDock-L

### Objective

Add the current DiffDock repository's default **DiffDock-L** model, not legacy DiffDock v1. DiffDock-L performs blind small-molecule docking to a protein and returns ranked poses plus confidence—not binding affinity.

Upstream: `https://github.com/gcorso/DiffDock`

### Required implementation

- Add:
  - `models/diffdock/manifest.yaml`
  - `models/diffdock/README.md`
  - `packages/adapters/src/diffdock/index.ts`
  - `packages/adapters/src/diffdock/index.test.ts`
  - `examples/diffdock/` with a tiny redistributable protein/ligand job and provenance
  - website docs/navigation entries.
- Register `diffdock` in `packages/adapters/src/catalog.ts` and exports as needed.
- Pin a known DiffDock-L source commit and all compatible Python/PyTorch/PyG dependencies. Do not use the legacy `v1.0` checkout.
- Use the generic companion-input staging capability. Support a clear MoleculeDesk job format containing:
  - protein PDB path;
  - exactly one ligand as an SDF/MOL2 path or validated SMILES;
  - optional job name.
- Rewrite file references to staged copies. A run must remain reproducible after the original files are moved.
- Validate PDB and ligand extensions/content at a practical level. Reject directories unless the job schema explicitly allows them.
- Map the staged job to the pinned upstream CLI. Expose a small, validated parameter surface such as:
  - `samples_per_complex`;
  - `inference_steps`;
  - `batch_size`;
  - `seed`/deterministic option where supported;
  - CPU/GPU choice only where genuinely supported.
- Collect ranked `.sdf` poses and confidence data. Preserve rank/confidence association and make the top pose easy to identify. A random file anywhere below output must not satisfy required output validation.
- Verification must test the pinned model import, graph-extension imports, installed weights, and CLI help. Fail clearly for ABI mismatches in Torch/PyG extensions.
- Advertise only tested platforms. Upstream documents CPU execution for PDB inputs but does not document Apple MPS acceleration; do not claim MPS support without a real test.
- License: MIT for upstream code/weights; preserve notices.

### Required live gate

- From a clean install, dock the checked-in ligand against the checked-in PDB.
- Assert at least one parseable SDF pose, finite coordinates, matching atom count, confidence/rank metadata, and complete `run.json` input/output hashes.
- Run twice with a deterministic setting if upstream supports one and document reproducibility behavior.
- If advertising CUDA, run on a real NVIDIA GPU and prove device use. If advertising `darwin-arm64`, run the complete install and example on Apple Silicon; CPU-only must be labeled as such.

### Milestone 2 done when

- `moldesk install diffdock` and `moldesk run diffdock <job>` work from clean state.
- DiffDock-L, not legacy DiffDock, is proven by pinned revision/model artifacts.
- Companion inputs are safely staged and recorded.
- Outputs are useful ranked poses, not merely arbitrary discovered files.

---

## Milestone 3 — Add OpenDDE Preview

### Objective

Add OpenDDE Preview as an all-atom biomolecular co-folding model. Support its official Apple Silicon MPS path and Linux NVIDIA CUDA path where those devices are available. Keep the model labeled preview/beta.

Upstream: `https://github.com/aurekaresearch/OpenDDE`

Known upstream facts to re-verify at implementation time:

- Package/CLI name: `opendde`.
- Public model: `opendde_v1`, approximately 656M parameters.
- General and antibody–antigen checkpoints are approximately 2.625 GB each.
- Upstream documents CPython 3.11–3.13, Apple Silicon `--device mps`, CPU, and Linux x86-64 CUDA 12.6 with the GPU extra.
- License: Apache-2.0.

### Required implementation

- Add model manifest, README, adapter/tests, minimal example, catalog registration, and website docs.
- Pin the OpenDDE source/package release and checkpoint URLs, exact sizes, and SHA-256 values from upstream's model manifest. Install the general checkpoint by default; make the ABAG checkpoint an explicit opt-in only if the current MoleculeDesk asset/runtime model can represent it reproducibly.
- Support platform-appropriate installation:
  - Apple Silicon: native Python/PyTorch build with MPS; do not use the NVIDIA Docker image.
  - Linux NVIDIA: verified CUDA-compatible Torch plus `opendde[gpu]`/cuEquivariance as required by the pinned release.
  - CPU only if intentionally exposed and documented as slow.
- If reusable installer support is needed for a Torch backend/index selection, add a strictly validated manifest field rather than embedding arbitrary pip command fragments.
- Accept OpenDDE JSON jobs and safely stage any referenced PDB/CIF or other companion files. Pure sequence/SMILES jobs should remain single-file inputs.
- Expose validated params for `device` (`auto`, `mps`, `cuda`, `cpu` as platform permits), samples, diffusion steps, cycles, seed(s), MSA, template, and RNA-MSA switches. Preserve safe defaults suitable for a bounded smoke test.
- Prevent `device=auto` from silently selecting CPU when the user explicitly requested CUDA or MPS.
- Use an installation-scoped runtime root/cache and preinstall verified common assets. Large optional search databases must be explicit, estimated in install size, and documented; the minimal no-MSA/no-template path must not download them.
- Collect predicted mmCIF plus confidence/score JSON. Validate required outputs as nonempty and parseable.
- `verifyInstallation` must check checkpoint digest/size, imports, CLI, and the selected accelerator. Add unit tests for MPS/CUDA/CPU command construction and platform rejection.

### Required live gates

- **Apple Silicon:** clean install on an M-series Mac, run the tiny checked-in example with `--device mps`, prove tensors/model execute on MPS, and validate output mmCIF/JSON.
- **CUDA:** clean install on Linux/NVIDIA, run the same example with CUDA, prove CUDA execution, and validate outputs.
- Do not advertise a platform whose live gate was not executed. Keep `status: beta` because upstream itself calls this a preview.

### Milestone 3 done when

- OpenDDE installs without uncontrolled global assets.
- MPS and/or CUDA claims are backed by real runs.
- Tiny no-MSA run is bounded and reproducible enough for CI/manual smoke testing.
- Preview limitations and large optional databases are accurately documented.

---

## Milestone 4 — Add BindCraft2

### Objective

Add BindCraft2 for protein-binder campaigns. This is Linux accelerator software, not a macOS/M3-local model. Integrate it without violating its hosting restriction or pretending CPU execution is practical.

Upstream: `https://github.com/PacesaLab/BindCraft2`

License: **BindCraft2 Source-Available License (Hosting-Restricted)**. It permits local/internal commercial use and redistribution for users to run themselves, but prohibits exposing substantial functionality as a hosted service without a separate commercial license. Preserve this wording in manifest/docs and do not label it OSI open source.

### Required implementation

- Add model manifest, README, adapter/tests, bounded example campaign, catalog registration, and website docs.
- Pin a full upstream revision. Re-verify the current canonical repository URL and release/version because earlier documentation has used both `BindCraft2` and `BC2` paths.
- Advertise Linux only. Require a supported accelerator exactly as upstream currently documents. Do not claim macOS, MPS, or CPU support.
- Integrate upstream provisioning without bypassing MoleculeDesk's atomic installer:
  - If the pinned source can be installed reproducibly through its Python metadata, express exact dependencies and accelerator selection through safe reusable installer fields.
  - If its installer performs required accelerator-specific provisioning, add a narrowly scoped adapter provisioning hook executed inside the staging directory with structured arguments, cancellation, logs, and rollback. Do not add a general arbitrary-shell manifest field.
  - Keep AlphaFold parameters and all other weights in MoleculeDesk-managed, verified asset/cache locations. Account for upstream's substantial disk requirement.
- Use the companion-input staging capability for campaign JSON plus target PDB/mmCIF/FASTA and any custom scaffold files. Rewrite staged references and reject escaping paths.
- Validate campaign JSON before execution. Require a finite stopping condition: `number_of_final_designs` plus a bounded trajectory/attempt budget. MoleculeDesk must never start an accidentally unbounded campaign.
- Expose only stable high-value params initially: modality, final-design count, maximum trajectories/attempts, binder-length range where applicable, and resume behavior. Reject incompatible combinations early rather than passing them downstream.
- Run through the installed `bindcraft` CLI. Ensure campaign resume semantics cannot mutate a finalized prior MoleculeDesk run; resumption must create a new run record or explicitly reference a safely copied prior campaign.
- Collect structured outputs by stage:
  - trajectories and trajectory summary;
  - refolded candidates and summary;
  - ranked accepted designs (`.cif` and ranked CSV) when present.
- A bounded campaign that finds no accepted design must be represented honestly (successful computation with zero accepted designs, or a documented model-specific outcome), not as a fake required-output success and not as an infinite retry.
- Verification must check the CLI, JAX accelerator backend, ProteinMPNN/HyperMPNN weights, all required AlphaFold checkpoints, and available disk. Detect `[CpuDevice]` and fail before campaign execution.
- Add prominent local-execution/license notices. Do not implement or document MoleculeDesk-hosted third-party execution for BindCraft2.

### Required live gate

- On a supported Linux accelerator, perform a clean installation and upstream self-check.
- Run a bounded official example or a small redistributable target with an explicit maximum trajectory budget.
- Prove accelerator use, termination at the requested bound, parseable summaries/structures, complete input/output hashes, cancellation behavior, and no orphan workers.
- Test a no-accepted-design result and confirm it is finite and clearly reported.

### Milestone 4 done when

- Clean install, accelerator self-check, bounded run, cancellation, and output collection pass.
- No macOS/CPU claim exists.
- License/hosting restrictions are exact and visible.
- Campaigns cannot run without a finite attempt bound.

---

## Final handoff

After all four milestones:

1. Run the full repository verification commands again.
2. Run `moldesk list` and `moldesk doctor`; confirm status/hardware messages match reality.
3. Run every checked-in example on each advertised platform.
4. Review `git diff` for generated files, secrets, machine-specific paths, downloaded checkpoints, and accidental large artifacts. None may be committed.
5. Provide a concise matrix containing model, status, upstream revision, package version, license, platforms, accelerator, live-tested hardware, example command, result, runtime, and output checksums.
6. Explicitly list any unexecuted live gates. Do not describe a model as working on hardware that was not actually tested.
