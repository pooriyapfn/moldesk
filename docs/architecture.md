# Architecture

```text
CLI / Desktop
      |
    Core
      |
   Runtime
      |
Model Registry
      |
Boltz / AlphaFold / Chai / ...
```

- **`apps/cli`** parses commands and delegates to `@moldesk/core`. It contains
  no business logic of its own — this keeps the future desktop app (`apps/desktop`)
  able to reuse the exact same engine.
- **`packages/core`** is the shared engine: it composes runtime and registry
  operations into the actions the CLI/desktop expose (`doctor`, `list`,
  `install`, `run`).
- **`packages/runtime`** handles everything that touches the host machine:
  hardware detection, Python/Docker discovery, and subprocess execution.
- **`packages/registry`** loads model manifests from `models/*/manifest.yaml`
  and resolves install/compatibility state.
- **`models/<name>`** holds one adapter per supported model: a manifest plus
  (eventually) `install.ts` and `runner.ts`.
