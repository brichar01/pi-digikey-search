#!/usr/bin/env bash
#
# Start the MCP server, installing its runtime dependencies on first run.
# A plugin install copies the repository without node_modules.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [ ! -d "$ROOT/node_modules/@modelcontextprotocol/sdk" ]; then
  # stdout carries the MCP protocol, so npm output must go to stderr.
  # --omit=peer skips the pi packages, which only pi provides.
  npm install --prefix "$ROOT" --omit=dev --omit=peer --no-audit --no-fund >&2
fi

exec node "$ROOT/mcp/server.mjs"
