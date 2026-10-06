#!/usr/bin/env bash
# Bootstrap a source checkout without system-wide Node or package-manager changes.
set -euo pipefail

tools_only=false
case "${1:-}" in
  "") ;;
  --tools-only) tools_only=true ;;
  --help|-h)
    echo "Usage: bash scripts/bootstrap.sh [--tools-only]"
    echo "Installs Node/npm if needed, pinned pnpm, dependencies, and branch CLI."
    echo "MOLDESK_BOOTSTRAP_HOME sets the tool directory (use /workspace/.moldesk-tools on a GPU Pod)."
    exit 0 ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac
if (( $# > 1 )); then echo "Too many arguments" >&2; exit 2; fi

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bootstrap_home=${MOLDESK_BOOTSTRAP_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/moleculedesk/bootstrap}
mkdir -p "$bootstrap_home/bin"
bootstrap_home=$(cd "$bootstrap_home" && pwd)
export PATH="$bootstrap_home/bin:$PATH"
node_version=22.23.2

node_ready() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'
}

if ! node_ready; then
  case "$(uname -s)" in Linux) node_os=linux ;; Darwin) node_os=darwin ;; *) echo "Unsupported OS; install Node >=20 and npm first." >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) node_arch=x64 ;; arm64|aarch64) node_arch=arm64 ;; *) echo "Unsupported CPU architecture." >&2; exit 1 ;; esac
  node_name="node-v${node_version}-${node_os}-${node_arch}"
  node_dir="$bootstrap_home/$node_name"
  if [[ ! -f "$node_dir/.moldesk-bootstrap-complete" || ! -x "$node_dir/bin/node" || ! -x "$node_dir/bin/npm" ]]; then
    command -v curl >/dev/null || { echo "curl is required to download Node." >&2; exit 1; }
    download_dir=$(mktemp -d "$bootstrap_home/node-download.XXXXXX")
    trap 'rm -rf "$download_dir"' EXIT
    archive="$node_name.tar.gz"
    base="https://nodejs.org/dist/v$node_version"
    echo "Installing Node $node_version (includes npm) in $node_dir"
    curl --fail --silent --show-error --location --retry 3 "$base/$archive" -o "$download_dir/$archive"
    curl --fail --silent --show-error --location --retry 3 "$base/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
    # Verify the selected artifact before extraction; never disable TLS checks.
    awk -v file="$archive" '$2 == file { print; found=1 } END { if (!found) exit 1 }' "$download_dir/SHASUMS256.txt" > "$download_dir/checksum.txt"
    if command -v sha256sum >/dev/null; then
      (cd "$download_dir" && sha256sum -c checksum.txt)
    else
      (cd "$download_dir" && shasum -a 256 -c checksum.txt)
    fi
    # Pod volume filesystems can forbid chown even when the shell is root.
    tar --no-same-owner -xzf "$download_dir/$archive" -C "$bootstrap_home"
    touch "$node_dir/.moldesk-bootstrap-complete"
    rm -rf "$download_dir"
    trap - EXIT
  fi
  export PATH="$node_dir/bin:$PATH"
fi
node_ready || { echo "Node >=20 and npm are required." >&2; exit 1; }
node_executable=$(command -v node)
node_bin=$(dirname "$node_executable")
export PATH="$bootstrap_home/bin:$node_bin:$PATH"
pnpm_version=$(node -e 'const p=require(process.argv[1]).packageManager; if (!/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/.test(p)) process.exit(1); console.log(p.slice(5))' "$repo_dir/package.json")

if [[ ! -x "$bootstrap_home/bin/pnpm" ]] || [[ $("$bootstrap_home/bin/pnpm" --version) != "$pnpm_version" ]]; then
  echo "Installing pnpm $pnpm_version in $bootstrap_home"
  npm install --global --prefix "$bootstrap_home" --no-audit --no-fund "pnpm@$pnpm_version"
fi

# Explicit tool path for later SSH sessions, without editing shell profiles.
node - "$bootstrap_home/env.sh" "$node_bin" "$bootstrap_home/bin" <<'JS'
const fs = require('node:fs');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
fs.writeFileSync(process.argv[2], `export PATH=${quote(process.argv[4])}:${quote(process.argv[3])}:"$PATH"\n`);
JS
echo "Node $(node --version), npm $(npm --version), pnpm $(pnpm --version)"

if [[ "$tools_only" == false ]]; then
  cd "$repo_dir"
  pnpm install --frozen-lockfile
  # GPU testing needs CLI/shared packages; no website build or font download.
  pnpm -r --filter='./packages/*' --filter=@moldesk/cli build
  node - "$bootstrap_home/bin/moldesk" "$node_executable" "$repo_dir/apps/cli/dist/index.js" <<'JS'
const fs = require('node:fs');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
fs.writeFileSync(process.argv[2], `#!/usr/bin/env bash\nexec ${quote(process.argv[3])} ${quote(process.argv[4])} "$@"\n`, {mode: 0o755});
JS
  "$bootstrap_home/bin/moldesk" --version
fi
echo "Next shell: source \"$bootstrap_home/env.sh\""
