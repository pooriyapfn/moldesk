# Installing MoleculeDesk

## macOS and Linux

```bash
curl -fsSL https://moleculedesk.com/install.sh | sh
```

- No Node.js, npm, Python, or administrator password needed. The script downloads a private, checksum-verified Node.js only if a recent one is missing.
- Installs into `~/.moldesk` and adds one line ending in `# MoleculeDesk` to the shell profile.
- The `moldesk` command works in **new** terminals. In the current shell, use `~/.moldesk/bin/moldesk` or `export PATH="$HOME/.moldesk/bin:$PATH"`.
- The user can read the script first: https://moleculedesk.com/install.sh

Before running it, tell the user it downloads and runs a script from moleculedesk.com and get a yes.

Verify:

```bash
moldesk --version
moldesk doctor
```

## Windows

Install WSL2, open the Ubuntu terminal, and run the same command there. Native Windows is not supported.

## Remote GPU servers

Home folders on rented GPU machines are often small. Put everything on the large disk:

```bash
curl -fsSL https://moleculedesk.com/install.sh | MOLDESK_HOME=/workspace/.moldesk sh
export MOLDESK_HOME=/workspace/.moldesk
export PATH="$MOLDESK_HOME/bin:$PATH"
moldesk doctor
```

`MOLDESK_HOME` must be set for every later command too.

## Installer options

Set before `sh`:

- `MOLDESK_HOME=<folder>`: install and data location (default `~/.moldesk`).
- `MOLDESK_NO_MODIFY_PATH=1`: do not edit the shell profile.
- `MOLDESK_CLI_SPEC=<npm package>`: a specific version, for example `@moldesk/cli@0.0.5`.

## Update

Run the install command again. Installed models are kept.

## Docker

```bash
docker run --rm moldesk/moldesk:latest doctor
```

## Storage layout

Under `MOLDESK_HOME` (default `~/.moldesk`): `models/` (installed models), `cache/` (shared checkpoints), `runs/` (run directories), `state/`.

## Remove

Ask the user before deleting anything.

```bash
rm -rf ~/.moldesk/cli ~/.moldesk/node ~/.moldesk/bin
```

Then remove the line ending in `# MoleculeDesk` from `~/.zshrc`, `~/.bashrc`, or `~/.profile`. Deleting all of `~/.moldesk` also removes installed models and past runs.
