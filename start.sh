#!/usr/bin/env bash
# Start the backend and the frontend together, log both, shut both down on Ctrl-C.
#
#   ./start.sh              dev mode: Next hot-reloads, uvicorn reloads on save
#   ./start.sh --prod       production build, closer to what gets hosted
#   API_PORT=8001 WEB_PORT=3001 ./start.sh
#
# Checks everything it needs first and says exactly what to run if something is
# missing, so a teammate on a fresh clone gets a straight answer rather than a
# stack trace.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LOGS="$ROOT/logs"; mkdir -p "$LOGS"
STAMP="$(date +%Y%m%d-%H%M%S)"
API_LOG="$LOGS/api-$STAMP.log"
WEB_LOG="$LOGS/web-$STAMP.log"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"
PROD=0
[[ "${1:-}" == "--prod" ]] && PROD=1

API_PID=""; WEB_PID=""

cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "stopping..."
  # kill the whole process group of each child: uvicorn --reload and next both
  # spawn workers, and killing only the parent leaves the port held.
  for pid in "$API_PID" "$WEB_PID"; do
    [[ -n "$pid" ]] && kill -- "-$pid" 2>/dev/null || true
  done
  sleep 0.5
  for pid in "$API_PID" "$WEB_PID"; do
    [[ -n "$pid" ]] && kill -9 -- "-$pid" 2>/dev/null || true
  done
  echo "logs: $API_LOG"
  echo "      $WEB_LOG"
}
trap cleanup EXIT INT TERM

die() { echo ""; echo "  $1"; echo ""; exit 1; }

port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# ---- checks ----------------------------------------------------------------
[[ -x venv/bin/python ]] || die "No venv. Run:
    python3 -m venv venv && venv/bin/pip install -r requirements.txt"

venv/bin/python -c "import fastapi, uvicorn, polars, rdkit" 2>/dev/null \
  || die "Missing Python packages. Run:
    venv/bin/pip install -r requirements.txt"

[[ -f artifacts/meta.json ]] || die "No artifacts/. They should be committed; if you removed them:
    venv/bin/pip install -r requirements.txt -r requirements-build.txt
    venv/bin/python scripts/build_artifacts.py"

[[ -d web/node_modules ]] || die "Frontend dependencies missing. Run:
    cd web && npm install"

port_busy "$API_PORT" && die "Port $API_PORT is already in use. Stop that process, or:
    API_PORT=8001 ./start.sh"
port_busy "$WEB_PORT" && die "Port $WEB_PORT is already in use. Stop that process, or:
    WEB_PORT=3001 ./start.sh"

if [[ -f .env ]] && grep -q '^GEMINI_API_KEY=.\+' .env; then
  :
else
  echo "note: no GEMINI_API_KEY in .env, so /api/brief will return 503 (see .env.example)"
fi

# ---- backend ---------------------------------------------------------------
echo "backend  http://localhost:$API_PORT      -> $API_LOG"
RELOAD=(); [[ $PROD -eq 0 ]] && RELOAD=(--reload)
set -m   # own process group, so cleanup can take the workers down with it
venv/bin/python -m uvicorn api.main:app --host 0.0.0.0 --port "$API_PORT" \
  "${RELOAD[@]}" > "$API_LOG" 2>&1 &
API_PID=$!
set +m

# Loading the artifacts takes a couple of seconds; wait for a real 200.
for i in $(seq 1 60); do
  kill -0 "$API_PID" 2>/dev/null || die "Backend died on startup. Last lines:
$(tail -15 "$API_LOG")"
  curl -fs -o /dev/null "http://localhost:$API_PORT/api/health" 2>/dev/null && break
  sleep 0.5
  [[ $i -eq 60 ]] && die "Backend did not answer within 30s. Last lines:
$(tail -15 "$API_LOG")"
done
SUMMARY="$(curl -fs "http://localhost:$API_PORT/api/health" 2>/dev/null \
  | venv/bin/python -c "import json,sys
d = json.load(sys.stdin)
print(format(d['drugs'], ',') + ' drugs (' + format(d['approved_drugs'], ',') + ' approved), '
      + format(d['diseases'], ',') + ' diseases')" 2>/dev/null)"
echo "         ready: ${SUMMARY:-up}"

# ---- frontend --------------------------------------------------------------
echo "frontend http://localhost:$WEB_PORT      -> $WEB_LOG"
# 127.0.0.1, not localhost: on Windows and some Linux setups "localhost" tries IPv6 first and
# waits ~200 ms per request before falling back to IPv4, which uvicorn is bound to.
export NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT"

set -m
if [[ $PROD -eq 1 ]]; then
  # NEXT_PUBLIC_* is baked in at build time, so build with it already exported.
  echo "         building..."
  ( cd web && npm run build ) >> "$WEB_LOG" 2>&1 \
    || die "Frontend build failed. Last lines:
$(tail -25 "$WEB_LOG")"
  ( cd web && npm run start -- --port "$WEB_PORT" ) >> "$WEB_LOG" 2>&1 &
else
  ( cd web && npm run dev -- --port "$WEB_PORT" ) >> "$WEB_LOG" 2>&1 &
fi
WEB_PID=$!
set +m

for i in $(seq 1 120); do
  kill -0 "$WEB_PID" 2>/dev/null || die "Frontend died on startup. Last lines:
$(tail -25 "$WEB_LOG")"
  curl -fs -o /dev/null "http://localhost:$WEB_PORT/" 2>/dev/null && break
  sleep 0.5
  [[ $i -eq 120 ]] && die "Frontend did not answer within 60s. Last lines:
$(tail -25 "$WEB_LOG")"
done

echo ""
echo "  open http://localhost:$WEB_PORT      (API docs at http://localhost:$API_PORT/docs)"
echo "  Ctrl-C stops both"
echo ""

# Stream both logs until interrupted; if either process dies, stop.
tail -f "$API_LOG" "$WEB_LOG" &
TAIL_PID=$!
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done
kill "$TAIL_PID" 2>/dev/null
echo ""
echo "one of the processes exited; shutting the other down"
