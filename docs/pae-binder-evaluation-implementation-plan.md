# Boltz PAE and binder evaluation: implementation plan

Status: implementation prepared for review, uncommitted. Live/release gates remain pending; see
[implementation evidence](pae-binder-evaluation-validation.md). Original plan written 2026-10-27 against
MoleculeDesk 0.0.9, baseline commit `d3dea23`.

## 1. Objective and release boundary

Complete one computational binder-design campaign using the existing Claude
Code/Codex skill and MoleculeDesk execution APIs:

```text
approved target + hotspots
  -> RFD4-Proteina generation
  -> explicit target/binder sequence extraction
  -> Boltz complex prediction + full PAE
  -> ipSAE interface evaluation
  -> reproducible candidate table and shortlist
  -> agent chooses whether to run another bounded batch
```

Deliver four capabilities, in order:

1. Expose and collect existing Boltz PAE and pLDDT outputs.
2. Install a pinned CPU scoring tool and expose typed ipSAE evaluation.
3. Prepare binder prediction inputs and rank candidates without losing lineage.
4. Demonstrate a small PD-L1 campaign with measured costs, timings, and failures.

The agent continues to own planning and adaptive decisions. This release does
not introduce a general workflow scheduler, campaign-wide cloud authorization,
an in-house chat agent, a new design model, or pocket prediction. Existing
per-run cloud quotes, upload consent, and cleanup semantics remain applicable.
The work below does not authorize downloads, cloud spending, or lab submission.

## 2. Current implementation and verified upstream behavior

| Surface | Current behavior | Required change |
| --- | --- | --- |
| `packages/adapters/src/boltz/index.ts` | Params omit PAE export; collection includes structures, confidence, optional affinity. | Add export control and collect matching PAE/pLDDT arrays. |
| `models/boltz/manifest.yaml` | Output declarations mirror that subset. | Declare additive optional array outputs; review adapter version/fingerprint compatibility. |
| `packages/core/src/run-lifecycle.ts` | Hashes collected outputs and writes `run.json`; `--output` copies declared files. | Reuse this path for arrays; exercise export collisions. |
| `packages/core/src/cloud/run.ts` | Downloads verified worker results, then invokes local adapter collection. | Verify arrays survive transfer and enter the final run record. |
| `packages/core/src/tools/usalign.ts` | Pinned, managed tool install with receipt and atomic promotion. | Follow its lifecycle for ipSAE, adding a small isolated Python runtime. |
| `packages/core/src/schemas/{envelope,results}.ts` | Stable version-1 envelopes; result schemas are explicit. | Add an interface-evaluation kind without relaxing existing envelopes. |
| `packages/core/src/analysis/molstar-model.ts` | Parses chains, residue IDs, sequence, trace coordinates, and heavy-atom ownership. | Reuse for eligibility checks and binder preparation. |
| `plugins/moldesk/skills/moldesk/` | Agent instructions and CLI/model/workflow references. | Teach the new evaluation and campaign steps after the CLI exists. |

PAE is a Boltz confidence output, not a second model. ipSAE is a separate
calculation over the prediction and PAE, not another structure predictor.

The two pinned Boltz distributions have different defaults:

| Runtime | Pinned source | PAE control |
| --- | --- | --- |
| Linux/CUDA | `jwohlwend/boltz@cb04aeccdd480fd4db707f0bbafde538397fa2ac` | `--write_full_pae` is a positive Click flag. Function default is false; help text says true, so do not infer behavior from the help prose. |
| Darwin/MPS | `Novel-Therapeutics/boltz-community@401f18150cc7184b7e1bb37239a25035ef6b3a57` | Paired `--write_full_pae/--no_write_full_pae`; explicit default is true. |

Both inspected writers name files using the same record and confidence-ranked
model suffix: structure `.cif`, `confidence_*.json`, `pae_*.npz` with key `pae`,
and `plddt_*.npz` with key `plddt`. A model suffix is a prediction rank, not an
RFD4 candidate ID or a seed. Existing MPS runs may already contain raw PAE files
that MoleculeDesk does not register or export.

