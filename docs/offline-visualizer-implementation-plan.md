# MoleculeDesk offline molecular reports — implementation specification

Status: approved architecture for implementation. This document consolidates the agreed design; implement it without reopening delivery/update decisions.

## 1. Objective and boundaries

Add a clean, local Mol* visualizer for PDB and macromolecular mmCIF (`.cif`, `.mmcif`) files. Show interactive 3D structures and synchronized sequence letters. Generate a persistent, self-contained HTML report through both direct CLI use and successful model runs. Support multiple predictions, complexes, DNA/RNA, ligands, and future charts through a small reusable report contract.

Implementation priorities, in order:

1. Entire visualizer lifecycle is offline: generate, open, interact, show update instructions, update, reopen.
2. Correct scientific interpretation and preserved source data.
3. Small changes to existing core/CLI/adapters; one reusable visualizer package.
4. Simple researcher-facing UI and fast report generation.
5. Extendable schemas and rendering boundaries, without building a generic plugin platform.

Deliver a report, not a screenshot. Do not build a localhost server, new desktop app, remote updater, PyMOL replacement, or coordinate editor in this iteration. Do not change model installation/execution semantics. Model processes can have their existing network behavior; this specification prohibits network activity introduced by the visualizer, not unrelated existing model functionality.

## 2. Decisions already made

- HTML is an export format; the report contract is the integration boundary; the viewer is reusable browser code.
- Build/minify viewer JS and CSS once during package build/release. Never bundle, compile, install dependencies, convert coordinates, or launch Python while generating/updating reports.
- Embed matching JS, CSS, molecular data, report configuration, and required assets in one HTML file. No neighboring assets or installation paths are required to open it.
- Adapters describe scientific results. A shared service creates reports. Do not generate HTML separately in every adapter.
- Installed MoleculeDesk is the sole authority for updates. No release discovery, downloads, CDN, remote version checks, telemetry, or automatic requests.
- Browser update button only opens a modal with CLI instructions. It performs no update and no network request.
- CLI update replaces the report viewer with the locally installed bundle after confirmation. A different older local bundle is also eligible if compatible; this is replacement with the installed version, not a "latest version" policy.
- Preserve structures, sequences, metrics, and their hashes during viewer-only updates. Preserve the original report through a backup.
- Report generation failure never turns a successful scientific run into a failed run.
- Generate one report per run, with selectable scenes, rather than one duplicated report per prediction.

## 3. Repository fit and smallest change surface

Existing repository uses TypeScript, pnpm workspaces, ESM/NodeNext, Commander, and Vitest. `apps/cli` is thin; `packages/core` orchestrates workflows; `packages/runtime` owns host operations; `packages/adapters` translates model-specific behavior. `apps/desktop` is a planned Tauri wrapper, not an existing frontend to modify.

Current integration points:

- `packages/adapters/src/index.ts`: `CollectedOutput` currently contains `id` and `path`; `ModelAdapterDefinition.collectOutputs` returns these.
- `packages/core/src/run.ts`: collects and checksums outputs, determines model status, finalizes `run.json`, then performs `--output` copying. Preserve this lifecycle and error precedence.
- `apps/cli/src/index.ts`: command registration.
- `apps/cli/src/commands/run.ts`: run options, output printing, JSON results, cancellation and exit codes.
- `packages/runtime/src/filesystem/paths.ts`: centralized managed paths.
- `scripts/pack-verify.mjs` and release/build package lists: new published package and generated assets must be included.

Suggested files (combine small modules when clearer; do not create empty abstractions):

