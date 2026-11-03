#!/usr/bin/env bash
# Saves the currently built gateway binary as a named release (git sha) before deploying it.
set -euo pipefail
S=${STAGING_DIR:-/workspace/staging}; R=/workspace/solob-plus
n=${1:-$(git -C $R rev-parse --short HEAD)-$(date +%Y%m%d%H%M)}
mkdir -p $S/releases/$n; cp $R/polyglot/gateway-rust/target/release/solob-gateway $S/releases/$n/
git -C $R rev-parse HEAD > $S/releases/$n/COMMIT; echo $n
