# Workflow recipes

Start every workflow with `moldesk doctor` and `moldesk list`. Use a working folder per task, for example `./moldesk-work/<task>/`, and keep inputs, a short `NOTES.md` of what you ran, and `--output` results there.

Ask before each install and before each download (`moldesk fetch`, `moldesk install usalign`). Prefer small test runs first (one sample, small budget), then scale up with the user's agreement.

---

## 1. Quick smoke test (any machine)

Proves the install works in under a minute.

```bash
moldesk install proteinmpnn
curl -O https://files.rcsb.org/download/1UBQ.pdb
moldesk run proteinmpnn 1UBQ.pdb --output ./results
```

## 2. Predict a structure (Boltz-2)

1. Get the sequence(s) from the user, or from UniProt/RCSB with their agreement.
2. Write a Boltz YAML (see [models.md](models.md)). Use `msa: empty` for a fast offline first pass.
3. `moldesk run boltz input.yaml --output ./results --json`
4. Report `confidence_score`, pLDDT, and pTM/ipTM from the confidence JSON, and open the report.
5. If confidence is low, offer a rerun with `--param use_msa_server=true` (sequences leave the machine; ask) and more `diffusion_samples`.

On Apple Silicon, OpenDDE is an alternative co-folding model (`moldesk run opendde job.json`). Running both and comparing is a reasonable sanity check.

## 3. Protein-ligand complex and affinity (Boltz-2)

1. Protein sequence + ligand SMILES, with `properties: - affinity: binder: <ligand chain id>`.
2. Run Boltz-2. Report the predicted affinity and binder probability with the structure's confidence.
3. For several ligands, write one YAML per ligand in one folder and run them one at a time. Summarize in a table.

## 4. Dock a ligand (DiffDock-L, Linux + NVIDIA)

1. Protein structure as `.pdb`: user file, RCSB download, or a Boltz-2 prediction converted to PDB.
2. Ligand as SMILES or `.sdf`/`.mol2`.
3. Write the job JSON next to the files; run `moldesk run diffdock job.json --output ./results`.
4. Read `poses_summary.json`; report the top poses and confidence. Do not present confidence as affinity.

On a Mac: explain that DiffDock-L needs CUDA. Offer Boltz-2 complex prediction (workflow 3) locally, or a Linux GPU machine.

## 5. Redesign a protein sequence, then check it folds (ProteinMPNN → Boltz-2)

1. `moldesk run proteinmpnn structure.pdb --param num_seq_per_target=8 --output ./designs`
2. Parse the FASTA; pick the top few by score (lower is better). Skip the first record (native sequence).
3. For each pick, write a Boltz YAML and run Boltz-2.
4. Compare predicted structures to the original: confidence, and RMSD if a structure tool is available. Report a ranked table.

Use LigandMPNN instead of ProteinMPNN when a ligand or partner chain in the PDB should constrain the design.

## 6. Binder design campaign (BindCraft2, Linux + NVIDIA)

1. Confirm the license terms with the user (no hosted service for others).
2. Prepare the target (`.pdb`/`.cif`/`.fasta`) and pick chains and binder length range with the user.
3. First run with `max_trajectories` 1 or 2 to measure time per trajectory.
4. Agree a larger budget with the user based on that timing, then run.
5. Report the accepted-design count from `moldesk-summary.json`. Zero is a valid outcome; then summarize the trajectory CSVs and suggest changes (lengths, hotspots, budget).

## 7. Look at a structure

```bash
moldesk view structure.cif --open
moldesk view structure.cif --highlight A:40-60 --highlight B:12 --color '#ff5500' --open
moldesk view alphafold-model.cif --color-by plddt --open     # needs a known pLDDT source
```

Works for any PDB/mmCIF, including RCSB downloads and outputs of earlier runs. Every `moldesk run` also writes a report unless `--no-visualize` is passed. Highlights are drawn as sticks over the normal chain-colored cartoon; a highlight that matches nothing fails with the list of chains and residue ranges that exist.

## 8. Understand a structure you were given (or fetched)

