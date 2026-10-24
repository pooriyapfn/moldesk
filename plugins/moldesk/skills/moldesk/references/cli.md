# `moldesk` command reference

Every command accepts `--json` (`schema` always prints JSON). Without a terminal (as when an agent runs it), commands that need confirmation stop and say so instead of prompting.

The structure commands (`fetch`, `analyze`, `inspect`, `compare`, `describe`) print one envelope on stdout and keep logs on stderr: `schemaVersion` (1), `kind`, `status` (`ok`), `input` (absent for `fetch`, `compare`, `describe`), `result`, `warnings[]` (`code`, `message`) and `provenance` (`moldeskVersion`, optional `tool`). Errors are `{ "status": "error", "code", "message", "remediation", "details"? }`. `moldesk schema <kind>` prints the JSON Schema. Exit codes for these commands: `0` ok, `2` invalid input or usage (including a missing tool), `3` unknown model (`describe`), `8` cancelled (`fetch`), `10` internal or upstream failure.

## `moldesk doctor [--json]`

Reports platform, arch, CPU, memory, disk, Apple Silicon, host Python, Docker, and NVIDIA/CUDA. JSON keys: `platform`, `arch`, `cpu`, `memory`, `disk`, `appleSilicon`, `hostPython`, `docker`, `nvidia`.

## `moldesk list [--installed] [--runtime python|docker] [--json]`

Lists every model with category, status (`available`, `beta`, `planned`), and compatibility with this machine. A `*` before the name means installed. With `--json`, each entry has `manifest` and `compatibility` (`status`, `selectedRuntime`, `reasons[]` with `code`, `message`, `remediation`).

## `moldesk install <model> [--yes] [--reinstall] [--runtime python|docker] [--json]`

Shows a plan (steps, download size, disk size, target folder), then installs. Each Python model gets a pinned source checkout and its own `uv` environment. Checkpoints are SHA-256 verified and cached. Installs are staged and promoted atomically.

- Large, unknown-size, or destructive (`--reinstall`) installs need `--yes` when there is no terminal. Without it, the JSON result has `status: "confirmation-required"` plus `estimatedDownloadBytes` and `estimatedDiskBytes`.
- `--reinstall` replaces an existing install. The old one stays if the new one fails.
- `--runtime` picks a runtime explicitly. There is no silent fallback.

`moldesk install usalign` is a tool, not a model: it downloads the pinned US-align source (about 263 KB, SHA-256 checked) and builds it with the user's C++ compiler into `~/.moldesk/tools`. Without `--yes` it prints the plan and exits 1 with `confirmation-required`, whatever the size. `moldesk uninstall usalign` removes it, and `moldesk doctor` lists the compiler and install state.

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

## `moldesk view [file] [--highlight <selector>] [--color <#rrggbb>] [--color-by chain|plddt] [--scene <file>] [--label] [--bfactor-is-plddt] [--output <file>] [--open] [--json]`

Builds an offline, interactive 3D report (Mol*) for any `.pdb` or `.cif`/`.mmcif` file. Useful for structures from RCSB or from earlier runs. The report is one HTML file that works without a network connection. `--output` must not exist.

- `--highlight A:40-60` (repeatable) draws that chain, residue or range as colored sticks over the cartoon. `--color` gives one color for all highlights or one per `--highlight`. A highlight that matches nothing exits 2 with the chains and residue ranges that exist.
- `--color-by plddt` colors by the four AlphaFold confidence classes and needs a known pLDDT source (`PLDDT_UNAVAILABLE` otherwise). `--bfactor-is-plddt` states that the B-factor column is pLDDT; only use it when that is true.
- `--scene scene.json` is the same as JSON: `{ "structure"?, "colorBy"?, "components": [{ "selector", "color"?, "label"?, "representation"? }] }`. It cannot be combined with the flags above.

## `moldesk fetch <source:id> [--format mmcif|pdb] [--output <dir>] [--refresh] [--json]`

Downloads `pdb:<4-character id>` (RCSB), `afdb:<UniProt accession>` (AlphaFold DB model) or `uniprot:<accession>` (FASTA) into `~/.moldesk/cache/fetch/<source>/<ID>/` with a `provenance.json` sidecar (URL, time, SHA-256, source version, license). Ask first (it uses the network). There is no search. `--format` applies to `pdb:` and `afdb:`. `--output` copies the file and its provenance into a directory and never overwrites. A verified cache hit makes no request; `--refresh` downloads again.

