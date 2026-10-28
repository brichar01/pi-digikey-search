#!/usr/bin/env bash
#
# Install the Digi-Key part-search pi extension and CLI.
#
# Defaults:
#   extension:  ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/digikey-product-search
#   CLI:        ${PREFIX:-$HOME/.local/bin}/digikey-search
#
# The extension advertises its bundled skill through resources_discover, so no
# separate skill symlink is needed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
BIN_DIR="${PREFIX:-$HOME/.local/bin}"
DO_EXTENSION=1
DO_CLI=1
COPY=0
FORCE=0
UNINSTALL=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --agent-dir DIR    pi agent directory (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
  --bin-dir DIR      CLI install directory (default: $PREFIX or ~/.local/bin)
  --copy             copy extension files instead of symlinking (CLI stays linked)
  --force            replace an existing non-matching install
  --no-extension     do not install the pi extension
  --no-cli           do not install the digikey-search CLI
  --uninstall        remove the installed extension and CLI
  -h, --help         show this help

Environment:
  PI_CODING_AGENT_DIR   pi config directory override
  PREFIX                CLI prefix override (default ~/.local)

After install, export the Digi-Key API credentials in your shell profile:
  export DIGIKEY_CLIENT_ID="..."
  export DIGIKEY_CLIENT_SECRET="..."

Optional:
  export DIGIKEY_SITE=US
  export DIGIKEY_LANGUAGE=en
  export DIGIKEY_CURRENCY=USD
  export DIGIKEY_SANDBOX=1        # sandbox-api.digikey.com
  export DIGIKEY_TIMEOUT_MS=30000
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-dir)
      AGENT_DIR="${2:?--agent-dir requires a directory}"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="${2:?--bin-dir requires a directory}"
      shift 2
      ;;
    --copy)
      COPY=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --no-extension)
      DO_EXTENSION=0
      shift
      ;;
    --no-cli)
      DO_CLI=0
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

EXT_TARGET="$AGENT_DIR/extensions/digikey-product-search"
CLI_TARGET="$BIN_DIR/digikey-search"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (Node 20+)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "warning: Node 20+ is recommended; found $(node --version)." >&2
fi

remove_install() {
  if [ -L "$EXT_TARGET" ]; then
    rm -f "$EXT_TARGET"
    echo "removed extension symlink: $EXT_TARGET"
  elif [ -e "$EXT_TARGET" ]; then
    if [ -f "$EXT_TARGET/package.json" ] && grep -q '"name": "pi-digikey-product-search"' "$EXT_TARGET/package.json" 2>/dev/null; then
      rm -rf "$EXT_TARGET"
      echo "removed extension copy: $EXT_TARGET"
    else
      echo "warning: not removing unrecognized directory: $EXT_TARGET" >&2
    fi
  fi

  if [ -L "$CLI_TARGET" ]; then
    rm -f "$CLI_TARGET"
    echo "removed CLI symlink: $CLI_TARGET"
  elif [ -f "$CLI_TARGET" ]; then
    if grep -q 'runCli' "$CLI_TARGET" 2>/dev/null; then
      rm -f "$CLI_TARGET"
      echo "removed CLI: $CLI_TARGET"
    else
      echo "warning: not removing unrecognized file: $CLI_TARGET" >&2
    fi
  fi
}

if [ "$UNINSTALL" -eq 1 ]; then
  remove_install
  echo "Uninstalled. Run /reload in pi if it is currently running."
  exit 0
fi

if [ "$DO_EXTENSION" -eq 1 ]; then
  mkdir -p "$AGENT_DIR/extensions"
  if [ "$EXT_TARGET" = "$ROOT" ]; then
    echo "error: extension target must not be the checkout itself: $EXT_TARGET" >&2
    exit 1
  fi

  if [ -L "$EXT_TARGET" ]; then
    CURRENT="$(readlink "$EXT_TARGET")"
    if [ "$CURRENT" = "$ROOT" ] && [ "$COPY" -eq 0 ]; then
      echo "extension already linked: $EXT_TARGET"
    elif [ "$FORCE" -eq 1 ]; then
      rm -f "$EXT_TARGET"
    else
      echo "error: $EXT_TARGET already links to $CURRENT (use --force to replace)" >&2
      exit 1
    fi
  elif [ -e "$EXT_TARGET" ]; then
    if [ "$FORCE" -ne 1 ]; then
      echo "error: $EXT_TARGET already exists (use --force to replace)" >&2
      exit 1
    fi
    rm -rf "$EXT_TARGET"
  fi

  if [ "$COPY" -eq 1 ]; then
    mkdir -p "$EXT_TARGET"
    cp -R "$ROOT/bin" "$ROOT/lib" "$ROOT/extensions" "$ROOT/skills" "$EXT_TARGET/"
    cp "$ROOT/index.ts" "$ROOT/package.json" "$ROOT/README.md" "$ROOT/install.sh" "$EXT_TARGET/"
    echo "copied extension: $EXT_TARGET"
  else
    ln -s "$ROOT" "$EXT_TARGET"
    echo "linked extension: $EXT_TARGET"
  fi
fi

if [ "$DO_CLI" -eq 1 ]; then
  mkdir -p "$BIN_DIR"
  # The CLI stays linked to the checkout so its relative lib/ import resolves.
  ln -sfn "$ROOT/bin/digikey-search" "$CLI_TARGET"
  echo "linked CLI: $CLI_TARGET"
  chmod +x "$ROOT/bin/digikey-search" 2>/dev/null || true
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      echo "note: $BIN_DIR is not on PATH. Add it, for example:"
      echo "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
fi

cat <<EOF

Installed.

Next steps:
  1. Export credentials (and optionally locale/sandbox settings):
       export DIGIKEY_CLIENT_ID="..."
       export DIGIKEY_CLIENT_SECRET="..."
  2. Verify the CLI:
       digikey-search --keywords "ceramic capacitor" --limit 3 --format text
  3. Open pi and run /reload, then ask for a Digi-Key part or run:
       /skill:digikey-part-search
EOF
