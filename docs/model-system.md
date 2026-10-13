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

## Optional `cloud` block (remote execution)

A manifest opts in to running on rented compute with a strict, independently
versioned `cloud` block. No block means the model is never run in the cloud.

```yaml
cloud:
  schemaVersion: 1
  platform: linux-x64
  images:
    gpu: registry.example/moldesk/worker-gpu@sha256:<64 hex>   # inference
    cpu: registry.example/moldesk/worker-cpu@sha256:<64 hex>   # asset preparation only
  minVramGb: 24
  minRamGb: 32
  ephemeralDiskGb: 40     # one job's container disk
  volumeGb: 40            # persistent network volume (raw cache + materialized assets)
  assetLayoutRevision: "1"
  cpuAssetPreparation: true
```

Images must be pinned by digest, never a tag. The block reuses the manifest's
own `assets`, `runtimes` and `source`; it adds no commands. Validation requires
a Python runtime entry that applies to `linux-x64`, `minVramGb` at least that
runtime's own floor, and disk/volume sizes no smaller than the declared asset
bytes (a lower bound only; measure extraction and runtime headroom live).
Values must come from a live validation of that model on those images; do not
ship placeholders.

A model being listed does not mean MoleculeDesk redistributes its weights —
each model remains subject to its own license and usage terms.

See [adding-a-model.md](./adding-a-model.md) for how to add a new one.
