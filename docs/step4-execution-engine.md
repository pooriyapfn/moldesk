# Step 4 — Execution Engine (`moldesk run`)

Technical summary of the implementation that replaced the `moldesk run` placeholder
with a real execution lifecycle, per `docs/v0.1-implementation-spec.md` §4.

Scope: Python-runtime execution only, for ProteinMPNN and LigandMPNN. Docker
execution is deferred — Boltz has no install path yet, and the `RuntimeProvider`
abstraction below was built to accept a `DockerRuntimeProvider` later without
reshaping the orchestration.

## 1. Runtime layer (`packages/runtime`)

### `filesystem/paths.ts` — `runDir()`

Added a `runDir(runId, env?)` helper alongside the existing `modelInstallDir`/
`modelVersionDir`. It joins onto `getMoldeskPaths().runs`
(`$MOLDESK_HOME/runs`) and validates the run ID against a strict pattern
(`<ISO-timestamp-with-dashes>-<uuid>`) via the same `safeSegment` guard used
everywhere else in this file, so a malformed or path-traversing run ID is
rejected before it ever touches the filesystem.

### `process/index.ts` — cancellation and pid tracking

`runCommand()` previously supported a hard timeout (immediate `SIGKILL`) and
buffered stdout/stderr with streaming callbacks. Extended, additively, with:

- `signal?: AbortSignal` — external cancellation trigger (CLI wires this to
  its own `SIGINT`/`SIGTERM` handlers).
- `gracefulTimeoutMs?: number` — when set, termination sends `SIGTERM` first
  and only escalates to `SIGKILL` if the child hasn't exited within this
  window. When unset, termination is still an immediate `SIGKILL` — the
  original behavior, unchanged, so every pre-existing caller (install-time
  subprocess calls with short timeouts) keeps identical semantics.
- `onSpawn?: (pid: number) => void` — fires synchronously right after
  `spawn()` returns, so a caller can persist the pid before the promise
  resolves.
- `RunResult` gained `pid`, `signal` (from the `close` event's second
  argument, previously discarded), and `cancelled` (true when termination
  was triggered by `signal` aborting, as opposed to a `timeoutMs` timeout).

### `providers.ts` + `providers/python.ts` — `RuntimeProvider`

`providers.ts` already declared a `RuntimeProvider` interface
(`inspect`/`prepare`/`execute`/`remove`) but had zero implementations and
wasn't consumed anywhere. Extended `ExecuteRequest`/`ExecutionResult` with
the same cancellation/pid/signal fields as `RunOptions`/`RunResult`, then
implemented `PythonRuntimeProvider`:

- `prepare()` resolves `<targetDir>/.venv/bin/python` and throws
  `MODEL_NOT_INSTALLED` if it's missing.
- `execute()` opens `stdout.log`/`stderr.log` for append directly under the
  caller-supplied `cwd`, calls the extended `runCommand()` with
  `gracefulTimeoutMs: 5000`, and forwards each chunk both to the log files
  and to the caller's `onStdout`/`onStderr` (so `run.json`'s logs and the
  CLI's live tee come from the same stream). The provider never knows about
  run IDs — it only knows "write logs next to `cwd`."

### `redact.ts` — `redactEnv()`

A small pure helper that replaces values whose keys match
`/token|secret|password|key|credential|auth/i` (plus any caller-declared
sensitive keys) with `"[redacted]"`. Used before persisting a command's
`env` into `run.json` — the full inherited process environment is never
captured, only whatever an adapter explicitly declared on its `CommandSpec`.

## 2. Adapters layer (`packages/adapters`)

### `index.ts` — `ParamDescriptor` and extended `RunContext`

Added `ParamDescriptor` (`name`, `type: string|number|boolean`, `required`,
`default`, `min`/`max`, `enum`, `description`) and an optional
`params?: ParamDescriptor[]` on `ModelAdapterDefinition`. Params are declared
in adapter code, not the manifest schema — this keeps `packages/registry`
untouched and matches the spec's "model-specific translation code belongs in
adapters" rule.

