# Workflow recipes

Start every workflow with `moldesk doctor` and `moldesk list`. Use a working folder per task, for example `./moldesk-work/<task>/`, and keep inputs, a short `NOTES.md` of what you ran, and `--output` results there.

Ask before each install. Prefer small test runs first (one sample, small budget), then scale up with the user's agreement.

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
```

Works for any PDB/mmCIF, including RCSB downloads and outputs of earlier runs. Every `moldesk run` also writes a report unless `--no-visualize` is passed.

---

## Reporting back

For every run, tell the user:

- the command you ran and the parameters,
- the run directory and the `--output` folder,
- key scores, with their meaning,
- the report path and how to open it,
- that predictions need experimental validation.
