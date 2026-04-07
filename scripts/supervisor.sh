#!/bin/bash
# DisClawd Supervisor — keeps the bot alive across updates
# The bot can self-update via !update: git pull + exit(0) → supervisor restarts with new code

set -euo pipefail

DISCLAWD_DIR="/home/xavier/xklip/disclawd"
LOG_FILE="$DISCLAWD_DIR/data/disclawd.log"
PID_FILE="$DISCLAWD_DIR/data/disclawd.pid"
BUN="/home/linuxbrew/.linuxbrew/bin/bun"

# Fallback bun paths
if [ ! -x "$BUN" ]; then
  BUN="$(which bun 2>/dev/null || echo "/usr/local/bin/bun")"
fi

mkdir -p "$DISCLAWD_DIR/data"

cleanup() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Supervisor shutting down..." >> "$LOG_FILE"
  if [ -f "$PID_FILE" ]; then
    BOT_PID=$(cat "$PID_FILE")
    kill "$BOT_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  exit 0
}

trap cleanup SIGINT SIGTERM

echo "[$(date '+%Y-%m-%d %H:%M:%S')] DisClawd supervisor started (PID $$)" >> "$LOG_FILE"

while true; do
  cd "$DISCLAWD_DIR"

  # Install deps if needed (new packages after git pull)
  if [ "$DISCLAWD_DIR/package.json" -nt "$DISCLAWD_DIR/node_modules/.package-lock.json" ] 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Installing dependencies..." >> "$LOG_FILE"
    $BUN install --frozen-lockfile 2>> "$LOG_FILE" || $BUN install 2>> "$LOG_FILE"
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting DisClawd bot..." >> "$LOG_FILE"

  # Start bot and track PID
  $BUN run src/index.ts >> "$LOG_FILE" 2>&1 &
  BOT_PID=$!
  echo "$BOT_PID" > "$PID_FILE"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bot started (PID $BOT_PID)" >> "$LOG_FILE"

  # Wait for bot to exit
  wait "$BOT_PID" 2>/dev/null
  EXIT_CODE=$?
  rm -f "$PID_FILE"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bot exited (code $EXIT_CODE)" >> "$LOG_FILE"

  # Exit code 42 = planned update restart
  # Exit code 0 = clean shutdown (also restart)
  # Other codes = error (still restart, but with longer delay)
  if [ "$EXIT_CODE" -eq 42 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Update restart requested. Restarting in 2s..." >> "$LOG_FILE"
    sleep 2
  elif [ "$EXIT_CODE" -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Clean exit. Restarting in 3s..." >> "$LOG_FILE"
    sleep 3
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Error exit. Restarting in 10s..." >> "$LOG_FILE"
    sleep 10
  fi
done
