# Structure intelligence: implementation plan

Target: one release, one week. Build in the order below; each feature depends on the ones above it.
**Must ship:** F1–F5. **Cut from the bottom** if the week slips. **Stretch:** S1.

Product goal (the demo in F10): fetch a protein → predict it → analyze it → highlight regions → compare against an experimental structure → offline report. Every step is a CLI command with stable `--json` output that an agent can chain.

## Ground rules (apply to every feature)

- **Verify before coding.** Read the real, pinned source/API of every upstream dependency (Mol*, US-align, RCSB, AlphaFold DB, UniProt). Do not guess flags, output formats, URLs, or file layouts. Record what you verified in the PR description.
- **Thin CLI.** Logic lives in `packages/core` (or a new `packages/analysis`); `apps/cli/src/commands/*` only parses flags and prints.
- **JSON output.** With `--json`, stdout carries exactly one JSON document; logs go to stderr. Errors use the existing shape `{ status: "error", code, message, remediation }` (`apps/cli/src/utils/report-errors.ts`).
- **Exit codes.** Reuse the existing ones: 0 ok, 2 invalid input/usage, 8 cancelled, 10 internal. New error codes go in the `EXIT_CODES` map.
- **Security.** Confine every written path with `path.relative()` checks. Validate IDs before using them as path segments or URL parts. Write files atomically. Never overwrite without `--force`/confirmation. Audit and pin every download (URL + SHA-256 or size cap + content check). No silent fallbacks: if a capability is missing, fail with a remediation.
- **Units.** Distances in Å, angles in degrees. Residues are always identified with both `auth` and `label` ids (same as `ResidueRef` in `packages/visualizer/src/contract.ts`).
- **Never invent science.** A B-factor is reported as pLDDT only when the source is known to store pLDDT there (F1). Unknown → `null` plus a warning.
- **Definition of done (per feature):** `pnpm typecheck && pnpm lint && pnpm test && pnpm pack:verify` pass; docs page and `CHANGELOG.md` updated; fixtures committed (PDB entries are CC0).

---

## F1: Analysis JSON contract (Day 1)

**Want:** one versioned envelope shared by `analyze`, `inspect`, `compare`, `fetch` and `describe`, so agents can rely on it.

```jsonc
{
  "schemaVersion": 1,
  "kind": "moldesk.analysis",          // moldesk.inspect | moldesk.compare | moldesk.fetch | moldesk.model
  "status": "ok",
  "input": { "path": "…", "format": "pdb|mmcif", "sha256": "…" },
  "result": { /* kind-specific */ },
  "warnings": [{ "code": "…", "message": "…" }],
  "provenance": { "moldeskVersion": "…", "tool": { "name": "usalign", "version": "…" } }
}
```

- TS types plus a JSON Schema per `kind` in `packages/core/src/schemas/`.
- `moldesk schema <kind>` prints the schema, so agents can discover it.
- Shared selector grammar, parsed once in core: `A`, `A:45`, `A:40-60`, `A:52A` (insertion code). The default namespace is `auth`; `--label` switches it.

**Test:**
- Unit: validate every command's `--json` output against its schema in tests. Reject unknown `kind`/`schemaVersion`. Reject `__proto__` keys (mirror `contract.test.ts`).
- Selector parser: valid and invalid table (`A:`, `A:60-40`, `:5`, `A:4x` → exit 2).

## F2: `moldesk analyze <file>` (Days 1–2): includes sequence extraction and FASTA validation

**Want:** a structural summary of a PDB/mmCIF file.
- Models, chains (auth and label ids, entity type: protein, DNA, RNA, ligand or water) and residue counts.
- Per-chain one-letter sequence (`X` for non-standard residues), plus gaps (numbering jumps, plus mmCIF unobserved-residue records when present).
- Secondary structure (helix/strand/coil fractions and per-residue). Mark the source: `"file"` (HELIX/SHEET records) or `"computed"`.
- Geometry: center of mass, radius of gyration and bounding box (Å).
- Confidence:
  - per-residue pLDDT only from a known source: a ModelCIF `ma_qa_metric`, MoleculeDesk run outputs (Boltz/OpenDDE), or an explicit `--bfactor-is-plddt`;
  - otherwise `confidence: null` plus a warning;
  - attach Boltz confidence JSON when the file comes from a run directory.
