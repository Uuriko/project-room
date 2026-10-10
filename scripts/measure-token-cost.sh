#!/bin/bash
# Per-token cost instrument (200-hard-tasks #27) — runs ON A MAC PROVIDER.
# Measures the two blueprint numbers:
#   1. tunnel stability (uptime, reconnects, latency over the window)
#   2. per-token cost vs cheapest commodity API
# See research/PER-TOKEN-COST-INSTRUMENT.md for the full protocol.
# Usage: sudo ./scripts/measure-token-cost.sh <model-id> <minutes> <out-csv>
# Requirements: macOS, powermetrics (sudo), the provider tunnel running,
# a local inference endpoint at $INFER_URL (default http://127.0.0.1:8080).
set -euo pipefail

MODEL_ID="${1:?usage: measure-token-cost.sh <model-id> <minutes> <out-csv>}"
MINUTES="${2:?usage: measure-token-cost.sh <model-id> <minutes> <out-csv>}"
OUT_CSV="${3:?usage: measure-token-cost.sh <model-id> <minutes> <out-csv>}"
INFER_URL="${INFER_URL:-http://127.0.0.1:8080}"
PROMPT="${PROMPT:-Summarize the following in one sentence: }"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: this instrument runs on macOS (powermetrics)" >&2
  exit 1
fi

echo "model,prompt_tokens,completion_tokens,tokens_per_sec,wall_power_w,window_sec,timestamp" > "$OUT_CSV"

# Baseline: idle wall power for 60s (machine on, no inference).
echo "[1/3] measuring idle power (60s)..."
sudo powermetrics -n 60 -i 1000 --samplers cpu_power -o /tmp/idle-power.txt >/dev/null 2>&1 || true
IDLE_W=$(grep -o 'CPU Power: [0-9]*' /tmp/idle-power.txt | awk '{s+=$3; n++} END {print (n? s/n : 0)}')
echo "idle power: ${IDLE_W} mW"

# Inference loop: fixed prompt, fixed max tokens, back-to-back for the window.
echo "[2/3] running inference for ${MINUTES} min against ${INFER_URL}..."
END_AT=$(( $(date +%s) + MINUTES * 60 ))
sudo powermetrics -n $(( MINUTES * 60 )) -i 1000 --samplers cpu_power -o /tmp/load-power.txt >/dev/null 2>&1 &
POWER_PID=$!
while [[ $(date +%s) -lt $END_AT ]]; do
  START_MS=$(date +%s%3N)
  RESP=$(curl -s -m 120 -X POST "${INFER_URL}/v1/completions" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"${MODEL_ID}\",\"prompt\":\"${PROMPT}\",\"max_tokens\":128}") || { echo "inference request failed" >&2; break; }
  END_MS=$(date +%s%3N)
  CT=$(echo "$RESP" | grep -o '"completion_tokens":[0-9]*' | grep -o '[0-9]*' || echo 0)
  PT=$(echo "$RESP" | grep -o '"prompt_tokens":[0-9]*' | grep -o '[0-9]*' || echo 0)
  DUR_MS=$(( END_MS - START_MS ))
  TPS=$(awk "BEGIN {print ${CT} / (${DUR_MS} / 1000)}")
  echo "${MODEL_ID},${PT},${CT},${TPS},,${DUR_MS},$(date -u +%FT%TZ)" >> "$OUT_CSV"
done
wait $POWER_PID || true
LOAD_W=$(grep -o 'CPU Power: [0-9]*' /tmp/load-power.txt | awk '{s+=$3; n++} END {print (n? s/n : 0)}')
echo "load power: ${LOAD_W} mW"

# Tunnel stability probe: ping the tunnel endpoint every 10s during a 10-min window.
echo "[3/3] tunnel stability probe (10 min, 10s cadence)..."
TUNNEL_URL="${TUNNEL_URL:-https://tunnel.dasha.example/ping}"
STAB_CSV="${OUT_CSV%.csv}-tunnel.csv"
echo "timestamp,ok,latency_ms" > "$STAB_CSV"
for _ in $(seq 1 60); do
  T0=$(date +%s%3N)
  if CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$TUNNEL_URL"); then
    T1=$(date +%s%3N)
    echo "$(date -u +%FT%TZ),1,$(( T1 - T0 ))" >> "$STAB_CSV"
  else
    echo "$(date -u +%FT%TZ),0," >> "$STAB_CSV"
  fi
  sleep 10
done

echo "done. results: $OUT_CSV  tunnel: $STAB_CSV"
echo "summarize with: awk -F, 'NR>1 {t+=\$4; n++} END {print \"mean tok/s:\", t/n}' $OUT_CSV"
