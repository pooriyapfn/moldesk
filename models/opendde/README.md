# OpenDDE Preview adapter

All-atom biomolecular co-folding (proteins, DNA, RNA, ligands, ions,
covalent links) from Aureka AI Research. Given an OpenDDE JSON job, predicts
3D structures (mmCIF) plus confidence summaries (pLDDT, pTM/ipTM, ranking
score, clash flags).

Upstream itself calls this a **preview**: "CLI flags, input/output JSON
fields, and released checkpoints may change between versions, and
predictions are not guaranteed to be reproducible across releases. It is not
yet intended for production pipelines." MoleculeDesk therefore keeps it at
`status: beta` regardless of verification.

## Source and provenance

- Repository: https://github.com/aurekaresearch/OpenDDE — **Apache-2.0**
  (`LICENSE`; `pyproject.toml` `license = "Apache-2.0"`; PyPI metadata
  `license_expression: Apache-2.0`). Checkpoints on Hugging Face
  (`aurekaresearch/OpenDDE`) are published by the same project under the same
  license.
- Pinned release: **v1.1.1** (latest tag, verified with `git ls-remote --tags`
  on 2026-09-26). Tag object `1e986714b6a397d0d812d58ee78e1c7dc8c75cf2` peels
  to commit **`ddfa1df8aff1babf1fddac4247b7d2351bd0ce9f`** (the manifest's
  `source.revision`).
- Package: **`opendde==1.1.1`** from PyPI, installed from the exact wheel
  `opendde-1.1.1-py3-none-any.whl`, sha256
  `94b193bd360e017c9cfab08d199ec9333cb2919a49fe1d9270c659c4b2efe544`
  (enforced by uv's hash-checking pass). Package ↔ source correspondence was
  verified by unpacking that wheel and comparing all 117 files under
  `opendde/` and `runner/` byte-for-byte against the pinned commit: 0
  differences. `verifyInstallation` additionally asserts the installed
  distribution version is exactly `1.1.1`.
- Torch: opendde 1.1.1 itself pins `torch==2.7.1`. Apple Silicon installs
  PyPI's `torch-2.7.1-cp311-none-macosx_11_0_arm64.whl` (sha256
  `aea4fc1bf433d12843eb2c6b2204861f43d8364597697074c8d38ae2507f8730`); the
  Linux entry pins `torch-2.7.1+cu126-cp311-cp311-manylinux_2_28_x86_64.whl`
  from `download.pytorch.org/whl/cu126` (sha256
  `e1a8465165708c2e2e90786ade8a3e1b1d01eca1f022792cd397caad9d8c21bc`).
- Public model: `opendde_v1`, 655,791,538 parameters, training-data cutoff
  2021-09-30 (upstream `opendde/config/model_manifest.json`).

## Platforms

| Platform | Runtime entry | Status in this manifest |
| --- | --- | --- |
| `darwin-arm64` (Apple Silicon) | native PyPI torch 2.7.1 with MPS, no CUDA/cuEquivariance extra, never the NVIDIA Docker image | **Advertised** — live gate below |
| `linux-x64` + NVIDIA | upstream's `--torch-backend cu126 "opendde[gpu]"` install (Triton + cuEquivariance 0.10.0), CUDA probe on verify | Implemented and unit-tested, **not advertised** — no NVIDIA hardware was available to run the CUDA gate |
| CPU | `--param device=cpu` on either install | Allowed explicitly, documented as slow; never selected implicitly |

The Linux entry is present in `runtimes:` but `linux-x64` is deliberately
absent from `hardware.platforms`, so the compatibility check rejects Linux
hosts before that entry can be selected. To enable it, run the CUDA gate
below on a real NVIDIA host, record the evidence here, then add `linux-x64` to
`hardware.platforms`.

### Reusable installer field: `torchBackend`

