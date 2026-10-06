# BindCraft2 adapter

Local protein-binder campaigns using AlphaFold and ProteinMPNN/HyperMPNN.
**Status: planned.** Implementation and automated checks do not constitute
live CUDA verification. No GPU was available on the development Mac.

## Source, license and dependencies

- Canonical upstream: https://github.com/PacesaLab/BindCraft2
- Source revision: `5bac63cd2d4e7ed3d5077ba4fc5966e0352038e4`, reviewed 2026-10-06.
- Package: `bindcraft` 1.0.3, installed from that revision with `cuda12` extras.
- Python: managed 3.12. JAX/JAXlib/CUDA plugins: 0.11.2; cuEquivariance family:
  0.11.1. Full dependency closure is version-pinned in the manifest, resolved
  for Linux x64/Python 3.12 with managed uv 0.12.8. Accelerator components are
  wheel-only; an actual clean GPU install remains unverified.
- License: **BindCraft2 Source-Available License (Hosting-Restricted)**.
  Local/internal commercial use is permitted. Substantial functionality cannot
  be exposed as a hosted service without a separate commercial license.
  This model is not OSI open source. MoleculeDesk runs it on the user's own
  workstation/server and does not implement hosted third-party execution.
- AlphaFold parameters: upstream's official 2022-12-06 release, CC BY 4.0.
  ProteinMPNN/HyperMPNN weights (MIT) ship in the immutable upstream tree; retain
  upstream notices and attribution when redistributing that tree.

## Installation and relocation

The existing managed installer provisions the Python environment, pinned source
and verified assets, then verifies before atomic promotion. It does not invoke
upstream `install.sh`, download another uv, create an editable installation or
execute shell snippets.

Upstream's wheel excludes repository-root `settings/` and `scaffolds/`, although
its CLI loads presets beside its package. Runs use the installed Python CLI
module with `PYTHONPATH=<install>/source` and `PYTHONNOUSERSITE=1`, so code,
presets and shipped weights come from the same pinned checkout. Paths are
recomputed from the final install directory; none retain a staging path.

## Hardware and managed assets

Linux x64 + NVIDIA only, CUDA 12 runtime, driver supporting at least CUDA 12.1.
JAX documents driver >=525 for CUDA 12; GPU SM >=5.2. See
https://docs.jax.dev/en/latest/installation.html. No macOS, CPU, AMD, CUDA 13,
multi-GPU or automatic-worker support in this adapter.

Plan at least 25 GB free disk for environment, cached archive, extracted weights
and results; at least 24 GB host RAM. GPU memory depends on target/binder size,
not a single universal minimum. Upstream estimates roughly 8 GB per worker for
a padded 128-residue complex, with additional headroom; prefer a larger card
for the combined model test session. These estimates are not live measurements.

The official AlphaFold archive is pinned by Google object generation, exact size
and SHA-256 in `manifest.yaml`. All seven required campaign checkpoints are
verified, alongside the three MPNN `v_48_020` variants. The adapter checks
integrity before install promotion and each launch. It sets explicit
`BINDCRAFT_AF2_PARAMS` and `BINDCRAFT_MPNN_WEIGHTS`; missing files fail instead
of triggering upstream's lazy download. Working/compilation caches stay under
managed install/run paths through `BINDCRAFT_WEIGHTS`, `XDG_CACHE_HOME`,
`JAX_COMPILATION_CACHE_DIR` and `MPLCONFIGDIR`.

Verification checks package pins, presets, upstream `selfcheck cuda12`, real
JAX CUDA tensor execution and free space. Launch also probes CUDA and refuses
CPU fallback. Inherited upstream worker knobs and disabled CUDA constraint
checks are cleared; local library search overrides cannot replace pinned wheels.

### Verified checkpoint digests

The official archive was read byte-for-byte on 2026-10-06 (temporary range
parts deleted after verification): 5,587,968,000 bytes; SHA-256
`36d4b0220f3c735f3296d301152b738c9776d16981d054845a68a1370b26cfe3`. Each required extracted checkpoint is also size/hash
checked before installation promotion and before every campaign:

