#!/bin/sh
# MoleculeDesk installer for macOS and Linux.
#
#   curl -fsSL https://moleculedesk.com/install.sh | sh
#
# Needs nothing installed beforehand: no Node.js, no npm, no admin rights. If a
# suitable Node.js (>= 20) is not found, a private copy is downloaded (checksum
# verified) and used only by MoleculeDesk. Everything lives under
# ~/.moldesk (or $MOLDESK_HOME): nothing outside it is touched except one line
# added to your shell profile so the `moldesk` command is found.
#
# Options (environment variables):
#   MOLDESK_HOME=<dir>          install location and data directory (default ~/.moldesk)
#   MOLDESK_CLI_SPEC=<spec>     npm package to install (default @moldesk/cli)
#   MOLDESK_NO_MODIFY_PATH=1    do not edit your shell profile
#
# Re-running this script updates MoleculeDesk.
set -eu

NODE_VERSION="22.23.2"
NODE_MIN_MAJOR=20
CLI_SPEC="${MOLDESK_CLI_SPEC:-@moldesk/cli}"
HOME_DIR="${MOLDESK_HOME:-$HOME/.moldesk}"

say() { printf '%s\n' "$*"; }
fail() {
  printf '\nMoleculeDesk could not be installed.\n%s\n' "$*" >&2
  printf 'Need help? https://moleculedesk.com/docs/troubleshooting\n' >&2
  exit 1
}

