# MoleDesk Workflows & Studio test plan

Run each gate after the matching step in the [implementation plan](./workflows-studio-implementation-plan.md). The commands below target the proposed code and test filenames. The default suite uses the committed crambin fixture, synthetic runner failures, and a temporary `MOLDESK_HOME`. GPU execution is a separate smoke test.

From the repo root, install dependencies and build the CLI and its workspace dependencies. Rebuild after changes because the test runner resolves workspace packages through `dist`.

```sh
pnpm install --frozen-lockfile
pnpm --filter '@moldesk/cli...' build
work=$(mktemp -d)
export MOLDESK_HOME="$work/home"
workflow=examples/workflows/structure-analysis.yaml
structure=packages/visualizer/test/fixtures/1CRN.pdb
```

## 1. YAML schema and operation contracts

Add `packages/core/src/workflows/schema.test.ts`.

| Case | Pass condition |
| --- | --- |
| Committed workflow examples | Both parse with the expected API version, operation IDs, and typed ports. Each operation's discovery record exposes the same ports and supported backend as the validator. |
| Schema boundaries | Unknown keys at root, nested objects, and operation ports fail. Unsupported API versions, `backend: docker`, `backend: runpod`, `max_parallel: 2`, and an unknown `uses` each fail with a field path. |
| YAML boundaries | A duplicate key, second document, alias, merge key, custom tag, forbidden object key, and oversized source each produce a diagnostic. Assert one-based positions for syntax and schema errors with known source locations. |
| Restricted references | Both supported reference forms parse. Interpolation inside a larger string, arbitrary expressions, and a `with` key outside the operation contract are rejected. Fixtures remain inert. |
| Single-chain prediction binding | A valid input sequence normalizes successfully. Empty input, over-limit input, non-amino-acid characters, and a structured model job supplied as `sequence` fail. |

```sh
pnpm --filter @moldesk/core test workflows/schema.test.ts
```

## 2. Deterministic compiler and CLI planning

Add `packages/core/src/workflows/compiler.test.ts` and `apps/cli/src/commands/workflow.test.ts`.

| Case | Pass condition |
| --- | --- |
| DAG resolution | Two disconnected ready nodes keep declaration order. A later-declared prerequisite executes first. Steps have typed bindings and the edge list matches `needs`. |
| Broken DAG | Duplicate step IDs, self-edges, cycles, duplicate or missing dependencies, missing `needs` for a reference, unknown input/output names, and wrong artifact types fail before any runner call. |
| Bindings | Missing, extra, and duplicate external input values fail. The CPU example plans in an empty home. A missing local Boltz installation gets a specific diagnostic without installing anything. |
| File access | Normal CLI-relative paths work, including paths with spaces. With a workspace root set, reject paths and symlink targets outside it. Reject directories, invalid formats, and oversized inputs. |
| Determinism | Replan identical YAML and input bytes with reordered input-map keys. Plan ID and normalized DAG match. Editing YAML bytes, changing the file's bytes, or swapping the resolved installation fingerprint changes the plan ID. |
| CLI behavior | `--json` emits exactly one parseable JSON value. `workflow schema` returns the same schema and operation contracts used by core. Validation and planning errors exit `2`. Spy on runtime/provider calls and assert zero at both endpoints. |

```sh
pnpm --filter @moldesk/core test workflows/compiler.test.ts
pnpm --filter @moldesk/cli test commands/workflow.test.ts
node apps/cli/dist/index.js workflow schema --json
node apps/cli/dist/index.js workflow validate "$workflow" --json
node apps/cli/dist/index.js workflow plan "$workflow" --input "structure=$structure" --json > "$work/plan.json"
```

Inspect `plan.json`. It contains a `planId`, the source hash, order `import`, `analyze`, one edge from `import` to `analyze`, and a file hash for `structure`. Validation and planning create zero run or step records.

## 3. Approval, execution, persistence, cache, and resume

Add `packages/core/src/workflows/store.test.ts` and `execute.test.ts`. Use temporary paths and the fake-provider pattern in [`run-fixture.ts`](../packages/core/src/testSupport/run-fixture.ts). For a Boltz wrapper integration test, supply a fixture model receipt and a fake provider that writes a committed mmCIF and synthetic confidence JSON into the adapter's expected output layout. Retain one real CPU analysis test through `analyzeStructureFile`.

| Case | Pass condition |
| --- | --- |
| Approval | A missing or invalid receipt, declined prompt, or non-TTY approval creates no run. A changed file or installation blocks a new submit before a runner starts. Concurrent submissions of one receipt share one run ID and invoke the executor once. |
| Happy path | The CPU workflow records both successful steps and one analysis artifact. Validate the JSON with the existing `moldesk.analysis` envelope schema. Compare result chains and geometry against `moldesk analyze` on the same fixture, allowing provenance paths to differ. |
| Provenance | Edit the YAML and source file after a run. The saved workflow, plan and input hashes still match the original. Each listed artifact opens from its recorded managed path and matches SHA-256 and size. |
| Boltz bridge | Fake runtime receives the generated single-chain job and one-sample option. A successful child record links the verified CIF to analysis. Zero or multiple `structures` entries, a bad output hash, or an out-of-root artifact prevents downstream execution. |
| Failure and cancellation | Inject a preflight rejection and a failed returned `RunModelResult`. Each records a useful failure and skips dependents. Cancel a running fake provider and assert no later step starts or artifact is published. |
| Cache | Two approved identical CPU runs yield `cached` steps on the second. Change the input hash, options/version, or disable caching and assert recomputation. Corrupt a cache entry and verify recomputation. Change a run copy and check another run and the cache still verify. |
| Resume and ownership | Interrupt a test process after the import commit. Resume in a second process and assert import runs once overall and analysis runs once on the verified snapshot. A live owner blocks competing resume, a tampered output blocks reuse, and an unresolved model attempt produces no new runtime call. |
| Crash consistency | Inject exit after writing an output but before its status transaction. A fresh process sees no published artifact for that attempt. Replayed event IDs are ordered and agree with the latest persisted status. |