The inspected ipSAE script supports Boltz NPZ/CIF, discovers confidence and
pLDDT sidecars by naming convention, and writes files beside its structure
input. Its chain/token parsing and fallback behavior need a controlled wrapper.
Pin a reviewed upstream commit before implementation; a moving `main` URL or
Git blob SHA is not a substitute for a source revision and SHA-256 receipt.

## 3. Phase A / PR 1: expose and preserve Boltz arrays

### A1. Parameter semantics

- Add boolean `write_full_pae` to the adapter's `PARAMS`.
- Resolve its effective default from the installed runtime, alongside
  `accelerator`: Darwin true, Linux false. Preserve existing upstream behavior
  while recording an actual effective value; an explicit user value wins.
- Map true to `--write_full_pae` on both platforms. Map false to
  `--no_write_full_pae` on Darwin and omit the flag on Linux. Do not send a
  negative option to the pinned Linux CLI, which does not declare it.
- Verify the installed CLI behavior with a small probe/test. Reject unsupported
  combinations before inference; do not silently upgrade Boltz or patch it.
- Update dynamic-default tests and `describeModel` expectations. Cloud planning
  must resolve Linux defaults even when its client runs on a Mac.

Proposed user-facing invocation, available only after implementation:

```bash
moldesk run boltz complex.yaml --param write_full_pae=true --json
```

### A2. Output declaration and completeness

Add matching declarations to adapter and model manifest:

```yaml
- id: pae
  glob: "boltz_results_*/predictions/*/pae_*.npz"
  required: false
- id: plddt
  glob: "boltz_results_*/predictions/*/plddt_*.npz"
  required: false
```

Keep the manifest entries optional for old and PAE-disabled runs. In
`collectOutputs`, when effective `write_full_pae` is true, additionally require
one matching PAE for every collected prediction structure. A single PAE match
for an entire multi-sample run is insufficient. Missing requested arrays fail
the run with `MISSING_REQUIRED_OUTPUT`, even after process exit zero.

Collect actual arrays found even when their generation was not requested by
MoleculeDesk. Do not infer success from confidence-summary PAE averages.
Continue rejecting symlinks through the existing output collector.

### A3. Shared artifact resolver

Add `packages/core/src/analysis/boltz-artifacts.ts` with a typed resolver:

```ts
interface BoltzPredictionArtifacts {
  recordId: string;
  predictionRank: number;
  structure: HashedFile;
  confidence: HashedFile;
  pae?: HashedFile;
  plddt?: HashedFile;
}
// HashedFile = { path: string; sha256: string; sizeBytes: number }.
// resolveBoltzPredictionArtifacts(record, selector) -> one exact artifact set.
```

Resolve within the same prediction directory and exact filename suffix. Do not
pair files by glob order, first match, or rank alone across records. Reject
ambiguous selectors, duplicate matches, missing sidecars, and changed hashes.
Use the same resolver in evaluation and campaign preparation.

Leave `RunRecord.schemaVersion` at 1 for additive output IDs. Do not modify old
records. Evaluate the installation-fingerprint impact of an adapter-version
bump; describe any required reinstall rather than silently invalidating it.

### A4. Local/cloud export and worker compatibility

- Exercise `run.json` hashing and `--output` copying for binary NPZ files.
- The existing export flattens basenames. Preserve its collision refusal; do
  not silently overwrite same-named outputs from different records.
- Inspect worker inventory creation in `cloud/worker/server.ts` and download
  validation in runtime/backend code; test arrays through the full transfer.
- Rebuild the worker with the updated adapter and manifest. Refresh the
  versioned worker URL/checksum through `scripts/worker-release.mjs` at release
  time. An older worker must not be used with the changed manifest digest.
- Include array bytes in transfer/storage measurements. PAE storage is O(N²)
  per sample; do not put matrices into normal CLI JSON or agent context.