1. If the user gives an id instead of a file, ask, then fetch it: `moldesk fetch pdb:1M17 --output ./work --json` (use `afdb:<accession>` for an AlphaFold DB model, `uniprot:<accession>` for a sequence). Use `result.files[].path`. Tell the user the license from `result.provenance.license`; AlphaFold and UniProt need attribution.
2. `moldesk analyze <file> --json`. Report chains and their types, the sequence of each polymer chain, `gaps[]` and `unobserved[]` (residues missing from the experiment), the secondary-structure source, and the radius of gyration. Quote every entry of `warnings[]`.
3. Zoom in on a region the user cares about: `moldesk inspect <file> A:40-60 --radius 5 --json`. Each residue lists its `neighbors[]` with the closest atom pair. Use the ids the analysis gave you, with `--label` only if you read label ids.
4. Show it: `moldesk view <file> --highlight A:40-60 --open`. For an AlphaFold DB model, `analyze` reports pLDDT (from its ModelCIF metrics) and `moldesk view <file> --color-by plddt --open` colors by confidence class. For an experimental structure there is no pLDDT: do not substitute B-factors.

## 9. Compare a prediction with an experimental structure (EGFR kinase domain end to end)

Fetch, analyze, predict, compare, inspect. The repository's `examples/egfr-end-to-end/` has the same flow as a script. Use the kinase domain, not full-length EGFR: it is far smaller. Ask before each download, install and long run.

1. **Fetch** the experimental structure (RCSB, CC0): `moldesk fetch pdb:1M17 --output ./egfr --json`. The file is `./egfr/1M17.cif`.
2. **Analyze** it: `moldesk analyze ./egfr/1M17.cif --json`. Take the `result.chains[]` entry with `type: "protein"` and `authId: "A"` and read its `sequence`. Note its `gaps[]` and `unobserved[]`: the experiment is missing those residues, so they cannot be compared. 1M17 also holds a ligand and waters; the prediction below has neither.
3. **Predict** that sequence with Boltz-2. Write `./egfr/egfr.yaml` (see [models.md](models.md)) with `id: A`, the sequence, and `msa: empty` for an offline first pass. Say that single-sequence mode is lower accuracy and that `--param use_msa_server=true` would send the sequence off the machine (ask). Run `moldesk run boltz ./egfr/egfr.yaml --output ./egfr/prediction --json`. The structure is the `record.outputs[]` entry with `id: "structures"`; the confidence JSON is `id: "confidence"`.
4. **Install US-align once**, with approval: `moldesk install usalign` (downloads about 263 KB of pinned source and builds it with the local C++ compiler; pass `--yes` only after the user agrees).
5. **Compare**: `moldesk compare <prediction.cif> ./egfr/1M17.cif --chain-a A --chain-b A --report ./egfr/overlay.html --json`. The prediction is structure A and the experiment is the reference, B. Report `tmScore.normalizedByB` (normalized by the experimental structure), `rmsd` over `alignedLength` residues, `sequenceIdentity`, and `lengths`. As a rule of thumb a TM-score above about 0.5 means the same fold. The report overlays both structures (B moved onto A), charts the deviation per aligned residue, and highlights residues above 2 Å.
6. **Inspect the biggest deviation**: in `result.mapping[]` (aligned pairs in order, each with `distance` in Å) find the run of consecutive pairs with the largest distances. Read the experimental residue numbers from `mapping[].b.authSeqId`, then `moldesk inspect ./egfr/1M17.cif A:<first>-<last> --json` and say what the neighbors are. Optionally `moldesk view ./egfr/1M17.cif --highlight A:<first>-<last> --open`.
7. **Report honestly**: which files, the commands and parameters, the scores, the pLDDT of the prediction (`confidence.mean` from `moldesk analyze` on the prediction, which is known because it is a MoleculeDesk Boltz output), the report path, that the prediction used no MSA (if so), and that a prediction is not an experimental result.

---

## Reporting back

For every run, tell the user:

- the command you ran and the parameters,
- the run directory and the `--output` folder,
- key scores, with their meaning,
- the report path and how to open it,
- that predictions need experimental validation.
