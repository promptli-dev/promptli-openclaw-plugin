#!/bin/sh
# Install the packed plugin into a throwaway OpenClaw home (the openclaw devDependency) and check that the
# real host loads it: status "loaded", no diagnostics, channel "promptli", every tool, the CLI. No network
# calls to Promptli are made.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OC="$ROOT/node_modules/.bin/openclaw"
export HOME="$TMP/home" OPENCLAW_STATE_DIR="$TMP/home/.openclaw" PROMPTLI_HOME="$TMP/home/.promptli"
mkdir -p "$HOME"
(cd "$ROOT" && npm run build >/dev/null && npm pack --pack-destination "$TMP" >/dev/null)
"$OC" plugins install "npm-pack:$(ls "$TMP"/*.tgz)" --force --accept-capabilities >"$TMP/install.log" 2>&1 || { cat "$TMP/install.log"; exit 1; }
"$OC" plugins inspect promptli-comms --runtime --json >"$TMP/inspect.json"
# The single quotes are intended: the backticks below are JavaScript template literals, not shell.
# shellcheck disable=SC2016
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const man = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const p = r.plugin, bad = [];
if (p.status !== "loaded") bad.push(`status ${p.status}: ${p.error}`);
if ((r.diagnostics || []).length) bad.push(`diagnostics: ${JSON.stringify(r.diagnostics)}`);
if (!p.channelIds.includes("promptli")) bad.push("channel promptli missing");
const missing = man.contracts.tools.filter((t) => !p.toolNames.includes(t));
if (missing.length) bad.push(`tools missing: ${missing}`);
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log(`host-smoke: loaded in OpenClaw, channel promptli, ${p.toolNames.length} tools`);
' "$TMP/inspect.json" "$ROOT/openclaw.plugin.json"
"$OC" promptli --help | grep -q "setup" || { echo "host-smoke: openclaw promptli CLI missing"; exit 1; }
"$OC" promptli status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.configured!==false)process.exit(1);console.log("host-smoke: CLI ok (not configured, as expected)")})'
