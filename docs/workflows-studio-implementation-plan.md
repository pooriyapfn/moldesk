# MoleDesk Workflows & Studio implementation plan

Build one local workflow from YAML through CLI, MCP, and Studio. All three entry points must call the same core services. Ship an offline `import → analyze` example using the committed crambin structure, then exercise `Boltz monomer prediction → analyze` on an existing managed local Python installation. Follow the matching [test plan](./workflows-studio-test-plan.md) after each step.

Keep new workflow logic in `packages/core/src/workflows/` and transport code in `apps/cli/`. The first slice uses the repo's YAML parser, Ajv, SQLite driver, and offline viewer. Use serial execution, same-run resume, and a small cross-run cache for CPU steps. Defer workflow Docker and RunPod execution, parallel scheduling, automatic retries, and advanced Studio editing. Local `runModel` currently executes Python. Future RunPod support should call `planCloudRun` and `runCloudModel` with the existing quote, approval, and recovery contracts.

## 1. Define the YAML schema and operation contracts

**Add** `packages/core/src/workflows/schema.ts` and `operations.ts`. Declare a strict draft-07 JSON Schema, validate it with Ajv, and return the same schema from discovery. Add `yaml` to core at the repo's existing dependency range and move core's existing Ajv dependency to runtime. The registry's [manifest loader](../packages/registry/src/loader.ts) already uses `yaml`. Keep workflow documents and model manifests as separate contracts.

- Require `apiVersion: moldesk.ai/v1alpha1`, `kind: Workflow`, `metadata.{name,version}`, and `spec.{inputs,execution,steps}`. Allow optional `metadata.description`. `execution` accepts `backend: local`, `cache: true|false` (default `true`), and `max_parallel: 1` (default `1`). Store artifacts under `MOLDESK_HOME` with a fixed retention policy.
- Each step has `id`, exact versioned `uses`, a `with` map, declared output types, and optional `needs` (default `[]`). Validate input and step IDs with `^[a-z][a-z0-9_-]{0,63}$`. Parse one bounded YAML document with unique keys. Reject aliases, custom tags, merge keys, forbidden object keys, and unknown fields. Report diagnostics with a stable code, field path, and one-based line/column when a YAML node is available.
- Accept only whole-value `${inputs.<name>}` and `${steps.<id>.outputs.<name>}` references in `with`. These are references to typed values, resolved by lookup. Operations are selected from a fixed map keyed by `uses`. Keep command construction inside existing adapters.

| `uses` | Required `with` binding | Declared output | Existing code to reuse |
| --- | --- | --- | --- |
| `moldesk/import-structure@1` | `file: structure_file` | `structure: protein_structure` | [`readStructureInput`](../packages/core/src/analysis/structure-input.ts) and [`parseStructure`](../packages/core/src/analysis/molstar-model.ts) validate a local PDB/mmCIF containing a protein chain. |
| `moldesk/structure-analysis@1` | `structure: protein_structure` | `report: json` | [`analyzeStructureFile`](../packages/core/src/analysis/analyze.ts) returns the existing `moldesk.analysis` envelope. |
| `moldesk/boltz@1` | `sequence: protein_sequence` | `structure: protein_structure` | [`describeModel`](../packages/core/src/describe/describe.ts), the [Boltz manifest](../models/boltz/manifest.yaml), and [`runModel`](../packages/core/src/run.ts). This contract is for single-chain prediction. |

Expose each contract's input/output types, accepted formats, backend, and requirements from the same map used for validation. External inputs are declared as required `structure_file` or `protein_sequence`. Validate sequences as bounded, nonempty strings of standard amino-acid letters, normalize to uppercase, and reject any extra model-job fields. Use the established one-chain, empty-MSA [Boltz input shape](../examples/boltz/protein.yaml).

Add `examples/workflows/structure-analysis.yaml` using the following contract. Paths are supplied separately as input values.

```yaml
apiVersion: moldesk.ai/v1alpha1
kind: Workflow
metadata:
  name: structure-analysis
  version: 0.1.0
spec:
  inputs:
    structure:
      type: structure_file
      required: true
  execution:
    backend: local
    cache: true
    max_parallel: 1
  steps:
    - id: import
      uses: moldesk/import-structure@1
      with:
        file: ${inputs.structure}
      outputs:
        structure: protein_structure
    - id: analyze
      uses: moldesk/structure-analysis@1
      needs: [import]
      with:
        structure: ${steps.import.outputs.structure}
      outputs:
        report: json
```

Add `examples/workflows/boltz-analysis.yaml` for the model smoke. Replace the `structure` input with required `sequence: protein_sequence`, replace `import` with `predict` using `moldesk/boltz@1`, and bind `analyze.structure` to `${steps.predict.outputs.structure}` with `needs: [predict]`.

**Done when** the example validates, the schema and operation catalog describe every accepted field, and invalid YAML fails before file staging or runtime calls.

