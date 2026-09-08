# Model system

Every supported model lives under `models/<name>/` and is described by a
`manifest.yaml`:

```yaml
schemaVersion: 1
name: boltz
displayName: Boltz-2
modelVersion: "2.2.1"      # upstream model/package version
adapterVersion: "0.1.0"    # MoleculeDesk adapter contract version
description: Open-source biomolecular structure prediction model.
category: structure-prediction
status: planned            # available only after install/run verification
homepage: https://github.com/jwohlwend/boltz
license: MIT
source:
  repository: https://github.com/jwohlwend/boltz
  revision: cb04aeccdd480fd4db707f0bbafde538397fa2ac
runtimes:
  - kind: python
    python: "3.11"
    installer: uv
    requirements:
      - name: boltz
        version: 2.2.1
hardware:
  platforms: [darwin-arm64, linux-x64]
input:
  formats: [.yaml, .fasta]
  required: true
outputs:
  - id: structures
    glob: "**/*.cif"
    required: true
```

Manifests are runtime-validated (Zod) against `ModelManifestV1`; unknown
`schemaVersion` values and the legacy top-level `version` field are rejected.

`@moldesk/registry` reads every `models/*/manifest.yaml` at runtime and
exposes them via `listAvailableModels()`. `moldesk list` renders that list
alongside install state from `listInstalledModels()`.

A model being listed does not mean MoleculeDesk redistributes its weights —
each model remains subject to its own license and usage terms.

See [adding-a-model.md](./adding-a-model.md) for how to add a new one.