Acceptance: local MPS and Linux/CUDA runs expose exact structure/PAE pairings;
one Runpod result round-trips byte-identical arrays, with recorded hashes.

## 4. Phase B / PR 2: managed ipSAE and interface scoring

### B1. Tool packaging and installation

Add `packages/core/src/tools/ipsae.ts` using the managed-tool conventions:

- Select and record an exact upstream commit, download SHA-256, license notice,
  scorer identity, and source URL. Preserve the MIT attribution.
- Install under `paths.tools/ipsae/<version-or-revision>/`, with a staged
  `.venv`, source, lock/receipt, license, and deterministic self-test fixture.
- Use managed Python/uv infrastructure, with pinned/hash-verified NumPy wheels
  for Darwin ARM64 and Linux x64. Resolve real dependency hashes; invent none.
- Add a narrow helper if needed: current `preparePythonEnvironment` expects a
  model source checkout and is not automatically suitable for this small tool.
- Use install locking, atomic promote/rollback, hash verification, reinstall,
  and uninstall. Avoid a broad tool registry refactor for two tools.
- Scoring must work on CPU without installing Boltz locally. A Mac can score
  artifacts downloaded from a cloud prediction. No global Python/pip fallback.
- Install may use the network after the existing confirmation flow; evaluation
  itself must run offline and must never implicitly install missing tools.

Wire `moldesk install ipsae`, `uninstall ipsae`, and installed-tool status into
the existing CLI/tool paths, including `doctor`. Keep managed tools distinct
from scientific models in discovery. Add package files needed by the published
core distribution and verify them with `pack:verify`.

### B2. Evaluation boundary and wrapper

Initial support: one Boltz mmCIF model containing exactly two standard protein
chains with explicit target/binder roles, plus its paired NPZ and confidence
JSON. Both chains must have usable coordinates. Reject mixed ligand/nucleic
acid jobs, modified-residue tokenization, ambiguous chain IDs, missing trace
atoms, and multi-model input until each is supported by tested mapping rules.
Other Boltz runs remain supported; this restriction applies to scoring only.

Before calling upstream:

1. Verify hashes and parse structure identity. Select chains by author IDs;
   retain author/label IDs and reject ambiguous mappings. Never guess the
   binder from chain length or choose the first two chains.
2. Verify PAE is a numeric, square, finite, nonnegative matrix with key `pae`;
   preserve directionality rather than symmetrizing it. Validate dimensions
   against the exact Boltz token order, not just total residue count.
3. Load NPZ with pickle disabled. Reject object arrays, unexpected members,
   oversized headers/archives, and oversized decompressed arrays before load.
   Start with a documented scorer limit of 2,048 protein tokens; test memory
   bounds and choose compressed/uncompressed byte caps accordingly.
4. Validate optional pLDDT length, confidence JSON chain indexing, input chain
   order, and the association with the same prediction. A shape match alone
   does not establish artifact identity.
5. Snapshot inputs into a private scratch directory with controlled filenames
   (`prediction.cif`, `pae_prediction.npz`, etc.). Upstream filename replacement
   must not traverse arbitrary user path strings or write beside original data.

Run the pinned Python scorer using argv, timeout, AbortSignal, bounded logs,
and a private cwd. Parse named output columns, not fixed character positions.
Require valid expected rows even when upstream exits zero; preserve raw output
and diagnostics for auditing. Never execute the generated PyMOL script.

Initially expose only tested ipSAE fields. If upstream substitutes zeros for
missing ancillary inputs, do not publish those as genuine pLDDT/pDockQ values.
Any minimal compatibility patch must have a recorded patch hash and numerical
parity tests. Do not replace the scientific calculation with an unverified TS
reimplementation.

### B3. CLI and core API

Proposed public surface; names can be adjusted once, before release:

```bash
moldesk score interface prediction.cif \
  --pae pae_prediction.npz \
  --confidence confidence_prediction.json \
  --plddt plddt_prediction.npz \
  --target-chain A --binder-chain B \
  --pae-cutoff 15 --distance-cutoff 15 \
  --output interface.json --json

moldesk schema moldesk.interface
```