```text
packages/visualizer/
  package.json
  tsconfig.json                 # Node build; existing repo conventions
  tsconfig.browser.json         # DOM/browser code, separate from Node
  scripts/build-viewer.mjs      # pinned production bundle; no runtime bundling
  src/
    contract.ts                 # pure types + lightweight validation
    index.ts                    # Node exporter/inspection/update exports
    report.ts                   # trusted template, encode/decode, validation
    bundle.ts                   # locate installed assets + bundle metadata
    browser/
      main.tsx                  # UI bootstrap and report panels
      molstar.ts                # small bridge over Mol* operations
      styles.css
  dist/
    ...Node/type output...
    assets/viewer.js
    assets/viewer.css
    assets/bundle.json

packages/core/src/visualization.ts
apps/cli/src/commands/view.ts
apps/cli/src/commands/visualizer.ts
```

Add `@moldesk/visualizer` with separate exports:

```text
@moldesk/visualizer             # Node APIs; never loads browser bundle as code
@moldesk/visualizer/contract    # browser-neutral types/validation
```

Dependency direction: CLI → core → visualizer; core → adapters as today. Adapters may use a type-only import from visualizer/contract (declare dependency properly). Visualizer must not depend on core/adapters/runtime. Browser entry must not import Node modules. No cycle. Importing core for `list`/`doctor` must not initialize Mol*, React, or WebGL.

Prefer one production bundler (esbuild is sufficient) and only needed dependencies. Pin Mol* to an exact tested version and retain its license/required attribution. Start with its existing plugin/sequence UI rather than recreating molecular parsing, picking, and sequence correspondence. A thin shell with restrained CSS is sufficient. Do not fork Mol*.

## 4. Contracts: descriptions versus portable payloads

Keep filesystem references on the Node side. Exported reports contain data and stable local identifiers, not file paths, URLs, commands, or executable adapter code. Resources are stored once and reused across scenes.

The following types establish the intended shape. Refine naming as needed, preserving these boundaries. Implement runtime validation; TypeScript interfaces alone are insufficient.

```ts
type MolecularFormat = "pdb" | "mmcif" | "sdf";
type ResourceFormat = MolecularFormat | "json" | "csv";

type SourceRef =
  | { kind: "output"; path: string }
  | { kind: "input"; path: string };

interface ReportDescription {
  title: string;
  resources: Array<{
    id: string;
    source: SourceRef;
    format: ResourceFormat;
    label: string;
  }>;
  scenes: Scene[];
  panels: Panel[];
}

interface MolecularReportV1 {
  schemaVersion: 1;
  id: string;
  title: string;
  resources: Array<{
    id: string;
    label: string;
    format: ResourceFormat;
    sha256: string;               // SHA-256 of original bytes
    sizeBytes: number;
    encoding: "base64";
    data: string;                 // original bytes, not regenerated coordinates
  }>;
  scenes: Scene[];
  panels: Panel[];
  provenance: {
    createdAt: string;
    runId?: string;
    model?: string;
    modelVersion?: string;
  };
}

interface Scene {
  id: string;
  title: string;
  rank?: number;
  structures: Array<{
    id: string;
    resourceId: string;
    modelIndex?: number;          // explicitly documented, zero-based
    assemblyId?: string;
    transform?: number[];        // 16 finite values; document matrix convention
  }>;
  components?: Array<{
    id: string;
    structureId: string;
    selection: MolecularSelection;
    label?: string;
    role?: "target" | "binder" | "receptor" | "ligand";
    representation?: "cartoon" | "sticks" | "surface";
    color?: string;              // validated color value, not arbitrary CSS
  }>;
}

type MolecularSelection =
  | { kind: "all" }
  | { kind: "molecule"; type: "protein" | "dna" | "rna" | "nucleic" |
      "ligand" | "ion" | "water" }
  | { kind: "chains"; namespace: "label" | "auth"; ids: string[] }
  | { kind: "entities"; ids: string[] }
  | { kind: "residues"; residues: ResidueRef[] };

interface ResidueRef {
  chainNamespace: "label" | "auth";
  chainId: string;
  residueNamespace: "label" | "auth";
  sequenceId: number;
  insertionCode?: string;
}

type Panel =
  | { id: string; kind: "structure"; sceneIds: string[] }
  | { id: string; kind: "table"; dataset: DatasetRef; columns: Column[] }
  | { id: string; kind: "chart"; dataset: DatasetRef; chart: ChartSpec };

interface DatasetRef {
  resourceId: string;
  rowsKey?: string;              // one named array in JSON; no evaluated query
}

interface Column {
  field: string;
  label: string;
  unit?: string;
}

type ChartSpec =
  | { type: "line" | "scatter" | "bar"; x: Column; y: Column;
      seriesField?: string }
  | { type: "heatmap"; x: Column; y: Column; value: Column };
```

