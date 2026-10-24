# Offline molecular reports

MoleculeDesk can turn structures into a **single, self-contained HTML report** with an interactive, fullscreen 3D view (Mol*) with MoleculeDesk's own sequence strip and a floating toolbox, on an always-dark background. A report opens from disk in a normal browser, works with no internet connection, and keeps working after you move it anywhere.

The design contract is in [`offline-visualizer-implementation-plan.md`](./offline-visualizer-implementation-plan.md). This page describes what is implemented, how to use it, and where the limits are.

## Using it

```sh
moldesk view ./protein.pdb                          # writes a report under MoleculeDesk's cache
moldesk view ./complex.cif --output ./report.html   # explicit file; refuses to overwrite
moldesk view ./protein.mmcif --json                 # one JSON object on stdout
moldesk view ./protein.pdb --open                   # also open it in your default browser

moldesk run boltz ./job.yaml                        # successful runs get <run>/artifacts/viewer.html
moldesk run boltz ./job.yaml --no-visualize         # skip the report
moldesk run boltz ./job.yaml --output ./results     # copies moldesk-report-<run-id>.html too

moldesk visualizer update ./report.html             # replace the report's viewer (asks first)
moldesk visualizer update ./report.html --output ./updated.html --yes
```

`view` accepts local PDB (`.pdb`) and macromolecular mmCIF (`.cif`, `.mmcif`) files. `.cif` means macromolecular mmCIF; arbitrary crystallographic CIF is not supported. Nothing is converted: the original bytes are embedded.

Nothing opens a browser unless you pass `--open`. If opening fails the report is still written, you get a warning, and the exit status stays 0.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success (including a declined confirmation and "already up to date") |
| 2 | Invalid input or report, `--output` already exists, unsupported report, update needs confirmation (`--yes`) |
| 8 | Cancelled |
| 10 | Unexpected internal error |

With `--json`, the result (or an error object) is a single JSON document on stdout; logs never mix into it.

## Highlights and coloring (the Scene API)

```sh
moldesk view p.pdb --highlight A:40-60                          # sticks, palette color
moldesk view p.pdb --highlight A:40-60 --highlight B:12 --color '#ff5500'   # one color for all
moldesk view p.pdb --highlight A:40-60 --highlight B:12 --color '#ff5500' --color '#00c2ff'
moldesk view p.pdb --color-by plddt --bfactor-is-plddt           # AlphaFold confidence classes
moldesk view --scene scene.json                                  # the same, as JSON
```

