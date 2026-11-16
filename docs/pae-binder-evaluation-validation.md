# PAE / binder evaluation implementation evidence

Implementation prepared 2026-10-29 (development checks began 2026-10-28). Changes remain uncommitted for review. This records development evidence, not completion of the live campaign/release gates in the implementation plan.

## Existing paths reused

Boltz still uses `collectGlobOutputs`, `prepareRunParams`, `collectRunOutputs`, worker inventories/download validation and `finalizeRun`. NPZ files are ordinary hashed binary outputs; no matrices enter envelopes. Exact prediction resolution is shared by scoring (when a run record is supplied) and campaign ingestion. Atomic JSON publication uses the existing `writeFileExclusive` helper. Structure identities and sequences use Mol*, and generation specs reuse the adapter's validated reader/companion resolver. The approved spec, hotspot settings and companion bytes are frozen before generation. No scheduler or scientific score reimplementation was added.

The managed ipSAE installer follows US-align's locking/staging/promotion/rollback conventions. A narrow source-independent managed-Python helper reuses existing uv/environment construction. Normal evaluation uses only the installed tool, offline, with no global Python fallback. The example runner makes no inference or cloud calls.

## Pins and compatibility

- ipSAE source revision: `6174cf9e71cb1bd660cc805856a18c4871a6dec3`; downloaded source SHA-256: `10cf9b08c68c91e06cb28526cf2026f47a3980c9048fd3226d13e3304eaf1c27`. MIT attribution ships in `resources/ipsae/LICENSE` and the installation.
- Managed runtime: CPython 3.11.13, NumPy 2.2.6; cp311 Darwin ARM64 and Linux x64 wheel hashes come from [published PyPI release metadata](https://pypi.org/pypi/numpy/2.2.6/json). Installation uses `--require-hashes --no-deps --only-binary :all:`. Source, requirements, wrapper, environment files and interpreter hashes enter the receipt.
- Boltz adapter version changes from 0.2.0 to 0.3.0. The Python runtime/source/dependency specifications do not change, so the runtime fingerprint does not change and existing pinned installations do not require a reinstall for these additive outputs/parameters. Existing run records stay version 1 and are never rewritten. Reinstall only to repair a damaged/unsupported installation through the normal flow.
- The local installed MPS Click metadata was probed: positive option `--write_full_pae`, negative option `--no_write_full_pae`, default `True`. Linux's positive-only/false behavior follows the pinned source and is covered by command/default tests; a live CUDA probe remains pending.
- The manifest digest changes. Old workers reject it with `WORKER_MANIFEST_MISMATCH`; no published worker URL/checksum was invented or changed. A current local worker bundle builds successfully. Release must publish and validate a matching worker through `scripts/worker-release.mjs` before cloud use. The release checksum check against the old published bundle is expected to differ until that release step.

## Development checks

Workspace build, typecheck, lint, tests, package verification and skill-command checks pass. Package verification checks the actual packed CLI/schema and Python resources from an unrelated directory. Existing loopback HTTP worker tests require normal local socket permissions; sandbox-only runs refuse binding and were rerun successfully outside the sandbox.

Added coverage includes platform PAE defaults/flags, each requested PAE, exact selectors/sidecars, changed hashes and symlinks, binary worker inventory/download/hash/run-record/export round trips, collision refusal, chain/token mapping, schema samples and mutations, CLI JSON/errors, tool checksum/receipt/damage/rollback/idempotence, bounded process output/cancellation, and candidate deduplication/ranking/failures/restart checks.

The NPZ CPU tests reject wrong members, dimensions, object dtype, negative/NaN/infinite values, oversized headers/dimensions, excessive directory entries and decompressed sizes, and invalid pLDDT. Limits: 2,048 standard protein tokens; 34 MiB archive/member, 4 KiB NPY header and 4 KiB ZIP directory. Metadata bounds are checked before ZIP/NumPy allocation; loading disables pickle. PAE directionality is preserved.

Offline CPU validation and synthetic upstream parity were additionally run using an existing managed Python/NumPy 2.4.6 environment without installing anything. Both directional scores and max matched the pinned source (0.5 / 0.2 / 0.5); comparison tolerance is 0.000002, allowing two units in the upstream table's sixth decimal. These checks do not establish parity on a genuine Boltz complex or validate the new pinned 2.2.6 installation on both platforms.

A synthetic 2,048-token, two-chain CPU stress test of the pinned scorer measured 673,873,920 bytes maximum resident set size and 2.67 seconds on this Mac with NumPy 2.4.6. This is a development measurement on uniform synthetic PAE/coordinates, not a prediction throughput estimate or a guaranteed maximum across platforms/data. Downstream scoring allocates several quadratic arrays beyond the input's 32 MiB maximum; plan at least 1 GiB available memory and remeasure the pinned runtime on each release platform.

Optional offline checks (existing Python/source only; no auto-install):

```bash
MOLDESK_TEST_IPSAE_PYTHON=/absolute/path/to/python \
MOLDESK_TEST_IPSAE_SOURCE=/absolute/path/to/pinned/ipsae.py \
pnpm --filter @moldesk/core exec vitest run src/analysis/npz.test.ts src/analysis/interface.parity.test.ts
```

`MOLDESK_BOLTZ_FIXTURE=/absolute/path/to/fixture` additionally enables genuine-data parity. It needs the original successful `run.json` with valid artifact paths/hashes plus `provenance.json` recording source rights (`sourceLicense`), job, seed, model revision, and target/binder author chain roles. No genuine two-chain fixture is bundled; all in-repo interface fixtures are explicitly synthetic.

## Remaining release/live gates

1. Install/self-test the pinned managed CPU tool on Darwin ARM64 and Linux x64; verify the real dependency environment and wheel/platform behavior.
2. Obtain a bounded genuine two-chain Boltz fixture with provenance, run directional/max parity and validate token mapping against the original prediction job.
3. Run enabled/disabled PAE predictions on MPS and CUDA, then one approved Runpod round trip with a matching published worker, local scoring without Boltz, accounting and cleanup evidence.
4. Register the PD-L1 campaign policy, obtain approvals, complete the 2-design smoke test, review measurements, and decide whether to run the 20-design pilot. No new live inference, downloads of model assets, cloud spending, pilot yield or confirmed binders are claimed here.

The example's `measurements.json` intentionally starts with unknown actual charges/API cost as null. Threshold relaxation is not a gate, and zero shortlisted candidates remains valid.