Upstream's supported install selects the PyTorch build with uv's
`--torch-backend` (`cpu`, `cu126`). Rather than an arbitrary index URL or pip
argument fragment, the registry gained a strictly validated closed-enum
runtime field, `torchBackend: cpu | cu126`, which the installer maps to
`UV_TORCH_BACKEND` on every uv invocation (managed uv 0.12.8 supports it).
Extend the enum only alongside a manifest that pins and verifies that
backend's wheels.

## Assets: no uncontrolled downloads

Upstream reads everything from `$OPENDDE_ROOT_DIR` (default
`~/.cache/opendde`) and, on first `opendde pred`, downloads any missing
checkpoint/common file there. MoleculeDesk instead installs the files below at
install time, through its checksum-verified asset pipeline, into
`<install>/assets/opendde-root/`, and every run sets
`OPENDDE_ROOT_DIR` to that directory. All three are pinned to Hugging Face
commit `eddd563ce96571f784012edd8f045181c8f8627d` — the revision upstream's
own `model_manifest.json` names — with upstream's published sizes/digests,
independently re-checked against Hugging Face's `X-Linked-Size`/`X-Linked-ETag`:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `checkpoint/opendde.pt` (general-purpose) | 2,625,249,069 | `7b826620390afad877ee2babc6a4d0df81b94d3a0be030959853d6a7da0807cc` |
| `common/components.cif` (CCD) | 490,777,362 | `bb31ae5cf6c8bc669924313077cb4231ee5ffefd3a20118cd14f3ec89f8bb6a5` |
| `common/components.cif.rdkit_mol.pkl` | 142,498,117 | `d1cfb71f5993a3ebea7c47877022d7f597bbfbaf86e28a4770e957da6c50cd35` |

Defense in depth for runs:

- the adapter passes `--load_checkpoint_path` explicitly, so upstream never
  enters its checkpoint download path;
- `OPENDDE_DEPENDENCY_URL`, `OPENDDE_COMMON_URL`, and
  `OPENDDE_SEARCH_DATABASE_URL` are set to `https://downloads-disabled.moldesk.invalid`
  (an RFC 2606 reserved, never-resolvable name), so if an installed file ever
  went missing or changed size, upstream's fallback download fails
  immediately instead of silently fetching into the install;
- `verifyInstallation` re-checks each file's exact size **and** SHA-256
  (upstream's own runtime check is size-only).

**Not installed:**

- `opendde_abag.pt` (antibody–antigen checkpoint, 2,625,271,509 bytes,
  sha256 `5cf37441ddef2a2f148b81dd4a218ad274f996fecaf17dec901ab6cf1351713d`).
  MoleculeDesk's asset model has no optional/opt-in asset concept yet, so
  shipping it would force another 2.6 GB onto every install. No param selects
  it.
- Template and RNA-MSA search databases — `pdb_seqres` (~220 MB), Rfam
  (~220 MB), RNAcentral (~13 GB), NT-RNA (~75 GB) from
  `storage.googleapis.com/alphafold-databases/v3.0`, plus a PDB mmCIF mirror
  for template featurization — and the template-only
  `obsolete_to_successor.json` / `release_date_cache.json`. See the params
  below for how the adapter keeps runs from reaching for them.

Total install footprint: ~3.26 GB of assets + the managed Python environment
(measured below).

## Job format and companion files

An OpenDDE job file is upstream's own format: a non-empty JSON **list** of
jobs, each with `name`, `sequences` (one entity key per item:
`proteinChain`, `dnaSequence`, `rnaSequence`, `ligand`, `ion`), optional
`modelSeeds` and `covalent_bonds`. See upstream
`docs/infer_json_format.md`. `examples/opendde/tiny.json` is the smallest.

Pure sequence / SMILES / CCD jobs are single-file inputs. When a job
references files, the adapter declares them as companion inputs and the
generic staging capability copies each into the run's `input/` area before
execution:

| Field | Allowed extensions |
| --- | --- |
| `proteinChain.pairedMsaPath`, `proteinChain.unpairedMsaPath` | `.a3m` |
| `proteinChain.templatesPath` | `.a3m`, `.hhr` |
| `rnaSequence.unpairedMsaPath` | `.a3m` |
| `ligand.ligand` = `FILE_<path>` | `.pdb`, `.sdf`, `.mol`, `.mol2` |

References resolve relative to the job file and must stay inside the job
file's directory tree (traversal, absolute paths elsewhere, and
symlinks/ancestor symlinks escaping it are rejected); each must be a
non-empty regular file. The legacy `proteinChain.msa` form (a directory) is
rejected. Because upstream opens these paths relative to its working
directory, the adapter writes `output/moldesk-resolved-job.json` — the job
with every reference rewritten to its staged absolute path — runs that, and
records it as the checksummed `resolved_job` output. Every staged file's path
and SHA-256 are recorded in `run.json`; the run keeps working after the
original files are moved or deleted.

