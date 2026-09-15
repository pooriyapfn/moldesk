# Installation

## npm (recommended)

```bash
npm install -g @moldesk/cli
moldesk --version
moldesk doctor
```

## Docker

```bash
docker run --rm moldesk/moldesk:latest doctor
```

## From source

```bash
git clone https://github.com/pooriyapfn/moldesk.git
cd moldesk
pnpm install
pnpm --filter @moldesk/cli dev -- doctor
```

## Supported platforms

v0.1 targets macOS Apple Silicon (`darwin-arm64`) and Linux x86-64
(`linux-x64`). `moldesk doctor` reports your platform and what's usable on
it; a model's own hardware requirements (below) can further restrict what's
actually installable on a given machine.

## Installing models

ProteinMPNN, LigandMPNN, and Boltz-2 have beta installation adapters:

```bash
moldesk install proteinmpnn       # review plan, then confirm
moldesk install ligandmpnn --yes  # non-interactive
moldesk list --installed
moldesk install proteinmpnn --reinstall --yes
moldesk uninstall proteinmpnn --yes
```

Each Python model gets a pinned source checkout and its own uv-managed virtual
environment. Checkpoints use a resumable, content-addressed cache and are
verified before use. Installation is staged and promoted atomically; failed
reinstalls leave the prior installation intact.

## Cache and state layout

State defaults to `~/.moldesk`; set `MOLDESK_HOME` to relocate everything
below it:

- `models/` — installed model environments and their checkpoints, one
  directory per model/version/runtime-fingerprint.
- `cache/downloads/` and `cache/objects/` — the shared, content-addressed
  download cache (checksummed assets are deduplicated across models and
  reinstalls; this is what `uninstall` deliberately leaves behind).
- `runs/` — one directory per `moldesk run` invocation, holding the input
  snapshot, output, logs, and `run.json` provenance record.
- `state/` — the installed-models index and per-installation locks.
- `tools/` — the managed `uv` and Python interpreters, shared across models.

Disk usage is dominated by model checkpoints — ProteinMPNN's is a few MB,
LigandMPNN's tens of MB, Boltz-2's checkpoints are multi-GB (~6.2 GB across
its two checkpoints and molecule dictionary). `moldesk install` always
prints an estimated download/disk size before prompting.

## Uninstall semantics

`moldesk uninstall <model>` removes only that model's own installation
directory under `models/` (its venv, source checkout, and checkpoint
copies). It does **not** remove:

- the shared download cache under `cache/` (so a reinstall, or installing
  another model that happens to need the same checksummed asset, doesn't
  re-download it);
- run history under `runs/` (past `moldesk run` results and their
  provenance records survive an uninstall of the model that produced them).

## Model licenses

All three current models are MIT-licensed upstream (see each model's own
`README.md` under `models/<name>/` for the exact upstream repository,
pinned revision, and any checkpoint-specific licensing notes):
`models/proteinmpnn/README.md`, `models/ligandmpnn/README.md`,
`models/boltz/README.md`.

## Expected hardware

- **ProteinMPNN, LigandMPNN**: CPU is sufficient; both install and run
  correctly on Apple Silicon without a GPU.
- **Boltz-2**: an NVIDIA GPU is **required** for v0.1, not just recommended.
  The pinned upstream revision has a confirmed CPU-inference correctness bug
  (produces distorted structures — see `models/boltz/README.md` for the
  upstream issue links) that isn't fixed in any released version yet. A
  CPU-only machine will report Boltz-2 as unsupported in `moldesk list`.

## Troubleshooting

`moldesk run` uses a stable exit-code contract so scripts can branch on
failure type without parsing text:

| exit | meaning | typical fix |
|---|---|---|
| 2 | invalid CLI usage, input, or `--param` value | check the input file extension and `--param key=value` syntax |
| 3 | unknown or unavailable model | run `moldesk list` for the correct name |
| 4 | incompatible machine/runtime | check `moldesk doctor`; e.g. Boltz-2 needs a GPU |
| 5 | model not installed | run `moldesk install <model>` first |
| 6 | installation/download failure | check network access and disk space, then retry |
| 7 | model execution failed or produced no output | check `stdout.log`/`stderr.log` in the printed run directory |
| 8 | run was cancelled (Ctrl-C) | re-run if needed; a partial run leaves no false "succeeded" state |
| 10 | unexpected internal error | check the printed message; consider filing an issue |

Every error MoleculeDesk raises includes a remediation hint alongside the
message — read the full CLI output, not just the exit code.
