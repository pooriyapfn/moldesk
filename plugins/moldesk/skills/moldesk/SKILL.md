---
name: moldesk
description: Install, check, and run molecular AI models (Boltz-2, OpenDDE, DiffDock-L, BindCraft2, ProteinMPNN, LigandMPNN) with the MoleculeDesk `moldesk` CLI. Use when the user wants to predict a protein or complex structure, estimate binding affinity, dock a ligand, design protein sequences or binders, view a PDB/mmCIF file, check which models their machine can run, or run a model on a Runpod cloud GPU. Also use when the user mentions MoleculeDesk or moldesk.
---

# MoleculeDesk (`moldesk`)

MoleculeDesk is a CLI that installs molecular AI models into isolated, pinned environments and runs them on local files. Each run gets its own run directory with checksummed outputs and an offline 3D report.

You drive the CLI for the user. They make the decisions that cost time, disk, money, or data.

## Ground rules

1. **Check before acting.** Run `moldesk doctor` and `moldesk list` before you pick a model. Do not guess hardware support. See [references/compatibility.md](references/compatibility.md).
2. **Ask before installing.** Installs fetch from a few MB to over 15 GB. Tell the user which model you want to install and why, and get a yes before the first `moldesk install`. Run it without `--yes`: a large, unknown-size, or destructive install then stops with `confirmation-required` and prints the download and disk estimates. Show those numbers and pass `--yes` only after the user agrees. Small installs proceed without that stop.
3. **Never spend money without explicit approval.** Cloud runs bill the user's Runpod account. Always quote first with `--dry-run`, show the cost, and wait for a clear yes. Never pass `--yes`, `--accept-lifetime-risk`, or `--accept-storage-charges` on your own. See [references/cloud-runpod.md](references/cloud-runpod.md).
4. **Never handle API keys.** Ask the user to run `moldesk cloud connect runpod` in their own terminal. Do not ask for the key in chat, put it in a command, or write it to a file.
5. **Tell the user before data leaves the machine.** `--param use_msa_server=true` (Boltz-2) and `--param use_msa=true` (OpenDDE) send sequences to a public MSA server. Cloud runs upload inputs. Proprietary sequences may not be allowed to leave.
6. **Do not invent inputs silently.** Use the user's files, the shipped examples, or public structures (RCSB PDB). If you write an input file, say what is in it and where its sequence or ligand came from.
7. **Report results honestly.** These are predictions. Give confidence scores where the model provides them, and say that results need experimental validation. A BindCraft2 campaign with zero accepted designs is a valid result, not a failure.
8. **Respect licenses.** BindCraft2 is source-available and hosting-restricted: no hosted service, API, or web app for other people.

## Is it installed?

```bash
moldesk --version
```

If the command is missing, read [references/install.md](references/install.md). The short version for macOS and Linux:

```bash
curl -fsSL https://moleculedesk.com/install.sh | sh
```

Tell the user that this command downloads and runs a script, and get a yes first. After installing, a new shell is needed; until then, use `~/.moldesk/bin/moldesk`.

## Core workflow

```bash
moldesk doctor                       # hardware, Python, Docker, CUDA, RAM, disk
moldesk list                         # every model, status, and compatibility here (* = installed)
moldesk install <model>              # shows a plan and asks; --yes only after user approval
moldesk run <model> <input> --output ./results
moldesk view <structure.pdb|.cif> --open   # offline 3D report for any structure
```

Add `--json` to `doctor`, `list`, `install`, `run`, and `view` for machine-readable output. Prefer `--json` when you need to parse results. Full command reference: [references/cli.md](references/cli.md).

## Pick a model

| Goal | Model | Input | Runs on |
| --- | --- | --- | --- |
| Structure of a protein or complex, binding affinity | `boltz` | `.yaml` / `.fasta` | Apple Silicon (MPS), Linux + NVIDIA |
| All-atom co-folding (protein, DNA, RNA, ligand, ions) | `opendde` | OpenDDE `.json` | Apple Silicon (MPS) |
| Blind docking of a small molecule into a protein | `diffdock` | `.json` job | Linux + NVIDIA only |
| Protein binder design campaign | `bindcraft2` | `.json` campaign | Linux + NVIDIA only |
| Sequence design for a backbone | `proteinmpnn` | `.pdb` | Apple Silicon, Linux |
| Sequence design around ligands or multimers | `ligandmpnn` | `.pdb` | Apple Silicon, Linux |

Input formats, parameters, and example files for each model: [references/models.md](references/models.md).
Multi-step recipes (design then fold, dock then inspect, and others): [references/workflows.md](references/workflows.md).

## Running a model

1. Confirm the model is `compatible` in `moldesk list`. If it is not, explain the reason shown and offer the options in [references/compatibility.md](references/compatibility.md).
2. Install it if it has no `*` in `moldesk list`, after approval.
3. Prepare the input in a working folder the user chose (default: a new folder in the current directory). Check it against [references/models.md](references/models.md).
4. Run it:

   ```bash
   moldesk run <model> <input> --output ./results --json
   ```

   Runs can take seconds (ProteinMPNN) to tens of minutes (BindCraft2). Run long jobs in the background if your environment allows it, and tell the user roughly how long to expect.
5. Read the result. `--json` returns the status, the run directory, each output path, and the report path. Exit code `0` is success, `7` is a failed run, `8` is cancelled, `5` is "not installed", `4` is "unsupported here".
6. Summarize for the user: what ran, where the outputs are, key scores, and how to open the report (`open <report.html>` on macOS, `xdg-open` on Linux).

## When something fails

- Read the error message. MoleculeDesk errors include a code and a remediation line; follow the remediation.
- `RUNTIME_PLATFORM_UNSUPPORTED`: the model has no build for this OS or CPU. Do not try to work around it. Offer another model or a Linux + NVIDIA machine.
- `DISK_SPACE_LOW`: tell the user how much is needed. Suggest freeing space or setting `MOLDESK_HOME` to a larger disk.
- A broken install: `moldesk install <model> --reinstall` (after approval). The previous install stays intact if the reinstall fails.
- Do not edit files under `~/.moldesk` by hand, and do not pip-install the model yourself as a fallback.