`--plddt` is optional for ipSAE-only evaluation; absent data must remain absent
in ancillary results. Require positive finite cutoffs; start with integer
angstrom values compatible with upstream filename formatting. The default
15/15 settings are an explicit recipe choice, not a biological pass threshold.
Output files are created atomically and must not already exist.

Core entry point: `scoreProteinInterface(options)` in
`packages/core/src/analysis/interface.ts`; export it from `core/src/index.ts`.
Register a thin `apps/cli/src/commands/score.ts`. Use existing report error
formatting and explicit error/exit mappings; stdout is exactly one envelope
under `--json`, while progress/diagnostics go to stderr.

Add `moldesk.interface` to `ENVELOPE_KINDS` and `RESULT_SCHEMAS`. Keep the shared
envelope version at 1 and put multi-file identity in `result.inputs`, since
top-level `input` currently describes a single structure only. Proposed result:

```ts
interface InterfaceScoreResult {
  inputs: {
    structure: HashedFile;
    pae: HashedFile;
    confidence: HashedFile;
    plddt?: HashedFile;
  };
  chains: {
    target: { authId: string; labelId: string };
    binder: { authId: string; labelId: string };
  };
  settings: { paeCutoffAngstrom: number; distanceCutoffAngstrom: number };
  tokenMapping: { mode: "boltz-two-protein-chains"; count: number; sha256: string };
  scores: {
    ipsaeTargetToBinder: number;
    ipsaeBinderToTarget: number;
    ipsaeMax: number;
  };
  scorer: { name: "ipsae"; revision: string; sourceSha256: string; patchSha256?: string };
  artifacts: HashedFile[];
}
```

Use the upstream `ipSAE` column and its two directional rows / `max` row.
Do not substitute `ipSAE_d0chn` or `ipSAE_d0dom`. Record aggregation explicitly
in any ranking policy. Scores assess modeled interfaces, not measured affinity.

### B4. Error contract

Add tested mappings for `INVALID_INTERFACE_ARGS`, `INVALID_PAE`,
`PAE_STRUCTURE_MISMATCH`, `BOLTZ_ARTIFACT_MISMATCH`,
`UNSUPPORTED_INTERFACE_INPUT`, `IPSAE_NOT_INSTALLED`, `IPSAE_DAMAGED`,
`IPSAE_EXECUTION_FAILED`, `IPSAE_NO_RESULT`, and `INTERFACE_CANCELLED`.
Input/usage errors map to exit 2, cancellation to 8, unexpected internal errors
to 10. A scientifically low but valid score is success, not execution failure.

## 5. Phase C / PR 3: preparation, ranking, and agent recipe

### C1. Prepare predictions from generated designs

Add focused core helpers under `packages/core/src/binders/`, exercised by the
example runner. A separate preparation CLI is optional after a real need is
shown; no general workflow engine is required.

- Accept a generation `RunRecord` and explicit target/binder chain assignments.
- Select only `generated_structures` from RFD4 outputs, not its input copies.
- Assign a stable candidate ID from source run ID plus design/replicate key;
  separately hash the binder sequence for exact deduplication across batches.
- Use parsed CIF data and validated spec roles; no regex-only CIF parser or
  heuristic that the shorter chain is always the binder.
- Freeze the intended target sequence from the approved target/crop mapping.
  Verify it against the generated target and preserve residue-number mapping.
  Neither `sequence` nor `fullSequence` is universally correct: incomplete
  structures and intentional domain crops must be resolved explicitly.
- Extract the binder sequence, require supported residues, and write one Boltz
  YAML per unique candidate with explicit chain IDs and a source mapping JSON.
- Initial recipe uses `msa: empty` to avoid an undeclared external MSA request.
  Treat any later MSA-backed evaluation as a separately recorded protocol.
- Reuse original inputs unchanged. Validate YAML before paid inference.

### C2. Rank without hiding failures or changing criteria

