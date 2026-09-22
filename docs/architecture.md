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
- **`packages/core`** is the shared engine: it composes runtime, adapters, and
  registry operations; owns atomic installation transactions and installed-model
  state; and exposes `doctor`, `list`, `install`, and future `run` workflows.
- **`packages/runtime`** handles everything that touches the host machine:
  hardware detection, Python/Docker discovery, subprocess execution, isolated
  uv environments, pinned Docker images, and checksum-verified asset caching.
- **`packages/registry`** validates and loads model manifests from
  `models/*/manifest.yaml`; it contains no mutable per-user state.
- **`packages/adapters`** contains thin, typed model-specific installation and
  execution translations.
- **`models/<name>`** contains registry metadata and provenance: a validated
  manifest plus model documentation.
