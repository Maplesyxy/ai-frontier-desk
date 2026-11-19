#!/usr/bin/env bash
# Start AI Frontier Desk on http://127.0.0.1:8766
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8766}"
if [ ! -x .venv/bin/python ]; then
  echo "Creating virtualenv..."
  uv venv --python 3.12 .venv
  uv pip install --python .venv/bin/python -r requirements.txt
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Port $PORT already in use (server probably running). Open http://127.0.0.1:$PORT"
  exit 0
fi
echo "AI Frontier Desk -> http://127.0.0.1:$PORT"
exec .venv/bin/python server.py
