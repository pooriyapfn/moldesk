# MoleculeDesk

MoleculeDesk is an open-source package manager and runtime for running molecular AI models locally.

It aims to make tools like Boltz, AlphaFold, ColabFold, Chai, and other molecular AI models easier to install and run on local machines, workstations, and remote GPU servers.

Think of it as a simpler interface for scientific models:

Read the [documentation](https://moleculedesk.com/docs), [Boltz-2 local guide](https://moleculedesk.com/docs/guides/run-boltz-locally), and [Apple Silicon support guide](https://moleculedesk.com/docs/guides/apple-silicon) for current commands and platform limits.

```bash
curl -fsSL https://moleculedesk.com/install.sh | sh

moldesk doctor
moldesk install proteinmpnn
moldesk list --installed
```

The installer works on macOS and Linux with nothing installed beforehand: no Node.js, no npm, no admin rights. It sets up everything inside `~/.moldesk`. See the [installation guide](https://moleculedesk.com/docs/installation) for updating, removing, and GPU servers.

Instead of manually setting up Python environments, CUDA dependencies, containers, model weights, and model-specific commands, MoleculeDesk provides a consistent interface across supported models.

## Use it from Claude Code or Codex

The MoleculeDesk skill lets a coding agent install the CLI, check compatibility, prepare inputs, and run models for you. It asks before large downloads and before anything that costs money.

```bash
# Claude Code
claude plugin install moldesk --marketplace pooriyapfn/moldesk

# Codex: add the marketplace, then open /plugins in Codex and install moldesk
codex plugin marketplace add pooriyapfn/moldesk
```
 See [plugins/moldesk](plugins/moldesk) and the [agent skills guide](https://moleculedesk.com/docs/agent-skills).

## Status

MoleculeDesk is currently in early development.

Available:

* `moldesk doctor` for system and hardware detection
* `moldesk list` for model discovery
* compatibility explanations for Python, Docker, CUDA, GPU, RAM, and disk
* isolated, atomic ProteinMPNN and LigandMPNN installation
* Boltz-2 installation and prediction on Apple Silicon using MPS; Linux x64/CUDA verified on an NVIDIA RTX 3090 (see the [benchmarks](https://moleculedesk.com/docs/benchmarks))
* OpenDDE Preview (all-atom co-folding) installation and prediction on Apple Silicon using MPS and on Linux x64/CUDA (verified on Runpod A40 and RTX 3090 Pods; the no-GPU refusal path is not yet verified)
* `moldesk list --installed`, reinstall, and uninstall state management
* offline, self-contained 3D reports: `moldesk view <pdb|cif>` and an automatic report for successful Boltz, OpenDDE, BindCraft2, and DiffDock runs (see [docs](docs/visualizer.md))
* structure intelligence with a stable JSON contract: `moldesk fetch` (PDB, AlphaFold DB, UniProt), `analyze`, `inspect`, `view --highlight`, `compare` (US-align, with an overlay report) and `describe`; see [analysis-json](docs/analysis-json.md) and the [EGFR end-to-end example](examples/egfr-end-to-end/README.md)
* `moldesk --version`
* initial CLI and runtime architecture

In progress:

* RFD4-Proteina adapter (protein, binder, enzyme and antibody design from condition specs; generation only, Linux/NVIDIA): unit-tested and run end to end on a Runpod RTX 6000 Ada Pod (`--compute runpod`, about 2.7 minutes and roughly $0.05 for a 100-residue monomer); **not yet run on a local Linux machine**; see [models/rfd4-proteina](models/rfd4-proteina/README.md)
* BindCraft2 adapter for bounded local Linux/NVIDIA binder campaigns: install and bounded campaigns verified on NVIDIA RTX 3090 and A40 GPUs (beta) (source-available, hosting-restricted license)
* reproducible run history

Future releases will add more models, remote GPU execution, and a desktop interface for researchers who prefer not to use the command line.

## Goals

MoleculeDesk focuses on a few principles:

* **Simple installation**
  Researchers should not need to manually manage CUDA, Python environments, containers, or model-specific setup.

* **Consistent commands**
  Different models should follow the same install and run workflow.

* **Local-first execution**
  Run models on your own laptop, workstation, or GPU machine whenever possible.

* **Reproducibility**
  Preserve model versions, parameters, inputs, outputs, environment information, and logs.

* **Hardware awareness**
  Detect available CPU, GPU, memory, CUDA, and runtime capabilities before running a model.

### Optional cloud execution

Boltz-2 and ProteinMPNN can run on your own Runpod account (`moldesk run <model> <input> --compute runpod`), with verified results returned locally. Use temporary model assets (`ephemeral`, supported) or retain a reusable model cache (`persistent`, experimental: it was slower than `ephemeral` in live tests, and retained storage keeps incurring charges until you delete it). Other models are not enabled for cloud execution yet. Shutdown is best effort: if MoleculeDesk disconnects, Pods may keep charging; each run requires explicit risk acknowledgment. Read the [Runpod cloud execution guide](https://moleculedesk.com/docs/guides/runpod-cloud-execution) for the workflow, costs and limits.

## Architecture

```text
CLI / Desktop
      |
     Core
      |
    Runtime
      |
Model Registry
      |
Boltz / AlphaFold / ColabFold / Chai / ...
```

### Repository structure

* `apps/cli`
  The `moldesk` command-line interface. It stays intentionally thin and delegates functionality to the shared core.

* `apps/desktop`
  Future Tauri desktop application using the same MoleculeDesk core.

* `packages/core`
  Shared application logic used by the CLI and desktop app.

* `packages/runtime`
  Hardware detection, Python environments, containers, processes, and execution infrastructure.

* `packages/registry`
  Model discovery, manifests, compatibility metadata, and model resolution.

* `packages/adapters`
  Thin model-specific installation, command, and output translations.

* `packages/visualizer`
  The offline molecular report: report contract, exporter, local viewer updater, and the Mol* viewer bundle built once at package build time.

* `models/`
  Validated model manifests and provenance documentation.

Example:

```text
models/
├── boltz/
├── colabfold/
├── alphafold/
└── chai/
```

## Development

MoleculeDesk uses a pnpm workspace.

```bash
git clone https://github.com/pooriyapfn/moldesk.git
cd moldesk

pnpm install
pnpm --filter @moldesk/cli dev -- doctor
```

## Model support

Model support is being added incrementally.

| Model | Status |
| --- | --- |
| Boltz-2 | Available; Apple Silicon MPS and Linux/NVIDIA CUDA verified |
| ProteinMPNN | Available; Apple Silicon and Linux/NVIDIA CUDA (RTX 3090) |
| LigandMPNN | Available; Apple Silicon and Linux/NVIDIA CUDA (RTX 3090) |
| DiffDock-L | Available; Linux/NVIDIA CUDA only, verified on an A40 |
| BindCraft2 | Beta; Linux/NVIDIA CUDA verified on RTX 3090 and A40; source-available, hosting-restricted license |
| RFD4-Proteina | Generation only, Linux/NVIDIA (CUDA 12); BSD-3-Clause; run on a Runpod RTX 6000 Ada Pod only (not yet on a local Linux machine) |
| OpenDDE Preview | Available (upstream preview); Apple Silicon MPS verified; Linux/NVIDIA CUDA verified on Runpod A40 and RTX 3090 Pods |
| ColabFold | Planned |
| AlphaFold | Planned |
| Chai | Planned |

A model being listed here does not mean MoleculeDesk redistributes that model or its weights. Each model remains subject to its own license and usage terms.

## Contributing

MoleculeDesk is in an early stage, and contributions are welcome.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MoleculeDesk is licensed under the MIT License.

See [LICENSE](./LICENSE).
