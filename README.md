<div align="center">

# MoleculeDesk

**Run molecular AI models on your own Mac, Linux GPU or rented cloud GPU, with one command.**

Protein structure prediction, protein and binder design, and molecular docking, without setting up conda, CUDA, containers or model weights by hand.

[![Release](https://img.shields.io/github/v/release/pooriyapfn/moldesk?label=release)](https://github.com/pooriyapfn/moldesk/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20(Apple%20Silicon)%20%7C%20Linux%20(NVIDIA)-555)](https://moleculedesk.com/docs/model-compatibility)
[![GitHub stars](https://img.shields.io/github/stars/pooriyapfn/moldesk?style=social)](https://github.com/pooriyapfn/moldesk/stargazers)

[Website](https://moleculedesk.com) · [Docs](https://moleculedesk.com/docs) · [Benchmarks](https://moleculedesk.com/docs/benchmarks) · [Guides](https://moleculedesk.com/docs/guides/run-boltz-locally)

<!-- TODO: hero GIF (install -> moldesk run boltz -> 3D report opening), ~10 s, < 5 MB.
     ![MoleculeDesk demo](docs/assets/demo.gif) -->

</div>

---

## Quick start

```bash
# 1. Install (macOS or Linux; no Node.js, npm or admin rights needed)
curl -fsSL https://moleculedesk.com/install.sh | sh

# 2. Check what your machine can run
moldesk doctor

# 3. Install a model and predict a structure
moldesk install boltz
moldesk run boltz protein.yaml
```

<details>
<summary><code>protein.yaml</code>: a minimal Boltz-2 input</summary>

```yaml
version: 1
sequences:
  - protein:
      id: A
      sequence: QLEDSEVEAVAKGLEEMYANGVTEDNFKNYVKNNFAQQEISSVEEELNVNISDSCVANKIKDEFFAMISISAIVKAAQKKAWKELAVTVLRFAKANGLKTNAIIVAGQLALWAVQCG
      msa: empty
```

</details>

Boltz-2, OpenDDE, DiffDock-L and BindCraft2 runs write an **offline, self-contained 3D report** you can open in any browser. Everything is installed under `~/.moldesk`. See the [installation guide](https://moleculedesk.com/docs/installation) for updating, uninstalling and GPU servers.

## What you can do

- **Predict protein and complex structures** with [Boltz-2](https://moleculedesk.com/docs/models/boltz) and [OpenDDE](https://moleculedesk.com/docs/models/opendde), including on Apple Silicon (MPS). → [Run Boltz-2 locally](https://moleculedesk.com/docs/guides/run-boltz-locally)
- **Design protein binders.** 8 PD-L1 binder designs took about 5 minutes and cost about $0.09 on a rented L40S with [RFD4-Proteina](https://moleculedesk.com/docs/models/rfd4-proteina). → [Step-by-step guide](https://moleculedesk.com/docs/guides/design-pd-l1-binder-rfd4-proteina)
- **Design sequences** for a backbone with [ProteinMPNN](https://moleculedesk.com/docs/models/proteinmpnn) and [LigandMPNN](https://moleculedesk.com/docs/models/ligandmpnn).
- **Dock small molecules** with [DiffDock-L](https://moleculedesk.com/docs/models/diffdock).
- **Run binder campaigns** with [BindCraft2](https://moleculedesk.com/docs/models/bindcraft2) (beta).
- **Fetch, analyze and compare structures** from PDB, AlphaFold DB and UniProt (`moldesk fetch`, `analyze`, `inspect`, `compare`, `describe`), with a stable JSON output. → [EGFR end-to-end example](examples/egfr-end-to-end/README.md)
- **Use your own cloud GPU when you need one.** Add `--compute runpod` to run on your own Runpod account and get verified results back on your machine. → [Cloud guide](https://moleculedesk.com/docs/guides/runpod-cloud-execution)

## Supported models

| Model | What it does | Apple Silicon | Linux + NVIDIA | Runpod cloud |
| --- | --- | :---: | :---: | :---: |
| [Boltz-2](https://moleculedesk.com/docs/models/boltz) | Structure and complex prediction | ✅ | ✅ | ✅ |
| [OpenDDE](https://moleculedesk.com/docs/models/opendde) (preview) | All-atom co-folding | ✅ | ✅ | ✅ |
| [ProteinMPNN](https://moleculedesk.com/docs/models/proteinmpnn) | Sequence design | ✅ | ✅ | ✅ |
| [LigandMPNN](https://moleculedesk.com/docs/models/ligandmpnn) | Ligand-aware sequence design | ✅ | ✅ | — |
| [DiffDock-L](https://moleculedesk.com/docs/models/diffdock) | Molecular docking | — | ✅ | ✅ |
| [RFD4-Proteina](https://moleculedesk.com/docs/models/rfd4-proteina) | Protein, binder, enzyme and antibody design | — | 🧪 | ✅ |
| [BindCraft2](https://moleculedesk.com/docs/models/bindcraft2) | Binder design campaigns | — | 🧪 | — |
| ColabFold · AlphaFold · Chai | | 🔜 | 🔜 | 🔜 |

✅ available · 🧪 beta or partly verified · 🔜 planned · — not supported. See [model compatibility](https://moleculedesk.com/docs/model-compatibility) for the exact hardware each result was verified on, and [benchmarks](https://moleculedesk.com/docs/benchmarks) for measured time and cost.

MoleculeDesk does not redistribute models or weights. Each model stays under its own license; BindCraft2 is source-available with a hosting restriction.

## Use it from Claude Code or Codex

Ask your coding agent to "predict this structure" or "design a binder for PD-L1". The MoleculeDesk skill installs the CLI, checks your hardware, prepares inputs and runs the model. It asks before large downloads and before anything that costs money.

```bash
# Claude Code
claude plugin install moldesk --marketplace pooriyapfn/moldesk

# Codex: add the marketplace, then open /plugins in Codex and install moldesk
codex plugin marketplace add pooriyapfn/moldesk
```

See the [agent skills guide](https://moleculedesk.com/docs/agent-skills) and [plugins/moldesk](plugins/moldesk).

## Why MoleculeDesk

| By hand | With MoleculeDesk |
| --- | --- |
| A separate conda env, CUDA build and README for every model | `moldesk install <model>`: isolated, pinned and atomic |
| Guess whether your GPU, RAM or disk is enough | `moldesk doctor` explains what runs on your machine, and why |
| A different input format and flags for every tool | One `moldesk run <model> <input>` workflow |
| Results scattered across output folders | An offline 3D report plus recorded versions, parameters and logs |
| Rent a GPU, SSH in and rebuild the environment | `--compute runpod`, with a cost quote and a budget guard |

## FAQ

**Can I run Boltz-2 on a Mac?**
Yes. Boltz-2, OpenDDE, ProteinMPNN and LigandMPNN run on Apple Silicon using MPS. See the [Apple Silicon guide](https://moleculedesk.com/docs/guides/apple-silicon).

**Do I need an NVIDIA GPU?**
Not for the models above. DiffDock-L, RFD4-Proteina and BindCraft2 need Linux with NVIDIA CUDA. If you don't have that hardware, you can run them on your own Runpod account.

**How fast is it, and what does a cloud run cost?**
On an RTX 3090, a 115-residue Boltz-2 prediction takes about 85 s once warm, and a ProteinMPNN design takes about 8 s. On Runpod, a 100-residue RFD4-Proteina design took about 2.7 minutes (~$0.05). All numbers are in the [benchmarks](https://moleculedesk.com/docs/benchmarks).

**Is MoleculeDesk an AlphaFold replacement?**
No. It is a package manager and runtime that installs and runs existing open models (Boltz-2, RFD4-Proteina, DiffDock-L and others) behind one consistent CLI. AlphaFold, ColabFold and Chai support is planned.

**Does anything leave my machine?**
Local runs stay local. Downloads (model weights, PDB, AlphaFold DB and UniProt fetches) happen only when you ask for them, and cloud runs happen only with `--compute runpod` and an explicit acknowledgment of the cost risk.

## Project status

MoleculeDesk is in early development (latest: [releases](https://github.com/pooriyapfn/moldesk/releases)). Verification status per model and platform is tracked on the [model compatibility](https://moleculedesk.com/docs/model-compatibility) page and in the [CHANGELOG](./CHANGELOG.md). Coming next: more models, reproducible run history, and a desktop app for researchers who prefer not to use the command line.

## Contributing

Contributions are welcome: new model adapters, platform verification reports and docs fixes. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), [adding a model](docs/adding-a-model.md) and the [architecture overview](docs/architecture.md).

```bash
git clone https://github.com/pooriyapfn/moldesk.git
cd moldesk
pnpm install
pnpm --filter @moldesk/cli dev -- doctor
```

If MoleculeDesk saves you a setup afternoon, a ⭐ helps other researchers find it.

## License

MIT. See [LICENSE](./LICENSE). Models and weights keep their own licenses.
