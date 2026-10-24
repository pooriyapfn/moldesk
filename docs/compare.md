# `moldesk compare` and the US-align tool

`moldesk compare <a> <b>` superposes two structures with [US-align](https://github.com/pylelab/USalign) and prints one [`moldesk.compare` envelope](./analysis-json.md) with `--json`.

```sh
moldesk install usalign                          # once: pinned source, built with your compiler
moldesk compare model.cif 1M17.pdb               # first polymer chain of each file
moldesk compare a.pdb b.pdb --chain-a A --chain-b B
moldesk compare complex1.cif complex2.cif --multimer    # all polymer chains, one superposition
moldesk compare a.pdb b.pdb --json
moldesk compare a.pdb b.pdb --report overlay.html                  # offline overlay report (refuses to overwrite)
moldesk compare a.pdb b.pdb --report overlay.html --deviation-threshold 3
```

## Installing US-align

`moldesk install usalign` is a managed tool, not a model. It follows the same safety model as model installs:

1. Downloads the pinned source (release `20260527`, commit `177cc8a2bbd3e2a6e9c5faaaa4ff5dfa1e6048f7`, 263,246 bytes) over HTTPS from `codeload.github.com/pylelab/USalign`.
2. Refuses it unless the SHA-256 is `c0ed4ad81b4ebf7241b6103d2df83079f489653fa5644342f1b12d1b465a109a` and the size matches. GitHub archives are not guaranteed byte-stable forever; if GitHub ever serves different bytes the install fails closed and the pin has to be updated.
3. Builds `USalign.cpp` with your `c++`, `g++` or `clang++` using upstream's flags (`-O3 -ffast-math`, no `-static`). The build takes about 6 seconds. There is no prebuilt binary and no conda dependency.
4. Verifies the binary: it must report `Version 20260527` and align the sample structures shipped with the source (`PDB1.pdb`, `PDB2.pdb`) to TM-scores 0.4265 / 0.6163 (±0.005), lengths 250 / 166 and 119 aligned residues.
5. Writes `~/.moldesk/tools/usalign/20260527/` atomically (staged, then renamed, with rollback) with `installation.json` recording the source hash, compiler and binary SHA-256.

Because it compiles downloaded code it always asks, even though the download is small: confirm interactively, or pass `--yes` (without a terminal or with `--json`, it exits 1 with `confirmation-required`). `moldesk uninstall usalign` removes it. `moldesk doctor` lists the compiler and the install state. Every `compare` re-checks the binary against the recorded hash.

**License.** US-align uses a permissive HPND-style license: use, copy, modify and distribute for any purpose, provided the notices, the reference information and the copyright notice stay in all copies. MoleculeDesk does not redistribute it (it is downloaded and built on your machine), keeps the upstream `LICENSE` next to the binary, and puts the three required references in every result (`result.citation`).

## Result

| Field | Meaning |
| --- | --- |
| `mode`, `chains` | `monomer` (one chain per structure) or `multimer`; the auth chain ids compared, in alignment order. |
| `lengths`, `alignedLength` | Residues US-align read per structure, and the number it aligned. |
| `tmScore` | `normalizedByA` and `normalizedByB`. Use the one normalized by the reference structure. |
| `rmsd` | Å over the aligned residues, as US-align prints it: two decimals. This is the least-squares optimal RMSD of the aligned pairs (upstream recomputes it that way, `TMalign.h`), not the RMS under the printed matrix. |
| `sequenceIdentity` | Identical / aligned residues. |
| `transform.matrix` | Row-major 4×4 that maps structure A onto structure B: `x' = R x + t`. US-align prints the matrix with 10 decimals. |
| `mapping[]` | The aligned pairs `{ a, b, distance }`: each side has `chainAuthId`, `authSeqId`, `labelSeqId`, `insertionCode` and `name`; `distance` is the Å between the two CA (C3' for nucleic acids) atoms after applying `transform`. Its RMS is therefore at least `rmsd`. |
| `report` | With `--report`: `path`, `fileUrl`, `sha256`, `sizeBytes`, `deviationThreshold` and `residuesAboveThreshold`. |
| `inputs` | Path, format and SHA-256 of both files (the envelope's single `input` field is not used). |

The mapping is rebuilt from US-align's aligned sequences and the residues it read (ATOM records and MSE that have a CA, or C3' for nucleic acids). If the two do not agree exactly the command stops with `ALIGNMENT_MAPPING_MISMATCH` instead of guessing.

## Overlay report (`--report`)

`moldesk compare a b --report overlay.html` writes one offline report (see [visualizer.md](./visualizer.md)):

- **One scene with both structures.** A stays where it is; B carries the inverse of US-align's A→B matrix as its `SceneStructure.transform`, so B is moved onto A. US-align's row-major rotation and translation are inverted and written out column-major, the layout Mol* applies. A is blue, B orange; only the compared chains are drawn.
- **Deviation per aligned residue** (the `mapping[].distance` above) as a JSON dataset (`index`, `chainA`, `a`, `nameA`, `b`, `nameB`, `deviation`, `aboveThreshold`), shown as a line chart panel (one line per chain in `--multimer` mode). Hover a point for its value.
- **Highlighted residues.** Pairs with a deviation above `--deviation-threshold` (default 2 Å, at most 100) are drawn as red sticks in both structures.
- No synchronized side-by-side view.

The destination and the threshold are checked before US-align runs. The embedded structures are the exact bytes that were compared; if a file changed in between, the report is refused with `INPUT_CHANGED`. Everything is ordinary report content (no new contract fields), so the report works offline like any other.

## What is verified about US-align 20260527

Checked against the real built binary and its `-h`: `-outfmt -1` (full output without banner), `-m -` (matrix on stdout), `-het 2` (ATOM plus MSE), `-chain1/-chain2`, `-mm 1 -ter 1`, `-v`. The matrix block rotates structure 1 onto structure 2. For a multi-model file only the first model is used. Multimer output puts a `*` after every chain. For input with nothing to align US-align prints a warning and **exits 0**, so success is decided from the output, not the exit code.

## Behaviour and limits

- **Chains.** Without `--chain-a/--chain-b` the first polymer chain of each file is used, and a `CHAIN_DEFAULTED` warning names the choice when there are several. `--multimer` cannot be combined with a chain choice.
- **Models.** Only the first model of an ensemble is compared (`MULTIPLE_MODELS` warning).
- **Residues.** HETATM residues other than MSE are not aligned. Selenomethionine is aligned as M.
- **Ligands and water** are never part of the alignment.
- **Not covered:** circular permutation, non-sequential and flexible alignment, mirror images, and `-mm 2`/`-mm 4`.

## Errors

| Code | Exit | When |
| --- | --- | --- |
| `USALIGN_NOT_INSTALLED`, `USALIGN_DAMAGED` | 2 | Run `moldesk install usalign` (`--reinstall` if damaged). There is no fallback to another aligner. |
| `COMPILER_NOT_FOUND` | 2 | No `c++`/`g++`/`clang++`; the message gives the install command for your platform. |
| `INVALID_COMPARE_ARGS`, `CHAIN_NOT_FOUND`, `NO_ALIGNABLE_RESIDUES`, `USALIGN_NO_RESULT` | 2 | Bad options, an unknown chain (the available chains are listed), a file with no protein or nucleic-acid residues to align, or US-align produced no alignment. |
| `USALIGN_BUILD_FAILED`, `USALIGN_VERIFY_FAILED`, `USALIGN_TIMEOUT`, `USALIGN_OUTPUT_UNPARSEABLE`, `ALIGNMENT_MAPPING_MISMATCH` | 10 | Internal problems; the message says what failed. |

`--report` adds `OUTPUT_EXISTS` (the file exists), `INVALID_COMPARE_ARGS` (bad `--deviation-threshold`), `INPUT_CHANGED` and `SCENE_TOO_LARGE` (more than 10,000 residues above the threshold) , all exit 2.

Input file errors are the same as for [`analyze`](./analyze.md#errors).

## Tests

Parser and mapping tests run on real US-align output captured from the pinned build (`packages/core/src/analysis/testdata/usalign`), including a structure and a copy of it with a known rigid transform: the returned transform equals the applied one within 1e-3, and its inverse when the structures are swapped. An opt-in live test downloads, builds and runs everything for real:

```sh
MOLDESK_LIVE_USALIGN=1 pnpm --filter @moldesk/core exec vitest run src/tools/usalign.live.test.ts
```