- `--fasta` writes the chain sequences as FASTA. `moldesk analyze --validate-fasta <file>` checks alphabet, empty records and duplicate headers.

**Parser decision (spike first, ≤2 h):** prefer the already-bundled Mol* running headless in Node (keeps the runtime Python-free). Verify that it parses PDB/mmCIF and computes secondary structure in Node. If not, use gemmi in a managed Python env. Document the choice.

**Test:**
- Golden JSON for committed fixtures: a small single-chain protein (e.g. 1CRN), a multi-chain complex with a ligand, an NMR multi-model file, a file with insertion codes and altlocs, a Boltz output with confidence JSON.
- Reference values (Rg, residue counts, sequences) generated once by an independent tool (gemmi/Biopython script kept in `scripts/`), compared with tolerance 1e-3 Å.
- Bad input: empty, truncated, binary or oversize file → exit 2 and a specific error code. An experimental structure's B-factors are never reported as pLDDT.

## F3: `moldesk inspect <file> <selector>` (Day 2)

**Want:** zoom in on a chain, residue or range.
- Per residue: name, auth/label ids, secondary structure, pLDDT (if known), atom count.
- `--radius <Å>` (default 5) lists neighboring residues within that heavy-atom distance, with the minimum distance and the atom pair.

**Test:**
- A hand-built tiny PDB with known coordinates (two residues 3.4 Å apart, one 8 Å away) gives exact neighbor results at radius 4 and 9.
- A selector with no match → exit 2 (never an empty success).
- An insertion-code selector resolves correctly.
- Output validates against the F1 schema.

## F4: Highlighting and coloring in reports (Day 3): includes the "Scene API"

**Want:**
- `moldesk view <file> --highlight A:40-60 [--highlight B:12] [--color '#ff5500'] [--color-by chain|plddt]`.
- `moldesk view --scene scene.json` accepts the same thing as JSON (this is the "Scene API": a documented subset of the existing `Scene`/`SceneComponent` contract, not a new format).
- Highlights map to `SceneComponent.selection` and `SceneComponent.color`.

**Constraint:** `--color-by plddt` needs a new contract field. Adding fields to `MolecularReportV1` requires following the compatibility rules in `packages/visualizer/src/update.ts` (schema/envelope versions). Decide on a v1-compatible encoding or a deliberate v2. Do not break reports that are already out in the wild.

**Test:**
- Unit: selectors become the expected components.
- Contract tests for the new fields, including that an old viewer refuses a newer report cleanly.
- A highlight that matches nothing → exit 2.
- The browser smoke harness renders a highlighted report with no console errors.

## F5: `moldesk compare <a> <b>` with US-align (Day 4)

**Want:**
- Output: TM-score (normalized by each structure), RMSD, aligned length, sequence identity, a 4×4 superposition transform, and the residue mapping (a→b pairs).
- `--chain-a/--chain-b` for single-chain comparison; multimer mode for complexes.

**Install:** `moldesk install usalign` as a managed tool through the existing atomic installer.
- Pin the upstream release/commit plus SHA-256.
- Decide between building from source (needs a C++ compiler; detect it in `doctor`) and a pinned bioconda package.
- Check the license first.
- Parse US-align's machine-readable output mode, verified against the pinned version.

**Test:**
- Parser unit tests on captured US-align stdout fixtures.
- Self-compare: TM = 1.0, RMSD ≈ 0.
- A fixture against a copy with a known rigid transform applied: TM ≈ 1.0, and the returned transform inverts the applied one (tolerance 1e-3).
- US-align not installed → error code with an install remediation (no fallback).

## F6: Overlay report (Day 5)

**Want:**
- `moldesk compare a b --report out.html`: one scene with both structures, where b carries `SceneStructure.transform`. Convert US-align's row-major rotation and translation to a column-major Mat4.
- Per-residue deviation (aligned Cα distance after superposition) as a JSON dataset, a line chart panel, and highlighted residues above `--deviation-threshold` (default 2 Å).
- No synchronized side-by-side view (cut).

