# EGFR kinase domain, end to end

One script that chains the structure commands: fetch an experimental structure, read its sequence, predict it, compare the prediction with the experiment, and zoom in where they differ.

```
fetch pdb:1M17 -> analyze -> run boltz -> compare --report -> inspect the biggest deviation
```

[1M17](https://www.rcsb.org/structure/1M17) is the EGFR kinase domain with the inhibitor erlotinib. The kinase domain is used rather than full-length EGFR, which is far too large for a local run.

## Run it

```bash
moldesk install boltz                       # once; a large download (skip it when using --prediction)
./examples/egfr-end-to-end/run.sh --workdir ./egfr-demo
```

Needs the `moldesk` CLI, `bash`, `awk` and `sed`, and a C++ compiler (for US-align). Set `MOLDESK="node apps/cli/dist/index.js"` to run from a source checkout. The script prints every command it runs.

What it downloads or builds, so nothing is a surprise:

| Step | Network | Notes |
| --- | --- | --- |
| `fetch pdb:1M17` | files.rcsb.org, about 0.3 MB, CC0 | Cached under `~/.moldesk/cache/fetch`; a verified cached copy is reused offline. |
| `run boltz` | none | Single sequence with `msa: empty`, so nothing leaves the machine. Needs Boltz-2 installed. |
| `install usalign` | codeload.github.com, 263 KB | Pinned source, SHA-256 checked, built with your compiler. It asks first; `--yes` accepts without a prompt. |

`--prediction FILE` skips Boltz-2 and compares that structure instead. CI uses it with the committed prediction in `fixtures/`.

## What each step does

1. **Fetch** `pdb:1M17` and print where it was cached.
2. **Analyze** it and write the chain sequences with `analyze --fasta`. That file holds each chain's *complete* entity sequence: 333 residues for chain A, of which the experiment gives coordinates for 312. Predicting the 312 modeled residues instead would silently join the pieces on either side of the 12-residue loop (965-976) that has no coordinates.
3. **Predict** that sequence with Boltz-2 (`moldesk run boltz`), single sequence, no MSA.
4. **Compare** the prediction (A) with the experiment (B): `moldesk compare ... --chain-a A --chain-b A --report overlay.html`. The report overlays both structures (the experiment moved onto the prediction), charts the deviation per aligned residue and highlights residues above 2 Å.
5. **Inspect** the experimental region with the largest deviation: the window of 5 consecutive aligned residues with the highest mean distance, found by `deviation-window.awk` from `compare.json`.

Outputs in the work directory: `chains.fasta`, `egfr.yaml`, `boltz-run.json`, `analysis.json`, `compare.json`, `inspect.json`, `overlay.html`.

## A real run

Recorded on 2026-10-24: MoleculeDesk 0.0.7, Boltz-2 2.2.1 through the Apple Silicon runtime (`boltz-community` 2.10.12, `torch` 2.14.0), US-align 20260527, Apple M3 with 24 GB, macOS, accelerator `mps`.

| | |
| --- | --- |
| Boltz-2 prediction, 333 residues, MPS | **244 s** (`durationMs` 244146) |
| Everything else together (fetch, analyze, building US-align, compare, inspect) | about 11 s, measured from an empty `MOLDESK_HOME` |
| Whole script, Boltz-2 included | 274 s |
| CUDA GPU | not measured: no NVIDIA GPU was available. Run the script on one and add the timing here. |

Prediction: Boltz confidence score 0.872, pTM 0.899, mean pLDDT 86.5 (from the file's ModelCIF metrics; it matches the confidence JSON's `complex_plddt` 0.865 × 100).

Comparison with 1M17 chain A:

| | |
| --- | --- |
| TM-score normalized by the experimental structure | 0.9158 (0.8591 normalized by the prediction) |
| RMSD | 1.17 Å over 293 aligned residues (the experiment models 312) |
| Aligned pairs above 2 Å | 19 |
| Largest deviation (window of 5) | experimental residues A:960-964, mean 4.2 Å; the single worst pair is 9.4 Å |

The 960-964 window ends where the experiment has no coordinates for the next 12 residues (965-976). That is an observation; why the two differ there was not investigated.

How far to trust this: one prediction, one seed, no MSA (single-sequence mode is lower accuracy), the apo sequence predicted without erlotinib, compared with one experimental structure. A prediction is not an experimental result.

## Fixtures

`fixtures/egfr_model_0.cif` and `fixtures/confidence_egfr_model_0.json` are the unmodified Boltz-2 outputs of that run (SHA-256 `ede4c9ae...09c2b` and `05d4e5fc...cc7`). Boltz-2 is MIT licensed; the input sequence is the entity sequence of PDB entry 1M17 (CC0). Regenerate them with the script without `--prediction`; a new run will differ slightly because no seed is set.

## CI

CI runs `run.sh --prediction fixtures/egfr_model_0.cif` from an empty home (a live RCSB fetch and a US-align build, no Boltz) and requires the TM-score to stay above 0.85. `deviation-window.test.mjs` checks the awk helper against real `compare --json` output and an independent calculation.
