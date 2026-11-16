# `moldesk` command reference

Every command accepts `--json` (`schema` always prints JSON). Without a terminal (as when an agent runs it), commands that need confirmation stop and say so instead of prompting.

The structure commands (`fetch`, `analyze`, `inspect`, `compare`, `describe`, `score interface`) print one envelope on stdout and keep logs on stderr: `schemaVersion` (1), `kind`, `status` (`ok`), `input` (absent for `fetch`, `compare`, `describe`, `score interface`), `result`, `warnings[]` (`code`, `message`) and `provenance` (`moldeskVersion`, optional `tool`). Errors are `{ "status": "error", "code", "message", "remediation", "details"? }`. `moldesk schema <kind>` prints the JSON Schema. Exit codes for these commands: `0` ok, `2` invalid input or usage (including a missing tool), `3` unknown model (`describe`), `8` cancelled (`fetch`), `10` internal or upstream failure.

## `moldesk doctor [--json]`

Reports platform, arch, CPU, memory, disk, Apple Silicon, host Python, Docker, and NVIDIA/CUDA. JSON also includes `tools.ipsae` installation status. System keys: `platform`, `arch`, `cpu`, `memory`, `disk`, `appleSilicon`, `hostPython`, `docker`, `nvidia`.

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

## `moldesk workflow` commands

Declarative YAML workflows chain local operations. The document, its JSON Schema, and the registered operation contracts come from the core compiler; planning resolves inputs and installed models but never starts a run. An approval receipt is the only way to start one. See [workflows.md](workflows.md) for the agent recipe.

Operation IDs: `moldesk/import-structure@1` (`file: structure_file` → `structure: protein_structure`), `moldesk/structure-analysis@1` (`structure: protein_structure` → `report: json`) and `moldesk/boltz@1` (`sequence: protein_sequence` → `structure: protein_structure`, one chain, requires a ready local `boltz` install). Input types are `structure_file` and `protein_sequence`; references are whole-value `${inputs.<name>}` or `${steps.<id>.outputs.<name>}` only.

Workflow commands share the CLI error envelope (`status: "error"`, `code`, `message`, `remediation`, optional `details`) and print one JSON value on stdout. Validation and planning problems exit `2`. A run that ends `cancelled` exits `8`; one that ends `failed` or `interrupted` exits with its error code's mapping (`10` for step and model failures, `2` for problems such as a damaged artifact, a structure without a protein chain, or a changed model installation). Read the JSON `status` and `runStatus` rather than the exit code. Diagnostics carry `code`, `message`, `path`, and one-based `line`/`column` when the YAML source is available.

## `moldesk workflow schema [--json]`

Prints `{ schema, operations }`: the exact draft-07 JSON Schema for the workflow document and the operation map used for validation. Read it instead of guessing fields, flags, or contracts. For a model's parameters and installation verdict, also run `moldesk describe <model> --json`.

## `moldesk workflow validate <file> [--json]`

Validates the YAML bytes only; it does not resolve inputs or read structures. Checks the API version, metadata, declared inputs, step IDs, `uses`, `needs`, references, cycles, and declared output types. Result: `status`, `valid`, `order` (steps in execution order), `edges[]` (`from`, `to`), `diagnostics[]`. Invalid input exits `2` with `WORKFLOW_INVALID`; in JSON the diagnostics are under `details.diagnostics`.

## `moldesk workflow plan <file> [--input <name=value>] [--json]`

Validates, then resolves every declared input, hashes file inputs, and binds the local runtime. Relative file inputs resolve against the caller's working directory. For `moldesk/boltz@1` the plan selects the existing ready Python installation, records its model and adapter versions, manifest digest, runtime and environment fingerprints, source revision, and asset checksums. A missing or changed install is a planning diagnostic.

- `--input name=value` is repeatable, one binding per input. A duplicate, malformed, missing, or unknown binding fails with `INVALID_WORKFLOW_INPUT` or `WORKFLOW_PLAN_FAILED` (exit `2`).
- The plan is stored by `planId`; plan ids are deterministic for the same YAML bytes and resolved inputs. File inputs include their canonical absolute path, so the same bytes at another path yield another plan id.

JSON result: `status`, `schemaVersion`, `workflowSha256`, `planId`, `inputs` (`type`, `value`, `format`, `sizeBytes`, `sha256`), `steps[]` (`id`, `uses`, `operationVersion`, `needs`, `bindings[]`, `outputs[]`), `edges[]`, `requirements[]` (`stepId`, `backend`, `operationVersion`, optional `model` identity), and empty `diagnostics[]`. Show this plan to the user before approval.

## `moldesk workflow approve <plan-id> [--json]`

Prints the stored plan, then asks the person to confirm on a human terminal. Without a terminal it exits `2` with `WORKFLOW_APPROVAL_REQUIRES_TTY` and does not create a receipt. Requires the exact stored `planId` (`WORKFLOW_PLAN_NOT_FOUND` otherwise). JSON result: `status`, `approvalId`, `planId`, `plan`. The `approvalId` is one-use and bound to that plan; give it to the agent only after approving.

