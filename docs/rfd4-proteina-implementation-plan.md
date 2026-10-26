# RFD4-Proteina implementation plan

Scope: add RFD4-Proteina (IPD / Baker Lab × NVIDIA) as a MoleculeDesk model. Same shape as
`bindcraft2-implementation-plan.md`: manifest, thin adapter, no changes to core, runtime or the installer unless a
concrete requirement forces one. Keep `status: beta` until a live GPU run passes; `available` only after that.

Planned and reviewed 2026-10-26 against pinned upstream sources and the current MoleculeDesk adapter, installer and Runpod worker.
This is an implementation plan, not a record of a successful installation or GPU run. Dependency compatibility, output files and
cloud resource sizes still need the live gates below.

## Upstream findings (2026-10-26)

- Released 2026-10-20/21 (GTC Berlin). Alpha: PyPI `rfd4-proteina` 0.0.1 → 0.0.3 in 26 hours. Expect churn; pin everything.
- Code: https://github.com/RosettaCommons/RFD4-Proteina, BSD-3-Clause (GitHub API `spdx_id: BSD-3-Clause`).
  - Tag `v0.0.3` is an annotated tag; peeled commit `bc004fe61811225b83ef5a815963dfed47dd3639`.
  - `main` (`aaccdd2…`, 2026-10-22) is already ahead of 0.0.3. Do not pin `main`.
- PyPI wheel `rfd4_proteina-0.0.3-py3-none-any.whl`, sha256 `8d4d9a6dd1468c3af00c83c8bd889178d4a1a5d6cbd577e5f4b843374ca9486b`.
  It carries `rfproteina/configs/` and `rfproteina/.project-root`, and its `inference.yaml` pins the same HF revision as `main`.
- Weights: https://huggingface.co/nvidia/RFD4-Proteina, BSD-3-Clause, not gated. The repo is about 178 GB because it also holds
  AlphaFold2/OpenFold3 runtime images. **Generation needs exactly two files** (`load_pretrained_bundle` uses
  `allow_patterns=["config.json","model.safetensors"]`), at the revision pinned in `configs/inference.yaml`,
  `a06e2509c7033b010fc43614e9fd840303588502`:

  | File | Bytes | sha256 |
  |---|---|---|
  | `model.safetensors` (flow + autoencoder) | 1,742,660,596 | `5b549dd61adb2f6c6b5cb95bda13f40f5e31556b4e6c755edc0ca6f011c68fb0` |
  | `config.json` | 7,270 | `154ea927ab8005b7eac2d047a792147fb4606ab4878e496aa8414b6b40dad368` |

  HF `main` currently serves the same `model.safetensors` oid; pin the revision anyway.
- Python `>=3.12,<3.13`. Upstream package metadata permits `torch>=2.11,<3`; this integration will pin `2.14.1+cu126`.
  The official cu126 index lists a Python 3.12 Linux x86_64 wheel; availability does not establish compatibility with every CUDA extension.
  Local generation supports Linux x86_64 only; macOS and Windows unsupported. No CPU path for generation.
- Upstream-tested GPUs: A100 (40/80 GB), H100, H200, GH200, L40S, RTX 6000 Ada, and Blackwell parts. **Not tested:** A40, A10,
  RTX 3090/4090, A5000/A6000. CUDA 12 profile: `--torch-backend cu126` + extra `all-cuda12`. CUDA 13 profile: cu130/cu132 + `all-cuda13`
  (adds BioIR, CUDA 13 only).
- CLI: `rfd4-generate` (Hydra `key=value`, never `--key value`). Roots `configs/inference.yaml`; preset
  `inference_experiment=quickstart` composes **no metrics** and `compile_lengths: null` (no torch.compile warm-up).
- Inputs: annotated CIF, or a YAML/JSON **condition spec**: top-level key = design name; fields `input` (path or list), `input_as_annotated_cif`,
  `contig`, `conditions`; reserved `global_args`; unknown fields raise. `input` may be **absolute**; relative paths resolve against the spec's own
  directory (`_resolve_input_path`). The pinned loader explicitly supports CIF/BinaryCIF, plain, gzip or Zstandard, including `.cif.zst`.
- `select:` strings are not `eval`'d. atomworks 3.0.4 `QueryExpression` walks an `ast` tree with a whitelist of operators and named functions
  (read the wheel, sha256 `7333368062…`). Still length-cap them.
