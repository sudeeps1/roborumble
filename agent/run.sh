#!/usr/bin/env bash
# One command: ./run.sh [run.py flags]. Runs the Library Builder once (README.md); overnight,
# ./run_forever.sh restarts it whenever it exits. The first run creates .venv and installs
# requirements.txt (again whenever requirements.txt changes). AGENT_PYTHON=/path/to/python skips
# the venv and runs with that interpreter as is (on the GPU box: the server's /root/venv/bin/python,
# which already has anthropic and sentence-transformers).
set -euo pipefail
cd "$(dirname "$0")"
if [ -n "${AGENT_PYTHON:-}" ]; then
  exec "$AGENT_PYTHON" run.py "$@"
fi
PY="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv
fi
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt
  touch .venv/.installed
fi
exec .venv/bin/python run.py "$@"
