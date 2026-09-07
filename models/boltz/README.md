# Boltz adapter

Manifest and (future) installer/runner for the [Boltz](https://github.com/jwohlwend/boltz)
structure prediction model.

## Status

Not yet installable via `moldesk install boltz`. Currently only listed via
`moldesk list` from `manifest.yaml`.

## Planned files

- `manifest.yaml` — model metadata and compatibility (done)
- `install.ts` — installation logic (pip/conda/docker)
- `runner.ts` — invocation logic for `moldesk run boltz <input>`
