---
name: moldesk
description: Install, check, and run molecular AI models (Boltz-2, OpenDDE, DiffDock-L, BindCraft2, ProteinMPNN, LigandMPNN) and analyze protein structures with the MoleculeDesk `moldesk` CLI. Use when the user wants to predict a protein or complex structure, estimate binding affinity, dock a ligand, design protein sequences or binders, fetch a structure from the PDB, AlphaFold DB or UniProt, summarize or inspect a PDB/mmCIF file (chains, sequences, secondary structure, pLDDT, neighbors), highlight residues or compare two structures (TM-score, RMSD, deviation), view a structure, check which models their machine can run or what a model's parameters are, or run a model on a Runpod cloud GPU. Also use when the user mentions MoleculeDesk or moldesk.
---

# MoleculeDesk (`moldesk`)

MoleculeDesk is a CLI that installs molecular AI models into isolated, pinned environments and runs them on local files. Each run gets its own run directory with checksummed outputs and an offline 3D report. It also fetches, analyzes, inspects and compares structures, and every one of those commands prints one machine-readable JSON document.

You drive the CLI for the user. They make the decisions that cost time, disk, money, or data.

## Ground rules

1. **Check before acting.** Run `moldesk doctor` and `moldesk list` before you pick a model. Do not guess hardware support. See [references/compatibility.md](references/compatibility.md).
2. **Ask before installing.** Installs fetch from a few MB to over 15 GB. Tell the user which model you want to install and why, and get a yes before the first `moldesk install`. Run it without `--yes`: a large, unknown-size, or destructive install then stops with `confirmation-required` and prints the download and disk estimates. Show those numbers and pass `--yes` only after the user agrees. Small installs proceed without that stop.
3. **Never spend money without explicit approval.** Cloud runs bill the user's Runpod account. Always quote first with `--dry-run`, show the cost, and wait for a clear yes. Never pass `--yes`, `--accept-lifetime-risk`, or `--accept-storage-charges` on your own. See [references/cloud-runpod.md](references/cloud-runpod.md).
4. **Never handle API keys.** Ask the user to run `moldesk cloud connect runpod` in their own terminal. Do not ask for the key in chat, put it in a command, or write it to a file.
5. **Tell the user before data leaves the machine.** `--param use_msa_server=true` (Boltz-2) and `--param use_msa=true` (OpenDDE) send sequences to a public MSA server. Cloud runs upload inputs. Proprietary sequences may not be allowed to leave.
6. **Do not invent inputs silently.** Use the user's files, the shipped examples, or public structures (RCSB PDB). If you write an input file, say what is in it and where its sequence or ligand came from.
7. **Report results honestly.** These are predictions. Give confidence scores where the model provides them, and say that results need experimental validation. A BindCraft2 campaign with zero accepted designs is a valid result, not a failure.
8. **Respect licenses.** BindCraft2 is source-available and hosting-restricted: no hosted service, API, or web app for other people. Structures from AlphaFold DB and sequences from UniProt are CC BY 4.0: tell the user they must be attributed when published. PDB entries are CC0.
9. **Ask before network fetches and builds.** `moldesk fetch` downloads from RCSB, AlphaFold DB or UniProt, and `moldesk install usalign` downloads source code and compiles it with the user's C++ compiler. Say which id or tool, what gets saved (the cache is `~/.moldesk/cache/fetch`, tools go to `~/.moldesk/tools`) and get a yes first. `moldesk install usalign` always stops without `--yes`, whatever its size; pass `--yes` only after approval.
10. **Read `warnings` and never invent confidence.** Structure commands put caveats in `warnings[]`; relay them. pLDDT appears only from a known source (ModelCIF metrics in the file, a MoleculeDesk Boltz run output, or the user's own statement). Do not pass `--bfactor-is-plddt` for an experimental structure, and never describe an experimental B-factor as confidence. Say when a structure is a prediction.

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
moldesk describe <model> --json            # inputs, parameters, hardware, cloud, license, verdict for this machine
```

Structures:

```bash
moldesk fetch pdb:1M17 --json              # after approval: pdb:<id>, afdb:<accession>, uniprot:<accession>
moldesk analyze <structure> --json         # chains, sequences, gaps, secondary structure, geometry, pLDDT if known
moldesk inspect <structure> A:40-60 --json # residues and their neighbors within --radius
moldesk view <structure> --highlight A:40-60 --color-by plddt
moldesk compare <a> <b> --report overlay.html --json   # needs `moldesk install usalign` once
moldesk schema moldesk.analysis            # the JSON Schema of an output kind
```

Add `--json` to `doctor`, `list`, `describe`, `install`, `run`, `view`, `fetch`, `analyze`, `inspect`, and `compare` for machine-readable output. Prefer `--json` when you need to parse results. Full command reference: [references/cli.md](references/cli.md).

The structure commands print exactly one document on stdout: `{ "schemaVersion": 1, "kind": "moldesk.analysis|inspect|compare|fetch|model", "status": "ok", "result": …, "warnings": […], "provenance": … }`. Errors print `{ "status": "error", "code", "message", "remediation" }` and exit 2 for bad input. Run `moldesk schema <kind>` to see every field instead of guessing. Residues always carry both `authSeqId` and `labelSeqId`; selectors such as `A`, `A:45`, `A:40-60` and `A:52A` use author ids unless `--label` is given.

## Pick a model

| Goal | Model | Input | Runs on |
| --- | --- | --- | --- |
| Structure of a protein or complex, binding affinity | `boltz` | `.yaml` / `.fasta` | Apple Silicon (MPS), Linux + NVIDIA |
| All-atom co-folding (protein, DNA, RNA, ligand, ions) | `opendde` | OpenDDE `.json` | Apple Silicon (MPS), Linux + NVIDIA |
| Blind docking of a small molecule into a protein | `diffdock` | `.json` job | Linux + NVIDIA only |
| Protein binder design campaign | `bindcraft2` | `.json` campaign | Linux + NVIDIA only |
| Sequence design for a backbone | `proteinmpnn` | `.pdb` | Apple Silicon, Linux |
| Sequence design around ligands or multimers | `ligandmpnn` | `.pdb` | Apple Silicon, Linux |

Input formats, parameters, and example files for each model: [references/models.md](references/models.md). For the authoritative parameter list, ranges, platform defaults and whether the model runs here, run `moldesk describe <model> --json` before writing `--param` values.
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
- `SELECTOR_NO_MATCH`: the message says whether the chain or the residue is missing and lists what exists (`details.available`). Pick from that list; do not guess ids.
- `USALIGN_NOT_INSTALLED` or `USALIGN_DAMAGED` (compare): ask, then `moldesk install usalign` (or `--reinstall`). There is no other aligner to fall back to. `COMPILER_NOT_FOUND`: tell the user to install a C++ compiler (`xcode-select --install` on macOS), do not install one yourself.
- `PLDDT_UNAVAILABLE` (`view --color-by plddt`): the file has no known pLDDT source. Offer a ModelCIF or MoleculeDesk Boltz structure instead.
- `FETCH_NOT_FOUND`: there is no search; ask the user for a correct id. `OUTPUT_EXISTS`: choose a new name, the commands never overwrite.
- Do not edit files under `~/.moldesk` by hand, and do not pip-install the model yourself as a fallback.
