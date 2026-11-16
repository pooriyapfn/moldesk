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
2. `moldesk analyze <file> --json`. Report chains and their types, the sequence of each polymer chain (`sequence` is the modeled residues, `fullSequence` the complete entity sequence), `gaps[]` and `unobserved[]` (residues missing from the experiment), the secondary-structure source, and the radius of gyration. Quote every entry of `warnings[]`.
3. Zoom in on a region the user cares about: `moldesk inspect <file> A:40-60 --radius 5 --json`. Each residue lists its `neighbors[]` with the closest atom pair. Use the ids the analysis gave you, with `--label` only if you read label ids.
4. Show it: `moldesk view <file> --highlight A:40-60 --open`. For an AlphaFold DB model, `analyze` reports pLDDT (from its ModelCIF metrics) and `moldesk view <file> --color-by plddt --open` colors by confidence class. For an experimental structure there is no pLDDT: do not substitute B-factors.

## 9. Compare a prediction with an experimental structure (EGFR kinase domain end to end)

Fetch, analyze, predict, compare, inspect. The repository's `examples/egfr-end-to-end/` has the same flow as a script. Use the kinase domain, not full-length EGFR: it is far smaller. Ask before each download, install and long run.

1. **Fetch** the experimental structure (RCSB, CC0): `moldesk fetch pdb:1M17 --output ./egfr --json`. The file is `./egfr/1M17.cif`.
2. **Analyze** it: `moldesk analyze ./egfr/1M17.cif --json`. Take the `result.chains[]` entry with `type: "protein"` and `authId: "A"` and read its **`fullSequence`** (333 residues), not `sequence` (the 312 residues that have coordinates): the experiment has no coordinates for a 12-residue loop and the chain ends, so predicting `sequence` would silently join the pieces. Note its `gaps[]` and `unobserved[]`: those residues cannot be compared. 1M17 also holds a ligand and waters; the prediction below has neither.
3. **Predict** that complete sequence with Boltz-2. Write `./egfr/egfr.yaml` (see [models.md](models.md)) with `id: A`, the sequence, and `msa: empty` for an offline first pass. Say that single-sequence mode is lower accuracy and that `--param use_msa_server=true` would send the sequence off the machine (ask). Run `moldesk run boltz ./egfr/egfr.yaml --output ./egfr/prediction --json`. The structure is the `record.outputs[]` entry with `id: "structures"`; the confidence JSON is `id: "confidence"`. Boltz writes ModelCIF pLDDT into the structure, so `moldesk analyze` reports the prediction's confidence from the file itself.
4. **Install US-align once**, with approval: `moldesk install usalign` (downloads about 263 KB of pinned source and builds it with the local C++ compiler; pass `--yes` only after the user agrees).
5. **Compare**: `moldesk compare <prediction.cif> ./egfr/1M17.cif --chain-a A --chain-b A --report ./egfr/overlay.html --json`. The prediction is structure A and the experiment is the reference, B. Report `tmScore.normalizedByB` (normalized by the experimental structure), `rmsd` over `alignedLength` residues, `sequenceIdentity`, and `lengths`. As a rule of thumb a TM-score above about 0.5 means the same fold. The report overlays both structures (B moved onto A), charts the deviation per aligned residue, and highlights residues above 2 Å.
6. **Inspect the biggest deviation**: in `result.mapping[]` (aligned pairs in order, each with `distance` in Å) find the run of consecutive pairs with the largest distances. Read the experimental residue numbers from `mapping[].b.authSeqId`, then `moldesk inspect ./egfr/1M17.cif A:<first>-<last> --json` and say what the neighbors are. Optionally `moldesk view ./egfr/1M17.cif --highlight A:<first>-<last> --open`.
7. **Report honestly**: which files, the commands and parameters, the scores, the pLDDT of the prediction (`confidence.mean` from `moldesk analyze` on the prediction; the source is the file's ModelCIF metrics) and Boltz's own scores from the confidence JSON, the report path, that the prediction used no MSA (if so), and that a prediction is not an experimental result.

---

## 10. Declarative YAML workflow (import → analyze)

Use this when the user wants a repeatable pipeline rather than one model run. The shipped example validates a local PDB/mmCIF and analyzes it; a Boltz variant predicts one chain first. Agents discover the schema, write and plan the workflow, and show the plan. The user approves it in their own terminal; only then can the agent run it.

1. **Check the capability.** If `moldesk --help` does not list `workflow`, the installed CLI is older than this feature. Tell the user the declarative-workflow capability is unavailable and that updating the CLI adds it. Do not substitute ad-hoc commands for a workflow the user asked for.

2. **Discover the live schema and contracts.** Do not guess fields:

   ```bash
   moldesk workflow schema --json
   ```

   Read `schema` for the accepted YAML shape and `operations` for each operation's `uses`, required `with` bindings, output types, backend, and requirements. For model details such as parameters, formats, and whether a local install is ready, run `moldesk describe boltz --json`. Check installs with `moldesk list`.

3. **Write the YAML in the task folder**, for example `./moldesk-work/<task>/structure-analysis.yaml`. Inputs declared by the document are bound later, not embedded as paths. A minimal import → analyze document is:

   ```yaml
   apiVersion: moldesk.ai/v1alpha1
   kind: Workflow
   metadata:
     name: structure-analysis
     version: 0.1.0
   spec:
     inputs:
       structure:
         type: structure_file
         required: true
     execution:
       backend: local
       cache: true
       max_parallel: 1
     steps:
       - id: import
         uses: moldesk/import-structure@1
         with:
           file: ${inputs.structure}
         outputs:
           structure: protein_structure
       - id: analyze
         uses: moldesk/structure-analysis@1
         needs: [import]
         with:
           structure: ${steps.import.outputs.structure}
         outputs:
           report: json
   ```

   For a model smoke, replace the `structure` input with a required `sequence: protein_sequence`, replace `import` with a `predict` step using `moldesk/boltz@1`, and bind `analyze.structure` to `${steps.predict.outputs.structure}`. The Boltz contract is single-chain, standard amino acids only, and needs a ready local `boltz` installation. It never sends the sequence to an MSA server.

4. **Validate the draft**, before any file staging or model work:

   ```bash
   moldesk workflow validate ./moldesk-work/<task>/structure-analysis.yaml --json
   ```

   A valid document returns `valid: true`, `order` and `edges`. Otherwise fix each diagnostic. Read `details.diagnostics[]` and report `code`, `message`, `path`, and `line`/`column` to the user; the path names the YAML field.

5. **Plan with explicit input bindings.** Use the user's real file or sequence, resolved from the current working directory:

   ```bash
   moldesk workflow plan ./moldesk-work/<task>/structure-analysis.yaml --input structure=./moldesk-work/<task>/1CRN.pdb --json
   ```

   Bindings are one per declared input; a missing, unknown, or duplicate binding exits `2`. The plan returns `planId`, `workflowSha256`, resolved `inputs` with size and SHA-256, ordered `steps`, `edges`, and runtime `requirements`. Show the user the resolved inputs, the step order, and the required backend or installed model. A changed input file or installation produces a new `planId`.

6. **Get the user's approval.** Ask the user to run this in their own terminal, then give you the `approvalId`:

   ```bash
   moldesk workflow approve <plan-id> --json
   ```

   The CLI prints the plan again, asks for confirmation, and returns a one-use `approvalId` bound to that exact plan. Never run `approve` yourself and never fabricate an approval. If they report that approval requires a terminal, they must rerun it interactively.

7. **Run the approved plan** and wait for the outcome:

   ```bash
   moldesk workflow run <approval-id> --json
   ```

   The run is durable. Report `runStatus`, each step's `status` and `attempt`, and any `error.code` with its message. Resubmitting the same receipt returns the original `runId` with `duplicate: true`; it does not start another executor.

8. **Inspect the run.** Use the returned `runId`:

   ```bash
   moldesk workflow status <run-id> --json
   moldesk workflow artifacts <run-id> --json
   ```

   `status` is the durable source of truth (`queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`) with steps, events, and errors. `artifacts` lists committed typed artifacts with `type`, `format`, `relativePath`, `sha256`, `sizeBytes`, and `verified`. Only use artifacts whose `verified` is true. The import step writes the validated structure (`structure.pdb` or `structure.cif`), and the analysis step writes the unchanged `moldesk.analysis` envelope to `report.json` under `steps/<step>/attempt-<n>/`; use the artifact `path`. A step with status `cached` reused an identical earlier result and counts as success. For the Boltz variant, the `predict` step's `childRunId` names the child model run that keeps the logs and confidence outputs; if prediction failed, the child run ID is in the step error message.

9. **Recover or cancel when needed.** For a run reported as `interrupted`, or one whose owner is gone, resume it from verified outputs. A `failed` run can also be resumed, but only after the cause in the step error is fixed:

   ```bash
   moldesk workflow resume <run-id> --json
   ```

   Resume reuses verified completed attempts and restarts interrupted CPU work; it refuses damaged outputs and unresolved in-flight prediction attempts rather than relaunching a maybe-live job. To stop a run, request cancellation and then inspect status:

   ```bash
   moldesk workflow cancel <run-id> --json
   moldesk workflow status <run-id> --json
   ```

   Report results honestly: these are computations, not experimental validation, and a cancelled or failed run is a result to report, not to hide or retry silently.

---

## Reporting back

For every run, tell the user:

- the command you ran and the parameters,
- the run directory and the `--output` folder,
- key scores, with their meaning,
- the report path and how to open it,
- that predictions need experimental validation.

## RFD4 → Boltz → ipSAE campaign

Use `examples/pdl1-binder-campaign/` in the repository for local core-helper bookkeeping. First register target/crop, explicit author chain roles, protocol/seeds, scorer/cutoffs and ranking criteria. Generate 2 candidates with an approved RFD4 run; prepare exact target/binder sequences using parsed CIF data and source residue mapping. Predict each unique sequence with Boltz and full PAE, using `msa: empty` initially. Ingest every sample and failure, then score offline and rank with the registered aggregation rule. Keep duplicate rows and parent IDs. Review measured throughput/costs before approving a 20-design pilot or another seed.

The example writes campaign/input/source mappings, JSON and CSV candidate tables, score artifacts, decisions and molecular-report links under the selected directory. Restarts verify hashes before reuse. It does not schedule inference, silently retry failures or authorize a cloud campaign. Incompatible targets/protocols/scorers cannot be combined; criteria changes require a new recorded policy. Zero passing candidates is valid and does not justify threshold relaxation. Scores are computational evidence only.