Resolve/validate references: resource/scene/structure/component/panel IDs are unique in their scope; references exist; scene resources have molecular formats; table/chart resources have supported data formats. Require finite numeric values, bounded arrays/strings, allowed discriminants, and safe field lookup. Reject arbitrary code, remote URLs, custom HTML, dynamic import names, and unbounded generic extension objects. Avoid prototype-sensitive property lookup. No JavaScript expressions, callbacks, or third-party plugin names in chart configuration.

For JSON datasets, absent `rowsKey` means root array, or root object represented as one row for summary metrics; present `rowsKey` selects one own array property. CSV uses a proper bounded parser, including quoted cells. Treat original data bytes as immutable. A declared but unavailable optional chart renderer should show a labeled data table/fallback, not crash the structure viewer; unsupported scientific interpretation must never be guessed.

Validate transforms and coordinate-space assumptions. Multiple docking files in one scene must already share coordinates or have an explicit transform. Do not silently align them. Default uses original model coordinates; biological assemblies are an explicit choice.

Do not duplicate the complete molecular hierarchy in adapters/report JSON. Mol* derives chains, polymer types, residues, entities, ligands, and sequence correspondence from source files. Adapters add scientific roles and verified mappings. Entity identity is not equivalent to chain ID: an entity can have multiple chain instances. PDB metadata may be incomplete; unknown is acceptable. Preserve author/label numbering, insertion codes, model identity, assembly instances, missing residues, and modified residues when presenting selections/sequences. Do not make sequence letters by naively joining ATOM records.

Later cross-panel selection can reference a scene + structure + residue locator or scene ID. Do not add an event bus/framework now. Chart-only reports are allowed (`scenes: []`); tables/charts must not require a Mol* instance. `MolViewSpec` is a possible future scene interchange format; do not implement its full schema or a custom selection language in this iteration.

## 5. Viewer UX and scientific behavior

- One main 3D viewport, visible sequence strip, compact header, collapsible controls.
- Scene/prediction selector for multiple results; instantiate one Mol* plugin and load one selected scene initially. Release replaced scene data/representations.
- Default polymer cartoon, ligand sticks, waters hidden. Sensible chain colors; adjustable background, representation, visibility, fit/reset, and PNG export.
- Protein and DNA/RNA sequences: chain selector, letters and residue numbering, hover highlight, click-to-select/focus using Mol* correspondence.
- Ligand-only structures: show structure with a clear "No polymer sequence" state.
- Model selection must be explicit when a source has multiple models. Do not treat NMR models as independent predictions or assemblies as source chains without labeling.
- Separate experimental roles (target/binder/receptor/ligand) from chemical type (protein/DNA/RNA/etc.).
- Confidence coloring only when model semantics and residue/atom correspondence are verified. Arbitrary B-factors are not automatically pLDDT. Summary/global scores are not per-residue colors. Unknown metrics remain labeled values/tables.
- Parsing/rendering failures show a readable error and keep other report controls usable. Unsupported/no WebGL has an actionable browser message; report generation cannot guarantee GPU rendering.
- Avoid external fonts, icons, images, and UI services. Use local CSS/system fonts and local icons.

Use a small Mol* bridge for initialization/disposal, raw-data parsing, scene loading, component presets, selections, focusing, and image export. Keep adapter/model-specific filenames out of browser code.

Support simple tables in the first delivery. Implement a small reusable numeric chart renderer (e.g. SVG line/scatter/bar/heatmap) when an actual model/report fixture exercises it; verify types remain representable without shipping a large plotting platform. A future AF2binding-like adapter can supply score tables/charts through this contract. Do not invent model outputs or metrics. No model-specific dashboard code inside Mol* bridge.

