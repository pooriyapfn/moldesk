# MoleculeDesk

MoleculeDesk is an open-source package manager and runtime for computational biology models.

It aims to make tools like Boltz, AlphaFold, ColabFold, Chai, and other molecular AI models easier to install and run on local machines, workstations, and remote GPU servers.

Think of it as a simpler interface for scientific models:

```bash
npm install -g @moldesk/cli

moldesk doctor
moldesk install proteinmpnn
moldesk run proteinmpnn input.pdb
moldesk list --installed
```

Instead of manually setting up Python environments, CUDA dependencies, containers, model weights, and model-specific commands, MoleculeDesk provides a consistent interface across supported models.

## Status

MoleculeDesk is approaching a v0.1 Early Preview, not yet released.

Available:

* `moldesk doctor` for system and hardware detection
* `moldesk list` for model discovery, with compatibility explanations for
  Python, Docker, CUDA, GPU, RAM, and disk
* isolated, atomic install/uninstall/reinstall for ProteinMPNN and
  LigandMPNN, with `moldesk list --installed` state management
* `moldesk run <model> <input>` — real end-to-end execution for
  ProteinMPNN and LigandMPNN, with live logs, checksummed outputs, a stable
  CLI exit-code contract, and a full reproducibility record
  (`run.json`: hardware, parameters, command, timing, checksums) per run
* a Boltz-2 install/run adapter — implemented and unit-tested, but **not
  yet verified on a real CUDA host**; GPU is required (the pinned upstream
  revision has a known CPU-inference correctness bug), so Boltz stays
  release-blocking until that verification happens
* `moldesk --version`

Before release:

* a real Boltz-2 install + run verified on an NVIDIA GPU host
* published npm packages at a coordinated version (the previous `0.0.1`
  publish is incomplete/broken — `@moldesk/adapters` was never published)

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

MoleculeDesk uses an npm workspace.

```bash
git clone https://github.com/pooriyapfn/moldesk.git
cd moldesk

npm install
npm run dev -w @moldesk/cli -- doctor
```

## Model support

Model support is being added incrementally.

| Model     | Status      |
| --------- | ----------- |
| Boltz     | In progress |
| ColabFold | Planned     |
| AlphaFold | Planned     |
| Chai      | Planned     |

A model being listed here does not mean MoleculeDesk redistributes that model or its weights. Each model remains subject to its own license and usage terms.

## Contributing

MoleculeDesk is in an early stage, and contributions are welcome.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MoleculeDesk is licensed under the MIT License.

See [LICENSE](./LICENSE).