Job names must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (stricter than
upstream) and may not be `err` (reserved by upstream for error reports).

## Params

| Param | Default | Maps to | Notes |
| --- | --- | --- | --- |
| `device` | `mps` on the darwin-arm64 install, `cuda` on linux-x64 | `--device` | `auto` is resolved by the adapter to the installed accelerator — never passed through, because upstream's own `auto` silently falls back to CPU. `mps` off Darwin and `cuda` on the Darwin install are rejected before launch. An explicit `mps`/`cuda` fails closed upstream if unavailable. `cpu` is allowed only explicitly and is slow. |
| `samples` | `1` | `--sample` | Upstream default is 5. |
| `steps` | `200` | `--step` | Upstream default. |
| `cycles` | `10` | `--cycle` | Upstream default. |
| `seed` | — (job `modelSeeds`) | `--seeds` | Integer in [0, 2³²−1]. |
| `use_msa` | `false` | `--use_msa` | `true` uses precomputed A3M paths when present, otherwise queries the **public ColabFold MMseqs2 server** (`api.colabfold.com`, network). |
| `use_template` | `false` | `--use_template false` | `true` is rejected: template featurization needs the search DBs and fetches PDB mmCIFs at run time into the install. |
| `use_rna_msa` | `false` | `--use_rna_msa` | `true` requires a precomputed `unpairedMsaPath` on every `rnaSequence` (the RNA search DBs are not installed). |
| `deterministic` | `false` | `--deterministic` | Deterministic PyTorch algorithms. |

Always passed: `-n opendde_v1 --load_checkpoint_path <install>/…/opendde.pt
--dtype fp32`. Integer params reject fractional values. The defaults make a
bounded, offline smoke test.

## Outputs

Upstream writes `output/<job>/seed_<seed>/predictions/`:

| Output id | Glob | Required |
| --- | --- | --- |
| `structures` | `*/seed_*/predictions/*_sample_*.cif` | yes |
| `confidence` | `*/seed_*/predictions/*_summary_confidence_sample_*.json` | yes |
| `atom_confidence` | `*/seed_*/predictions/*_full_data_sample_*.json` | no |
| `structures_pdb` | `*/seed_*/predictions/*_sample_*.pdb` | no |
| `pdb_export_errors` | `moldesk-pdb-export-errors.json` | no |
| `resolved_job` | `moldesk-resolved-job.json` | no |

**PDB export.** Upstream writes mmCIF only. After validating the mmCIF,
`collectOutputs` converts each structure to a `.pdb` next to it. It uses the
install's own biotite (an exact opendde dependency, 1.4.0), keeps per-atom
pLDDT in the B-factor column, and writes CONECT records for ligand bonds. The
mmCIF paths are passed as argv, never interpolated into the script. Legacy PDB
can't represent every structure (for example >99,999 atoms or multi-character
chain IDs). Those failures are recorded per file in
`moldesk-pdb-export-errors.json` instead of failing a valid prediction, and
the mmCIF stays the primary result.

Beyond the globs, `collectOutputs` requires **every** job in the submitted
file to have produced at least one structure and one confidence summary,
each structure to be a non-empty mmCIF (`data_` block with `_atom_site.`
records), and each confidence summary to parse as a JSON object.