## 6. Adapter hook and current models

Add one optional hook; leave `collectOutputs`, manifests, required-output verification, and existing output IDs intact:

```ts
describeVisualization?(
  context: RunContext,
  outputs: readonly CollectedOutput[],
): Promise<ReportDescription | undefined>;
```

`undefined` means no report applies, not a failure. Existing adapters without the hook keep working. Provide a small shared helper for converting selected molecular outputs into resource/scene descriptions. Extend `RunContext` only when staged primary/companion inputs already provide insufficient information; do not pass unsnapshotted original inputs.

| Adapter | Required interpretation |
| --- | --- |
| Boltz | Native CIF predictions, exact association to confidence/affinity when available; explicit prediction selector. |
| OpenDDE | Prefer native CIF; exported PDB is alternate format of the same prediction, not another prediction. Match job/seed/sample identifiers exactly. |
| BindCraft2 | Accepted/ranked designs first when available, then refolded/trajectory scenes. Valid run with no eligible structure produces no report. Parse declared CSV/JSON for actual rank rather than inventing one. |
| DiffDock | Staged receptor PDB plus SDF poses in the same scene; rank/confidence from existing pose summary. Top pose duplicates can reuse resources/scenes. |
| ProteinMPNN / LigandMPNN | Sequence outputs do not create new coordinates. Do not automatically present mutated structure; omit automatic report initially, or explicitly label a future input-backbone preview. |

Deliver adapter reports for all existing structure-producing adapters, without changing model readiness/installation support. A standalone `view` must work without any model installed. Start implementation with Boltz/OpenDDE, then use the same primitives for BindCraft2/DiffDock. ProteinMPNN/LigandMPNN should not need edits beyond optional-hook compatibility tests.

Association rules belong in adapters and must be tested against pinned layouts/fixtures. Core cannot pair confidence files by global sort order or recursively pick every `.cif`: e.g. CCD component dictionaries are not predictions. Output IDs are not unique per file; source matching uses the exact collected path, then exporter assigns report-local IDs. Never pick scientific roles solely from filename extension.

## 7. Core lifecycle, storage, and export

Add core entry points to create a standalone report and prepare/apply an existing-report update. CLI handles prompts/printing; package/core handles deterministic validation and writes.

Standalone path flow: resolve explicit local input → reject URL/directory/unsupported file → read bounded regular file → lightweight format preflight → create one-scene description → export. `.cif` means macromolecular mmCIF for this feature; arbitrary crystallographic CIF is not promised. Preserve bytes; no CIF-to-PDB conversion. Actual molecular parsing remains in browser Mol*. Empty/clearly wrong files should fail before export; avoid creating a second Node molecular parser.

Run flow:

```text
existing model execution and output verification
  → outputs hashed and model status determined
  → success + visualization enabled + adapter hook
  → describe, resolve allowed sources, create HTML in artifacts/
  → record artifact or nonfatal warning
  → finalize run.json atomically
  → existing scientific output copy + separate artifact copy
```

Keep visualization errors out of the catch that marks model execution failed. Cancellation before/during visualization skips/aborts artifact work; preserve model outcome already determined. Check abort between work units and before publishing a file. Existing failed/cancelled scientific runs generate no automatic report.

```text
<run>/
  input/                      # existing snapshots
  output/                     # existing scientific outputs
  artifacts/viewer.html       # derived report
  run.json
```

Add optional/additive fields to existing run record/result, with explicit types:

```ts
artifacts?: Array<{
  id: string;
  kind: "molecular-report";
  path: string;
  sha256: string;
  sizeBytes: number;
  sourceSha256: string[];
  viewerVersion: string;
  bundleSha256: string;
}>;
warnings?: Array<{ code: string; message: string }>;
```

