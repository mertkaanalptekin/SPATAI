#!/usr/bin/env bash
# GeoPano3D Studio - start on Linux / macOS:  ./start.sh  [--with-ai] [--port 8080] [--no-browser]
set -euo pipefail
cd "$(dirname "$0")"
for cand in python3.13 python3.12 python3.11 python3 python; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
    if ! "$cand" -c 'import venv, ensurepip' 2>/dev/null; then
      echo "Python's venv module is missing. On Debian/Ubuntu run: sudo apt install python3-venv" >&2
      exit 1
    fi
    exec "$cand" launch.py "$@"
  fi
done
echo "Python 3.11 or newer is required: https://www.python.org/downloads/" >&2
exit 1
