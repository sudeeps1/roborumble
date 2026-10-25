#!/usr/bin/env bash
# Starts the game server on :8000. ENGINE=kimodo on the GPU box; mock everywhere else.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d server/.venv ] && [ -z "${VIRTUAL_ENV:-}" ] && [ -z "${CONDA_PREFIX:-}" ]; then
  python3 -m venv server/.venv
  server/.venv/bin/pip install -q -r server/requirements.txt
fi
PY=python3
[ -d server/.venv ] && [ -z "${VIRTUAL_ENV:-}" ] && [ -z "${CONDA_PREFIX:-}" ] && PY=server/.venv/bin/python
exec "$PY" -m uvicorn server.app:app --host 0.0.0.0 --port "${PORT:-8000}" "$@"
