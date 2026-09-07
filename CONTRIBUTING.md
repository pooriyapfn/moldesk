# Contributing to MoleculeDesk

Thanks for your interest in contributing.

## Development setup

```bash
git clone https://github.com/pooriyapfn/moldesk.git
cd moldesk
pnpm install
pnpm --filter @moldesk/cli dev -- doctor
```

## Repo layout

- `apps/cli` — the `moldesk` CLI (thin, delegates to `@moldesk/core`)
- `apps/desktop` — future desktop app
- `packages/core` — shared engine logic
- `packages/runtime` — hardware/Python/Docker/process execution
- `packages/registry` — model manifest resolution
- `models/<name>` — one directory per supported model

## Adding a model

See [docs/adding-a-model.md](./docs/adding-a-model.md).

## Pull requests

- Keep PRs focused on a single change.
- Add/update tests for behavior changes.
- Run `pnpm lint && pnpm typecheck && pnpm test` before opening a PR.
- Describe the "why" in the PR description, not just the "what".

## Commit messages

Use clear, imperative-mood commit messages (e.g. `add boltz install command`,
not `added stuff`).
