# Model system

Every supported model lives under `models/<name>/` and is described by a
`manifest.yaml`:

```yaml
name: boltz
displayName: Boltz
version: "0.1.0"
description: Open-source biomolecular structure prediction model.
homepage: https://github.com/jwohlwend/boltz
license: MIT
compatibility:
  cpu: true
  gpu: recommended
```

`@moldesk/registry` reads every `models/*/manifest.yaml` at runtime and
exposes them via `listAvailableModels()`. `moldesk list` renders that list
alongside install state from `listInstalledModels()`.

A model being listed does not mean MoleculeDesk redistributes its weights —
each model remains subject to its own license and usage terms.

See [adding-a-model.md](./adding-a-model.md) for how to add a new one.
