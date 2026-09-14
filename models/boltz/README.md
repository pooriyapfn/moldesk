# Boltz-2 adapter

Upstream: https://github.com/jwohlwend/boltz (MIT).
Pinned revision: `cb04aeccdd480fd4db707f0bbafde538397fa2ac`, the commit
referenced by upstream release tag `v2.2.1`; PyPI `boltz 2.2.1` is used as
`modelVersion` (requires-python `>=3.10,<3.13`, verified via PyPI and
`pyproject.toml`).

Evidence:
- `pip install boltz[cuda] -U` (CUDA) or `pip install boltz -U` (CPU, slower).
- Boltz-2 released as v2.0.0; v2.2.1 latest patch at time of writing.
- `boltz predict <input.yaml> --out_dir <out>`; inputs YAML/Fasta, outputs CIF.

Deferred to Step 4: checkpoint/download SHA-256, Docker
digest decision (Python preferred if pinnable), CUDA minima, smoke-test log
on a CUDA host. CPU path retained for macOS ARM64 with warning-level
performance expectations (Step 2 compatibility).

Registry status remains `planned` until installation verification, input
validation, execution, and output collection work end-to-end.