## Verification (`verifyInstallation`)

1. `.venv/bin/python`, `.venv/bin/opendde`, and all three assets present, each
   with its exact published size.
2. Accelerator probe:
   - darwin-arm64: `platform.system() == "Darwin"`, `platform.machine() ==
     "arm64"`, `torch.backends.mps.is_built()`, `torch.backends.mps.is_available()`,
     and a real tensor op executed on `mps` with its result checked;
   - linux-x64: torch CUDA build present, `torch.cuda.is_available()`,
     ≥1 device, `cuequivariance_torch` imports, and a real tensor op on `cuda`.
   Both assert `importlib.metadata.version("opendde") == "1.1.1"`, torch
   `2.7.1`, and that `opendde` and `runner.batch_inference` import.
3. `opendde pred --help` advertises `--device` (with `mps`/`cuda` as
   appropriate), `--load_checkpoint_path`, `--use_msa`, `--seeds`.
4. SHA-256 of every asset.

## Limitations

- Preview upstream; outputs are not guaranteed reproducible across OpenDDE
  releases.
- The minimal default path runs **without MSA or templates**, which is much
  less accurate than a full run — fine for smoke tests, not for science.
- No template search, no RNA-MSA search, no ABAG checkpoint (see above).
- Multi-GPU Fold-CP (`torchrun`) is not exposed.
- Linux/CUDA not live-verified, therefore not advertised.

## Live verification

### Apple Silicon (MPS) — passed, 2026-09-26

Host: Apple M3 MacBook Air, 8 cores, 24 GB unified memory, macOS 26.6.2
(Darwin 25.6.0, arm64), Node v22.23.2. Managed env: Python 3.11.16,
torch 2.7.1 (`mps_built=True`, `mps_available=True`), opendde 1.1.1, source
`ddfa1df8aff1babf1fddac4247b7d2351bd0ce9f`. `PYTORCH_ENABLE_MPS_FALLBACK`
unset, so any MPS-unsupported operator would have raised instead of falling
back to CPU.

1. `moldesk doctor` → `darwin (arm64)`, `Apple M3`, `✓ Apple Silicon`.
2. Clean install (no prior `~/.moldesk/models/opendde`):
   `moldesk install opendde --yes` → `OpenDDE Preview: installed.`
   `verifyInstallation` passed: exact sizes, MPS probe (Darwin/arm64,
   MPS built+available, real `mps` matmul), pinned versions, CLI flags, and
   SHA-256 of all three assets. The venv is 823 MB and the assets are 3.1 GB.
   (An earlier attempt was killed mid-download by a tool timeout, not by
   MoleculeDesk. The resumed install reused the partial download and verified
   it.) Install time: 261 s, with the asset cache partially warm.
3. `moldesk run opendde examples/opendde/tiny.json` → `succeeded`, exit 0,
   **39 s** wall (`durationMs` 38608). The upstream log shows
   `Apple MPS backend selected; dtype=fp32, triangle kernels: multiplicative=torch, attention=torch.`,
   `Selected inference device: mps`, and
   `tiny [seed:101] succeeded. Model forward time: 28.06s`. No fallback or CPU
   warnings appear in stdout/stderr, and no `opendde pred` process was left
   running.
   Command recorded in `run.json`:
   `opendde pred -i <run>/input/tiny.json -o <run>/output -n opendde_v1 --load_checkpoint_path <install>/assets/opendde-root/checkpoint/opendde.pt --device mps --dtype fp32 --sample 1 --step 200 --cycle 10 --use_msa false --use_template false --use_rna_msa false --deterministic false`
   with `OPENDDE_ROOT_DIR` set to the install and the three download URLs set
   to the `.invalid` sentinel.

   | Item | SHA-256 | Notes |
   | --- | --- | --- |
   | input `tiny.json` | `e6872dbc4567999081d3436f2d5687fd955671b7035061ddfbe39fbbe94d4fd3` | |
   | `tiny_sample_0.cif` | `e23d930f546c85b1d5d5cabe36d48c189bd3cbfda0c0b16ac66aacadea74055b` | 8035 B; biotite parses 9 residues / 71 atoms |
   | `tiny_summary_confidence_sample_0.json` | `a0aba926fe291a5d05030ee166d23432ee14f333ab70988121e5f71ddaedcb75` | pLDDT 93.08, pTM 0.196, ranking 0.039, no clash |
   | `tiny_full_data_sample_0.json` | `ae91bd8759aec2f20fde75c2a75f98c57b1796399c2ab4a6a129af03f7f5107e` | |

