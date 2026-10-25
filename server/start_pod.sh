#!/usr/bin/env bash
# Restarts the real server on the RunPod GPU box. Keys are read from files the owner saved themselves
# (never typed into a command): /root/.muse_key turns on Muse speech to text, /root/.anthropic_key turns
# on Claude wildcard specs and lets the overnight agent run.
set -euo pipefail
cd "$(dirname "$0")/.."
pkill -f "uvicorn server.app:app" || true
export ENGINE=kimodo LIBRARY_DIR=${LIBRARY_DIR:-/root/library}
if [ -s /root/.muse_key ]; then export STT=muse MUSE_API_KEY="$(cat /root/.muse_key)"; fi
if [ -s /root/.anthropic_key ]; then export ANTHROPIC_API_KEY="$(cat /root/.anthropic_key)"; fi
nohup /root/venv/bin/python -m uvicorn server.app:app --host 0.0.0.0 --port 8000 > /root/server.log 2>&1 < /dev/null &
echo "server starting (model load takes ~2 min); log: /root/server.log; STT=${STT:-none}; claude=$([ -n "${ANTHROPIC_API_KEY:-}" ] && echo on || echo off)"