## `moldesk workflow run <approval-id> [--json]`

Consumes the one-use receipt, claims the run, executes ready steps in planned order, and waits in the foreground. A second submission with the same receipt returns the original `runId` with `duplicate: true` and starts no second executor. JSON result: `status` (`ok` for a good run, or `failed`/`cancelled`/`interrupted`), `runId`, `planId`, `runStatus`, `steps[]`, `artifacts[]`, `events[]`, `runDir`, optional `error`, and `duplicate`.

## `moldesk workflow status <run-id> [--json]`

Prints the durable state from SQLite. Result: `status: "ok"`, `runId`, `planId`, `runStatus` (`queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`), `steps[]` (each `id`, `uses`, `status`, `attempt`, optional `error`, optional `outputs`, and `childRunId` for a model step that produced a result), `artifacts[]`, `events[]` (append-only, increasing `id`) and `runDir`. Step `status` is `pending`, `running`, `succeeded`, `cached` (reused from an identical earlier CPU step; a success), `failed`, `cancelled`, or `skipped` (never started because the run was cancelled or stopped).

## `moldesk workflow artifacts <run-id> [--json]`

Lists committed artifacts with `id`, `type`, `format`, `relativePath`, `sha256`, `sizeBytes`, `producerStepId`, `stepId`, `createdAt`, plus `path` and `verified`. `verified` is false when the file is missing, outside the run, or its hash changed; do not use an unverified artifact.

## `moldesk workflow resume <run-id> [--json]`

Resumes an `interrupted` or `failed` run (or a `running` run whose owner is gone) from verified outputs. A `succeeded` run is returned unchanged; a `cancelled` run needs a new approval. Completed attempts are reused after hash and key checks; interrupted CPU work restarts in a new attempt directory. Damaged prior outputs and unresolved in-flight model attempts are rejected with recovery instructions and are never relaunched blindly. Resume a `failed` run only after fixing the cause the step error names; it reruns the failed step with the same plan.

## `moldesk workflow cancel <run-id> [--json]`

Records a durable cancellation request. The owning process turns it into an abort for model execution and checks it before publishing CPU outputs. Result: `status`, `runId`, `runStatus`, `cancelRequested`. Inspect with `status`; a run that already finished is unchanged.

## `moldesk visualizer update <report> [--output <file>] [--open] [--yes] [--json]`

Replaces the viewer inside an older report with the one installed now.

## `moldesk cloud ...`

`connect <provider>`, `disconnect <provider>`, `status`, `resources`, `recover <run-id>`, `cache list`, `cache delete <model>`. See [cloud-runpod.md](cloud-runpod.md).

## `moldesk score interface <structure> [options]`

Evaluate one complete two-protein-chain Boltz mmCIF prediction offline with managed ipSAE. Required: `--pae <npz>`, `--confidence <json>`, `--target-chain <author-id>`, `--binder-chain <author-id>`. Optional `--plddt <npz>` must belong to the same prediction. All sidecars must have exact matching Boltz filenames in the structure's directory. No guessing from chain length or matrix shape alone.

`--pae-cutoff <angstrom>` and `--distance-cutoff <angstrom>` default to 15 and require positive integers. These are recipe settings, not a biological pass threshold. `--output <json>` writes the envelope atomically and retains private `.artifacts` inputs, mapping, raw table and diagnostic logs beside it. Neither the JSON nor artifact directory may already exist. Without output, audit files go under the managed runs directory. `--json` prints exactly one envelope, kind `moldesk.interface`; multi-file identities are in `result.inputs`.

Result: explicit author/label roles, hashed token mapping, settings, `ipsaeTargetToBinder`, `ipsaeBinderToTarget`, `ipsaeMax`, pinned scorer identity and hashed audit artifacts. Ancillary upstream columns are unvalidated; absent pLDDT is never presented as a genuine zero. The scorer's generated PyMOL file is retained, never executed.

Input errors (`INVALID_INTERFACE_ARGS`, `INVALID_PAE`, `PAE_STRUCTURE_MISMATCH`, `BOLTZ_ARTIFACT_MISMATCH`, `UNSUPPORTED_INTERFACE_INPUT`), missing/damaged tool and missing scorer rows exit 2. `INTERFACE_CANCELLED` exits 8; `IPSAE_EXECUTION_FAILED` exits 10. A valid low/zero score succeeds.

Install the CPU tool once with `moldesk install ipsae`, after approving source, managed Python and hash-pinned NumPy downloads. No global Python fallback, GPU or local Boltz installation is required. `moldesk uninstall ipsae --yes` removes it; doctor reports status. Tools remain separate from model discovery. `moldesk schema moldesk.interface` publishes the result contract.
