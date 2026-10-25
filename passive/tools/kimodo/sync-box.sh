#!/usr/bin/env bash
# Copies the physics sim (passive/) to a GPU box so clip checks run there, not on the laptop.
#   tools/kimodo/sync-box.sh [user@host] [--setup]
# BOXDIR (default roborumble/passive, relative to the box's home) picks the copy, so parallel jobs
# can each have their own: BOXDIR=rr/scorer tools/kimodo/sync-box.sh
# --setup makes the copy runnable: node deps and the SONIC/G1/planner assets, hard-linked from the
# main copy when it has them (else installed and fetched).
set -euo pipefail
HOST=${1:-ubuntu@44.198.171.168}
DIR=${BOXDIR:-roborumble/passive}
HERE=$(cd "$(dirname "$0")/../.." && pwd)
ssh "$HOST" "mkdir -p $DIR"
rsync -az --delete \
  --exclude node_modules --exclude models --exclude public/sonic --exclude public/g1 \
  --exclude public/characters --exclude mockups --exclude 'tools/kimodo/out' --exclude '.vite' \
  "$HERE/" "$HOST:$DIR/"
if [[ "${2:-}" == "--setup" ]]; then
  ssh "$HOST" "set -e; cd $DIR; M=\$HOME/roborumble/passive
    if [ \"\$(pwd)\" != \"\$M\" ] && [ -d \$M/node_modules ] && [ -f \$M/models/planner_sonic.onnx ]; then
      for d in node_modules models public/sonic public/g1; do [ -e \$d ] || cp -al \$M/\$d \$d; done
    else
      npm ci --no-audit --no-fund --loglevel=error && npm run -s setup && npm run -s setup:planner
    fi
    ls models public/sonic >/dev/null && echo ready: \$(pwd)"
fi
