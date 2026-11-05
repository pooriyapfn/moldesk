# PD-L1 binder campaign

Local preparation, scoring and evidence bookkeeping using core APIs. An agent chooses when to run each bounded inference batch; the runner never rents GPUs, approves quotes, installs models or launches inference.

Start with **2 designs**, review timings, costs, artifacts and failures, then a **20-design pilot**. Additional batches need a new recorded decision. Scores assess modeled interfaces, not measured affinity or confirmed binders. Zero shortlisted candidates is valid.

## Register policy before generation

Build the workspace (`pnpm build`). Inspect `moldesk describe boltz --json`; edit `config.json` for the intended runtime and exact effective parameters before initialization. The example uses MPS, one prediction sample, an explicit fixed prediction seed and minimum ipSAE max 0.6. These are recipe choices, not biological pass thresholds. Linux/cloud prediction requires `accelerator: "gpu"` in a separate registered protocol. Keep all samples; aggregation is the minimum of their ipSAE max values.

The source target and hotspots are the existing [RFD4 PD-L1 example](../rfd4-proteina/pdl1-binder/README.md). Its source attribution and BSD notice apply. The approved crop is PD-L1 author chain A, residues 17–131; generated target chain A is renumbered 1–115; binder is explicitly chain B. Check these assignments against the actual generated structures; the helper refuses a sequence or numbering mismatch.

Decompress the shipped input into a user-selected directory, preserving the original:

```bash
mkdir -p /absolute/path/pdl1-input
zstd -dc examples/rfd4-proteina/pdl1-binder/5o45_cropped.cif.zst > /absolute/path/pdl1-input/target.cif
node examples/pdl1-binder-campaign/run.mjs init /absolute/path/pdl1-campaign examples/pdl1-binder-campaign/config.json /absolute/path/pdl1-input/target.cif
```

The runner freezes the exact generation spec/hotspots, all companion inputs, and modeled target crop/residue mapping before generation. Incomplete structures need an explicit complete approved target/crop; it never substitutes `fullSequence` or guesses missing residues. `campaign.json` is immutable and its initial hash is recorded in `decisions.jsonl`. Change criteria only in a new policy revision/campaign.

Install ipSAE once with the normal confirmation flow (`moldesk install ipsae`). It uses a pinned upstream revision, isolated managed Python and hash-pinned NumPy. Scoring thereafter works offline, including on a Mac without Boltz installed. No auto-install fallback exists.

## Smoke test, then pilot

Run generation explicitly, only after local/model or cloud/upload/spending approvals. Original hotspot input stays unchanged:

```bash
moldesk run rfd4-proteina examples/rfd4-proteina/pdl1-binder/binder.yaml --param numReplicates=2 --param batchSize=2 --param seed=28001 --json
node examples/pdl1-binder-campaign/run.mjs prepare /absolute/path/pdl1-campaign /absolute/path/generation-run/run.json
```

Preparation verifies the generation spec and hashes, extracts standard residues through Mol*, matches the frozen target, deduplicates exact binder sequences, and writes one Boltz YAML plus mapping JSON per unique candidate under `jobs/`. Each protein uses `msa: empty`; changing to an MSA-backed protocol requires a separate recorded protocol and upload decision. Candidate IDs derive from source run/design/replicate, separately from binder sequence hashes.

Run every unique job explicitly, using **all** registered parameters. For the MPS example:

```bash
moldesk run boltz /absolute/path/pdl1-campaign/jobs/CANDIDATE_ID.yaml --param accelerator=mps --param devices=1 --param diffusion_samples=1 --param write_full_pae=true --param seed=28101 --json
node examples/pdl1-binder-campaign/run.mjs prediction /absolute/path/pdl1-campaign CANDIDATE_ID /absolute/path/prediction-run/run.json
```

Ingest failed prediction records too: the runner retains their reasons. A successful run must match the candidate's exact job, model/adapter versions and effective protocol, and contain every declared sample. Arrays stay in files with recorded hashes; never paste PAE matrices into agent context.

```bash
node examples/pdl1-binder-campaign/run.mjs score /absolute/path/pdl1-campaign
node examples/pdl1-binder-campaign/run.mjs table /absolute/path/pdl1-campaign
node examples/pdl1-binder-campaign/run.mjs decision /absolute/path/pdl1-campaign "Smoke test reviewed: record timing, charges and failures before deciding whether to run pilot."
```

`score` retains failures; it does not silently retry or replace them. Interrupted work verifies retained inputs/results before reuse. A partial `.artifacts` directory without a complete verified score requires review and a separately named retry; file existence alone is never completion. Recovery here is local example bookkeeping, not general process recovery. Run one runner process per campaign directory.

After review, a 20-candidate pilot can use `numReplicates=20`, `batchSize=8`, seed `28002`. The adapter allows `batchSize <= 8`, `numReplicates <= 32` per design. Logical batch size is separate from simultaneous inference size. Review pilot yield/costs before using another declared seed.

For Runpod, use the existing `moldesk run` quote, budget, lifetime, upload-consent and cleanup flow. Every run needs its own approved quote. The updated Boltz manifest requires a matching rebuilt/released worker; old manifest digests must fail. No cloud run is authorized by this example. A planning reserve is not execution authorization or proof of an aggregate billing cap.

## Outputs and measurements

The selected directory holds immutable `campaign.json`, `jobs/`, `scores/`, `state.json`, `decisions.jsonl`, `measurements.json`, and versioned `snapshots/`. Current `candidates.json` is authoritative; CSV and `index.md` link to molecular reports. Counts separately show generated, unique, predicted, fully scored and shortlisted candidates. Duplicates and failures remain rows; missing scores remain null. Equal scores tie-break by candidate ID. Exact deduplication does not establish sequence-family or structural diversity.

Record wall time by phase, inference time, instance/rate, provisioning/install/idle time, storage/transfer bytes (including O(N²) PAE), all failed attempts, quote ceilings, confirmed actual charges and agent/API costs in `measurements.json`. Ingested run records retain duration and compute/cleanup evidence in decisions. Unknown charges stay null; estimates must be labeled. No live timings, pilot yield or cost claim has been established by adding this example.