`RunContext` gained `params: Record<string, unknown>` (normalized/validated/
defaulted) and `runtimeExecutable: string` (the resolved interpreter path).
`inputPath` now explicitly documents that it points at the *copied* input
inside the run directory, never the user's original path, and `outputDir` is
scoped to the run's `output/` subdirectory only.

### `params.ts` — `validateParams()`

Validates raw `--param key=value` strings against an adapter's declared
descriptors: rejects unknown keys, coerces by declared type, enforces
`min`/`max`/`enum` (including `enum` on string params — a bug caught by its
own test suite before shipping), fills defaults for missing non-required
params, and collects *every* error in one pass rather than stopping at the
first, so the CLI can report all problems at once.

### `outputs.ts` — `collectGlobOutputs()`

A minimal glob matcher (segment-wise `*` wildcards, no external dependency)
that resolves a manifest-style `{id, glob, required}` output declaration
against files under a run's output directory. Throws
`MISSING_REQUIRED_OUTPUT` if a required output has no matches — this is the
mechanism behind the spec's "exit code 0 is not sufficient" rule.

### `proteinmpnn/index.ts`, `ligandmpnn/index.ts`

Implemented the three previously-stubbed methods (`validateInput`,
`command`, `collectOutputs`) against the *actual* pinned upstream source —
both `protein_mpnn_run.py` and LigandMPNN's `run.py` were fetched at their
pinned commit SHAs and read directly rather than guessed:

- **`validateInput`**: file exists, extension is `.pdb`.
- **`command`**: builds the real CLI invocation. Notably:
  - ProteinMPNN's `--sampling_temp` is parsed upstream as a *space-separated
    string* of temperatures (`args.sampling_temp.split()`), not a float —
    declared as a `string` param, not `number`.
  - LigandMPNN's `run.py` defaults to `--model_type protein_mpnn`; the
    adapter always passes `--model_type ligand_mpnn` explicitly, plus an
    absolute `--checkpoint_ligand_mpnn` path (the upstream default is a
    `./model_params/...` relative path that would break once the process's
    `cwd` is the run directory instead of the source checkout).
- **`collectOutputs`**: both scripts write `<out_folder>/seqs/<name>.fa` —
  a nested subdirectory, not the top level. This didn't match the existing
  manifests, so `models/{proteinmpnn,ligandmpnn}/manifest.yaml`'s
  `outputs[0].glob` was corrected from `"*.fa"` to `"seqs/*.fa"` (a data
  fix, not a schema change).

## 3. Core layer (`packages/core/src/run.ts`)

`runModel(modelName, inputPath, options)` implements the spec's 11-step
lifecycle. The key structural decision: **only steps 1–3 (load manifest,
resolve installation, validate input/params) can reject the promise** — they
run before any run directory exists, so there's nothing to finalize.
**From step 4 onward (run directory allocated), `runModel` always resolves**
with a typed `{status: "succeeded"|"failed"|"cancelled", record}` — a
nonzero exit code, a missing output, a cancellation, or even an unexpected
internal exception are all captured into the record and written to disk,
never thrown. The CLI tells the two cases apart by `try/catch` (usage error)
versus `result.status` (run outcome).

```
load/validate manifest ─────────────┐
resolve ready installation ─────────┤  reject on failure — no run dir yet
validate input + params ────────────┘
──────────────────────────────────────────────────────
allocate run ID + directory (run/input/, run/output/)
copy input, sha256 it
write run.json (status: "preparing")        ← atomically, from here on every
                                                path below finalizes run.json
build RunContext, call adapter.command()
resolve RuntimeProvider (injected or real), call execute()
  → onSpawn fires: write run.json (status: "running", pid)   ← before await resolves
  → stdout/stderr stream to files and to CLI live tee
cancelled?        → status: "cancelled", RUN_CANCELLED
exitCode !== 0?   → status: "failed",    RUN_EXECUTION_FAILED   (never collects outputs)
else              → adapter.collectOutputs()
                     empty/throws → status: "failed", MISSING_REQUIRED_OUTPUT
                     else         → checksum + size each output, status: "succeeded"
write run.json (final, atomic)
──────────────────────────────────────────────────────
--output copy (only if succeeded): a separate post-finalization step.
A collision never flips the run's own status — it's reported as a distinct
`exportError`, since the model itself already ran and produced valid output.
```

