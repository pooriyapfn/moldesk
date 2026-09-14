# Installation

## npm (recommended)

```bash
npm install -g @moldesk/cli
moldesk --version
moldesk doctor
```

## Docker

```bash
docker run --rm moldesk/moldesk:latest doctor
```

## From source

```bash
git clone https://github.com/pooriyapfn/moldesk.git
cd moldesk
pnpm install
pnpm --filter @moldesk/cli dev -- doctor
```

## Installing models

ProteinMPNN and LigandMPNN have beta installation adapters:

```bash
moldesk install proteinmpnn       # review plan, then confirm
moldesk install ligandmpnn --yes  # non-interactive
moldesk list --installed
moldesk install proteinmpnn --reinstall --yes
moldesk uninstall proteinmpnn --yes
```

Each Python model gets a pinned source checkout and its own uv-managed virtual
environment. Checkpoints use a resumable, content-addressed cache and are
verified before use. Installation is staged and promoted atomically; failed
reinstalls leave the prior installation intact. `uninstall` retains shared cached
downloads so another model or reinstall can reuse them.

State defaults to `~/.moldesk`; set `MOLDESK_HOME` to relocate managed models,
state, locks, caches, and future run records.
