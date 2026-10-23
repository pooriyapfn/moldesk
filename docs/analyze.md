# `moldesk analyze`

A structural summary of a PDB or mmCIF file. With `--json` it prints one [`moldesk.analysis` envelope](./analysis-json.md); logs and warnings stay out of stdout.

```sh
moldesk analyze protein.pdb                          # short text summary
moldesk analyze model.cif --json                     # full result as JSON
moldesk analyze protein.pdb --fasta chains.fa        # also write polymer sequences (never overwrites)
moldesk analyze --validate-fasta chains.fa           # check a FASTA file instead
moldesk analyze model.pdb --bfactor-is-plddt         # only if you know the B-factor column is pLDDT
```

## Parser

Mol* 5.12.0, the same library behind the offline viewer, runs headless in Node, so analysis needs no Python. A spike on the repo's fixtures confirmed it reads PDB and mmCIF, multi-model files, the file's HELIX/SHEET records, and computes DSSP. It is loaded lazily, so other commands start as fast as before. gemmi was not needed.

## Result

| Field | Meaning |
| --- | --- |
| `modelCount`, `analyzedModel` | Only the first model (`0`) is analyzed; more models add a `MULTIPLE_MODELS` warning. |
| `chains[]` | One entry per Mol* chain: `authId`, `labelId`, `entityId`, `type` (`protein`, `dna`, `rna`, `polymer`, `ligand`, `water`, `other`) and `residueCount`. In PDB files `label` ids are inferred by Mol*; in mmCIF they are the file's. |
| `chains[].sequence` | One-letter sequence of polymer chains; `X` for any non-standard residue (for example selenomethionine). |
| `chains[].gaps[]` | Jumps in author numbering between neighbouring residues, with the count of missing numbers. |
| `chains[].unobserved[]` | mmCIF `pdbx_unobs_or_zero_occ_residues` rows for model 1. |
| `chains[].residues[]` | Every non-water residue with `authSeqId`, `labelSeqId` (null for non-polymers), `insertionCode`, `name`, `secondaryStructure` (`H`/`E`/`C`, protein) and `plddt` (when known). |
| `chains[].secondaryStructure` | Helix, strand and coil fractions of a protein chain. |
| `secondaryStructure.source` | `file` when the file has HELIX/SHEET (or `struct_conf`) records, otherwise `computed` (DSSP). |
| `geometry` | Centre of mass, radius of gyration and bounding box in Å over heavy, non-water atoms of the first alternate location, mass-weighted. Atoms with an unknown element are left out and reported. |
| `confidence` | `null`, or `{ source, detail, scale: "0-100", mean }`. |

## Confidence

A B-factor is never assumed to be pLDDT. Per-residue `plddt` (0-100) appears only when the source is known:

1. `modelcif`: the file has ModelCIF `ma_qa_metric` / `ma_qa_metric_local` pLDDT values.
2. `moldesk-run`: the file is a Boltz output recorded in a MoleculeDesk `run.json` (the file's SHA-256 must match the recorded output). Boltz writes pLDDT × 100 into the B-factor column of polymer atoms (checked in `src/boltz/data/write/mmcif.py` at the pinned revision); ligand atoms use a different scale, so only polymer residues get a value. The run's `confidence_*.json` is attached as `confidence.summary`.
3. `user-flag`: you passed `--bfactor-is-plddt`.

Otherwise `confidence` is `null` and the `NO_CONFIDENCE_SOURCE` warning says why. OpenDDE runs are not on the list: its B-factor semantics are not documented, so they stay `null` unless the file carries ModelCIF metrics or you pass the flag.

## Errors

All exit 2 and use the usual `{ status: "error", code, message, remediation }` shape.

| Code | When |
| --- | --- |
| `INPUT_NOT_FOUND`, `INPUT_EMPTY`, `INPUT_TOO_LARGE`, `INPUT_BINARY` | Missing or non-regular, empty, over 64 MiB, or binary file. |
| `UNSUPPORTED_STRUCTURE_FORMAT` | Extension is not `.pdb`, `.ent`, `.cif` or `.mmcif`. |
| `STRUCTURE_PARSE_FAILED` | No atoms or models, a malformed mmCIF loop, or an incomplete/non-numeric `ATOM`/`HETATM` line (Mol* would otherwise accept it with zero coordinates). A PDB cut exactly at a line boundary is a valid prefix and cannot be detected. |
| `INVALID_FASTA` | Bad alphabet, empty record, duplicate header or text before the first `>`. |
| `OUTPUT_EXISTS`, `NO_POLYMER_CHAINS` | `--fasta` target exists, or the structure has no polymer chain. |
| `INVALID_ANALYZE_ARGS` | No file, or `--validate-fasta` combined with other options. |

## Reference values

`scripts/structure-reference.py` (Biopython) generates `packages/core/src/analysis/testdata/reference.json`: sequences, water counts, centre of mass and radius of gyration for the fixtures in `packages/visualizer/test/fixtures`. Tests compare against it with a 1e-3 Å tolerance, plus golden `moldesk.analysis` files in `testdata/golden/`.