Do not put derived HTML into model-required outputs. Default `visualize: true`; CLI `--no-visualize` maps to false. Generation warning keeps successful exit status and is visible in text/JSON. Artifact copy errors can use existing post-run export error behavior, preserving run status.

`--output` copies the self-contained report too. Use a collision-resistant report filename such as `moldesk-report-<run-id>.html` in that external directory; do not rely on flattening scientific source basenames. No source dependencies need copying for report readability. Preserve existing scientific output copy semantics.

Standalone default: owned path under `paths.cache`, e.g. `cache/visualizations/<unique-id>/viewer.html`; explicit `--output` accepts a file path and refuses overwrite. Reuse centralized paths; add one helper only if useful. Print absolute path and a properly encoded `file:` URL via Node `pathToFileURL`.

Run record artifact digest describes originally generated bytes. Updating a report later must not silently rewrite historical `run.json`, model output hashes, or arbitrary sibling files. Report carries its own update metadata. Old record digest can legitimately no longer match an explicitly updated artifact; document this distinction in update result/implementation docs. Backup preserves original bytes.

## 8. CLI contract

```sh
moldesk view ./protein.pdb
moldesk view ./complex.cif --output ./report.html --open
moldesk view ./protein.mmcif --json
moldesk run boltz ./job.yaml --output ./results
moldesk run boltz ./job.yaml --no-visualize
moldesk visualizer update "/path/to/report.html"
moldesk visualizer update "/path/to/report.html" --open
moldesk visualizer update "/path/to/report.html" --output ./updated.html --yes
```

`view <file>` is the minimum direct command. Existing-run regeneration (`view --run`) and direct multi-file docking CLI inputs are deferred; hooks already support complex scenes without growing CLI scope.

`view`: `--output <file>`, `--open`, `--json`. `visualizer update <report>`: `--output <file>`, `--open`, `--yes`, `--json`. JSON output is one structured result on stdout; logs/errors must not corrupt it. Default never opens a browser automatically. Explicit `--open` is allowed for generation/update.

Reuse repo exit-code conventions: usage/invalid report = 2, confirmation required in noninteractive update = 2, unexpected internal error = 10. Opening failure after a successful write reports a warning and the usable path, rather than rolling back report. Declined confirmation = successful no-op (`status: "cancelled"`), no mutations. No-TTY/`--json` requires `--yes` for any replacement, including a separate output file. Exact matching viewer is a successful no-op, no prompt; an explicit separate `--output` may copy after confirmation instead.

Open browser through a small runtime helper using structured executable + args (`open` on macOS, `xdg-open` on Linux). No shell interpolation. Do not broaden platform support unnecessarily. Paths containing spaces, quotes, `$()`, backticks, Unicode, and leading dashes must never execute as shell code.

## 9. Update UI and local replacement

Button label: **Update viewer**. Clicking only displays this modal:

> Use your installed MoleculeDesk to update this report.
>
> 1. Copy the command below.
> 2. Run it in your terminal and confirm.
> 3. Refresh this report when finished.

```sh
moldesk visualizer update "/path/to/report.html"
```

Provide Copy command. Clipboard API may not work under `file:` in all browsers; selectable text/manual copy is the fallback. No network/file-write permission prompts from the modal. Do not start a server, launch CLI, probe installed version, or perform requests from browser.

Infer current path only from current `file:` page URL when possible; otherwise retain placeholder. A moved report must not use its creator's original path. Displayed/copied commands must use proper shell quoting for supported macOS/Linux shells, not JSON stringification; if path cannot be safely inferred, use placeholder. Never store full original paths inside portable reports.

CLI reads trusted installed `bundle.json`, then inspects target as data. Compare bundle digest/build identity, not just semantic version. Same version with a different build should still offer replacement. Local metadata is authoritative; report-declared version is informational and untrusted.

- Same local bundle and wrapper/template identity, with actual file matching the trusted reconstructed report: `This report already uses your current viewer.`
- Different compatible bundle: offer installed replacement, regardless of older/newer version.
- Unsupported schema: `Your installed MoleculeDesk cannot update this report. Your report has not been changed.`

