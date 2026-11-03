#!/usr/bin/env bash
# Rollback the gateway to a saved release binary: ./rollback.sh <release-name>  (see $S/releases/)
# Releases are saved by ./release.sh before every deploy. Data is untouched (migrations are additive only).
set -euo pipefail
S=${STAGING_DIR:-/workspace/staging}; B=/workspace/solob-plus/polyglot/gateway-rust/target/release/solob-gateway
r=${1:?usage: rollback.sh <release>  available: $(ls $S/releases 2>/dev/null | tr '\n' ' ')}
cp --remove-destination $S/releases/$r/solob-gateway $B
[ -f $S/run/gateway.pid ] && { kill "$(cat $S/run/gateway.pid)" || true; rm -f $S/run/gateway.pid; }
sleep 1; $S/start.sh
