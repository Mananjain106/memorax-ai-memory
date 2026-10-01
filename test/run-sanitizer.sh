#!/usr/bin/env bash
# Starts the mock OpenRouter canary + scratch MemoraX servers, runs the
# sanitizer live tests, then cleans up. No real OpenRouter quota is used.
set -u
cd "$(dirname "$0")/.."

kill_port() {
  for pid in $(netstat -ano | grep "$1" | grep LISTENING | awk '{print $5}' | sort -u); do
    taskkill //F //PID "$pid" >/dev/null 2>&1
  done
}
cleanup() {
  kill_port ':3010'
  kill_port ':3011'
  kill_port ':4010'
  [ -n "${CANARY_PID:-}" ] && kill "$CANARY_PID" >/dev/null 2>&1
}
trap cleanup EXIT

kill_port ':3010'; kill_port ':3011'; kill_port ':4010'

# Mock OpenRouter (default mode=ok; tests switch modes at runtime)
node test/mock-openrouter.js > data/mock-openrouter.log 2>&1 &
CANARY_PID=$!
sleep 1

# Scratch server A: ONLINE routing against the canary
PORT=3010 OPENROUTER_BASE_URL=http://localhost:4010 node server.js > data/sanitizer-online.log 2>&1 &
# Scratch server B: forced OFFLINE (local LLM only)
PORT=3011 FORCE_OFFLINE=1 node server.js > data/sanitizer-offline.log 2>&1 &
sleep 7

node test/sanitizer.live.js
RC=$?

echo "---- canary log ----"
cat data/mock-openrouter.log
exit $RC
