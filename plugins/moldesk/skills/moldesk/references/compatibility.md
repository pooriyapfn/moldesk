# Can this machine run the model?

Do not decide from memory. Ask the CLI:

```bash
moldesk doctor --json     # what the machine has
moldesk list --json       # per model: compatibility.status, selectedRuntime, reasons[]
```

`compatibility.status` is `compatible` or `unsupported`. Every reason has a `code`, a `message`, and often a `remediation`. Quote the message to the user instead of paraphrasing.

## Advertised support (as of MoleculeDesk 0.0.7)

| Model | Apple Silicon (darwin-arm64) | Linux x64 + NVIDIA | Linux x64, no GPU |
| --- | --- | --- | --- |
| `boltz` | yes (MPS) | yes (CUDA) | CPU accepted, slow |
| `opendde` | yes (MPS) | yes (CUDA) | no |
| `diffdock` | no | yes (CUDA required) | no |
| `bindcraft2` | no | yes (CUDA 12, 24 GB RAM, 25 GB disk) | no |
| `proteinmpnn` | yes | yes | yes |
| `ligandmpnn` | yes | yes | yes |

Intel Macs and native Windows are not supported. Windows users can use WSL2.

## Common reason codes

| Code | Meaning | What to offer |
| --- | --- | --- |
| `RUNTIME_PLATFORM_UNSUPPORTED` | No build for this OS/CPU | A model that runs here, a Linux + NVIDIA machine, or cloud for the models in [cloud-runpod.md](cloud-runpod.md) |
| `DISK_SPACE_LOW` | Not enough free space under `MOLDESK_HOME` | Free space, or move `MOLDESK_HOME` to a larger disk |
| `DOCKER_GPU_UNVERIFIED` | Docker cannot reach the GPU | Fix the NVIDIA container toolkit, or use the Python runtime |

## Choosing when the preferred model is unsupported

Explain the tradeoff and let the user choose:

- **Docking on a Mac:** DiffDock-L needs CUDA. Boltz-2 can model the protein-ligand complex and predict affinity locally. It answers a related but different question; say so.
- **Binder design on a Mac:** BindCraft2 needs CUDA. A lighter local route: ProteinMPNN or LigandMPNN on an existing complex, then fold the designs with Boltz-2 to check them. It is not equivalent to a BindCraft2 campaign.
- **Large complexes:** memory grows with size. If a run fails with an out-of-memory error, reduce `diffusion_samples`/`samples`, split the problem, or use a larger GPU.

## Running on a remote Linux GPU machine

If the user already has a Linux + NVIDIA server (their own, a lab cluster, or a rented machine they manage), MoleculeDesk installs there the same way. See "Remote GPU servers" in [install.md](install.md). Copy inputs there, run, and copy results back. The user controls the machine and its costs.

If the user has no GPU machine, see [cloud-runpod.md](cloud-runpod.md).