**Test:**
- Unit test of the matrix conversion with a known rotation and translation.
- Exporter test: the scene has 2 structures and the transform is applied to the right one.
- Smoke harness: the overlay renders. Self-compare gives zero deviation everywhere.

## F7: `moldesk fetch <source>:<id>` (Day 5)

**Want:**
- `pdb:1M17` (mmCIF/PDB), `afdb:P00533` (AlphaFold DB model), `uniprot:P00533` (FASTA).
- Cache under `~/.moldesk/cache/fetch/<source>/<id>/`, with a provenance sidecar: URL, retrievedAt, SHA-256, source version, license.
- `--output <dir>` copies the files out; `--refresh` re-downloads.
- No search (cut); the agent finds the ID itself.

**Rules:**
- Validate the ID with a strict regex per source **before** any network call or path join.
- HTTPS only, to an allowlisted host per source, with no cross-host redirects.
- Response size cap and content sniffing (`data_` for mmCIF, `>` for FASTA).
- Atomic writes.
- Resolve the AFDB file URL through its API instead of hardcoding a model version.

**Test:**
- A local mock HTTP server: success, 404, oversize response, wrong content, redirect to another host. The last three are each rejected and nothing is written.
- Traversal IDs (`../x`, `1M17/..`, URL-encoded) are rejected before any network call.
- A cache hit makes no network request.
- Live tests are opt-in with `MOLDESK_LIVE_FETCH=1`.

## F8: `moldesk describe <model> --json` (Day 6): covers model discovery, parameter schemas and hardware fit

**Want:**
- One document per model: capabilities, accepted inputs and formats, parameters (name, type, default, range, from `packages/adapters/src/params.ts`), hardware requirements, the current machine's compatibility verdict (reuse the doctor/compatibility logic), cloud availability and license.
- `moldesk list --json` stays as the index.

**Test:**
- Every catalog model's output validates against its schema.
- Consistency test: the set of parameters in `describe` equals the set that run-time validation accepts, for every model.
- The compatibility verdict matches `doctor` on mocked hardware profiles.

## F9: Agent skill update (Day 6)

**Want:**
- Extend the existing skill (`plugins/moldesk/skills/moldesk/`, `references/cli.md` and `workflows.md`) with `analyze`, `inspect`, `view --highlight`, `compare`, `fetch`, `describe`, `schema`.
- Add a recipe for the F10 flow.
- Keep the existing ground rules: ask before installs, network fetches and cloud runs.

**Test:**
- A script checks that every command and flag the skill mentions exists in `moldesk <cmd> --help`. Run it in CI.
- Manual agent eval: run the F10 prompt in Claude Code and in Codex and record the transcripts in the PR.

## F10: EGFR end-to-end demo (Day 7)

**Want:** `examples/egfr-end-to-end/` (README plus script):
1. `fetch pdb:1M17` (EGFR kinase domain).
2. `analyze` it to extract the chain sequence.
3. `run boltz` on that sequence.
4. `compare` the prediction with 1M17 using `--report`.
5. `inspect` the highest-deviation region.

Use the kinase domain, not full-length EGFR (too large for local runs).

**Test:**
- CI runs the script with a committed predicted-structure fixture instead of Boltz.
- A manual live run on Apple Silicon (MPS) and on a CUDA GPU, with timings recorded in the README.

## S1 (stretch): PNG screenshots

**Want:** `moldesk render <report.html> --scene <id> --png out.png --width 1600 --height 1200 [--camera scene.json]`, using the user's installed Chrome or Chromium headless (reuse the smoke-harness launch code). If no browser is found: a clear error, no bundled browser download.

**Test:**
- The PNG has the requested size and is not blank (pixel variance above a threshold).
- No browser → exit 2 with a remediation.

---

## Out of scope this release (do not build)

- **Postponed:** UniProt/RCSB search, binding-pocket analysis, protein-ligand interaction analysis (license check needed), Foldseek, N-way multi-model comparison (a loop over F5 later), synced side-by-side viewer.
- **Dropped:**
  - "scientific interpretation" (merged into F2/F5);
  - workflow definitions and engine (the agent plus run history cover this);
  - Open Targets and literature tools;
  - visual workflow UI;
  - OpenRouter and built-in LLM features.
