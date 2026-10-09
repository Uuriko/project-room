#!/bin/bash
# mut.sh <unit> — one mutation work unit. Applies a single mutant to a slice
# file under an flock, runs the affected suite, restores the file, writes the
# verdict to .tmp/units/results/<unit>.txt. Never touches git.
W=~/workspace/pr-wave1000-guild-11
export TMPDIR=$W/.tmp
cd "$W" || exit 1
U=$1
RES=$W/.tmp/units/results/${U}.txt
LOCK=$W/.tmp/mut.lock
HD=$W/.tmp/units/h

patch_once() { # PFILE OLD NEW via env
  node -e '
    const fs = require("fs");
    const f = process.env.PFILE, old = process.env.POLD, nw = process.env.PNEW;
    const src = fs.readFileSync(f, "utf8");
    const n = src.split(old).length - 1;
    if (n !== 1) { console.error("PATCH FAIL: " + n + " occurrences in " + f); process.exit(2); }
    fs.writeFileSync(f, src.split(old).join(nw));
    console.log("patched 1 occurrence in " + f);
  '
  return $?
}

run_suite() { # $1=cmd $2=timeout_secs
  timeout "$2" bash -c "$1" >"$W/.tmp/units/${U}.testlog" 2>&1
  echo $?
}

case "$U" in
  u01) FILE=server/tripwires.mjs; DESC="gaugeStatus exclusive->inclusive (v>t becomes v>=t)";
       OLD='(v, t) => v > t'; NEW='(v, t) => v >= t';
       SUITE="node --test tests/tripwires.test.mjs"; STIME=120 ;;
  u02) FILE=server/tripwires.mjs; DESC="pruneWindows penalty filter off-by-one (t>=cutoff becomes t>cutoff)";
       OLD='penaltyEntries = penaltyEntries.filter(t => t >= penaltyCutoff);'
       NEW='penaltyEntries = penaltyEntries.filter(t => t > penaltyCutoff);'
       SUITE="node --test tests/tripwires.test.mjs"; STIME=120 ;;
  u03) FILE=server/tripwires.mjs; DESC="revert p99 ns->ms fix (p99ns/1e6 becomes p99ns)";
       OLD='setGauge("event_loop_delay_ms_p99", p99ns / 1e6, atMs);'
       NEW='setGauge("event_loop_delay_ms_p99", p99ns, atMs);'
       SUITE="node --test tests/tripwires.test.mjs"; STIME=120 ;;
  u04) FILE=server/tripwires.mjs; DESC="dropped monitor.reset() after percentile sample";
       OLD=$(printf '            const p99ns = monitor.percentile(99);\n            monitor.reset();')
       NEW='            const p99ns = monitor.percentile(99);'
       SUITE="node --test tests/tripwires.test.mjs"; STIME=120 ;;
  u05) FILE=server/tripwires.mjs; DESC="silentTimeoutRatio off-by-one denominator (+1)";
       OLD='return timeouts / outcomes.length;'
       NEW='return timeouts / (outcomes.length + 1);'
       SUITE="node --test tests/tripwires.test.mjs"; STIME=120 ;;
  u06) FILE=server/tripwires.mjs; DESC="eventBudgetRemainingRatio dropped Math.max(0,...) clamp";
       OLD='const remaining = Math.max(0, eventsPerRoom - seq) / eventsPerRoom;'
       NEW='const remaining = (eventsPerRoom - seq) / eventsPerRoom;'
       SUITE="node --test tests/tripwires.test.mjs"; STIME=120 ;;
  u07) FILE=server/tripwires.mjs; DESC="trackCommandOutcome flipped writableEnded conditional";
       OLD='if (!settled && res.writableEnded !== true) record("timeout");'
       NEW='if (!settled && res.writableEnded === true) record("timeout");'
       SUITE="node --test tests/tripwires.test.mjs"; STIME=120 ;;
  u08) FILE=telemetry/gauges.mjs; DESC="toContractStatus dropped critical->trip mapping";
       OLD='if (status === "critical") return "trip";'
       NEW='if (status === "critical") return "critical";'
       SUITE="node --test telemetry/tripwire-contract.test.mjs"; STIME=60
       HARNESS="node $HD/h-u08.mjs" ;;
  u09) FILE=telemetry/gauges.mjs; DESC="contract view threshold criticalAt->warnAt";
       OLD='threshold: g.criticalAt'; NEW='threshold: g.warnAt'
       SUITE="node --test telemetry/tripwire-contract.test.mjs"; STIME=60
       HARNESS="node $HD/h-u09.mjs" ;;
  u10) FILE=telemetry/validate.mjs; DESC="claim min-length 10->5";
       OLD='finding.claim.length < 10'; NEW='finding.claim.length < 5'
       SUITE="true"; STIME=10
       HARNESS="node $HD/h-u10.mjs $W" ;;
  u11) FILE=telemetry/collect.mjs; DESC="extractFinding dropped FINDING prefix gate";
       OLD=$'  if (!body.startsWith(\'FINDING\\n\') && body.trimStart() !== \'FINDING\' && !body.startsWith(\'FINDING\\r\')) {\n    return { status: \'not-finding\' };\n  }'
       NEW=''
       SUITE="true"; STIME=10
       HARNESS="node $HD/h-u11.mjs $W" ;;
  u12) FILE=telemetry/build-dashboard-data.mjs; DESC="corrupt JSONL line: throw->skip";
       OLD='    throw new Error(`invalid JSON on line ${i + 1} of ${src}: ${e.message}`);'
       NEW='    console.error(`mutant: skipping corrupt line ${i + 1}`); return null;'
       SUITE="true"; STIME=10
       HARNESS="node $HD/h-u12.mjs $W" ;;
  u13) FILE=server/agent-plugin-store.mjs; DESC="deliverWakePing dropped WAKE_PING_EVENT filter (only '*' subs served)";
       OLD='if (!events.includes(WAKE_PING_EVENT) && !events.includes("*")) continue;'
       NEW='if (!events.includes("*")) continue;'
       SUITE="node --test tests/bonds.test.js"; STIME=600 ;;
  u14) FILE=server/agent-plugin-store.mjs; DESC="pruneWebhookDeliveries moreMayRemain === -> >";
       OLD='moreMayRemain: doomed.length === WEBHOOK_DELIVERY_PRUNE_BATCH,'
       NEW='moreMayRemain: doomed.length > WEBHOOK_DELIVERY_PRUNE_BATCH,'
       SUITE="node --test tests/webhook-delivery-load.test.js"; STIME=300 ;;
  u15) FILE=server/agent-plugin-store.mjs; DESC="SKIPPED_RECHECK_MS 10min->1ms";
       OLD='export const SKIPPED_RECHECK_MS = 10 * 60 * 1000;'
       NEW='export const SKIPPED_RECHECK_MS = 1;'
       SUITE="node --test tests/webhook-delivery-load.test.js"; STIME=300
       HARNESS="node $HD/h-u15.mjs" ;;
  *) echo "unknown unit $U"; exit 2 ;;
