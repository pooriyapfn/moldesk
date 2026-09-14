# ProteinMPNN adapter

Upstream: https://github.com/dauparas/ProteinMPNN (MIT, (c) 2022 Justas Dauparas).
Pinned revision: `8907e6671bfbfc92303b5f79c4b5e6ce47cdef57` (main, 2023-06-27,
verified via GitHub API).

Evidence:
- `Python>=3.0, PyTorch, Numpy` required; conda example uses `cudatoolkit=11.3`.
  Managed runtime pins Python 3.11 (compatible range).
- Default model `v_48_020` used as `modelVersion`; its 6,681,301-byte checkpoint
  is cached by SHA-256 `c9cb4a671d79604111231f8dbfc7c590e06f1197453b7a6854ac6661a642f5bd`.
- Entry point `protein_mpnn_run.py --pdb_path <input.pdb> --out_folder <out>`.

The exact resolved dependency freeze is captured in every installed-model record.
Pending before promotion to `available`: execution smoke tests and output collection.

Registry status remains `beta` until execution and output collection work
end-to-end. Step 3 installation is implemented with a pinned source checkout,
isolated managed Python environment, and post-install verification.