```sh
pnpm --filter @moldesk/core test workflows/store.test.ts workflows/execute.test.ts
pnpm --filter @moldesk/cli test commands/workflow.test.ts commands/run.test.ts commands/analyze.test.ts
```

After rebuilding, run the following from an interactive terminal. Replan to persist the plan in the new store. Answer `y` at the approval prompt.

```sh
node apps/cli/dist/index.js workflow plan "$workflow" --input "structure=$structure" --json > "$work/plan.json"
plan_id=$(node -p 'require(process.argv[1]).planId' "$work/plan.json")
node apps/cli/dist/index.js workflow approve "$plan_id" --json > "$work/approval.json"
approval_id=$(node -p 'require(process.argv[1]).approvalId' "$work/approval.json")
node apps/cli/dist/index.js workflow run "$approval_id" --json > "$work/run.json"
run_id=$(node -p 'require(process.argv[1]).runId' "$work/run.json")
node apps/cli/dist/index.js workflow status "$run_id" --json
node apps/cli/dist/index.js workflow artifacts "$run_id" --json
```

Expect `succeeded`, a PDB `protein_structure` artifact, and a JSON `report` artifact. Submit the same approval again and check the run ID and attempt counts remain identical.

## 4. Test the MoleDesk skill against the built CLI

Reuse the existing skill command checker. Smoke-test the [shared skill](../plugins/moldesk/skills/moldesk/SKILL.md) in Claude Code and Codex using the built CLI, the CPU fixture, and an isolated `MOLDESK_HOME` per smoke.

| Case | Pass condition |
| --- | --- |
| Command coverage | The checker confirms the skill's commands and flags exist in the built CLI and `references/cli.md` covers `workflow`. |
| Discovery and planning | Ask the agent to analyze the local crambin fixture as a YAML workflow. It reads `workflow schema --json`, uses declared operation IDs, validates its YAML, and presents the resolved plan with `planId`. Given broken YAML, it reports the CLI diagnostic and fixes the draft before planning. |
| Approval and artifacts | Withhold approval and verify no run starts. Approve the displayed plan from a separate human terminal using the same home and pass the receipt to the agent. It runs the plan, reads status and artifacts by `runId`, and reports the structure and JSON report. Verify the IDs and hashes via the CLI. |
| Older CLI | With a CLI that lacks `workflow`, the skill identifies the missing command and stops the workflow flow. |

```sh
pnpm --filter '@moldesk/cli...' build
node --test scripts/check-skill-commands.test.mjs
node scripts/check-skill-commands.mjs
```

## 5. Studio, packaging, and release smoke

Add `apps/cli/src/studio/server.test.ts`. Start the real loopback server on an OS-assigned port and call HTTP routes from the test. Use a real browser for the interactive check, following the existing [visualizer smoke test](../packages/visualizer/scripts/browser-smoke.mjs) if automating it.

| Case | Pass condition |
| --- | --- |
| Graph and editing | Load the example YAML. The graph shows `import → analyze` and node details from the core plan. Remove `needs`, verify the diagnostic and disabled Run action, then correct it and replan. Change an input after planning and verify a fresh plan is required. |
| Run inspector | Run after the explicit click. Watch step transitions, open artifact metadata, download the JSON report, and open the offline structure preview. Confirm the same run and artifact hashes from the CLI. |
| Events and recovery | Disconnect and reconnect SSE with the last event ID. Receive each later event once and reconcile to the saved snapshot. Cancel a slow fixture and resume an interrupted CPU fixture. Confirm the same behavior through CLI status. |
| Local boundaries | Assert the server listens on `127.0.0.1`. Reject an invalid Host, cross-origin mutation, missing session, and an out-of-workspace file. User text with HTML metacharacters displays as text. Artifact endpoints resolve only known, managed IDs. |
| Packed CLI | Extend [`scripts/pack-verify.mjs`](../scripts/pack-verify.mjs) for workflow planning and Studio asset/API checks from an unrelated working directory. The current tarball harness uses `--ignore-scripts`. Enable the existing SQLite native dependency in the isolated install for tests that open the workflow store. |

```sh
pnpm --filter @moldesk/cli test studio/server.test.ts
node apps/cli/dist/index.js studio --workspace "$PWD" --no-open
```

Open the printed URL and use `examples/workflows/structure-analysis.yaml` with `packages/visualizer/test/fixtures/1CRN.pdb` as input. Watch both steps, open the structure preview, and compare the downloaded report with the direct CLI analysis. Repeat with the installed tarball against a copied fixture in a separate directory.

Before release, run the repo checks on Node 20 and a clean checkout. Run the model smoke separately using an already prepared MoleDesk home with supported hardware. Use the sequence of the public [crambin fixture](../packages/visualizer/test/fixtures/1CRN.pdb).

```sh
node apps/cli/dist/index.js workflow plan examples/workflows/boltz-analysis.yaml \
  --input sequence=TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN --json
```

Approve and run that plan using step 3. Verify one real child model run, its recorded installation fingerprint, one verified CIF, and a downstream `moldesk.analysis` report. Record whether the GPU smoke passed or was skipped.

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm pack:verify
```
