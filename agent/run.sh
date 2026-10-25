#!/usr/bin/env bash
# One command: ./run.sh [flags]. Creates .venv and installs requirements on the first run.
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv
fi
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt
  touch .venv/.installed
fi
exec .venv/bin/python builder.py "$@"