- Outputs under `out_dir/inference_samples/`: `{example_id}_generated.cif`, `{example_id}_input.cif`; `inference_metrics/` only when
  `metrics_tags` is set. `ConditionSpecDataset` expands each design key to `{key}_{i}`, with `i=0..num_replicates-1`, even for one replicate.
  Its source documents per-example output directories; confirm the writer's exact layout in the live gate.
  Hydra snapshots go to `./hydra_outputs` unless `hydra.run.dir` is set.
  `generate.py` calls `load_dotenv()` (`.env.local` / `.env` from the working directory).
- Download paths audited (grep of `src/`): `utils/hub.py` (`snapshot_download`, skipped when `hf_ckpt_path` is a local directory) and
  `metrics/cdr_torsions.py` (HF *dataset* download, antibody metrics only). Nothing else fetches at run time. `anarcii` is a base dependency
  and may fetch its own models; the live gate must prove this.
- No built-in biosecurity screening in the CLI. The upstream Hugging Face Spaces screen designs with SecureDNA; `rfd4-generate` does not.

Review references: [package metadata](https://github.com/RosettaCommons/RFD4-Proteina/blob/v0.0.3/pyproject.toml),
[quickstart preset](https://github.com/RosettaCommons/RFD4-Proteina/blob/v0.0.3/configs/inference_experiment/quickstart.yaml),
[dataset and replicate IDs](https://github.com/RosettaCommons/RFD4-Proteina/blob/v0.0.3/src/rfproteina/inference_utils/datasets.py),
[condition-spec loader](https://github.com/RosettaCommons/RFD4-Proteina/blob/v0.0.3/src/rfproteina/inference_utils/condition_spec.py),
[official Torch cu126 wheel index](https://download.pytorch.org/whl/cu126/torch/).

## Decisions

1. **Scope v1 = generation only.** Reward-guided search, refolding metrics and `rfd4-evaluate` need an AlphaFold2 or OpenFold3 oracle
   environment (container images of 6–16 GB, plus OF3 weights). Out of scope; document the limit, do not half-support it.
2. **CUDA 12 / cu126 only** (the closed `torchBackend` enum already has `cu126`). This avoids a registry schema change.
   Exclude Blackwell from the cloud `gpuAllowList` pending validation of the pinned Torch and extension wheels; do not infer its kernel
   support from OpenDDE's older Torch build. CUDA 13 is a later change that needs the enum extended.
3. **Install the hash-pinned PyPI wheel rather than building the model from source.** Record tag commit `bc004fe…` as `source.revision`.
   The current installer unconditionally fetches this source revision before installing requirements, including wheel requirements.
   Accept and disclose that checkout's download/disk overhead in v1; removing it would require a separate installer change.
4. **Weights are managed assets, not an HF download at run time.** Two `assets` entries (`archive: none`, distinct `target`s under one
   directory), then `hf_ckpt_path=<assets>/rfd4-proteina-bundle` so `from_pretrained` takes the local-directory branch and never calls the Hub.
   Verify the installer follows the HF → CDN redirect and checks the hash after it.
5. **Input = condition spec (`.yaml`/`.yml`/`.json`)** with companion structure files. Annotated-CIF-only input is a possible later addition.
6. **Two delivery stages.** PR 1 adds the adapter and validates local Linux/NVIDIA generation; PR 2 adds the measured Runpod profile.
   A Mac can submit cloud jobs without installing the model locally. Cloud use also requires a matching published worker bundle;
   building the local CLI or adding a `cloud` block alone does not enable a new model in an older published worker.

## Adapter contract

`packages/adapters/src/rfd4-proteina/index.ts`, registered in `catalog.ts`. Hooks: `validateInput`, `resolveCompanionInputs`,
`resolveParamDefaults` (record a random default seed), `installPlan`, `command`, `collectOutputs`, `verifyInstallation`,
`describeVisualization` (last step).

**validateInput**
- Parse with `yaml` (`yaml.parse`, no custom tags). Cap file size (1 MiB), design count (≤ 8), `select`/`contig` string length (≤ 512).
- Reject unknown per-design keys (mirror upstream's four fields), non-mapping designs, empty file, duplicate keys.
  Validate `global_args` as a mapping with the same allowed keys and value/path rules; exclude it from the design count and identifiers.
  Merge it shallowly into each design (per-design values win), matching upstream, and validate every effective design.
  Check `input_as_annotated_cif` is boolean and validate the shape of `conditions`, including every nested `select` string.
- Design key = future replicate filename prefix (`{key}_{i}_generated.cif`). Require `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`,
  reject case-insensitive duplicates.
- `input`: non-empty string or non-empty list of non-empty strings, suffix in `.cif`, `.cif.gz`, `.cif.zst`, `.bcif`, `.bcif.gz`, `.bcif.zst`;
  **reject absolute paths, `..` path components, backslashes, NUL**. Each effective design must have an `input`.
  Upstream allows absolute paths; MoleculeDesk must not, because the cloud path uploads these files.

**resolveCompanionInputs** (same mechanism as DiffDock-L / BindCraft2)
- Return every `input` file (and any `global_args.input`), relative to the spec's folder. Core stages them with its existing confinement.
  Use deterministic adapter-owned companion IDs and map every occurrence, including shared/repeated references, back to its staged copy.
- Confinement uses `path.relative()` against the canonicalized root (`realpath` of the **full** path, so a symlinked ancestor fails too).
  Tests: sibling-prefix bypass, leaf symlink, ancestor symlink, duplicate destination, file changed between discovery and staging.

**command**
- Write a resolved spec under the run's output directory with every `input` rewritten to the staged copy (absolute, inside the run), and
  record its checksum. Do not edit the user's original.
- Flatten validated `global_args` into the resolved designs so inherited paths cannot remain unresolved. Hash and collect the resolved spec
  as an output artifact; cloud collection must consume the downloaded artifact rather than regenerate it with client-local paths.
- argv, never a shell string. Executable = the managed venv's `rfd4-generate` (resolve from `runtimeExecutable`'s bin dir).
  Overrides built only from validated params:

  ```
  rfd4-generate inference_experiment=quickstart inputs=<resolved spec> out_dir=<outputDir>
    hf_ckpt_path=<assets>/rfd4-proteina-bundle hf_ckpt_revision=null hydra.run.dir=<outputDir>/hydra
    num_replicates=N batch_size=B seed=S recycle_strategy=<enum> precision=bf16-mixed verbose=false
  ```
  Verify live whether `hf_ckpt_revision=null` is needed or harmful with a local directory.
- Serialize string override values for Hydra's grammar, in addition to passing an argv array. Test paths containing spaces, commas,
  brackets, `=` and quotes; argv alone prevents shell interpretation but does not escape Hydra syntax.
- Params (`ParamDescriptor`): `numReplicates` (integer 1–32, default 1), `batchSize` (integer 1–8, default 1), `seed` (integer 0–4294967295,
  default random but **recorded** in `run.json`), `recycle` (enum of upstream's preset names only:
  `thinking_low|thinking_medium|thinking_high`, default medium),
  `compile` (boolean, default false). Explicitly emit `compile_lengths=null` for false; for true emit the pinned upstream list
  `[128,160,192,224,256,288,320,352,384,448,512,640,768,896,1024]`, since the quickstart preset otherwise keeps compilation disabled.
  No pass-through of arbitrary Hydra overrides: that would reopen
  `_target_` instantiation, `ckpt_path`, `hydra.run.dir`, and the sampling-transform hook.
- `resolveParamDefaults` generates a seed with `crypto.randomInt(0, 2 ** 32)`. Core applies it before recording effective params locally
  and before preparing a cloud job; an explicit seed wins. Never choose a fresh seed inside `command()` or on the worker.
- The shared number validator does not enforce integrality. Use numeric `enum` values for the bounded replicate/batch ranges so fractions
  fail preflight; also use `Number.isSafeInteger` and bounds checks in the adapter before building the command, including for the seed.
  A seed check performed only in `command()` runs after cloud provisioning/install; do not claim it is a pre-provision validation.
- Environment (one builder shared by verify and run): `PYTHONNOUSERSITE=1`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`,
  `WANDB_MODE=disabled`, `HF_HOME`, `XDG_CACHE_HOME`, `TORCHINDUCTOR_CACHE_DIR`, `TRITON_CACHE_DIR`, `TORCH_HOME` all under the managed
  install/run path; `DATA_PATH` and `PROJECT_ROOT` set explicitly; force the public profile with `CLUSTER=local`.
  Core fixes the working directory to the private local run dir or worker job dir; `CommandSpec` has no `cwd` field. Use these existing dirs
  in v1 and never the user's input folder. Verify dotenv behavior during imports and CLI startup, including inherited environment settings
  and parent-directory discovery. If isolation needs a dedicated empty subdir, use a small adapter launcher that changes directory before
  importing the model; adding an ignored `cwd` field is not a solution. Use the same environment/isolation policy for verification.
- Fail closed without CUDA: no CPU fallback param, no `CUDA_VISIBLE_DEVICES=""` trick. Upstream has no generation CPU path.

**collectOutputs** (TypeScript only, no Python; the client collecting cloud results may have no local model runtime)
- Globs: `inference_samples/**/*_generated.cif` (required), `inference_samples/**/*_input.cif` (optional),
  `hydra/**` config snapshot (optional, for provenance).
  Use `lstat` at every level; reject any symlink the model wrote.
- Validity, not presence: expected count = designs × `numReplicates`; every design key must have that many generated structures; each CIF must
  contain a non-empty `_atom_site` loop with coordinates. Match exact expected replicate IDs `{key}_{i}`, not ambiguous prefix matches.
  Missing, empty, duplicate or extra generated structures fail the run with a named reason. Encode the source-derived IDs now;
  confirm and fix the exact per-example directory/file layout from the first live run before promotion.
- Tests must collect downloaded artifacts with `runtimeExecutable: ""` and nonexistent local model/assets dirs, matching cloud core.
  Read expected designs from the staged original spec; remote absolute paths in the resolved spec are provenance, not usable client paths.

**installPlan / verifyInstallation**
- Plan lists: wheel + pinned dependency set, two weight files with hashes and sizes, estimated disk.
- Verify: `rfd4-generate --help` exits 0; `import rfd4_proteina` version equals 0.0.3; torch reports 2.14.1 and `torch.cuda.is_available()`;
  a real CUDA tensor op runs; both asset hashes re-checked. Check the installed Torch CUDA build and arch list as well as its base version.
- Dependency consistency must pass managed `uv pip check --python <venv-python>` in the clean-install gate. Do not assume
  `python -m pip check` works: the current `uv venv` call does not seed pip. If this check is also added to the adapter hook, resolve the
  existing managed uv explicitly and inject/mock its runner in tests; do not depend on a host-global pip or uv.

## Manifest `models/rfd4-proteina/manifest.yaml`

- `category: other` (structure + sequence co-design); the current schema already supports it.
- `modelVersion: 0.0.3`, `adapterVersion: 0.1.0`, `status: beta`, `license: BSD-3-Clause`.
- `runtimes`: python 3.12, `installer: uv`, `platforms: [linux-x64]`, `torchBackend: cu126`, `nvidiaGpu: required`, `cuda.level: required`,
  `minDriverCudaVersion` set from the live gate (do not guess), `binaryOnly` listing exact names for torch, cuequivariance ops, tmol ops
  and the resolved NVIDIA wheel packages.
- `requirements`: `rfd4-proteina==0.0.3` with `extras: [all-cuda12]` and the wheel hash, then the **full transitive set pinned with hashes**.
  Produce it with `uv pip compile --python-platform x86_64-manylinux_2_28 --python-version 3.12 --torch-backend cu126 --generate-hashes`
  (works from macOS) and cross-check by installing on the GPU box. `atomworks[ml,openbabel]` pulls many packages and `openbabel` can need system libs: check it.
- Current installation first verifies hashed requirements with `--require-hashes --no-deps`, then performs an ordinary dependency-resolution
  pass. Supply the entire pinned closure and compare the installed freeze against it; do not describe this as a single fully locked install.
  Use exact package names in `binaryOnly` (the schema does not expand `nvidia-*` globs).
- `assets`: two entries (HF `resolve/a06e2509…/…` URLs, `archive: none`, hashes and sizes above).
- Do not copy upstream's pip-bootstrap instruction (a hash-pinned `pip 26.2.2` URL justified by a "compromised eMudhra/emSign CA" claim). That is
  upstream documentation, unverified by me; MoleculeDesk's installer uses `uv` with `--require-hashes` and does not need it.
- `input.formats: [.yaml, .yml, .json]`. Outputs: `generated_structures`, `input_structures` (optional), `resolved_spec`, `summary` (optional).
- `cloud` block added only after the live gate, because it needs measured numbers (see below).

## Gates before commit

Focused tests: spec validation (each rejection above), design-key identifier rules, absolute/`..`/backslash/symlink inputs, rewritten spec
content, exact argv and env, param bounds, no pass-through of overrides, output validity (missing, empty, extra, symlink, wrong count),
registry/catalog tests, `pack:verify` expected-model list. Then `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm pack:verify`, **in that order**
(stale `dist` broke CI in #21). Fetch before branching. No AI attribution in commits or PR text.
Include inherited/shared companion inputs, `.cif.zst`, random/explicit seed provenance, fractional params, both compile branches,
Hydra path escaping and cloud collection without a local runtime. Refresh/check the worker bundle as described below in both implementation PRs.

## Gates on a rented Linux/NVIDIA GPU (A100 or L40S first)

1. Clean `moldesk install rfd4-proteina`; record wall time, disk (including the source checkout), driver/CUDA, exact resolved freeze.
   Run managed `uv pip check --python <venv-python>` and compare the freeze to the pinned closure.
2. Run upstream's smallest monomer and the PD-L1 binder spec (`docs/examples/inputs/5o45_cropped.cif.zst` + the 10-line YAML) with `numReplicates=1`.
   Wrap the annotated monomer CIF in a condition spec with `input_as_annotated_cif: true`; direct CIF input is outside v1.
   Exercise the supported `.cif.zst` path and two replicates; confirm naming, count, CIF validity and resolved-spec checksum.
3. **Network-off proof:** repeat with outbound traffic blocked after install; it must complete. Any fetch found (anarcii, HF, torch hub) gets pinned or disabled.
4. Record peak VRAM and disk on a 50- and a 120-residue binder; derive `minVramGb`, `minRamGb`, `ephemeralDiskGb`, `volumeGb`.
5. Cancel mid-run; confirm no orphan processes and no partial `inference_samples` reported as success.
6. Confirm the GPU the run used matches the allow-list. Record `torch.cuda.get_arch_list()` and extension compatibility before making any
   claim about Blackwell kernels. Test excluded GPU refusal in quote/provisioning tests; renting an excluded GPU just to provoke a kernel
   failure is not a prerequisite. Keep Blackwell excluded from v1 pending separate validation.

## Cloud (second PR)

- Models run on the user's own Runpod account only. BSD-3 permits redistribution, but MoleculeDesk still does not host.
- `cloud` block: digest-pinned `runpod/pytorch` image whose CUDA matches cu126 (verify the digest used by OpenDDE; reuse if it fits),
  `gpuAllowList` limited to upstream-tested Ampere/Ada/Hopper parts (A100 40/80 GB variants, H100 variants, H200, L40S, RTX 6000 Ada),
  numbers from the gate above. Spec companion files are uploaded, so the run needs `--accept-file-upload`.
- Test client-side TypeScript validation, companion upload/rewrite on Linux, installation, inference, artifact download/collection on a Mac,
  visualization and confirmed Pod cleanup end to end. Start with `ephemeral`; persistent caching remains experimental.
- Refresh the worker bundle in **both PR 1 and PR 2**, including PR 1 without a cloud block: manifests and bundled adapter code affect it.
  After final bundled-source edits, run `node scripts/worker-release.mjs update --tag <next tag>`, rebuild and run
  `node scripts/worker-release.mjs check`; commit the release-record update in the same PR (see `runpod-remaining-work.md`).
- A pre-release live cloud test needs a newly built worker served at an HTTPS URL plus its exact checksum through
  `MOLDESK_WORKER_BUNDLE_URL` / `MOLDESK_WORKER_BUNDLE_SHA256`. The existing released worker cannot run the new adapter.
  End-user support requires publishing the matching CLI and worker release asset, then repeating a smoke test without these overrides.

## Post-implementation test commands

These are acceptance commands, not commands that work before the adapter/fixtures are implemented. Add and live-test
`examples/rfd4-proteina/monomer.yaml` plus its small annotated companion CIF in PR 1; also add a binder spec/companion fixture if its
redistribution terms permit. The monomer YAML must preserve the source CIF's annotations with `input_as_annotated_cif: true`.

From the repository root, build dependencies before using the development CLI:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm pack:verify
pnpm --filter @moldesk/cli dev describe rfd4-proteina
```

The remaining examples use `moldesk` from the matching installed release. For a source checkout, replace `moldesk` with
`pnpm --filter @moldesk/cli dev`. Cloud development also needs the matching worker override described above.

Local smoke test: run on supported Linux x86_64/NVIDIA hardware, not on the Mac submitting cloud jobs.

```bash
moldesk install rfd4-proteina --yes
moldesk run rfd4-proteina examples/rfd4-proteina/monomer.yaml \
  --param numReplicates=1 \
  --param batchSize=1 \
  --param seed=42 \
  --param recycle=thinking_low \
  --param compile=false \
  --output ./rfd4-local-results
```

Repeat with `--param numReplicates=2` and a fresh output directory. Expect exactly two generated structures for the one-design fixture.
Also test an omitted seed (effective seed recorded), `compile=true`, and cancellation separately.

Runpod smoke test: usable from the Mac after PR 2 and a matching worker are available. No local model installation needed.
The budget/lifetime values are illustrative limits, not measured cost or duration promises; inspect the quote and adjust for the cold install.

```bash
moldesk cloud connect runpod
moldesk cloud status

# Quote only: no upload or provisioning.
moldesk run rfd4-proteina examples/rfd4-proteina/monomer.yaml \
  --compute runpod \
  --cache-policy ephemeral \
  --gpu "NVIDIA L40S" \
  --max-budget 10 \
  --max-lifetime 3600 \
  --param seed=42 \
  --param recycle=thinking_low \
  --dry-run

# Prompts for approval of the quote; explicitly acknowledges the companion upload and lifetime risk.
moldesk run rfd4-proteina examples/rfd4-proteina/monomer.yaml \
  --compute runpod \
  --cache-policy ephemeral \
  --gpu "NVIDIA L40S" \
  --max-budget 10 \
  --max-lifetime 3600 \
  --param seed=42 \
  --param recycle=thinking_low \
  --accept-file-upload \
  --accept-lifetime-risk \
  --output ./rfd4-cloud-results

moldesk cloud resources
```

For noninteractive execution add `--yes` to the actual run after reviewing the quote. Pass criteria: exactly one valid generated CIF,
the resolved spec, effective seed and remote runtime/command provenance in the run artifacts, downloaded results, and confirmed Pod cleanup.
Use `moldesk cloud recover <run-id>` if cleanup remains pending. These runs validate execution; generation-only v1 does not establish
binding quality, provide refolding scores or guarantee bitwise-identical results across GPUs.

## Risks and open questions

- **Alpha churn.** 0.0.3 may change quickly. The pin protects us; re-verify before each bump, including the HF revision.
- **Heavy dependency stack** (atomworks, openbabel, tmol, cuequivariance, cutlass DSL, anarcii). Transitive resolution is the main schedule risk.
- **Output writer compatibility** (see collectOutputs). Replicate IDs are known from source; confirm the exact file layout in the first live run.
- **Memory growth with length.** Upstream supports up to 1024 tokens; VRAM at 512+ is unmeasured. Floors from short runs only, as with other models.
- **Dual-use.** The model designs binders, including to DNA and arbitrary targets, and nothing in the CLI screens sequences.
  See delivery default 1 below.

## Delivery defaults

1. Include a short factual screening/limitations note in the model README and page: upstream Spaces screen designs; this CLI does not.
2. Ship generation-only v1; document reward-guided search and refolding as unsupported. Generated candidates need downstream evaluation.
3. Defer CUDA 13 and Blackwell to a separately validated runtime profile. These defaults do not block the adapter implementation.

## Files and change budget

New: `models/rfd4-proteina/{manifest.yaml,README.md}`; `packages/adapters/src/rfd4-proteina/{index.ts,index.test.ts}`;
`examples/rfd4-proteina/` with the tested monomer YAML and annotated companion CIF (check the file's own license first); website model page.
Existing edits: `catalog.ts`, catalog/registry test expectations, pack-verify model list, README, website navigation and the generated
`packages/core/src/cloud/worker-release.ts` release record in each implementation PR.
Target: no core behavior, runtime, registry-schema or installer changes. A source-checkout-free installation or new configurable `cwd`
contract would be separate work if later required; neither is assumed by v1.