Confirmation (keep researcher-facing text, not implementation terminology):

```text
Update this report’s viewer?

Your structures and results will stay unchanged.
A backup of your current report will be saved.

Continue? [y/N]
```

For `--output`, replace backup sentence with `Your updated report will be saved as a separate file.` Include target path separately. `--yes` bypasses prompt, never compatibility/source validation.

Success:

```text
Viewer updated. Refresh your report to see the changes.
Backup saved: /path/to/report.backup.html
```

Use unique backups if name already exists; never overwrite an existing backup. With `--open`, open updated file, but do not claim existing tabs were refreshed. Browser cache may require user reload; use the self-contained artifact, not remote assets.

## 10. Report envelope, compatibility, and safe updating

Use a recognizable, versioned report envelope separate from executable viewer code, for example one uniquely identified inert `script[type="application/json"]` block containing JSON:

```ts
interface ReportEnvelopeV1 {
  magic: "moldesk-molecular-report";
  envelopeVersion: 1;
  payloadEncoding: "base64-json";
  payload: string;              // UTF-8 MolecularReportV1 JSON → base64
  payloadSha256: string;
  viewer: {
    version: string;
    molstarVersion: string;
    bundleSha256: string;
    templateVersion: number;
  };
  lastUpdatedAt?: string;
}
```

Build metadata lists compatible envelope/report schema versions and digests of shipped assets. Compute aggregate bundle digest deterministically over assets using an explicit order. A checksum is consistency/integrity evidence, not authentication of a malicious report; do not claim otherwise.

Encode body so `</script>`, quotes, Unicode, malicious titles, and molecular comments cannot escape into executable HTML. Escape all template text/attributes independently. Browser UI uses React escaping or `textContent`, never untrusted `innerHTML`. Render CSV/JSON content as data.

Updater algorithm:

1. Inspect regular target file; reject symlinks, missing/duplicate envelope, unrecognized HTML, unsupported schemas, malformed/base64-invalid/oversized payload, inconsistent resource hashes/references.
2. Read/decode only the bounded inert envelope. Do not execute/import old scripts, use a browser to inspect it, follow paths in payload, or parse arbitrary HTML as a script-bearing DOM. A narrow exact-envelope extractor is sufficient; reject ambiguity. No general HTML rewriting engine.
   Report-declared bundle hashes alone do not prove existing scripts are trusted. Before a same-bundle no-op or `--open`, compare actual HTML with deterministic reconstruction using installed template/assets and preserved envelope. A mismatch requires confirmed regeneration; never open unverified old executable content merely because its metadata claims a matching version.
3. Preserve validated report payload verbatim for schema v1; viewer-only update cannot normalize/rewrite coordinate/metric bytes. Retain payload digest. Change envelope viewer metadata/update time and trusted template only.
4. Generate complete replacement from installed trusted template/assets. Do not regex-replace script tags or copy old executable HTML/CSS into new report.
5. Before commit, ensure inspected target has not changed since confirmation (identity/stat + digest). Reject conflicts. Stage temporary file in destination directory; retain permissions appropriately; clean failed temporary files.
6. For in-place update, create exclusive backup of inspected original bytes before atomic rename. For `--output`, refuse existing destination and preserve original; use race-safe exclusive publication. Never unlink original first.
7. Return updated path/digest/version and backup path. No sibling manifest edits, source file edits, or package updates.

For initial v1 accept only supported v1 reports. Do not implement a generic migration registry. Later schema migrations must be explicit, local, tested, and preserve scientific resource hashes; unsupported migration must leave file untouched. Node update can be tested with deliberately malformed/untrusted HTML without running any JS.

## 11. Offline and security requirements

Zero internet requests includes requests blocked by a policy, not merely successful requests. Disable/remove network-capable Mol* behaviors rather than relying solely on CSP.

