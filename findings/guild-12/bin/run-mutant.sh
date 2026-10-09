#!/usr/bin/env bash
# run-mutant.sh MUTID — wave1000 guild-12 mutation unit driver.
# Applies ONE mutant to the guild worktree, runs the affected test file,
# restores the source, appends KILLED/SURVIVED to mutant-results.log.
# Serialized per source file via flock. Mutations are transient; never committed.
set -u
WT=~/workspace/pr-wave1000-guild-12
MUTID="${1:?usage: run-mutant.sh MUTID}"
LOGDIR="$WT/findings/guild-12"
mkdir -p "$LOGDIR/logs" "$WT/.tmp"

case "$MUTID" in
  M01) FILE=server/wake-queue.mjs;        SED='s/Math\.min(row\.due_at, request\.dueAt)/Math.max(row.due_at, request.dueAt)/'; TEST=tests/wake-queue.test.js;;
  M02) FILE=server/wake-queue.mjs;        SED='s/if (receipts >= wakeQueueLimits\.receipts)/if (receipts > wakeQueueLimits.receipts)/'; TEST=tests/wake-queue.test.js;;
  M03) FILE=server/wake-queue.mjs;        SED='s/due_at<=?/due_at<?/'; TEST=tests/wake-queue.test.js;;
  M04) FILE=server/wake-queue.mjs;        SED='s/attempts>=max_attempts/attempts>max_attempts/'; TEST=tests/wake-queue.test.js;;
  M05) FILE=server/wake-queue.mjs;        SED='s/2 \*\* (row\.attempts - 1)/2 ** row.attempts/'; TEST=tests/wake-queue.test.js;;
  M06) FILE=server/wake-queue.mjs;        SED='s/request\.maxAttempts > wakeQueueLimits\.maxAttempts/request.maxAttempts >= wakeQueueLimits.maxAttempts/'; TEST=tests/wake-queue.test.js;;
  M07) FILE=server/wake-queue.mjs;        SED='s/row\.lease_owner !== leaseOwner/row.lease_owner === leaseOwner/'; TEST=tests/wake-queue.test.js;;
  M08) FILE=server/wake-queue.mjs;        SED='s/if (isGuestAgentMemberId(auth\.member\.id))/if (!isGuestAgentMemberId(auth.member.id))/'; TEST=tests/wake-queue.test.js;;
  M09) FILE=server/work-wakes.mjs;        SED='s/item\.revision === before\.workItems\[id\]?\.revision/item.revision !== before.workItems[id]?.revision/'; TEST="tests/agent-wake.test.js tests/agent-wake-poll.test.js tests/board-wake.test.js tests/board-wake-ready-work.test.js tests/room-mcp-wake.test.js tests/pull-only-heartbeat-wakes.test.js tests/agent-heartbeats.test.js";;
  M10) FILE=server/work-wakes.mjs;        SED='s/if (result\.length >= limit) break;/if (result.length > limit) break;/'; TEST="tests/agent-wake.test.js tests/agent-wake-poll.test.js tests/board-wake.test.js tests/board-wake-ready-work.test.js tests/room-mcp-wake.test.js tests/pull-only-heartbeat-wakes.test.js tests/agent-heartbeats.test.js";;
  M11) FILE=server/work-wakes.mjs;        SED='s/member?\.active !== false/member?.active === false/'; TEST="tests/agent-wake.test.js tests/agent-wake-poll.test.js tests/board-wake.test.js tests/board-wake-ready-work.test.js tests/room-mcp-wake.test.js tests/pull-only-heartbeat-wakes.test.js tests/agent-heartbeats.test.js";;
  M12) FILE=server/work-wakes.mjs;        SED='s/if (statement\.run(at, agentId, id, roomId, roomId)\.changes) acknowledged\.push(id);/statement.run(at, agentId, id, roomId, roomId); acknowledged.push(id);/'; TEST="tests/agent-wake.test.js tests/agent-wake-poll.test.js tests/board-wake.test.js tests/board-wake-ready-work.test.js tests/room-mcp-wake.test.js tests/pull-only-heartbeat-wakes.test.js tests/agent-heartbeats.test.js";;
  M13) FILE=server/wake-queue-limits.mjs; SED='s/leaseMs: 30000/leaseMs: 3000/'; TEST=tests/wake-queue.test.js;;
  M14) FILE=server/wake-queue-limits.mjs; SED='s/baseBackoffMs: 60000/baseBackoffMs: 6000/'; TEST=tests/wake-queue.test.js;;
  M15) FILE=server/action-classes.mjs;    SED='s/if (!klass) throw new Error(`Unclassified command type: ${type}`);/if (!klass) return "observe";/'; TEST=tests/action-classes.test.js;;
  *) echo "unknown mutant $MUTID" >&2; exit 3;;
esac

SRC="$WT/$FILE"
LOCK="$WT/.tmp/mutlock-$(echo "$FILE" | tr '/' '_')"
exec 9>"$LOCK"
flock 9

restore() { [ -f "$SRC.guild12bak" ] && mv -f "$SRC.guild12bak" "$SRC"; }
trap restore EXIT

cp "$SRC" "$SRC.guild12bak"
sed -i "$SED" "$SRC"
if cmp -s "$SRC" "$SRC.guild12bak"; then
  echo "$MUTID NOCHANGE sed matched nothing" | tee -a "$LOGDIR/mutant-results.log"
  exit 2
fi

START=$(date +%s)
OUT=$(cd "$WT" && TMPDIR="$WT/.tmp" timeout 600 node --test $TEST 2>&1); CODE=$?
END=$(date +%s)
echo "$OUT" > "$LOGDIR/logs/$MUTID.log"
if [ $CODE -eq 0 ]; then VERDICT=SURVIVED; else VERDICT=KILLED; fi
echo "$MUTID $VERDICT file=$FILE test=$TEST dur=$((END-START))s" | tee -a "$LOGDIR/mutant-results.log"
