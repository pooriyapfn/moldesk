#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js >=20 and npm are required. For a source checkout, run: bash scripts/bootstrap.sh" >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "Node.js >=20 is required. For a source checkout, run: bash scripts/bootstrap.sh" >&2
  exit 1
fi

echo "Installing MoleculeDesk CLI..."
npm install -g @moldesk/cli

echo
moldesk --version
echo
echo "Run 'moldesk doctor' to check your system."
