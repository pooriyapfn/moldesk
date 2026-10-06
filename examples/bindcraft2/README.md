# Bounded BindCraft2 smoke campaign

`campaign.json` requests one accepted binder, with **one trajectory maximum**,
against a short sequence target. Zero accepted designs is a valid finite result.
This is a compute/install smoke test, not a validated scientific campaign.

`target.fasta` contains the natural 17-residue dynorphin A sequence
`YGGFLRRIRPKLKWDNQ`, written directly for this example. The JSON and FASTA example
are distributed under MoleculeDesk's MIT license; they are not copied upstream
settings or proprietary target structures.

```bash
moldesk run bindcraft2 examples/bindcraft2/campaign.json
```

Requires a Linux/NVIDIA installation and managed AlphaFold/MPNN weights.
BindCraft2 remains `planned` until live verification; see
`models/bindcraft2/README.md` for the private test-registry commands.

CLI overrides: `--param max_trajectories=2`,
`--param number_of_final_designs=1`, `--param min_length=50 --param max_length=60`.
No automatic workers or resume; repeated commands create independent run records.

BindCraft2 uses a **Source-Available License (Hosting-Restricted)**. Local/internal
use is permitted; substantial hosted functionality needs a separate commercial
license. This example runs locally on the user's own rented GPU server.
