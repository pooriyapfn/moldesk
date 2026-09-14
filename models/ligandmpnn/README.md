# LigandMPNN adapter

Upstream: https://github.com/dauparas/LigandMPNN (MIT, (c) 2024 Justas Dauparas).
Pinned revision: `26ec57ac976ade5379920dbd43c7f97a91cf82de` (main, 2025-02-06,
verified via GitHub API). PyPI `ligandmpnn 0.1.2` used as `modelVersion`.

Evidence:
- `conda create -n ligandmpnn_env python=3.11`, `pip install -r requirements.txt`.
- Requires Python>=3.0, PyTorch, Numpy, ProDy; installable declares
  `Python <3.12,>=3.11`, docs pin PyTorch 2.2.1 + NumPy 1.X.
- Entry point `python run.py --pdb_path <input.pdb> --out_folder <out>`.

The selected 10,541,943-byte checkpoint is cached by SHA-256
`161cd264061fda9680cbb940255522ae42f2966c552d045d87913d9452a80970`;
the exact resolved dependency freeze is captured in installed-model state.
Pending before promotion to `available`: execution smoke tests and output collection.

Registry status remains `beta` until execution and output collection work
end-to-end. Step 3 installation uses the pinned source revision and a
content-addressed, SHA-256-verified checkpoint download.
