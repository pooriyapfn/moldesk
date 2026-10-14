# Model guide: inputs, parameters, examples

All models are `beta`: install and run work, broader verification is ongoing. Check `moldesk list` for what this machine supports; the "Runs on" lines below are what the registry advertises.

Example inputs ship in the MoleculeDesk repository under `examples/` (https://github.com/pooriyapfn/moldesk/tree/main/examples). Copy them into the user's working folder rather than running from a clone.

Set parameters with `--param key=value` (repeatable). Unknown parameters are rejected.

---

## Boltz-2 (`boltz`): structure and binding affinity

- **Runs on:** Apple Silicon (MPS) and Linux x64 + NVIDIA CUDA. CPU is accepted but slow.
- **Input:** Boltz YAML (`.yaml`/`.yml`, preferred) or `.fasta`.
- **Outputs:** structure (`.cif`), confidence (`.json`), affinity (`.json`) when requested, plus the 3D report.

Single protein, no MSA, fully offline (`examples/boltz/protein.yaml`):

```yaml
version: 1
sequences:
  - protein:
      id: A
      sequence: QLEDSEVEAVAKGLEEMYANGVTEDNFKNYVKNNFAQQEISSVEEELNVNISDSCVANKIKDEFFAMISISAIVKAAQKKAWKELAVTVLRFAKANGLKTNAIIVAGQLALWAVQCG
      msa: empty
```

Protein + ligand with affinity (Boltz-2 upstream schema):

```yaml
version: 1
sequences:
  - protein:
      id: A
      sequence: <PROTEIN SEQUENCE>
      msa: empty
  - ligand:
      id: B
      smiles: 'CC(=O)Oc1ccccc1C(=O)O'
properties:
  - affinity:
      binder: B
```

Every protein chain needs either `msa: empty` (single-sequence mode, offline, lower accuracy) or an MSA. `--param use_msa_server=true` generates MSAs on the public ColabFold MMseqs2 server: better accuracy, but it **sends the sequences off the machine**. Ask the user first.

| Param | Meaning |
| --- | --- |
| `accelerator` | `mps`, `gpu`, or `cpu`. Default is the platform's accelerator. `mps` only on Apple Silicon, `gpu` only on CUDA installs |
| `devices` | Number of devices (default 1) |
| `recycling_steps` | Recycling steps |
| `sampling_steps` | Diffusion sampling steps |
| `diffusion_samples` | Number of samples |
| `max_parallel_samples` | Samples predicted in parallel |
| `use_msa_server` | Use the public MSA server (network) |
| `no_kernels` | Disable custom kernels |
| `seed` | Random seed |

```bash
moldesk run boltz protein.yaml --output ./results
```

Read confidence from the confidence JSON (for example `confidence_score`, `ptm`, `iptm`, `complex_plddt`). Affinity output gives a predicted affinity value and a binder probability. Present both as predictions.

---

## OpenDDE Preview (`opendde`): all-atom co-folding

- **Runs on:** Apple Silicon (MPS). The Linux + CUDA path exists but is not advertised.
- **Disk:** about 3.3 GB of model assets plus the environment.
- **Input:** OpenDDE `.json`, a list of jobs.
- **Outputs:** mmCIF structures, PDB copies (pLDDT in the B-factor column), confidence JSON per sample.
- Upstream labels it a preview. Formats may change between versions.

```json
[
  {
    "name": "tiny",
    "modelSeeds": [101],
    "sequences": [
      { "proteinChain": { "sequence": "ACDEFGHIK", "count": 1 } }
    ]
  }
]
```

Entities can be proteins, DNA, RNA, ligands (SMILES, CCD code, or a file such as `"ligand": "FILE_ligand.sdf"`), and ions. Referenced files (`.sdf`, `.mol`, `.mol2`, `.pdb`, `.a3m`) are resolved relative to the job file and must stay inside its folder. See `examples/opendde/ligand-file.json`.

| Param | Default | Meaning |
| --- | --- | --- |
| `device` | `mps` on Apple Silicon | `auto`, `mps`, `cuda`, `cpu` (`auto` never picks CPU) |
| `samples` | 1 | Diffusion samples |
| `steps` | 200 | Diffusion steps |
| `cycles` | 10 | Pairformer cycles |
| `seed` | from `modelSeeds` | Seed override |
| `use_msa` | false | Use MSAs: precomputed `.a3m` if given, otherwise the public ColabFold server (network; ask first) |
| `use_rna_msa` | false | Needs `unpairedMsaPath` on every RNA chain |
| `deterministic` | false | Deterministic PyTorch algorithms |

`use_template=true` is not supported yet. On an M3 MacBook Air: about 26 s for a 9-residue peptide, about 67 s for ubiquitin (76 residues).

---

## DiffDock-L (`diffdock`): blind small-molecule docking

- **Runs on:** Linux x64 + NVIDIA CUDA only. No macOS, no CPU path.
- **Input:** `.json` job referencing a protein `.pdb` plus a ligand file (`.sdf`/`.mol2`) or SMILES.
- **Outputs:** top pose (`.sdf`), all ranked poses (`.sdf`), `poses_summary.json` (rank, confidence, atom count).
- Predicts poses with a confidence score, **not** binding affinity. For affinity, use Boltz-2.

```json
{
  "jobName": "trp-cage-aspirin",
  "proteinPath": "protein.pdb",
  "ligand": { "smiles": "CC(=O)Oc1ccccc1C(=O)O" }
}
```

`ligand` takes exactly one of `path` (relative to the job file) or `smiles`. `jobName` is optional: letters, digits, `.`, `_`, `-` only. A protein sequence instead of a structure is not supported; fold it first (Boltz-2) or download a structure.

| Param | Default | Meaning |
| --- | --- | --- |
| `samples_per_complex` | 10 | Poses sampled |
| `inference_steps` | 20 | Denoising steps |
| `batch_size` | 10 | Sampling batch size |

Install takes about 10 minutes; a docking job about a minute on an A40.

---

## BindCraft2 (`bindcraft2`): protein binder design

- **Runs on:** Linux x64 + NVIDIA, CUDA 12. At least 25 GB disk and 24 GB RAM.
- **License:** BindCraft2 Source-Available License (Hosting-Restricted). Local and internal commercial use is allowed. Offering it to others as a hosted service, API, or web app is not. Tell the user before installing.
- **Input:** `.json` campaign referencing PDB, mmCIF, or FASTA targets.
- **Outputs:** trajectory, refolded, and ranked CSVs, mmCIF structures, and `moldesk-summary.json` with the accepted-design count.

```json
{
  "targets": [{ "name": "my_target", "target_path": "target.pdb", "chains": "A" }],
  "modality": "binder",
  "binder_lengths": [50, 60],
  "number_of_final_designs": 1,
  "max_trajectories": 1,
  "resume": false
}
```

Modalities: `binder`, `peptide`, `cyclic_peptide`, `VHH`, `ARP`. Budgets must be positive integers. `resume` must be `false`.

| Param | Meaning |
| --- | --- |
| `modality` | Binder format |
| `number_of_final_designs` | Accepted designs requested |
| `max_trajectories` | Required finite attempt budget |
| `min_length`, `max_length` | Binder length range (set both) |

Start with a small budget (`max_trajectories=1` or `2`) to measure time per trajectory, then ask the user before scaling up. **Zero accepted designs is a normal outcome** of a bounded campaign; report it as such and point to the trajectory records.

---

## ProteinMPNN (`proteinmpnn`): sequence design for a backbone

- **Runs on:** Apple Silicon and Linux x64. No GPU required. Small install (checkpoint about 6.7 MB plus the environment).
- **Input:** `.pdb`. **Output:** FASTA sequences (`seqs/*.fa`).

```bash
curl -O https://files.rcsb.org/download/1UBQ.pdb
moldesk run proteinmpnn 1UBQ.pdb --param num_seq_per_target=8 --output ./results
```

| Param | Default | Meaning |
| --- | --- | --- |
| `num_seq_per_target` | 1 | Sequences per target |
| `sampling_temp` | `"0.1"` | Temperature(s), space-separated string, for example `"0.1 0.2"` |
| `seed` | 0 | 0 means random |
| `batch_size` | 1 | Batch size |
| `ca_only` | false | CA-only structures and models |

The first FASTA record is the native sequence; designed sequences follow with a score and sequence recovery in the header. Lower score is better.

---

## LigandMPNN (`ligandmpnn`): ligand- and multimer-aware sequence design

- **Runs on:** Apple Silicon and Linux x64. Small install.
- **Input:** `.pdb` that includes the ligand as HETATM records. **Output:** `seqs/*.fa`.
- Use instead of ProteinMPNN when a bound ligand, cofactor, or other chains should shape the design.

```bash
curl -O https://files.rcsb.org/download/3PTB.pdb
moldesk run ligandmpnn 3PTB.pdb --param batch_size=4 --output ./results
```

| Param | Default | Meaning |
| --- | --- | --- |
| `temperature` | 0.1 | Sampling temperature |
| `seed` | 0 | Random seed |
| `batch_size` | 1 | Sequences per pass |
| `number_of_batches` | 1 | Passes |

Total sequences = `batch_size` x `number_of_batches`.

---

## Planned (not runnable yet)

AlphaFold, ColabFold, and Chai appear in docs as "coming soon". Do not try to install them; suggest Boltz-2 or OpenDDE instead.
