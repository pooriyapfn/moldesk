# `moldesk inspect`

Zoom in on part of a structure. With `--json` it prints one [`moldesk.inspect` envelope](./analysis-json.md).

```sh
moldesk inspect protein.pdb A            # a whole chain
moldesk inspect protein.pdb A:45         # one residue
moldesk inspect protein.pdb A:40-60      # a range (includes insertion-coded residues in between)
moldesk inspect protein.pdb A:52A        # residue 52 with insertion code A
moldesk inspect protein.pdb A:45 --radius 8 --json
moldesk inspect model.cif A:1-20 --label # chain and residue numbers are label ids
```

The selector grammar and its `INVALID_SELECTOR` cases are described in [analysis-json.md](./analysis-json.md#selectors).

## Result

`result` has `selector`, `radius` and `residues[]`. Each residue has `chainAuthId`, `chainLabelId`, `authSeqId`, `labelSeqId`, `insertionCode`, `name`, `secondaryStructure` (`H`/`E`/`C`, protein), `plddt` (only from a known source, see [analyze.md](./analyze.md#confidence)), `atomCount` and `neighbors[]`.

A neighbour is any other residue with a heavy atom within `--radius` Å (default 5, at most 30) of any heavy atom of the inspected residue. It lists the residue's ids and name, the minimum `distance` (Å, 3 decimals) and the `atoms` pair (`selected`, `neighbor`) that achieves it, sorted by distance. Neighbours include residues next in sequence and residues inside the selection; ligands count, waters do not. Hydrogens are ignored, only the first alternate location is used, and a neighbour exactly at the radius is included (within 1e-4 Å, because Mol* stores float32 coordinates).

A single-residue selector names one residue exactly: `A:52` matches only residue 52 without an insertion code, `A:52A` only the one with code `A`.

## Errors

All exit 2: `SELECTOR_NO_MATCH` (nothing selected, never an empty success), `INVALID_SELECTOR`, `INVALID_INSPECT_ARGS` (radius not in (0, 30]), plus the input errors listed in [analyze.md](./analyze.md#errors).
