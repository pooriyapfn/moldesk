# `moldesk` command reference

Every command accepts `--json`. Without a terminal (as when an agent runs it), commands that need confirmation stop and say so instead of prompting.

## `moldesk doctor [--json]`

Reports platform, arch, CPU, memory, disk, Apple Silicon, host Python, Docker, and NVIDIA/CUDA. JSON keys: `platform`, `arch`, `cpu`, `memory`, `disk`, `appleSilicon`, `hostPython`, `docker`, `nvidia`.

## `moldesk list [--installed] [--runtime python|docker] [--json]`

Lists every model with category, status (`available`, `beta`, `planned`), and compatibility with this machine. A `*` before the name means installed. With `--json`, each entry has `manifest` and `compatibility` (`status`, `selectedRuntime`, `reasons[]` with `code`, `message`, `remediation`).

## `moldesk install <model> [--yes] [--reinstall] [--runtime python|docker] [--json]`

Shows a plan (steps, download size, disk size, target folder), then installs. Each Python model gets a pinned source checkout and its own `uv` environment. Checkpoints are SHA-256 verified and cached. Installs are staged and promoted atomically.

- Large, unknown-size, or destructive (`--reinstall`) installs need `--yes` when there is no terminal. Without it, the JSON result has `status: "confirmation-required"` plus `estimatedDownloadBytes` and `estimatedDiskBytes`.
- `--reinstall` replaces an existing install. The old one stays if the new one fails.
- `--runtime` picks a runtime explicitly. There is no silent fallback.

## `moldesk uninstall <model> [--yes] [--all] [--runtime python|docker] [--json]`

Removes the model's environment. Shared downloads stay in the cache for reuse. Ask the user first.

## `moldesk run <model> <input> [options]`

| Option | Meaning |
| --- | --- |
| `--output <dir>` | Also copy declared outputs to this folder |
| `--param key=value` | Model parameter; repeat for more. See [models.md](models.md) |
| `--no-visualize` | Skip the offline 3D report |
| `--runtime python\|docker` | Choose a runtime explicitly |
| `--json` | Machine-readable result |
| `--compute local\|runpod` | Where to run (default `local`). See [cloud-runpod.md](cloud-runpod.md) |

Each run creates a run directory under `~/.moldesk/runs/` holding a snapshot of the inputs, parameters, logs, outputs, and `run.json` with SHA-256 checksums. Text output ends with `Run directory: <path>`.

`--json` result: `status` (`succeeded`, `failed`, `cancelled`), and `record` with `outputs[]` (`id`, `path`), `artifacts[]` (the HTML report), `warnings[]`, `error`, and `command.cwd` (the run directory). On an error before the run starts: `{ "status": "error", "message", "code" }`.

Exit codes: `0` success, `2` usage, `3` unknown model, `4` unsupported, `5` not installed, `7` run failed, `8` cancelled, `10` internal, `11` credential, `12` provider, `13` cloud cleanup pending, `14` consent or safety refusal.

## `moldesk view <file> [--output <file>] [--open] [--json]`

Builds an offline, interactive 3D report (Mol*) for any `.pdb` or `.cif`/`.mmcif` file. Useful for structures from RCSB or from earlier runs. The report is one HTML file that works without a network connection.

## `moldesk visualizer update <report> [--output <file>] [--open] [--yes] [--json]`

Replaces the viewer inside an older report with the one installed now.

## `moldesk cloud ...`

`connect <provider>`, `disconnect <provider>`, `status`, `resources`, `recover <run-id>`, `cache list`, `cache delete <model>`. See [cloud-runpod.md](cloud-runpod.md).
