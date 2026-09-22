# Adding a model

1. Create `models/<name>/manifest.yaml`:

   ```yaml
   schemaVersion: 1
   name: <name>              # lowercase kebab-case stable ID
   displayName: <Display Name>
   modelVersion: "1.0.0"    # upstream model/package version
   adapterVersion: "0.1.0"  # MoleculeDesk adapter contract version
   description: One-line description.
   category: sequence-design # | structure-prediction | docking | other
   status: planned           # use available only after install/run verification
   homepage: https://...
   license: MIT
   source:
     repository: https://...
     revision: <full-immutable-commit-digest>
   runtimes:
     - kind: python
       python: "3.11"
       installer: uv
       requirements:
         - name: <pkg>
   hardware:
     platforms: [darwin-arm64, linux-x64]
   input:
     formats: [.pdb]
     required: true
   outputs:
     - id: <output-id>
       glob: "*.fa"
       required: true
   ```

2. Confirm it shows up:

   ```bash
   pnpm --filter @moldesk/cli dev -- list
   ```

3. (Once install/run support lands in Steps 3-4) add a thin adapter under
   `packages/adapters/src/<name>/`, register it in
   `packages/adapters/src/catalog.ts`, and document evidence in
   `models/<name>/README.md` (see `models/proteinmpnn/README.md`).

4. Add a `models/<name>/README.md` describing status and any setup notes.

5. Open a PR — see [CONTRIBUTING.md](../CONTRIBUTING.md).
