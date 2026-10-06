# OpenDDE examples

- `tiny.json`: the minimal job from upstream's README (a 9-residue peptide,
  `ACDEFGHIK`, seed 101). It is a pure sequence job, so it is a single-file
  input. This is the smoke-test input for the live gate in
  `models/opendde/README.md`.
- `ligand-file.json`: the Trp-cage miniprotein sequence (`NLYIQWLKDGGPSSGRPPPS`,
  PDB 1L2Y) plus one ligand given as a file (`"ligand": "FILE_ligand.sdf"`).
  It exercises companion-input staging: MoleculeDesk copies `ligand.sdf` into
  the run's input area and runs a rewritten copy of the job.
- `ligand.sdf` is upstream's `examples/ligands/compounds-3d-R.sdf` from
  aurekaresearch/OpenDDE @ `ddfa1df8aff1babf1fddac4247b7d2351bd0ce9f`
  (Apache-2.0, Copyright (c) 2026 Aureka AI Research), copied unmodified
  (sha256 `da0ad70027c82cf876d0d95a3034a38d23e47cb8e09b62020f8af9e2e07135d3`).

Both are smoke-test inputs, not scientifically meaningful targets.

```bash
moldesk install opendde
moldesk run opendde examples/opendde/tiny.json
moldesk run opendde examples/opendde/ligand-file.json
```

With the default params (1 sample, 200 steps, 10 cycles, no MSA or templates),
each run took about 40 s on an Apple M3 using MPS.
