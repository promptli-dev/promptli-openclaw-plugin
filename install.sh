#!/bin/sh
# Promptli Comms for OpenClaw: installer.
#
#   curl -fsSL https://comms.promptli.com/install/openclaw.sh | sh
#
# Installs the Promptli channel plugin into your OpenClaw (`openclaw plugins install`). It never asks for or
# stores an API key: run `openclaw promptli setup` afterwards (browser login).
#
# Environment overrides:
#   PROMPTLI_OPENCLAW_SPEC    plugin spec for `openclaw plugins install` (default: npm package)
#   PROMPTLI_OPENCLAW_SOURCE  local checkout to build, pack and install instead (development)
set -eu

SPEC="${PROMPTLI_OPENCLAW_SPEC:-@promptli-npm/openclaw-plugin}"
SOURCE="${PROMPTLI_OPENCLAW_SOURCE:-}"

say() { printf '\033[1;38;5;202m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v openclaw >/dev/null 2>&1 || die "OpenClaw is not installed: https://docs.openclaw.ai/install"
command -v node >/dev/null 2>&1 || die "Node.js is required (24.16+ or 26.1+)"

if [ -n "$SOURCE" ]; then
  command -v npm >/dev/null 2>&1 || die "npm is required to build from source"
  say "Building $SOURCE"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  (cd "$SOURCE" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npm run build >/dev/null && npm pack --pack-destination "$TMP" >/dev/null)
  TARBALL="$(ls "$TMP"/*.tgz)"
  SPEC="npm-pack:$TARBALL"
fi

say "Installing the Promptli Comms plugin ($SPEC)"
say "It opens an outbound WebSocket to Promptli and stores its login under ~/.promptli/openclaw (mode 600)."
openclaw plugins install "$SPEC" --force --accept-capabilities || die "openclaw plugins install failed"

say "Installed. Next:"
cat <<'MSG'

  openclaw promptli setup     log in with your browser, pick or create the agent (--number for a phone number)
  openclaw gateway restart    start answering email, texts and calls
  openclaw promptli doctor    check everything is working

Anyone who learns your agent's address or number can message it. Keep the agent's tool policy tight,
or set channels.promptli.dmPolicy to "allowlist" or "pairing".
MSG
