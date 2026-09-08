# ProteinMPNN adapter

Upstream: https://github.com/dauparas/ProteinMPNN (MIT, (c) 2022 Justas Dauparas).
Pinned revision: `8907e6671bfbfc92303b5f79c4b5e6ce47cdef57` (main, 2023-06-27,
verified via GitHub API).

Evidence:
- `Python>=3.0, PyTorch, Numpy` required; conda example uses `cudatoolkit=11.3`.
  Managed runtime pins Python 3.11 (compatible range).
- Default model `v_48_020` used as `modelVersion`; weights live in-repo under
  `vanilla_model_weights/` (no separate checksum to pin for Step 1; assets
  omitted until download URLs + SHA-256 verified).
- Entry point `protein_mpnn_run.py --pdb_path <input.pdb> --out_folder <out>`.

Pending before Step 3 install work: weight-file SHA-256, full pip freeze,
CUDA minima, smoke-test log.

Registry status remains `planned` until installation verification, input
validation, execution, and output collection work end-to-end.