Add a pure candidate-table/ranking helper and versioned campaign manifest.
Use JSON as the authoritative representation; emit CSV and a small index/report
linking existing molecular reports. Do not build a new visualization system.

Required records include candidate ID, source generation run/replicate, binder
sequence/hash, target hash, source chain mapping, prediction run/record/rank,
artifact hashes, evaluation file, scorer/settings, metrics, status, and reasons.
Keep thresholds and ranking policy in the manifest before generation starts.

- Report `generated`, `unique`, `predicted`, `scored`, and `shortlisted` separately.
- Keep duplicates and execution failures as visible rows with parent links.
- Rank only comparable evaluations: same target/crop, chain roles, scoring
  revision, cutoff settings, and prediction protocol. Partition incompatible
  rows or reject the comparison; never silently combine them.
- Keep all samples. A declared per-candidate aggregation rule must select
  across multiple prediction samples; do not silently cherry-pick the best.
- Declare `ipsaeMax` (or another tested field) as the ranking metric, tie-break
  deterministically by candidate ID, and record every rejection reason.
- Exact sequence deduplication is the initial diversity guarantee. Do not claim
  sequence-family/structural diversity without an implemented clustering rule.
- Missing scores remain null/failed, not zero. Zero qualified candidates is a
  valid campaign outcome. An agent may propose new criteria only as a new
  recorded policy revision; it cannot rewrite the original experiment.
- If geometry triage is added, report distance/contact conventions explicitly.
  A heuristic clash flag is not a validated binding or developability score.

### C3. Skill and campaign example

Add `examples/pdl1-binder-campaign/README.md`, an explicit config, and a small
runner importing the core helpers. Keep the example agent-driven: tools expose
state and evidence; Claude/Codex decides whether to start the next batch.

First live sequence: 2-candidate smoke test -> 20-candidate pilot -> optional
additional batches after reviewing measured throughput and acceptance yield.
Use distinct recorded seeds. Keep RFD4 `batchSize <= 8` and `numReplicates <= 32`
per spec entry, as the current adapter requires. Logical batch size is separate
from simultaneous GPU inference size. Reuse validated PD-L1 hotspot input and
attribution from `examples/rfd4-proteina/pdl1-binder/`.

Write `campaign.json`, `candidates.json`, `candidates.csv`, `decisions.jsonl`,
input jobs, scoring outputs, and report links under a user-selected directory.
On restart, inspect existing run records and verify hashes before reusing any
completed step; never infer completion solely from a file's existence. This
example recovery logic is not a promise of general job/process recovery.

Update the skill entry point and `references/{cli,models,workflows}.md`; cloud
reference changes are required if flags/output guidance changes there. Bump
both plugin manifest versions and run the skill-command checker. New commands
must exist before examples advertise them as runnable.

## 6. Validation and release gates

### Automated checks

| Layer | Required evidence |
| --- | --- |
| Boltz params | Linux/MPS omitted/true/false behavior, invalid values, effective defaults, cloud planning on a Mac. |
| Artifact collection | Multiple records/samples, exact sidecar pairing, one missing PAE among many, symlinks, export collisions. |
| Binary handling | NPZ key/type/shape checks, non-finite/negative data, asymmetric matrix, object arrays, decompression/memory limits. |
| Chain/token mapping | Reversed order, author/label differences, duplicate sequences, ambiguous IDs, unsupported tokens, multi-model rejection. |
| Tool lifecycle | Verified download/receipt, offline scoring, failed install rollback, damaged source/env, cancellation and timeout. |
| Scientific parity | Real small two-chain Boltz fixture; compare both directional scores and max against the pinned upstream scorer. |
| Schemas/CLI | Real outputs pass published schemas; stdout JSON is clean; errors/exit codes and no-overwrite behavior match contracts. |
| Candidate pipeline | Exact dedup, deterministic ties, protocol mismatch, failed candidates, partial restart, zero passing candidates. |
| Cloud | Binary inventory/download/hash verification, old-worker mismatch, requested PAE missing, transfer interruption. |