Selectors use the [shared grammar](./analysis-json.md#selectors) (`A`, `A:45`, `A:40-60`, `A:52A`); `--label` reads them as label ids. A highlight that matches nothing exits 2 (`SELECTOR_NO_MATCH`) and writes no report; the error says whether the chain or the residue is missing and lists the chains and residue ranges the file has (also as `details.available` with `--json`). `--color` takes one color for every highlight or one per `--highlight`.

A scene file is a documented subset of the report's `Scene`/`SceneComponent` contract, with a selector string in place of `selection`. Unknown keys are rejected:

```json
{
  "structure": "p.pdb",
  "colorBy": "chain",
  "label": false,
  "bfactorIsPlddt": false,
  "components": [
    { "selector": "A:40-60", "color": "#ff5500", "label": "Active site", "representation": "sticks" }
  ]
}
```

`structure` is optional when `<file>` is given (not both) and must be a relative path inside the scene file's folder. `--scene` cannot be combined with `--highlight`, `--color` or `--color-by`.

How it maps to the report: a scene with components draws only those components, so the report gets a base layer (the whole structure as an uncolored cartoon, which the viewer colors by chain, plus ligands and ions as sticks) and one component per highlight. Highlights default to `sticks` because a second cartoon over the base cartoon would z-fight; `representation` can be overridden in a scene file. A whole-chain highlight becomes a `chains` selection, anything else an explicit residue list (at most 10,000 residues per selection, else `SCENE_TOO_LARGE`).

`--color-by plddt` needs a known pLDDT source (see [analyze.md](./analyze.md#confidence)), otherwise it fails with `PLDDT_UNAVAILABLE`. Residues go into the AlphaFold DB classes (≥ 90 `#0053d6`, 70-90 `#65cbf3`, 50-70 `#ffdb13`, < 50 `#ff7d45`), one cartoon component per class; ligands keep their element colors.

**Compatibility decision.** Per-residue color needs no new contract field: classes are ordinary `residues` components with a `color`. So reports keep `schemaVersion: 1` and `envelopeVersion: 1`, every existing viewer renders them, and `moldesk visualizer update` behaves as before. Reports from an incompatible future version are still refused by the updater (`planUpdate` returns `unsupported`). The trade-off: four classes, not a continuous gradient.

## What a report contains

One HTML file with:

- the trusted viewer (Mol* 5.12.0, React, CSS), inlined;
- an inert JSON **envelope** holding the report payload (`<script type="application/json">`), never executed;
- your original molecular files, tables, and scene definitions inside that payload, with SHA-256 digests.

It contains no file paths, URLs, commands, environment variables, logs, or run records. Provenance is limited to creation time, run id, model name, and model version.

Reports are one per run, with a scene selector for multiple predictions or poses, rather than one duplicated file per result. A viewer is about 3.6 MiB, so even a tiny structure produces a ~3.8 MiB file; data is stored base64-encoded inside the payload (roughly 1.8× the source size).

## Models

| Model | Report |
| --- | --- |
| Boltz | One scene per predicted structure, titled "Prediction 1, 2, …". The `_model_<n>` number only orders scenes; **no rank is invented**. Confidence and affinity JSON are attached by exact file name, shown as tables. |
| OpenDDE | One scene per job/seed/sample mmCIF. The exported `.pdb` files are the same prediction in another format and are not extra scenes. Summary confidence is matched by exact job/seed/sample name. |
| BindCraft2 | Accepted designs first, ranked by the `rank` column of the ranked table; then refolded and trajectory structures. A tier is included whole or not at all (never cut partway) and only if it fits the 256-scene limit. No eligible structure means no report. |
| DiffDock | The staged receptor plus each ranked pose in one scene, in the receptor's coordinate frame (no alignment is applied). Rank and confidence come from the pose summary. **A missing receptor produces a warning and no report**: a ligand shown alone would misrepresent a docking result. |
| ProteinMPNN, LigandMPNN | No automatic report. They produce sequences, not coordinates. |

A report problem never fails a successful run. It becomes an entry in `run.json` `warnings` (visible in text and `--json`), and the run keeps its status and exit code. Failed and cancelled runs produce no report. Cancelling during report generation keeps the model's result and writes no file.

Only exact, already-checksummed files are embedded: the adapter returns file references, and core accepts a reference only if it matches a recorded output or staged input, is a regular non-symlink file inside the run directory, and still matches its recorded SHA-256 when read.

## Viewing scientific data correctly

- Mol* derives chains, polymer types, residues, entities, ligands, and sequence from the file itself. The report does not copy a second hierarchy. MoleculeDesk's sequence strip is built from Mol*'s own hierarchy and color theme at load time; the report does not store it.
- The sequence strip comes from the structure's sequence, not a join of ATOM records. **Unobserved (missing) residues stay in position and are marked missing.** Residue numbers use author numbering with insertion codes preserved (hovering residue 52A shows `ASN 53 [auth 52]A`). **Modified residues are kept and shown as themselves** (`MSE`, `CSS`, underlined), not collapsed or hidden.
- The strip has one row per polymer chain (up to 24; the rest are noted), in blocks of ten with position numbers. Each letter takes the color the structure is drawn with (chain colors by default). Hovering a residue highlights it in 3D and names it; clicking selects and focuses it, and clicking it again clears the selection. DNA, RNA and protein chains each get their own row. Symmetry copies from assemblies are not repeated.
- Structures with several models show a clear note ("This file has N models; showing model 1."). Models are not treated as independent predictions.
- Ligand-only files render, with "No polymer sequence in this structure."
- Default display: polymer cartoon, ligands as sticks, waters hidden. You can change style, show or hide ligands and water, switch background, fit the view, and save a PNG.
- **No confidence coloring is applied.** B-factors are not assumed to be pLDDT, and global scores are not per-residue values. Scores appear only as labeled tables.
- Scenes with several files (receptor + poses) must already share coordinates; nothing is aligned. By default the original model coordinates are used, not biological assemblies.

## Updating a report's viewer

Reports embed the viewer, so an old report keeps working with the viewer it was made with. To replace it with the viewer installed alongside your MoleculeDesk:

```sh
moldesk visualizer update ./report.html
```

The **Update viewer** button inside a report only shows these instructions and a copyable command (with your report's actual path, safely quoted, when the browser exposes it; otherwise a placeholder). It performs no update and no network request.

How the CLI update works:

1. The target is read as data and never executed. Symlinks, non-reports, duplicate envelopes, bad base64, oversized payloads, unsupported schemas, and inconsistent hashes are rejected, and the file is left untouched.
2. Your structures and results are preserved byte-for-byte; only the viewer and the envelope's viewer metadata change.
3. "Already current" is decided by rebuilding the report from the installed bundle and comparing bytes. Metadata that merely *claims* a matching version is not trusted, so an edited file is regenerated (after confirmation) instead of being treated as current or opened.
4. A different local bundle, older or newer, is replaced with the installed one.
5. You confirm first (`--yes`, or an interactive `y`). With `--json` or no TTY, confirmation requires `--yes`. Declining is a successful no-op.
6. In place: an exclusive backup of the original bytes (`report.backup.html`, then `-1`, `-2`, …, never overwritten) is written, then the file is replaced atomically. If the file changed after planning, nothing is changed. With `--output`: the original stays, and the destination must not exist.

A checksum is consistency evidence, not authentication of a malicious report.

**Run records after an update.** `run.json` records the digest of the report as originally generated. An explicit update later changes that file, so the recorded digest legitimately no longer matches. `run.json`, model output hashes, and other files are never rewritten by an update. The embedded payload digest (the data itself) is unchanged.

## Offline guarantee and security

The report makes no network requests, including ones that would be blocked:

- No fetch, XHR, WebSocket, EventSource, beacon, service worker, remote script/style/font/image, update check, telemetry, or structure/annotation download. Mol* starts from embedded bytes. Its remote-capable parts are removed from the plugin (download actions, volume streaming, the PDBe/SIFTS sequence mapping, and the remote state-snapshot panel, which would otherwise request a state list from a public server on load).
- A strict CSP is embedded: `default-src 'none'`, `connect-src 'none'`, scripts and styles allowed only by hash, `object-src`, `base-uri`, `form-action` none, no `unsafe-eval`, no `unsafe-inline`; only `data:`/`blob:` images and `blob:` workers are allowed.
- Titles, labels, and file contents (including `</script>` and HTML in molecular comments) are inert data. They are rendered as text and cannot reach executable HTML.
- Updating, `view`, and report generation never download, bundle, install, or launch Python. The viewer is built once when the package is built.
- Opening a browser uses an executable plus arguments (`open` on macOS, `xdg-open` on Linux), never a shell, so unusual paths are inert.

Model installation and execution keep their existing network behavior. This applies to the visualizer only.

## Limits

Reports are bounded and fail with a readable message instead of truncating:

| Limit | Value |
| --- | --- |
| One embedded file | 64 MiB |
| All embedded files | 256 MiB |
| Report file read by the updater | 400 MiB |
| Scenes / resources / panels | 256 / 512 / 64 |
| Table rows / cells | 100,000 / 2,000,000 |

Gzip/zip inputs are not supported.

## Deferred

- **Chart rendering.** The contract defines line/scatter/bar/heatmap chart panels and validates them, but no current model output exercises a numeric series, so charts render as a labeled data table. A future adapter (for example a score-table model) can use the existing panel type.
- `moldesk view --run <id>` (regenerating a report for a past run) and multi-file `view` inputs.
- A localhost server, automatic updates, and a plugin system are deliberately not part of this design.

## Verification and measurements

```sh
pnpm --filter @moldesk/visualizer test      # unit tests
pnpm --filter @moldesk/visualizer smoke     # real-Chrome acceptance check
pnpm --filter @moldesk/visualizer measure   # timings below
pnpm pack:verify                            # installs the tarballs, runs view + update from an unrelated cwd
```

The smoke harness drives your installed Chrome (it never downloads a browser). **It exits with code 2 and prints `SKIPPED` if Chrome is missing; a skip is not verification.** It records every attempt at a network API *before* the viewer starts (fetch, XHR, WebSocket, EventSource, beacon, workers, service workers, resource elements), plus CDP network/WebSocket/blocked events and CSP violations, and it runs online and with the browser offline. It checks:

- a moved report renders from `file:` fullscreen on a black background, with the translucent blurred toolbox, the colored ten-letter-block sequence, hover highlighting in 3D, PNG export, scene switching, the results table, the MoleculeDesk footer links and the Mol* credit, and the update modal;
- a report updated by the local updater renders offline;
- a hostile report (script and HTML in the title and file comments) executes nothing and shows the title as text;
- DNA/protein complexes, missing residues in position, insertion codes, modified residues, NMR models, and ligand-only structures;
- receptor + SDF pose scenes (the DiffDock shape);
- a clear WebGL-unavailable message, with the rest of the report still usable.

### Tested browsers

| Browser | Status |
| --- | --- |
| Chrome 154.0.8037.99, macOS arm64 | Automated: all checks above pass |
| Firefox, Safari | Not tested. Report rendering, clipboard, and `file:` behavior may differ; not claimed |

The report uses `navigator.clipboard`, which some browsers restrict on `file:` pages. The update modal falls back to selectable text and says so.

### Measurements

Apple M3 (8 cores, 24 GiB), macOS arm64, Node 22.23.2, Chrome 154.0.8037.99 headless with **software WebGL (SwiftShader)**, viewer 0.0.3 with Mol* 5.12.0. Run once; treat as indicative, not a guarantee.

"First structure" is page navigation until the scene is loaded into the viewer (data parsed and representations built), including the 3.6 MiB viewer parse. "Scene switch" is the same up to the loaded scene. Neither includes display time on a real GPU.

| Case | Export (median of 5) | Report size | First structure | Scene switch | JS heap after load | JS heap after 3 switches |
| --- | --- | --- | --- | --- | --- | --- |
| Small protein (crambin, 46 res, PDB) | 5 ms | 3.75 MiB | 4073 ms | n/a | 28.40 MiB | n/a |
| Protein–DNA complex (1AAY, PDB) | 6 ms | 3.91 MiB | 2504 ms | n/a | 31.17 MiB | n/a |
| Receptor + 20 SDF poses | 5 ms | 3.78 MiB | 2322 ms | 47 ms | 32.08 MiB | 34.52 MiB |
| Campaign: 30 × protein–DNA complex | 51 ms | 10.99 MiB | 2347 ms | 102 ms | 43.08 MiB | 46.10 MiB |

The first row includes a cold start (first page in a fresh browser); the others are warm. One viewer is created per report and one scene is loaded at a time.

## Known limitations

- The report is always dark; it does not follow the browser's light/dark preference, and the 3D background is always black.
- The footer shows the MoleculeDesk website, docs and GitHub links; they open in a new tab only when clicked and make no request otherwise. The viewer version and the required Mol* MIT credit are under "About".
- Report size has a fixed ~3.6 MiB viewer cost, duplicated per report by design (no shared script, no CDN).
- For mixed protein/nucleic files, Mol* shows the first entity by default (nucleic entities list first).
- Reports cannot guarantee GPU rendering; without WebGL the viewer shows an actionable message.
- The viewer's CSS still includes Mol*'s light skin; MoleculeDesk's own styles cover everything visible in the report.
