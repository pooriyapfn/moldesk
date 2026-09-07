# Adding a model

1. Create `models/<name>/manifest.yaml`:

   ```yaml
   name: <name>
   displayName: <Display Name>
   version: "0.1.0"
   description: One-line description.
   homepage: https://...
   license: MIT
   compatibility:
     cpu: true
     gpu: recommended # or "required" / "unsupported"
   ```

2. Confirm it shows up:

   ```bash
   pnpm --filter @moldesk/cli dev -- list
   ```

3. (Once install/run support lands) add `install.ts` and `runner.ts` next to
   the manifest, following the pattern in `models/boltz/README.md`.

4. Add a `models/<name>/README.md` describing status and any setup notes.

5. Open a PR — see [CONTRIBUTING.md](../CONTRIBUTING.md).