Golden fixture provenance must record source rights, job, seed, model revision,
and hashes. Store bounded fixtures only. Set numerical tolerances from observed
CPU/platform behavior; document them rather than asserting bitwise float parity.
Test scientific mapping on genuine data, not only synthetic matrices.

Run targeted tests while implementing, then required workspace gates:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm pack:verify
node scripts/check-skill-commands.mjs
```

At release, additionally run worker checksum and release-version checks for the
actual chosen tag. Do not invent a release URL or checksum before producing it.

### Live gates, separate from ordinary CI

- Darwin/MPS: one two-chain complex with export enabled and one disabled.
- Linux/CUDA: the same protocol; valid PAE/token mapping and scoring.
- Runpod: download, score locally without Boltz installed, verify cleanup and
  accounting, and retain raw artifacts. A live smoke test requires an approved
  quote; do not run the full campaign as a side effect of testing.
- Campaign: start with the smoke test, then complete the bounded pilot. Report
  zero hits honestly if nothing passes; threshold relaxation is not a release
  criterion. A large campaign requires a new decision based on pilot costs.

## 7. Publication and budget measurements

Use a title such as "A Muni-inspired binder-design campaign with MoleculeDesk:
$X, Y hours, Z shortlisted candidates" only after measuring the run.
RFD4-Proteina is not the Proteina-Complexa implementation used by Muni; this
campaign does not reproduce their search algorithms or establish equal quality.

Record wall time by phase, inference time when available, instance type/rate,
provisioning/install/idle time, storage, transfers, all failed attempts, agent/API
costs, quote ceilings, and confirmed actual charges. Label estimates and unknown
charges; `--max-budget` is not proof of a campaign-wide billing hard cap.

The discussed $100 reserve is a planning allowance, not execution authorization
or a promised bill. This work excludes wet-lab validation. Computational scores
and shortlist counts cannot be reported as confirmed binders or measured KD.

## 8. First implementation checklist

- [x] Pin/audit ipSAE revision/dependencies; confirm installed MPS flags (CUDA live gate remains).
- [x] Add PAE flag, PAE/pLDDT outputs, exact pairing, and regression tests.
- [x] Prove automated binary worker transfer and manifest compatibility; build the local worker bundle.
- [x] Add managed ipSAE install and deterministic CPU self-test (real pinned installs remain a release gate).
- [x] Add validated interface API, JSON schema, CLI, and synthetic parity fixtures.
- [ ] Validate genuine two-chain Boltz parity with fixture provenance.
- [x] Add binder input preparation, candidate records, and ranking helper.
- [x] Update the agent skill and documented PD-L1 campaign recipe.
- [ ] Complete approved live smoke tests; measure a pilot before scaling.

## References

- [Pinned Linux Boltz CLI](https://github.com/jwohlwend/boltz/blob/cb04aeccdd480fd4db707f0bbafde538397fa2ac/src/boltz/main.py)
- [Pinned Linux writer](https://github.com/jwohlwend/boltz/blob/cb04aeccdd480fd4db707f0bbafde538397fa2ac/src/boltz/data/write/writer.py)
- [Pinned MPS CLI](https://github.com/Novel-Therapeutics/boltz-community/blob/401f18150cc7184b7e1bb37239a25035ef6b3a57/src/boltz/main.py)
- [Pinned MPS writer](https://github.com/Novel-Therapeutics/boltz-community/blob/401f18150cc7184b7e1bb37239a25035ef6b3a57/src/boltz/data/write/writer.py)
- [DunbrackLab ipSAE](https://github.com/DunbrackLab/IPSAE) (inspection reference; implementation must pin a commit)
- [Muni campaign methods](https://www.muni.bio/research/muni-makeover-cli-autoresearch)
- [Muni experimental follow-up](https://www.muni.bio/research/closing-the-autoresearch-loop)
- [Existing PD-L1 example](../examples/rfd4-proteina/pdl1-binder/README.md)
- [Analysis JSON contract](analysis-json.md)
- [Cloud execution contract](cloud-execution.md)
