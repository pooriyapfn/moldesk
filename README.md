# MoleculeDesk

MoleculeDesk is an open-source package manager and runtime for computational biology models.

It aims to make tools like Boltz, AlphaFold, ColabFold, Chai, and other molecular AI models easier to install and run on local machines, workstations, and remote GPU servers.

Think of it as a simpler interface for scientific models:

```bash
npm install -g moldesk

moldesk doctor
moldesk install boltz
moldesk run boltz input.yaml
```

Instead of manually setting up Python environments, CUDA dependencies, containers, model weights, and model-specific commands, MoleculeDesk provides a consistent interface across supported models.

## Status

MoleculeDesk is currently in early development.

Available:

* `moldesk doctor` for system and hardware detection
* `moldesk list` for model discovery
* `moldesk --version`
* initial CLI and runtime architecture

In progress:

* `moldesk install boltz`
* `moldesk run boltz input.yaml`
* isolated model environments
* automatic hardware compatibility checks
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

* `models/`
  Model-specific adapters and manifests.

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