| Checkpoint | Bytes | SHA-256 |
| --- | ---: | --- |
| `model_1_multimer_v3` | 373043148 | `611da8fc7478928f68de12e8b226260ef1f4ce62bcc29b008572e52f4f212959` |
| `model_2_multimer_v3` | 373043148 | `51362b0844382ae0f5720c59b81dd13a43eea40fbf9995dd2573bdab88865378` |
| `model_3_multimer_v3` | 373043148 | `46d9bcad288edc7ad5a6362ee8e5f84307a69712e00e6c36b1ef9daf96ebc9ce` |
| `model_4_multimer_v3` | 373043148 | `59bdabd2d69c07fe26b37882d544acbd1b9f89f196828f4220da49e0610b572c` |
| `model_5_multimer_v3` | 373043148 | `917742be5a105d6b80f13f1f13f20459f27ec3fdcd34ea088b359f4502d6177f` |
| `model_1_ptm` | 373103340 | `5e564f79af5bcd54ccef6e2a6bb0ff01015d01650ebc41d4575e35f0de9ecc84` |
| `model_2_ptm` | 373103340 | `23645d9a82c4af2ed54cd48a7b3c1c2575dc6aa9fe931adb4d7203ca5f0dc398` |

## Campaign input and params

Input is one JSON object with an explicit non-empty `targets` list. Each target
has a unique safe `name`, a PDB/mmCIF/FASTA `target_path`, and optional `chains`,
`hotspots`, `coldspots`, `objective` (`target`/`detarget`) and positive `weight`.
At least one positive target is required.

Supported top-level fields: `targets`, `modality`, `binder_lengths`,
`binder_scaffold`, `number_of_final_designs`, `max_trajectories`,
`campaign_seed`, `project_folder`, `resume`, `auto_multi_gpu`, `design_workers`.
Other fields, named target shortcuts, arbitrary preset files, parameter sweeps
and modality combinations are rejected in this initial integration.

Targets/custom scaffolds are confined to the campaign directory tree, copied
into immutable run input, and checksummed in `run.json`. Traversal and symlinks
escaping that tree fail. The adapter writes checksummed `moldesk-campaign.json`
with staged paths and forces `project_folder` to the new run output directory.

| CLI param | Behavior |
| --- | --- |
| `modality` | `binder` (default), `peptide`, `cyclic_peptide`, `VHH`, `ARP` |
| `number_of_final_designs` | Positive integer; CLI overrides campaign value |
| `max_trajectories` | Mandatory positive integer finite attempt bound; CLI overrides campaign value |
| `min_length`, `max_length` | Supply together; replace `binder_lengths` |
| `resume` | Only `false`; every invocation starts a fresh independent run |

Both counts must exist after overrides. Plain binders require ordered positive
`binder_lengths`, or a custom structure scaffold. Peptides must be below 25
residues. VHH/ARP use pinned shipped scaffolds; custom scaffold/length overrides
are rejected. All runs force `resume=false`, `auto_multi_gpu=false`,
`design_workers=1`; finalized prior runs are never modified.

## Results and zero accepted designs

- `1_Trajectories/!_Trajectories.csv` and optional trajectory structures.
- `2_Refolded/!_Refolded.csv` and candidate structures when produced.
- `3_Ranked/!_Ranked.csv` and accepted mmCIFs when produced.
- Upstream `campaign_metadata.json`, `summary.csv`, resolved campaign, and
  adapter-authored `moldesk-summary.json`.

CSV quoting/columns and mmCIF coordinates are parsed with the managed Python
runtime. Outputs are confined to the run directory and symlinks are rejected.
Every ranked design must have a structure. Attempt counts cannot exceed the
budget, and a run must reach its design goal or exhaust its budget.

A finite campaign can finish successfully with **zero accepted designs**.
`moldesk-summary.json` records attempted, accepted, requested, budget,
`budgetExhausted`, and `goalReached`; it never invents accepted structures.
These are computational candidates, not experimentally verified binders.

## Live CUDA gate — not run

`planned` models are intentionally blocked from normal installation. For a
private GPU test, copy the registry and enable only this experimental model in
that copy; do not publish a beta claim before the live gate succeeds:

```bash
pnpm build
test_registry=$(mktemp -d)
cp -R models/. "$test_registry/"
python3 - "$test_registry/bindcraft2/manifest.yaml" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace('status: planned', 'status: beta', 1))
PY
export MOLDESK_MODELS_DIR="$test_registry"
nvidia-smi
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js install bindcraft2 --yes
node apps/cli/dist/index.js run bindcraft2 examples/bindcraft2/campaign.json
CUDA_VISIBLE_DEVICES="" node apps/cli/dist/index.js run bindcraft2 examples/bindcraft2/campaign.json
```

The last command must fail without CPU fallback. Record GPU/driver, JAX/CUDA,
Python/package/source pins, elapsed time, stdout/stderr and checksummed results.
Confirm a bounded zero-design outcome is finite and clearly represented.
Cancel an active run with Ctrl-C, confirm `cancelled` state and no orphan worker.
Only then update public status and `adapterVerification` with actual evidence.
Use the same rental for Boltz, DiffDock-L and OpenDDE CUDA verification in their
separate managed environments. Preserve original registry status for any gate
that does not pass.