TMP_DIR=""
cleanup() { [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

# --- 1. Check the machine ---------------------------------------------------

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) fail "This installer supports macOS and Linux. On Windows, install WSL2 (https://learn.microsoft.com/windows/wsl/install) and run the command from the Ubuntu terminal." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "Unsupported CPU type: $(uname -m). MoleculeDesk supports 64-bit Intel/AMD and ARM processors." ;;
esac

if [ "$OS" = linux ] && (ldd --version 2>&1 || true) | grep -qi musl; then
  fail "This Linux uses musl (for example Alpine), which MoleculeDesk does not support yet. Use Ubuntu, Debian, Fedora or similar."
fi

if command -v curl >/dev/null 2>&1; then
  download() { curl --fail --silent --show-error --location --retry 3 "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -q -O "$2" "$1"; }
else
  fail "Either curl or wget is needed to download files. On Ubuntu/Debian, run: sudo apt-get install -y curl"
fi
command -v tar >/dev/null 2>&1 || fail "tar is needed to unpack downloads. On Ubuntu/Debian, run: sudo apt-get install -y tar"

mkdir -p "$HOME_DIR" || fail "Cannot create $HOME_DIR. Check that you can write to that location."
HOME_DIR=$(cd "$HOME_DIR" && pwd)
TMP_DIR=$(mktemp -d "$HOME_DIR/.install.XXXXXX") || fail "Cannot create a temporary folder in $HOME_DIR."

say "Installing MoleculeDesk into $HOME_DIR"
say ""

# --- 2. Find or download Node.js ---------------------------------------------

node_ok() {
  [ -x "$1/node" ] && [ -x "$1/npm" ] &&
    "$1/node" -e "process.exit(Number(process.versions.node.split('.')[0]) >= $NODE_MIN_MAJOR ? 0 : 1)" >/dev/null 2>&1
}

NODE_BIN=""
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  SYSTEM_NODE_BIN=$(dirname "$(command -v node)")
  if node_ok "$SYSTEM_NODE_BIN"; then NODE_BIN="$SYSTEM_NODE_BIN"; say "Using Node.js found on this computer ($SYSTEM_NODE_BIN)."; fi
fi

if [ -z "$NODE_BIN" ]; then
  NODE_NAME="node-v$NODE_VERSION-$OS-$ARCH"
  NODE_DIR="$HOME_DIR/node/$NODE_NAME"
  if ! node_ok "$NODE_DIR/bin"; then
    say "Node.js was not found, so a private copy is being downloaded (about 40 MB)..."
    ARCHIVE="$NODE_NAME.tar.gz"
    BASE="https://nodejs.org/dist/v$NODE_VERSION"
    download "$BASE/$ARCHIVE" "$TMP_DIR/$ARCHIVE" || fail "Could not download Node.js from nodejs.org. Check your internet connection and try again."
    download "$BASE/SHASUMS256.txt" "$TMP_DIR/SHASUMS256.txt" || fail "Could not download the Node.js checksum list from nodejs.org."
    EXPECTED=$(awk -v f="$ARCHIVE" '$2 == f { print $1 }' "$TMP_DIR/SHASUMS256.txt")
    [ -n "$EXPECTED" ] || fail "Node.js checksum for $ARCHIVE was not found."
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL=$(sha256sum "$TMP_DIR/$ARCHIVE" | awk '{ print $1 }')
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL=$(shasum -a 256 "$TMP_DIR/$ARCHIVE" | awk '{ print $1 }')
    else
      fail "sha256sum or shasum is needed to verify downloads."
    fi
    [ "$EXPECTED" = "$ACTUAL" ] || fail "The downloaded Node.js file failed its safety check (checksum mismatch). Nothing was installed. Try again; if it repeats, report it."
    mkdir -p "$HOME_DIR/node"
    rm -rf "$NODE_DIR"
    # --no-same-owner: some shared/network volumes forbid changing file owners.
    tar --no-same-owner -xzf "$TMP_DIR/$ARCHIVE" -C "$HOME_DIR/node" || fail "Could not unpack Node.js."
    node_ok "$NODE_DIR/bin" || fail "The downloaded Node.js does not run on this computer."
  fi
  NODE_BIN="$NODE_DIR/bin"
fi
NODE="$NODE_BIN/node"
NPM="$NODE_BIN/npm"

# --- 3. Install the MoleculeDesk command-line tool ----------------------------

say "Installing the MoleculeDesk command-line tool..."
CLI_DIR="$HOME_DIR/cli"
mkdir -p "$CLI_DIR"
# A local --prefix install needs no admin rights and cannot clash with other npm packages.
# PATH carries Node so npm's own scripts find it; stdin is closed so `curl | sh` is not read.
PATH="$NODE_BIN:$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false "$NPM" install --prefix "$CLI_DIR" --no-audit --no-fund --loglevel=error "$CLI_SPEC" </dev/null \
  || fail "npm could not install $CLI_SPEC. Check your internet connection and try again."

PKG_DIR="$CLI_DIR/node_modules/@moldesk/cli"
ENTRY=$("$NODE" -e 'const p=require(process.argv[1]+"/package.json");const b=typeof p.bin==="string"?p.bin:p.bin&&p.bin.moldesk;if(!b)process.exit(1);console.log(b)' "$PKG_DIR") \
  || fail "The installed package does not provide a moldesk command."

BIN_DIR="$HOME_DIR/bin"
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/moldesk"
cat > "$LAUNCHER.tmp" <<EOF
#!/bin/sh
# Written by the MoleculeDesk installer. Re-run the installer to update.
exec "$NODE" "$PKG_DIR/$ENTRY" "\$@"
EOF
chmod +x "$LAUNCHER.tmp"
mv "$LAUNCHER.tmp" "$LAUNCHER"

VERSION=$("$LAUNCHER" --version </dev/null) || fail "MoleculeDesk was installed but did not start. Please report this at https://github.com/pooriyapfn/moldesk/issues"

# --- 4. Make the `moldesk` command available in new terminals ------------------

PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\"  # MoleculeDesk"
PROFILE_UPDATED=""
add_to_profile() {
  [ -f "$1" ] || [ "${2:-create}" = create ] || return 0
  grep -qF "# MoleculeDesk" "$1" 2>/dev/null && return 0
  { [ ! -s "$1" ] || [ -z "$(tail -c1 "$1")" ] || echo; printf '%s\n' "$PATH_LINE"; } >> "$1" 2>/dev/null || return 0
  PROFILE_UPDATED="$PROFILE_UPDATED $1"
}
if [ "${MOLDESK_NO_MODIFY_PATH:-}" != 1 ]; then
  case "${SHELL:-}" in
    */zsh)  add_to_profile "$HOME/.zshrc" ;;
    */bash) add_to_profile "$HOME/.bashrc"; add_to_profile "$HOME/.bash_profile" existing ;;
    *)      add_to_profile "$HOME/.profile" ;;
  esac
fi

# --- 5. Done ----------------------------------------------------------------

say ""
say "MoleculeDesk $VERSION is installed."
say ""
if [ "${MOLDESK_NO_MODIFY_PATH:-}" = 1 ]; then
  say "To use it, add this folder to your PATH: $BIN_DIR"
elif [ -n "$PROFILE_UPDATED" ]; then
  say "Open a NEW terminal window (or run: export PATH=\"$BIN_DIR:\$PATH\"), then:"
else
  say "If the moldesk command is not found, open a NEW terminal window, then:"
fi
say ""
say "  moldesk doctor     check your computer (GPU, Python, disk)"
say "  moldesk list       see which models can run here"
say ""
say "Docs: https://moleculedesk.com/docs"
