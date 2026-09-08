# LigandMPNN adapter

Upstream: https://github.com/dauparas/LigandMPNN (MIT, (c) 2024 Justas Dauparas).
Pinned revision: `26ec57ac976ade5379920dbd43c7f97a91cf82de` (main, 2025-02-06,
verified via GitHub API). PyPI `ligandmpnn 0.1.2` used as `modelVersion`.

Evidence:
- `conda create -n ligandmpnn_env python=3.11`, `pip install -r requirements.txt`.
- Requires Python>=3.0, PyTorch, Numpy, ProDy; installable declares
  `Python <3.12,>=3.11`, docs pin PyTorch 2.2.1 + NumPy 1.X.
- Entry point `python run.py --pdb_path <input.pdb> --out_folder <out>`.

Pending before Step 3 install work: model-param (`get_model_params.sh`) SHA-256,
full requirements freeze, smoke-test log.

Registry status remains `planned` until installation verification, input
validation, execution, and output collection work end-to-end.
