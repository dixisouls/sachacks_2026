#!/usr/bin/env bash
# Start the backend and frontend together, log both, and shut both down on Ctrl-C.
#   chmod +x run.sh && ./run.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
LOGS="$ROOT/logs"; mkdir -p "$LOGS"
STAMP="$(date +%Y%m%d-%H%M%S)"
API_LOG="$LOGS/api-$STAMP.log"
WEB_LOG="$LOGS/web-$STAMP.log"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"

cleanup() {
echo ""
echo "stopping..."
[[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null
[[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null
wait 2>/dev/null
echo "logs: $API_LOG"
echo "      $WEB_LOG"
}
trap cleanup EXIT INT TERM

# ---- backend -----------------------------------------------------------
if [[ ! -x venv/bin/python ]]; then
echo "no venv at $ROOT/venv - run: python3 -m venv venv && venv/bin/pip install -r requirements.txt"
exit 1
fi
[[ -f .env ]] || echo "note: no .env, /api/brief will return 503 (see .env.example)"