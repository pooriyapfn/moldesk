# DiffDock-L example

`job.json` references a real protein structure plus a small SMILES ligand — not invented fixtures.

- `protein.pdb` is PDB entry [1L2Y](https://www.rcsb.org/structure/1L2Y) (NMR structure of the Trp-cage miniprotein construct TC5B, Neidigh, Fesinmeyer & Andersen, 2002), downloaded from `https://files.rcsb.org/download/1L2Y.pdb` and trimmed to its first NMR model only (304 atoms, 20 residues) — the file otherwise contains 38 near-identical conformers, which would make this "tiny" example needlessly large for a smoke test. PDB archive entries are made freely available by the wwPDB for any use, with no additional restriction beyond attribution.
- The ligand is given as a SMILES string (`CC(=O)Oc1ccccc1C(=O)O`, acetylsalicylic acid/aspirin) rather than an `.sdf` file, to avoid a separate ligand-file license/provenance question — DiffDock-L's own `--ligand_description` flag accepts either form, and MoleculeDesk's job schema supports `ligand.smiles` for exactly this case.

The job format matches what `packages/adapters/src/diffdock/index.ts`'s `validateInput` expects for a `.json` input: `{ jobName?, proteinPath, ligand: { path } | { smiles } }`.

This is a smoke-test input, not a scientifically meaningful docking target — Trp-cage is a synthetic miniprotein with no known aspirin binding site. It exists to exercise the full install/run/output pipeline on real files, not to validate DiffDock-L's docking accuracy.

```bash
moldesk install diffdock
moldesk run diffdock examples/diffdock/job.json
```

As of this writing, `diffdock` is `status: planned` (see `models/diffdock/README.md`) — the command above has not been run end-to-end, since no Linux/NVIDIA hardware was available. It is documented here as the exact command a future live-gate run should use.