esac

exec 9>"$LOCK"; flock 9
BAK="$W/.tmp/mutbak-${U}-$$"
cp "$FILE" "$BAK"
restore() { cp "$BAK" "$FILE"; rm -f "$BAK"; }
trap restore EXIT

{
  echo "unit=$U"
  echo "file=$FILE"
  echo "mutant=$DESC"
  echo "suite=$SUITE"
} > "$RES"

PFILE=$FILE POLD=$OLD PNEW=$NEW patch_once || { echo "outcome=PATCH-FAIL" >> "$RES"; exit 0; }

SCODE=$(run_suite "$SUITE" "$STIME")
if [ "$SCODE" -eq 0 ]; then echo "outcome=SURVIVED" >> "$RES"; else echo "outcome=KILLED" >> "$RES"; fi
echo "suite_exit=$SCODE" >> "$RES"

if [ -n "$HARNESS" ]; then
  timeout 120 bash -c "$HARNESS" >"$W/.tmp/units/${U}.harnesslog" 2>&1
  HCODE=$?
  if [ "$HCODE" -eq 0 ]; then echo "harness=NOT-DETECTED" >> "$RES";
  elif [ "$HCODE" -eq 1 ]; then echo "harness=DETECTED" >> "$RES";
  else echo "harness=ERROR($HCODE)" >> "$RES"; fi
else
  echo "harness=none" >> "$RES"
fi
echo "done=$(date -u +%FT%TZ)" >> "$RES"
exit 0