- No fetch/XHR/WebSocket/EventSource/sendBeacon, remote script/style/font/image loads, update checks, resource prefetch, remote annotations, structure downloads, volume streaming, remote state, telemetry, error-reporting services, or service workers.
- Mol* initializes from embedded raw bytes through data builders. Avoid `loadPdb`, URL loaders, relative-file fetch, and remote preset/property providers. Audit default plugin behaviors/extensions; disable remote-dependent ones and remove corresponding controls. Local tasks/workers may be used only with fully embedded assets and no remote dependencies.
- Source refs resolve only against exact verified run outputs and staged inputs. Recheck regular files/path confinement at consumption; never allow adapter-requested arbitrary reads or symlink escape. Explicit standalone inputs follow the documented regular-file policy.
- Bound source/report sizes before reading/decoding; check base64 decoded lengths, nesting, counts, and total bytes. Use named limits/options internally with readable failures. Choose practical measured limits for scientific datasets; do not silently truncate. No gzip/zip inputs initially, avoiding decompression complexity.
- Resource hashes are over original bytes. Validate payload/resource integrity during update. Do not embed original absolute paths, environment variables, secrets, command lines, logs, or entire run records; only allowed provenance fields.
- Ship a restrictive meta CSP early in trusted template: `default-src 'none'`, `connect-src 'none'`, explicit hashes for trusted inline script/style blocks, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`. Add only observed necessary local allowances (e.g. blob images for PNG preview, blob workers if truly required). No `unsafe-eval`; prefer no `unsafe-inline`. Mol* may require style attributes: isolate and justify the narrowest compatible style policy, rather than weakening script/network rules. Test policy on actual browsers.
- Never execute source/report-provided code. No extensible arbitrary scripts or unsafe chart plugins. Validate allowed chart fields/color values; no arbitrary CSS injection.
- CLI opens only generated/validated local report, via structured process invocation. Updating ordinary HTML is rejected. Backup/update operations use safe path handling and do not accept URL sources.

Dependency download during developer install/build and existing MoleculeDesk package distribution are outside offline report runtime. Do not have exported HTML or visualizer CLI download missing dependencies/assets on demand. If installed bundle is missing/corrupt, fail with local repair instructions.

## 12. Performance and packaging

- Build once: minified browser bundle, matching CSS and metadata. No per-run bundler invocation or headless browser.
- Each export: bounded input reads, encoding/validation, trusted template assembly, atomic write. Avoid repeated coordinate parsing or hashing when core already has verified bytes/hashes; preserve verification where data could change.
- Browser parses only selected scene initially; do not initialize one viewer per pose. Deduplicate shared receptor/CIF resources within report. Base64 costs ~33% storage overhead; account for whole envelope memory and avoid unnecessary copies where practical.
- Single-file bundle duplication across different reports is an accepted initial tradeoff. No shared global JS file, mutable `latest.js`, or adjacent CDN path. Future localhost delivery can reuse contract/browser UI with another resource loader, but is not implemented now.
- Measure exporter time, artifact size, browser first structure time, and scene-switch memory for representative small proteins, protein–DNA complexes, receptor/pose sets, and larger campaigns. Record hardware/browser; avoid absolute unmeasured speed guarantees.
- Set `files`/exports so published package contains compiled Node code, type declarations, and generated assets. Do not expose TS source-only/browser build paths to consumers.
- Update pack/release/version lists and relevant CI publishing/install smoke tests wherever packages are explicitly enumerated (`scripts/pack-verify.mjs`, `scripts/release-lib.mjs`, build targets, workflow package lists). Follow existing release convention; do not refactor release tooling beyond adding package/supporting assertions.
- Installed CLI must generate/update reports from an unrelated cwd with no repository/node_modules-relative asset assumptions. Locate assets via package/module URL.

## 13. Implementation order

1. Create visualizer package and narrow report/envelope validators. Build offline Mol* bundle + template. Spike PDB and mmCIF opening under actual `file:` URLs with sequence correspondence; verify network silence early before polishing UI.
2. Add standalone core/CLI `view` path, output handling, optional browser opening, and packaging gate.
3. Add safe local CLI update and UI instructions using same exporter/template, backups, no-op/conflict behavior, and exact data preservation.
4. Add optional adapter hook, core nonfatal postprocessing, run artifacts/warnings, `--no-visualize`, and external report copy. Implement Boltz/OpenDDE descriptions.
5. Implement BindCraft2/DiffDock descriptions with existing layouts and staged receptor sources. Add table panel/actual chart fixture without inventing future model metrics.
6. Finish clean layout, scientific edge cases, appropriate verification/docs, typecheck/tests/package smoke. Remove experiment scaffolding and unused abstractions.

Keep work scoped. No broad refactoring, localhost services, automatic updater, generic plugin framework, molecular parser rewrite, new mandatory Python runtime, or edits to unrelated website/desktop code.

## 14. Meaningful verification and acceptance criteria

Reuse Vitest and existing CLI test patterns. Add focused tests for new boundaries, not implementation-mirroring tests. A browser smoke harness is justified for Mol*/offline behavior; reuse existing facilities if available and avoid downloading browsers during user commands.

Required coverage:

- Portable PDB/mmCIF report opens from `file:` after moving it away from source/installation. Browser can render and show synchronized sequence; no adjacent files required.
- Protein + DNA/RNA, multiple chains/models, insertion codes, modified/missing residues, ligand-only case. Synthetic fixtures must be chemically/structurally meaningful enough for Mol* parsing.
- Docking receptor + pose overlay preserves coordinates; scene switch changes pose and reuses receptor. OpenDDE CIF/PDB duplicates are not duplicate predictions. Confidence associations correct for multiple samples; arbitrary B-factors not mislabeled.
- Network instrumentation records **zero attempts** during startup, selection, scene changes, export, and update-modal/copy interactions; test both online-capable and network-denied environment. Assert request/WebSocket creation, not just successful external responses. Verify no blocked network errors masked as normal operation.
- Malicious `</script>`/HTML in labels/files, prototype-sensitive keys, remote refs, excessive payloads, invalid hashes/references, duplicate envelopes, symlink escapes, unsupported schemas: readable rejection, no execution/network, unchanged target.
- Update uses installed assets only; same-bundle no-op, different older/newer compatible bundle, `--yes`, non-TTY, declined confirmation, `--output` collision, backup collision, interrupted/failed write, changed file during prompt. Original resource/payload hashes unchanged after successful update.
- Successful model stays succeeded when describing/exporting report fails. Failed/cancelled model skips report. Legacy adapter without hook works. `--no-visualize` bypasses hook/exporter. `--output` contains portable report; no overwrite; JSON remains parseable.
- Packaging smoke installs tarballs in temporary unrelated project and generates/updates report from unrelated cwd. No unshipped assets or browser/Node import contamination.
- Browser smoke in Chrome/Chromium plus Safari/Firefox where available; document actual tested matrix and limitations rather than claiming universal support. WebGL failure and clipboard fallback usable.
- Run relevant package tests/typechecks, then `pnpm build` and `pnpm pack:verify`; broaden tests only for failures/shared contract changes. Record actual results.

Done means direct CLI generation, automatic eligible-model reports, portable offline rendering, and local update flow all work. Implementation handoff should list changes, verification, measured limitations, and any deliberately deferred chart feature; no unfinished core offline/update behavior.

## 15. Reference material

Use official docs/source for chosen pinned Mol* version; do not copy CDN examples literally into an offline exporter.

- Mol* integration, bundle/plugin/sequence UI: https://molstar.org/docs/plugin/instance/
- MolViewSpec selections/structures/assemblies: https://molstar.org/mol-view-spec-docs/tree-schema/
- Browser file origins: https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy#file_origins

Final design reminder: one modular viewer, one versioned report contract, one trusted exporter; adapters describe results; installed CLI performs explicit local updates. No internet requests anywhere in visualizer runtime.
