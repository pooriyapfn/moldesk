# Installation

## Quick install (macOS and Linux)

```bash
curl -fsSL https://moleculedesk.com/install.sh | sh
moldesk --version
moldesk doctor
```

Needs nothing installed beforehand: no Node.js, no npm, no admin rights. The
installer (`scripts/install.sh`, also served at `/install.sh` from
`apps/website/public/install.sh`) uses an existing Node.js >=20 when present,
otherwise downloads a checksum-verified private Node.js 22 into `~/.moldesk/node`,
installs the CLI into `~/.moldesk/cli`, writes a launcher to `~/.moldesk/bin`, and
adds one `# MoleculeDesk` PATH line to the shell profile. Re-run it to update.
Options: `MOLDESK_HOME`, `MOLDESK_NO_MODIFY_PATH=1`, `MOLDESK_CLI_SPEC`.

## Docker

```bash
docker run --rm moldesk/moldesk:latest doctor
```

## From source

```bash
git clone https://github.com/pooriyapfn/moldesk.git
cd moldesk
bash scripts/bootstrap.sh
source "${MOLDESK_BOOTSTRAP_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/moleculedesk/bootstrap}/env.sh"
moldesk doctor
```

The bootstrap installs Node 22.23.2 (including npm) when Node >=20/npm are
missing, verifies the official archive checksum, installs the repository-pinned
pnpm, installs frozen workspace dependencies, and builds CLI/shared packages.
It reuses a compatible existing Node installation and does not build the website
or install molecular model weights. Tools stay in a user-owned directory; shell
profiles and system packages are not changed. The source checkout must remain
in place for its `moldesk` launcher to work.

For a GPU Pod, keep tools, source and model state on persistent storage:

```bash
export MOLDESK_BOOTSTRAP_HOME=/workspace/.moldesk-tools
export MOLDESK_HOME=/workspace/.moldesk
bash scripts/bootstrap.sh
source /workspace/.moldesk-tools/env.sh
moldesk doctor
```

`bash scripts/bootstrap.sh --tools-only` installs only Node/npm/pnpm. The existing
`scripts/install.sh` installs the published CLI and checks its prerequisites.

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