## 2. Compile once and expose validation and planning in the CLI

**Add** `packages/core/src/workflows/compiler.ts` and `apps/cli/src/commands/workflow.ts`. Export the workflow APIs from `packages/core/src/index.ts` and register `workflow` in `apps/cli/src/index.ts`.

- `validateWorkflow` resolves the operation contracts and checks duplicate IDs, unknown input/step/output references, missing or duplicate `needs`, self-edges, cycles, and input/output type mismatches. Require every step reference to name a direct `needs` dependency. Emit structured bindings and explicit edges. Topologically sort with declaration order as the tie breaker. `validate` needs only the YAML bytes.
- `planWorkflow` also checks all supplied input names/values, hashes file inputs, and resolves local compute. Resolve CLI file inputs relative to the caller's working directory. MCP and Studio pass their explicit workspace root. Reuse [`isWithinRoot`](../packages/runtime/src/filesystem/companion-inputs.ts) with canonical paths whenever a workspace root is enforced. Bound file reads and include content size, SHA-256, and format in the plan.
- Emit `schemaVersion`, `workflowSha256`, `planId`, resolved inputs, steps, edges, runtime requirements, operation versions, and diagnostics. Derive `planId` from the YAML byte hash and a canonical JSON encoding of the execution-relevant plan. Sort map keys, preserve ordered arrays, and keep timestamps and display-only fields outside the hash. [`digest` and `sha256File`](../packages/core/src/hash.ts) supply hashing primitives. Planning may read installation state and files. It never launches a runner or stages a paid job.
- For Boltz, resolve the existing ready Python installation with `listInstalledModels`. Mirror the selection in `runModel` by explicitly selecting `python`. Require the selected installation to match the catalog manifest and record model and adapter versions, manifest digest, runtime/environment fingerprints, source revision, and asset checksums from the receipt. Recheck the binding at submit and before the model starts. Surface missing or changed installations as actionable diagnostics. CPU analysis needs no model installation.
- Add `moldesk workflow schema --json`, `moldesk workflow validate <file> --json`, and `moldesk workflow plan <file> --input name=value --json`. Support repeatable `--input` and reject duplicate bindings. Use the CLI's existing error envelope and one JSON value on stdout. A validation or planning error exits `2`. Step 3 makes plan IDs durable.

**Done when** a clean home can compile the offline example, repeated plans of the same inputs match, and the CLI returns JSON diagnostics for an invalid DAG or unavailable backend.

## 3. Execute approved plans and persist runs, artifacts, and recovery state

**Add** `packages/core/src/workflows/{store,execute}.ts`. Use a workflow-specific SQLite file under `getMoldeskPaths().state` with the existing `better-sqlite3` dependency. See [`CloudJournal`](../packages/core/src/cloud/state.ts) for the driver's setup pattern. Keep the workflow schema and transactions independent of cloud state.

