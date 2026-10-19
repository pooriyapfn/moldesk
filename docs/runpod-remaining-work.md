# Runpod cloud execution: remaining work

Status on 2026-10-19. Boltz-2, ProteinMPNN, DiffDock-L and OpenDDE have a `cloud` block and passed a live
`ephemeral` run. Cloud runs stay disabled for end users until a release records a worker bundle (see
[cloud-execution.md](./cloud-execution.md)). Evidence is in [runpod-spike-findings.md](./runpod-spike-findings.md).

## Before the release

| # | Job | Why |
|---|---|---|
| 1 | Choose the version and bump it | The release workflow checks the tag against the recorded bundle |
| 2 | Run `node scripts/worker-release.mjs update --tag vX.Y.Z` as the **last** change, then commit | Any later edit to worker code or a model manifest (a comment counts) changes the bundle checksum and fails CI |
| 3 | Run DiffDock-L once more with the final bundle | Its container disk was cut from 40 GB to 25 GB after the only live pass; the measured growth was 12.5 GB |
| 4 | Tag and push the tag | The release workflow builds `worker.tar`, attaches it to the GitHub Release and verifies it before publishing to npm |
| 5 | After publishing, install the released CLI and run one cheap model (for example ProteinMPNN) with no `MOLDESK_WORKER_BUNDLE_*` variables | Proves the CLI downloads and verifies the published bundle; check Pods and volumes are empty afterwards |
| 6 | Publish the post ([runpod-cloud-execution-post.md](./runpod-cloud-execution-post.md)) and the website guide | They state that four models are enabled |

## After every later release

1. Always run `node scripts/worker-release.mjs update --tag <next tag>` before tagging, even when nothing
   changed: the release workflow requires the recorded URL to be that tag's own release asset. No upload by
   hand is needed; the workflow builds and attaches `worker.tar`.
2. Once a bundle is recorded, a pull request that touches the worker code (`packages/core`) or any
   `models/*/manifest.yaml` (a comment counts) fails the CI `check` until the recorded checksum is refreshed,
   so refresh it in the same pull request with the planned next tag.
3. Re-run one live smoke test per model whose manifest or adapter changed.

## Known issues

- **Proxy 404.** Runpod's proxy often returns a transient 404 right after a Pod reports healthy (5 of 7
  automatic-choice attempts on ProteinMPNN and DiffDock-L). The run fails, cleanup is confirmed, and running
  again works. A bounded retry on upload and start calls was proposed and set aside.
- **No 3D report for cloud DiffDock-L runs** (`VISUALIZATION_RECEPTOR_MISSING`: the receptor is not staged locally).
- **Adapters assume a local runtime when collecting results.** OpenDDE's PDB copy is skipped in cloud runs as a
  fix for one adapter; a general post-run step on the worker would remove the assumption.
- **Worker logs are noisy and errors hide the cause.** About 1,600 `[assets] Downloading` lines per run, and a
  failed download shows `fetch failed` without the URL.
- **Boltz-2 has no GPU allow-list.** AMD (MI300X, MI350X) and consumer Blackwell cards pass the memory check
  and could be picked if the budget allows.
- **`persistent` caching is experimental.** The cold Boltz-2 run took about 43 min on a standard volume.
- **A timing-sensitive test** (`server.test.ts`, "gives up on a download that keeps stalling") can fail under
  a full parallel `pnpm -r test`.

## Not verified

- Actual charges after terminate (a billing audit), and the real container-disk and network-volume rates.
- Sizes for realistic inputs. GPU memory figures come from a 46-residue protein (ProteinMPNN), one small
  complex (DiffDock-L) and a 9-residue chain (OpenDDE), so they are floors.
- GPUs that were not run: every listed GPU except the A40 (DiffDock-L), the A40 and RTX A5000 (ProteinMPNN)
  and the A40 and RTX 3090 (OpenDDE).
- The 25 GB (DiffDock-L) and 32 GB (OpenDDE) container disks as limits.
- OpenDDE: a local `moldesk install opendde` on Linux, the no-GPU refusal path, and a job that references
  ligand files.
- DiffDock-L: the no-GPU refusal path.
- Behavior of the Pod-scoped key after expiry, and large proxy transfers (unit-tested only).

## Later releases

- **BindCraft2.** Needs result validation without a local runtime (its `collectOutputs` runs the local
  Python), a cost-bounded live run, and documentation that limits cloud use to the user's own Runpod account.
  Its license forbids offering BindCraft2 as a hosted service, so MoleculeDesk must not host it; re-read
  [models/bindcraft2/README.md](../models/bindcraft2/README.md) before writing any cloud wording.
- **LigandMPNN.** Blocked by its weights host (`files.ipd.uw.edu`), which timed out from a Pod and from a
  laptop. Retry later, or mirror the weights with a pinned checksum.
