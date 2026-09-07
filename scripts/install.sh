#!/usr/bin/env bash
set -euo pipefail

echo "Installing MoleculeDesk CLI..."
npm install -g moldesk

echo
moldesk --version
echo
echo "Run 'moldesk doctor' to check your system."
