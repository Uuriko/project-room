#!/usr/bin/env bash
# OpenAPI fuzzing (Schemathesis 4.x) against a throwaway local server.
# Hard gate: no 5xx and no response that violates the documented schema for a 2xx.
# Everything else (undocumented 4xx codes, rejected schema-valid data, missing 405 Allow) is
# reported in the JUnit/HAR artifacts as spec drift and tracked in QA2 findings, not gated yet.
# Usage: scripts/qa2/fuzz.sh [out-dir]   (needs node 24 and uv or pipx)
set -euo pipefail
OUT="${1:-qa2-fuzz-out}"; mkdir -p "$OUT"
DIR="$(mktemp -d)"; PORT="${QA2_FUZZ_PORT:-4311}"; ORIGIN="http://127.0.0.1:$PORT"
PORT=$PORT ROOM_DB="$DIR/room.sqlite" ROOM_INSTANCE_LOCK_PATH="$DIR/lock" node server.mjs > "$OUT/server.log" 2>&1 &
SERVER=$!; trap 'kill $SERVER 2>/dev/null || true; sleep 1; rm -rf "$DIR"' EXIT
for i in $(seq 1 50); do curl -fsS "$ORIGIN/api/health" >/dev/null 2>&1 && break; sleep 0.2; done
TOKEN=$(curl -fsS -X POST "$ORIGIN/api/agent-identities" -H 'content-type: application/json' -H "origin: $ORIGIN" -d '{"displayName":"qa2-fuzz"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).secret))')
ROOM=$(curl -fsS -X POST "$ORIGIN/api/agent-rooms" -H 'content-type: application/json' -H "origin: $ORIGIN" -H "authorization: Bearer $TOKEN" -d '{"title":"qa2-fuzz","purpose":"fuzz"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).roomId))')
printf '[parameters]\n"path.roomId" = "%s"\n' "$ROOM" > "$DIR/schemathesis.toml"
ST="uvx --from schemathesis==4.* st --config-file $DIR/schemathesis.toml"; command -v uvx >/dev/null || ST="pipx run --spec schemathesis st --config-file $DIR/schemathesis.toml"
set +e
# Pass 1 (hard gate): server errors and 2xx response-schema conformance only.
$ST run "$ORIGIN/openapi.json" --url "$ORIGIN" -H "Authorization: Bearer $TOKEN" -H "Origin: $ORIGIN" \
  --checks not_a_server_error,response_schema_conformance --exclude-checks negative_data_rejection \
  --max-examples 40 --seed 20261001 --phases fuzzing,stateful,coverage \
  --report junit --report-dir "$OUT/gate" > "$OUT/gate.log" 2>&1
GATE=$?
# Pass 2 (report only): every check, for spec-drift tracking.
$ST run "$ORIGIN/openapi.json" --url "$ORIGIN" -H "Authorization: Bearer $TOKEN" -H "Origin: $ORIGIN" \
  --checks all --max-examples 25 --seed 20261001 \
  --report junit,har --report-dir "$OUT/drift" > "$OUT/drift.log" 2>&1
set -e
tail -30 "$OUT/gate.log"
grep -E "^  ❌|^  ⚠️" "$OUT/drift.log" | sed 's/^/drift: /' || true
exit $GATE