4. Companion staging: `examples/opendde/` was copied to a temp dir and the run
   used `ligand-file.json` there (`"ligand": "FILE_ligand.sdf"`). Result:
   succeeded in 38 s on `mps`. The temp copy was then deleted. `run.json`
   records the staged `j0-s1-ligand-file/ligand.sdf` (sha256
   `da0ad70027c82cf876d0d95a3034a38d23e47cb8e09b62020f8af9e2e07135d3`), and the
   checksummed `moldesk-resolved-job.json` points at that staged copy, which
   still exists. The structure has chains A (protein) + B (ligand, 33 HETATM),
   187 atoms in total.
5. Reproducibility: two runs of `tiny.json` with `--param seed=101 --param
   deterministic=true` were **not byte-identical**. Coordinate RMSD between
   them was 6.4×10⁻⁵ Å (max 8.5×10⁻⁵ Å), and pLDDT/pTM/ranking agreed to
   about 1e-7. That is fp32 accumulation-order noise on MPS. The runs are
   reproducible enough for smoke testing but not bitwise.
6. Negative paths, all rejected before any model process started:
   `--param device=cuda` → `INVALID_RUN_PARAMS: --param device=cuda is not valid for the darwin-arm64 installation (no CUDA build).`;
   `--param use_template=true` → `INVALID_RUN_PARAMS` (template DBs not provisioned);
   `--param device=tpu` → `--param device: "tpu" is not one of auto, mps, cuda, cpu.`

7. PDB export + timing (same M3, later session with a warm file cache;
   default params: 1 sample, 200 steps, 10 cycles, no MSA). Every run wrote
   a `.pdb` next to its mmCIF, and the ligand PDB has 33 HETATM and 38
   CONECT records:

   | Job | Tokens | Model forward | Wall (whole `moldesk run`) |
   | --- | --- | --- | --- |
   | `tiny.json` (9 aa) | 9 | 12.9 s | 26 s |
   | `ligand-file.json` (20 aa + ligand) | ~53 | 26.6 s | 37 s |
   | ubiquitin (76 aa) | 76 | 56.1 s | 67 s (pLDDT 91.7, pTM 0.90) |

   The first-ever run after install was slower (tiny: forward 28 s, 39 s
   wall) because checkpoint and library files were not yet in the OS cache.

Known MPS notes: upstream always uses the PyTorch triangle kernels on MPS
(cuEquivariance is CUDA-only), and this run recorded no per-operator CPU
fallback.

### Linux x64 + NVIDIA CUDA — NOT run

No NVIDIA hardware was available. Exact gate to run before adding `linux-x64`
to `hardware.platforms`:

```bash
nvidia-smi
moldesk doctor
moldesk install opendde --yes   # after temporarily advertising linux-x64
moldesk run opendde examples/opendde/tiny.json --param device=cuda
grep "Selected inference device: cuda" ~/.moldesk/runs/<run>/stdout.log ~/.moldesk/runs/<run>/stderr.log
CUDA_VISIBLE_DEVICES="" moldesk run opendde examples/opendde/tiny.json --param device=cuda   # must fail early, not fall back
```

Things to spot-check there: the `UV_TORCH_BACKEND=cu126` resolution of
`torch==2.7.1+cu126` against the pinned hash, and that the
`cuequivariance_torch` import in the CUDA probe succeeds.