- Persist immutable plan records, approval receipts, run and step-attempt rows, and append-only events with increasing IDs. `workflow approve <plan-id> --json` displays the resolved plan and uses the CLI's [`confirm`](../apps/cli/src/utils/confirm.ts) helper on a human TTY, then stores a one-use `approvalId` bound to that exact plan. Stage files, verify their hashes, then atomically consume the receipt and claim the run. A duplicate submission returns the original run ID and cannot start a second executor. Studio uses the same receipt and submission methods after its explicit Run click.
- Use `<paths.runs>/workflows/<runId>/` for `workflow.yaml`, `plan.json`, snapshotted inputs, and per-step attempt outputs. Copy and hash server-owned snapshots before use. Write staged files before committing DB references. Make SQLite the status source of truth and generate `manifest.json` from committed records. Record typed artifacts as `{id, type, format, relativePath, sha256, sizeBytes, producerStepId}`. Verify file containment, regular-file type, and hashes before consumption, reuse, or export. Existing single-model `RunRecord` files remain the source for child-model logs and provenance.
- Execute ready steps in planned order and persist `pending → running → succeeded|cached|failed|cancelled` and the corresponding event in one transaction. Record `skipped` for blocked dependents when the run ends. Track `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `interrupted` at run level. Import publishes a validated structure snapshot. Analysis writes the unchanged envelope to `analysis.json` using `analyzeStructureFile`.
- For the Boltz step, render the validated sequence into a generated job file. Call `runModel` with the existing local Python runtime, the workflow abort signal and log callback, and one diffusion sample. Handle both thrown preflight errors and returned failed/cancelled results. On success find exactly one `structures` entry in `record.outputs`, verify its `.cif` format, hash and path under the child run's output directory, then copy it into the workflow. Store the child run ID and fingerprints. The child record retains confidence outputs. The copied structure may lack confidence metadata in the ordinary analysis envelope.
- With caching enabled, key cross-run CPU cache entries on contract/core versions, normalized bindings, file hashes, declared options and relevant analysis dependency version. Publish a cache entry only after success and verify its hashes before reuse. Recompute a missing/corrupt cache entry. Use an independent copy for each run so corrupting a run artifact can't mutate another run's outputs. Keep cross-run Boltz caching disabled until the environment can be fingerprinted sufficiently.
- Persist the executor owner and use transactional claim checks across processes. Shutdown aborts and drains owned work. A stale owner may be marked `interrupted` only after liveness is checked. Explicit `resume <run-id>` reuses completed attempts after hash and key checks and restarts interrupted CPU work with a new attempt directory. Reject damaged prior outputs and unresolved in-flight model attempts with recovery instructions. Never relaunch a potentially live prediction on timeout or ownership loss. `cancel <run-id>` records a durable request which the owner translates to `AbortSignal` for model execution and checks before publishing CPU outputs.
- Add `workflow run <approval-id> --json`, `status <run-id> --json`, `artifacts <run-id> --json`, `resume <run-id> --json`, and `cancel <run-id> --json`. The CLI waits in the foreground for execution. Also expose start-and-return-run-ID through the same core service for MCP and Studio. Record step and failure category in user-facing errors, with model logs available by child run ID.

**Done when** the CPU example succeeds in a temporary home, duplicate submission produces one run, a downstream step consumes a verified artifact, and an interrupted run resumes from verified outputs.

## 4. Add local MCP as a thin CLI command

**Add** `apps/cli/src/commands/mcp.ts` and register `moldesk mcp --workspace <dir>`. Use the official TypeScript SDK's stdio transport and lock a release compatible with the repo's Node 20 CI. Keep stdout reserved for protocol messages. Route diagnostics to stderr and scientific logs to the run. [Official MCP TypeScript SDK server guide](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server).

| Tool | Request and response |
| --- | --- |
| `models_list` | Return the workflow operation contracts with model details from existing registry discovery. |
| `workflow_schema` | Return the v1alpha1 JSON Schema and minimal example. |
| `workflow_validate` | Accept YAML text and return the core validation result. |
| `workflow_plan` | Accept YAML text and input values, resolve local file inputs under the configured workspace, and return the persisted plan. |
| `workflow_run` | Accept `approvalId` from the human CLI or Studio action. Return the run ID after claiming it. |
| `workflow_status` / `workflow_artifacts` | Accept `runId` and return stored status/events or typed artifact metadata. |

Use the same diagnostic and result types as the CLI. Check the approved plan's file bindings against the MCP workspace at submit time as well as during planning. Only the human CLI and Studio actions can mint receipts. Keep execution tied to the MCP process lifecycle and persist enough state for CLI recovery if the connection closes.

**Done when** a real stdio client discovers the schema, plans the CPU example, starts an approved run, and reads that same run from the CLI. An attempt to run without a receipt has no side effects.

## 5. Add the loopback Studio and verify the packaged product

**Add** `apps/cli/src/commands/studio.ts` and `apps/cli/src/studio/`. Use Node `http` and the existing CLI build for a small local page with a YAML textarea, read-only DAG, and run inspector. Start it with `moldesk studio --workspace <dir>` and call [`openInBrowser`](../packages/runtime/src/process/open.ts). Support `--no-open` for tests and scripting. The first UI can render ordered nodes and explicit edges without adopting a graph/editor framework.

- Wire compile/plan, start, status, cancel, resume, and artifact listing to core. The plan response drives the DAG and selected-node inspector. Show diagnostic line/column beside the YAML draft, show the resolved local backend and inputs before Run, and clear the selected plan after any draft or binding edit. Allow opening workspace YAML and downloading an edited draft.
- Keep the listener on `127.0.0.1` with an OS-assigned port. Use a per-launch session secret, exact Host and Origin checks on browser mutations, and same-origin API/SSE access. Scope file reads to the configured workspace and managed run artifacts. Serve artifact downloads by validated IDs and render YAML, user labels, logs, and errors as text. Cap request bodies and log tails.
- Stream committed step events by run ID via SSE with a persisted event cursor and replay from `Last-Event-ID`. Refresh the run snapshot after reconnect and display recent model log tails from the linked child run. Publish or download verified artifacts by type. Open protein structures using [`createStandaloneReport`](../packages/core/src/visualization.ts) and the existing offline Mol* renderer. Generate previews on demand and keep generated HTML out of the scientific cache.
- Package the page assets within the CLI's published `dist` and verify its packed CLI can start both Studio and MCP without the repo checkout. Add concise examples to the existing CLI and agent docs. Leave release metadata changes for the normal release process.

**Done when** a researcher can open the example, fix a YAML diagnostic, plan, approve, monitor, and inspect the real CPU analysis and structure from the packaged CLI. Run the network-free suite plus one benign Boltz smoke on a prepared machine before claiming live model support.
