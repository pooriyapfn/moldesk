# RFD4-Proteina adapter

All-atom protein design from condition specs: monomers, protein and DNA binders, enzymes and
motif scaffolds, small-molecule pockets, antibodies. Built by the Institute for Protein Design
(Baker Lab) with NVIDIA. **Status: available.** Installed and run end to end on Runpod RTX 6000 Ada Pods
(2026-10-26, see [Live Runpod evidence](#live-runpod-evidence)); a local Linux install and the remaining
gates are still open, see [Open gates](#open-gates).

## Source, license and pins

- Code: https://github.com/RosettaCommons/RFD4-Proteina, **BSD-3-Clause**. Pinned to tag `v0.0.3`,
  commit `bc004fe61811225b83ef5a815963dfed47dd3639` (annotated tag object
  `852f4b092568ef1e3c0e7cafe32db5b29f1e2c95`), read on 2026-10-26.
- What runs is the PyPI wheel `rfd4_proteina-0.0.3-py3-none-any.whl` (sha256
  `8d4d9a6dd1468c3af00c83c8bd889178d4a1a5d6cbd577e5f4b843374ca9486b`), which carries the Hydra
  configs. The installer also fetches the pinned source checkout (a few hundred MB) before the
  wheel is installed; that overhead is accepted for v1 and is provenance only.
- Weights: https://huggingface.co/nvidia/RFD4-Proteina, **BSD-3-Clause**, not gated, pinned to
  revision `a06e2509c7033b010fc43614e9fd840303588502` (the revision the wheel's own
  `inference.yaml` pins). The repository is about 178 GB because it also holds AlphaFold2 and
  OpenFold3 runtime images. Generation reads exactly two files, so only those are installed:

  | File | Bytes | SHA-256 |
  | --- | ---: | --- |
  | `config.json` | 7,270 | `154ea927ab8005b7eac2d047a792147fb4606ab4878e496aa8414b6b40dad368` |
  | `model.safetensors` | 1,742,660,596 | `5b549dd61adb2f6c6b5cb95bda13f40f5e31556b4e6c755edc0ca6f011c68fb0` |

- Dependencies: the full closure (167 packages, `torch==2.14.1+cu126`) is pinned with hashes in
  the manifest. Resolved on 2026-10-26 with `uv pip compile --python-platform
  x86_64-manylinux_2_28 --python-version 3.12 --torch-backend cu126 --no-sources
  --generate-hashes` for `rfd4-proteina[all-cuda12]==0.0.3`; uv 0.6.12 and the installer's managed
  uv 0.12.8 produced identical pins. `antlr4-python3-runtime` and `assertpy` publish only source
  distributions (pure Python) and build locally; everything GPU-related is wheel-only.
- The alpha package changes quickly (0.0.1 to 0.0.3 in 26 hours, and `main` is already past
  0.0.3). Re-verify every pin, including the Hub revision, before any bump.

## Hardware

Linux x64 + NVIDIA only, CUDA 12 build (torch 2.14.1+cu126). No macOS, CPU or AMD generation path
exists upstream, so the adapter has no CPU fallback: install verification and every run need a
working CUDA tensor operation. Upstream lists A100, H100/H200/GH200, L40S, RTX 6000 Ada and
Blackwell parts as tested; it does **not** list A40, A10, RTX 3090/4090 or the A5000/A6000 cards.
Blackwell is not a v1 target: the CUDA 13 profile needs a registry change, and the cu126 wheels'
architecture list has not been checked. Disk and VRAM were measured once on Runpod (below); RAM and the
minimum driver are still unset. The download estimate in the manifest (about 4.4 GB for the
runtime, plus 1.74 GB of weights) is a lower bound computed from wheel sizes.

## Input: condition specs

One YAML or JSON file. Each top-level key names a design; `global_args` holds shared defaults
(per-design values win, shallow merge). Per design:

| Field | Meaning |
| --- | --- |
| `input` | A CIF/BinaryCIF path, or a list of them (combined into one structure) |
| `input_as_annotated_cif` | `true` keeps conditions already present in `input` |
| `contig` | Subset the input and insert expandable segments, e.g. `"50-120, /0, A17-131"` |
| `conditions` | Annotation → value → list of `{select: …}` entries (hotspots, fixed sequence, …) |

Upstream documents the full grammar: https://rfd4-proteina.org/latest/reference/yaml-json.html.
MoleculeDesk accepts exactly these four fields and rejects everything else, including the legacy
fields upstream also rejects.

What MoleculeDesk adds or restricts:

- **Files stay inside the spec's folder.** `input` paths must be relative, with no `..`, backslash or
  drive letter, and end in `.cif`, `.cif.gz`, `.cif.gzip`, `.cif.zst`, `.bcif`, `.bcif.gz`,
  `.bcif.gzip` or `.bcif.zst`. Upstream would accept absolute paths; cloud runs upload these files,
  so MoleculeDesk does not. Files are copied into the run's immutable input area (symlinked
  ancestors that escape the folder fail) and checksummed in `run.json`. PDB files are not accepted
  by upstream either.
- **Design names** become output file names: letters, digits, `_` and `-`, up to 64 characters,
  unique ignoring case, at most 8 designs and 16 distinct structure files per spec.
- **MoleculeDesk parses the spec as YAML 1.2** and hands upstream a resolved **JSON** file
  (`moldesk-spec.json`): `global_args` flattened, every `input` rewritten to its staged copy, key
  order preserved (conditions are applied in declaration order, last write wins). Aliases, merge
  keys, custom tags and duplicate keys are rejected. Typed YAML keys are written the way upstream's
  JSON dialect spells them (`true` → `"true"`, `0.0` → `"0"`, `null` → `"null"`). Upstream's own
  YAML loader is YAML 1.1 (`yes`/`no` are booleans there but strings here). Whether upstream treats
  the JSON spelling of every condition key identically is part of the open gates.
- `select:` strings are interpreted by atomworks' query engine, which walks an `ast` whitelist (no
  `eval`). They are capped at 512 characters.

A starter spec and structure live in [`examples/rfd4-proteina`](../../examples/rfd4-proteina/README.md).

## Params

| CLI param | Behavior |
| --- | --- |
| `numReplicates` | Designs per spec entry, integer 1-32 (default 1) |
| `batchSize` | Designs generated at once, integer 1-8 (default 1); raise only after one fits |
| `seed` | Integer 0-4294967295. A random seed is chosen **before** the run (also for cloud) and recorded in `run.json` |
| `recycle` | `thinking_low`, `thinking_medium` (default) or `thinking_high` upstream recycling presets |
| `compile` | `true` enables upstream's `torch.compile` length buckets; default `false` skips the warm-up |

There is no pass-through of Hydra overrides: that would reopen `_target_` instantiation,
checkpoint and output paths. Task-specific recycle presets (`medium/front_loaded`, …) are not
exposed yet. Paths containing quotes, backslashes, `$` or control characters are refused rather
than escaped, because Hydra's grammar has no safe spelling for them in this position.

Runs use upstream's `quickstart` preset: **no metrics and no oracle**, one process, no dataloader
workers, uncompressed CIF output, `prevalidate_inputs=true` so a bad spec fails before GPU time.

## Offline and cache behavior

Weights are managed assets loaded from a local directory (`hf_ckpt_path=<assets>/rfd4-proteina-bundle`),
which takes `from_pretrained`'s no-network branch. The runtime also sets `HF_HUB_OFFLINE`,
`TRANSFORMERS_OFFLINE`, `HF_DATASETS_OFFLINE` and `WANDB_MODE=disabled`, selects the public profile
with `CLUSTER=local`, and keeps every cache (`HF_HOME`, `XDG_CACHE_HOME`, `TORCH_HOME`, Inductor, Triton,
matplotlib) beside the run. Download paths found in the pinned source: `utils/hub.py`
(`snapshot_download`, skipped for a local directory) and `metrics/cdr_torsions.py` (antibody metrics
only, never reached with metrics off). `anarcii` is a base dependency and may fetch its own models;
the network-off gate below must prove it does not on this path.

## Outputs

- `moldesk-spec.json`: the resolved spec the model actually read.
- `inference_samples/<design>_<i>/<design>_<i>_generated.cif`: one structure per design and replicate
  (`<i>` from 0). `<design>_<i>_input.cif` sits beside it. Read from upstream source; the exact layout
  is confirmed by the first live run.
- `moldesk-summary.json`: design list, effective parameters and atom counts.
- `hydra/`: upstream's resolved configuration snapshot.

A run succeeds only if every design has exactly `numReplicates` generated structures, no unexpected
files exist, and every CIF has a data block and an `_atom_site` loop with whole rows of finite
coordinates. Symlinks written by the model are ignored, not followed. These are computational
candidates; binding and function need experimental validation.

## Not supported in v1

Reward-guided search, refolding and other metrics (`rfd4-evaluate`) need an AlphaFold2 or
OpenFold3 oracle environment (container images of 6-16 GB plus OpenFold3 weights). Also not
included: annotated-CIF-only input (wrap it in a spec with `input_as_annotated_cif: true`), partial
diffusion and inverse-folding recipes as separate options, training, CUDA 13/BioIR, Blackwell GPUs,
and any Runpod GPU outside the allow-list.

## Dual use

The model designs protein, DNA-binding and antibody-like molecules against arbitrary targets, and
this CLI performs **no biosecurity screening** of its outputs. The upstream Hugging Face Spaces
screen designs with SecureDNA; `rfd4-generate` does not. Screening generated sequences before
synthesis is the user's responsibility.

## Live Runpod evidence

`moldesk run rfd4-proteina examples/rfd4-proteina/monomer.yaml --compute runpod --cache-policy ephemeral
--param seed=42 --param recycle=thinking_low` on 2026-10-26, with a development worker bundle:

| Run | GPU (datacenter) | Result | Wall time | Notes |
| --- | --- | --- | ---: | --- |
| 1 | RTX 6000 Ada (US-WA-1) | failed | 25 s | Runpod proxy 404 on the first upload (known transient) |
| 2 | L40S (EU-NL-1) | failed | 77 s | `INSTALL_COMMAND_FAILED`: `triton` 3.8.0 hash mismatch (below) |
| 3 | RTX 6000 Ada (US-WA-1) | succeeded | 162 s | 793-atom mmCIF; generation 13 s |
| 4 | RTX 6000 Ada (US-WA-1) | succeeded | 155 s | identical coordinates to run 3 (same seed) |
| 5 | RTX 6000 Ada (US-WA-1) | succeeded | 171 s | |
| 6 | RTX 6000 Ada (US-IL-1) | succeeded | 175 s | `numReplicates=4`: four structures |
| 20-25 | L40S (EUR-IS-2), PD-L1 binder, `numReplicates=8 batchSize=8` (upstream cookbook setting) | 1 succeeded, 5 transient proxy 404 | 302 s | 8 structures; peak VRAM 7277 MiB; generation 118 s; ~$0.09; binder_1 has a 1.86 Å and binder_7 a 2.19 Å inter-chain contact |
| 7-15 | L40S (EU-NL-1), PD-L1 binder (`examples/rfd4-proteina/pdl1-binder`, 4 designs, `.cif.zst` input) | 3 succeeded, 1 no capacity, 5 transient proxy 404 | 308 / 239 / 248 s | identical coordinates in all three; peak VRAM 4437 MiB; ~$0.07-0.09 per run |

- Peak GPU memory 2398 MiB and Pod disk growth 17.5 GiB (17.7 GiB used of 40 GiB) in every successful run; driver 595.91.07.
  A 100-residue monomer is a floor for VRAM, not a ceiling. RAM and GPU utilization were not recorded.
- The wall time is the whole cloud run (provisioning, install of 167 packages, 1.74 GB weights, model load, generation, download), and cost
  about $0.045 at the $0.99/h quoted for the RTX 6000 Ada (compute only; disk charges are not published).
- **Lock bug found by run 2:** `triton` 3.8.0 is published on PyPI and on the PyTorch cu126 index with different files; uv installs
  the index's file, but the lock carried PyPI's hashes. Re-resolving with the documented command gave the index's hashes; the other
  166 pins were unchanged. Re-run the resolution (and compare every pin) before any bump.
- Confirmed from the run: the output layout `inference_samples/<design>_<i>/<design>_<i>_generated.cif`, `hf_ckpt_revision=null` with a local
  bundle, the YAML-to-JSON spec path with `input_as_annotated_cif: true` and no `contig`, and the two source-only packages building under
  the hash-checked install.
- Binder run: upstream's PD-L1 example (hotspots on 5O45 Tyr56/Met115/Tyr123) returned four complexes of 73-103 residues; every hotspot atom is within 2.3-5.3 Å of the binder, no inter-chain atom pair is closer than 2.2 Å. No refolding or scoring was run.
- Not tested: A100/H100/H200, enzyme and antibody specs, targets much larger than PD-L1, longer designs, a network-off run (the Pod had
  network access), and cancellation.

## Open gates

Still open (the first install and run items above are done on Runpod only):

1. A local `moldesk install rfd4-proteina` on a Linux/NVIDIA machine, with `uv pip check`, wall time and disk.
2. Enzyme and antibody specs, and the `C_SEQ_PROB_*` typed-key behavior of the resolved JSON spec (the PD-L1 binder spec, `.cif.zst` input and `C_CRDGRP` ran fine).
3. **Network-off proof**: repeat after install with outbound traffic blocked.
4. Peak VRAM and disk for 50- and 120-residue binders, to confirm `minVramGb`, `minRamGb` and `minDriverCudaVersion`.
5. Cancel mid-run: no orphan processes and no partial `inference_samples` reported as success.
6. `torch.cuda.get_arch_list()` and extension compatibility before any claim about Blackwell, and live checks on the other allow-listed GPUs.

The cloud block (`cloud:` in the manifest) uses the stock digest-pinned `runpod/pytorch` image and a `gpuAllowList` of the GPUs upstream
lists as tested (A100, H100/H200, L40S, RTX 6000 Ada); only the RTX 6000 Ada and the L40S have been run. See
[`docs/rfd4-proteina-implementation-plan.md`](../../docs/rfd4-proteina-implementation-plan.md).

```bash
moldesk install rfd4-proteina --yes
moldesk run rfd4-proteina examples/rfd4-proteina/monomer.yaml --param numReplicates=2 --param seed=42
```