`result`: `source`, `id`, `format`, `fromCache`, `cacheDir`, `files[]` (`name`, `path`, `sha256`, `sizeBytes`; use `path`) and `provenance` (`url`, `sourceVersion`, `license`). AlphaFold files add the `PREDICTED_STRUCTURE` warning. Errors: `INVALID_FETCH_SPEC` and `FETCH_NOT_FOUND` exit 2, `FETCH_*` network or content problems exit 10.

## `moldesk analyze <file> [--fasta <file>] [--bfactor-is-plddt] [--json]`

Summarizes a `.pdb`, `.ent`, `.cif` or `.mmcif` file (first model). `result`: `modelCount`, `chains[]` (`authId`, `labelId`, `type` of `protein|dna|rna|ligand|water|other`, `residueCount`, `sequence` (modeled residues, `X` for non-standard) and `fullSequence` (the complete entity sequence including residues with no coordinates: use this to predict or search), `gaps[]`, `unobserved[]` for mmCIF, `secondaryStructure` fractions, `meanPlddt`, `residues[]` with `secondaryStructure` and `plddt`), `secondaryStructure.source` (`file` or `computed`), `geometry` (center of mass, radius of gyration, bounding box in Å) and `confidence`.

`confidence` is `null` with a `NO_CONFIDENCE_SOURCE` warning unless the file has ModelCIF pLDDT, is a MoleculeDesk Boltz output, or `--bfactor-is-plddt` was passed. `--fasta` writes each polymer chain's `fullSequence` (or the modeled residues when the file has none) and never overwrites.

## `moldesk analyze --validate-fasta <file> [--json]`

Checks a FASTA file (alphabet, empty records, duplicate headers). Invalid files exit 2 with `INVALID_FASTA` listing the problems. Do not combine with a structure file.

## `moldesk inspect <file> <selector> [--radius <angstrom>] [--label] [--bfactor-is-plddt] [--json]`

Per residue of a chain, residue or range: names, both id sets, secondary structure, pLDDT if known, heavy-atom count, and `neighbors[]` (other residues with a heavy atom within `--radius` Å, default 5, at most 30) with `distance` and the closest `atoms` pair. Waters are never selected or listed. Selectors: `A`, `A:45`, `A:40-60`, `A:52A` (an insertion code is exact; `A:52` means no insertion code). `SELECTOR_NO_MATCH` exits 2 and lists what exists.

## `moldesk compare <a> <b> [--chain-a <id>] [--chain-b <id>] [--multimer] [--report <file>] [--deviation-threshold <angstrom>] [--json]`

Superposes two structures with US-align (install once with `moldesk install usalign`, with approval). Defaults to the first polymer chain of each file and warns (`CHAIN_DEFAULTED`) when there are several; `--multimer` aligns all polymer chains of the first model. `result`: `mode`, `chains`, `lengths`, `alignedLength`, `rmsd`, `sequenceIdentity`, `tmScore` (`normalizedByA`, `normalizedByB`; use the one for the reference structure), `transform.matrix` (row-major 4×4 mapping A onto B), `mapping[]` (aligned pairs with `distance` in Å after superposition) and `citation`.

`--report overlay.html` also writes an offline overlay: both structures in one scene (B moved onto A), a per-residue deviation chart, and residues above `--deviation-threshold` (default 2 Å) highlighted. The file must not exist. Without US-align the command exits 2 with `USALIGN_NOT_INSTALLED`; there is no fallback.

## `moldesk describe <model> [--runtime python|docker] [--json]`

One document for a model: `parameters[]` (exactly the names `moldesk run <model> <input> --param key=value` accepts, with type, default, range, `defaultsByPlatform`), `input.formats`, `outputs[]`, `runtimes[]`, `hardware`, `assets[]`, `license`, `cloud` (`available`, minimum VRAM and RAM), and `compatibility` plus a one-line `verdict` for this machine. Use it instead of guessing parameters. `moldesk list --json` stays the index. Unknown model: exit 3.

## `moldesk schema [kind]`

Always prints JSON: the JSON Schema (draft-07) for `moldesk.analysis`, `moldesk.inspect`, `moldesk.compare`, `moldesk.fetch` or `moldesk.model`; without a kind it lists them.

## `moldesk visualizer update <report> [--output <file>] [--open] [--yes] [--json]`

Replaces the viewer inside an older report with the one installed now.

## `moldesk cloud ...`

`connect <provider>`, `disconnect <provider>`, `status`, `resources`, `recover <run-id>`, `cache list`, `cache delete <model>`. See [cloud-runpod.md](cloud-runpod.md).
