# Boltz-2 adapter

Upstream: https://github.com/jwohlwend/boltz (MIT).
Pinned revision: `cb04aeccdd480fd4db707f0bbafde538397fa2ac`, the commit
referenced by upstream release tag `v2.2.1`; PyPI `boltz 2.2.1` is used as
`modelVersion` (requires-python `>=3.10,<3.13`, verified via PyPI and
`pyproject.toml`).

## Runtime decision

Python (`installer: uv`), matching ProteinMPNN/LigandMPNN — `boltz==2.2.1`
is genuinely pip-installable and its transitive dependencies are pinnable
(see below), satisfying the spec's "prefer Python only if it can be pinned
and reproduced" rule.

## Dependency pinning

`boltz==2.2.1`'s own `pyproject.toml` pins nearly every dependency exactly,
except four open ranges: `torch>=2.2`, `numpy>=1.26,<2.0`, `rdkit>=2024.3.2`,
`pandas>=2.2.2`. The manifest pins these explicitly to real, verified
versions (`torch==2.8.0`, `numpy==1.26.4`, `rdkit==2025.3.6`,
`pandas==2.3.2`) so installs stay reproducible over time. MoleculeDesk also
resolves and pins the *full* transitive dependency graph at install-plan
time (see `resolvePythonLock` in `@moldesk/runtime`), folding its digest
into the runtime fingerprint.

## Checkpoint/asset provenance

Boltz's own downloader (`download_boltz2()` in `boltz.main`) performs **no
checksum verification** — it uses `urllib.request.urlretrieve` with no
digest check, and pulls from `.../resolve/main/...` (a moving ref). This
manifest instead pins each asset to a specific Hugging Face commit and a
checksum obtained via Hugging Face's blob-metadata API (`?blobs=true`),
so no full-file download was needed to compute them, and MoleculeDesk's own
asset pipeline verifies what upstream does not:

| file | source @ commit | sha256 |
|---|---|---|
| `boltz2_conf.ckpt` | `boltz-community/boltz-2` @ `6fdef46d763fee7fbb83ca5501ccceff43b85607` | `090e82ac8c92f5e943fa1b39e7410a44027bea7243c0bbb3caa67a77fc1428e1` |
| `boltz2_aff.ckpt` | same | `dcc5cd3722b1c9eaa34267e4ae32f55cbbf1963f4c19319381ccfa30fdd2ca9e` |
| `mols.tar` | same | `39e076d96dbec6b4e86982bbda16f3a53a2a60c9bdc17828d88f6f9a0c7d1fd7` |

`ccd.pkl` is **not** pinned as an asset — confirmed by reading
`boltz.main`'s source that the `--model boltz2` code path never downloads
it (`download_boltz2()` only fetches the two checkpoints and `mols.tar`)
and never reads it (`process_inputs` loads the CCD dictionary via
`load_canonicals(mol_dir)` for boltz2, not by unpickling `ccd.pkl` — that
only happens on the boltz1 branch). Including it would have been silently
wrong, not just unnecessary.

`mols.tar` is uncompressed, so the registry's `AssetSpec.archive` enum
gained a `"tar"` option (alongside the existing `"tar.gz"`/`"zip"`) and
`materializeAsset` extracts it during install — inside the same atomic
staging directory as every other install mutation — rather than letting
`boltz predict`'s own first run extract it into the shared assets
directory outside that atomicity guarantee.

## CLI shape (confirmed by reading `boltz.main` at the pinned commit)

`boltz predict <input> --out_dir <out> --cache <assetsDir> --output_format
mmcif --accelerator <cpu|gpu> [...params]`. Accepted input extensions:
`.fa`, `.fas`, `.fasta`, `.yml`, `.yaml` (confirmed via `check_inputs`).
Real output directory layout: `<out_dir>/boltz_results_<input-stem>/predictions/<record-id>/*.cif`
— three levels deep, requiring the registry's `**` glob matching to be
genuinely recursive (fixed in `@moldesk/adapters`'s `outputs.ts`).

`--output_format` is hardcoded to `mmcif` by the adapter, never exposed as
a param — the manifest only declares a `*.cif` output, and letting a run
succeed with `pdb` output would make MoleculeDesk wrongly report
`MISSING_REQUIRED_OUTPUT` on a run that actually worked.

`--use_msa_server` is deliberately not exposed as a param — it makes an
outbound network call to an MMSeqs2 server, which a reproducible "run"
should never do silently.

## Known CPU-inference correctness bug (why GPU is required for v0.1)

The pinned revision (`v2.2.1`) has a confirmed, real upstream bug: CPU
inference produces **distorted structures** (excessively long bonds,
colliding atoms) — see
[jwohlwend/boltz#653](https://github.com/jwohlwend/boltz/issues/653) and
[#662](https://github.com/jwohlwend/boltz/issues/662), a device-specific
autocast precision issue. It was fixed by
[PR #670](https://github.com/jwohlwend/boltz/pull/670) ("force float32
precision on CPU"), but that PR merged *after* the `v2.2.1` tag and is not
in any released `boltz` package on PyPI as of this writing.

Consequences:
- `hardware.nvidiaGpu`/`cuda.level` are `required`, not `recommended` — a
  CPU-only machine is honestly reported as unsupported.
- The adapter exposes `accelerator` as an explicit `cpu|gpu` param,
  **defaulting to `gpu`**, never silently defaulting to a known-broken CPU
  path. `accelerator=cpu` remains available as an informed, explicit
  opt-in — not the default.

## Status

Registry status is `beta` (adapter code and unit/fixture tests are real —
same convention as ProteinMPNN/LigandMPNN, meaning "installs and runs
Python code correctly," not "release-verified"). **Boltz-2 remains an
outstanding v0.1 release gate** until a real install + `boltz predict` run
is verified on an actual CUDA host (e.g. via RunPod) — nothing in this
adapter's test suite exercises a real checkpoint download or a real GPU
run; all installation-lifecycle and run-lifecycle tests use the same
injected-runner/fake-provider pattern as ProteinMPNN/LigandMPNN.