Other notable details:

- **Dependency injection**: `runModel` never constructs
  `new PythonRuntimeProvider()` directly — it accepts
  `options.runtimeProvider` and defaults to a real one. Tests inject a fake
  object literal implementing the four `RuntimeProvider` methods, so
  `run.test.ts` never spawns a real subprocess.
- **Atomic writes**: `run.json` uses the same `${file}.tmp-${pid}-${uuid}` +
  `fs.renameSync` idiom as `installation.ts`'s install records — a crash
  mid-write can never leave a corrupt or partially-written `run.json`.
- **`hash.ts`**: the `digest()` helper (stable sha256 of a JSON value) used
  for `manifestSha256` was extracted out of `installation.ts` into a shared
  module so both install and run provenance compute it identically, and a
  new `sha256File()` streams a file's checksum without loading it fully into
  memory (used for both the input snapshot and every collected output).
- **pid bug caught by testing**: the first draft overwrote
  `record.process` wholesale from the provider's return value, which could
  erase the pid captured earlier via `onSpawn` if a provider implementation
  omitted it from its result. Fixed to merge (`execution.pid ?? record.process?.pid`)
  rather than overwrite.

## 4. CLI layer (`apps/cli/src/commands/run.ts`)

Full rewrite of the 11-line placeholder:

- `--output <dir>`, `--runtime python|docker` (docker resolves to a clear
  "not installed for the docker runtime" error today — no silent fallback,
  and no special-casing needed since no model currently has a docker
  installation to select), `--param key=value` (repeatable; malformed pairs
  are rejected before `runModel` is even called), `--json`.
- `SIGINT`/`SIGTERM` are forwarded into an `AbortController` passed as
  `options.signal`, which propagates all the way down to `runCommand`'s
  graceful-kill logic.
- A local exit-code table maps `MoldeskError.code` → the spec's contract for
  errors thrown before a run directory exists (`UNKNOWN_MODEL` → 3,
  `MODEL_NOT_INSTALLED` → 5, `INVALID_RUN_PARAMS`/`INVALID_RUN_INPUT` → 2,
  `RUNTIME_EXECUTION_UNSUPPORTED` → 4); everything else falls through to 10.
  Run *outcomes* map directly from `result.status`: `succeeded` → 0,
  `failed` (or a present `exportError`) → 7, `cancelled` → 8.

## 5. Verification

- `pnpm build && pnpm typecheck && pnpm test` — clean, **167 tests** passing
  (up from 119 before this step), spanning every layer above plus two new
  bugs (the pid-overwrite issue and a missing `enum` check on string params)
  that the new tests caught before they shipped.
- **Real end-to-end run** on this machine: installed ProteinMPNN for real
  (actual `uv`/Python provisioning, actual checkpoint download), ran it
  against a real PDB file (1UBQ from the RCSB), and got back a real
  checksummed FASTA sequence plus a fully populated `run.json` (hardware
  report, manifest hash, install fingerprint, command, timing, process info,
  output checksums).
- **Exit codes verified live**: unknown model → 3, not installed → 5, and a
  real `SIGINT` sent mid-run → graceful `SIGTERM`, process actually
  terminated (confirmed no orphan), `run.json` finalized as `cancelled`,
  exit code 8.

## Known gap (pre-existing, not introduced here)

LigandMPNN's install fails at the Step 3 verification step —
`ModuleNotFoundError: No module named 'pkg_resources'` inside `prody`'s
import chain, because its manifest doesn't pin `setuptools`. This is a Step
3 manifest gap, not a Step 4 execution-engine issue; ProteinMPNN installs
and runs cleanly. LigandMPNN's adapter code (`validateInput`/`command`/
`collectOutputs`) is implemented and unit-tested the same as ProteinMPNN's,
but hasn't been exercised end-to-end on real hardware because of this
blocked install.
