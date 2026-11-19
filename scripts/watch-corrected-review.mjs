#!/usr/bin/env node
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";
import { validId } from "../src/events.js";

export async function watchCorrectedReview(client, scope, { signal, onWaiting = () => {} } = {}) {
  const { roomId, memberId, workItemId, priorCompletionEventId } = scope;
  let { after } = scope;
  if (![roomId, memberId, workItemId, priorCompletionEventId].every(validId)
    || !Number.isSafeInteger(after) || after < 0) throw new Error("Choose a work item, its prior completion and the last observed sequence");
  const access = await client.checkConnection({ signal });
  if (access.roomId !== roomId || access.memberId !== memberId || !access.permissions.includes("verify"))
    throw new Error("Use the designated reviewer's existing Room connection");

  // The cursor is captured before corrected submission. Reconnecting with it
  // recovers the same committed event and therefore the same review operation.
  onWaiting(after);
  while (!signal?.aborted) {
    const change = await client.waitForChange(after, { signal, timeoutMs: 45000, reviewWorkItemId: workItemId });
    if (!change.changed) {
      after = change.through;
      continue;
    }
    const selected = await client.workResult(workItemId, { signal });
    const { current, review } = selected;
    const completionEventId = current.completionEventId;
    const action = review?.action;
    if (current.next.action === "superseded" || (completionEventId && completionEventId !== priorCompletionEventId
      && ["complete", "decide"].includes(current.next.action))) return { status: "settled", completionEventId };
    if (selected.workThread?.correction?.completionEventId === priorCompletionEventId
      && current.next.memberId === memberId && action?.tool === "room_record_verification"
      && action.arguments.completionEventId === completionEventId) {
      return {
        status: "review_ready", workItemId, completionEventId, priorCompletionEventId,
        wake: { sequence: change.sequence ?? null, ...change.reviewHint,
          matchedCompletionEvent: change.reviewHint?.eventId === completionEventId,
          exactReadConfirmedAt: new Date().toISOString() },
        nextRead: { tool: "room_read_result", arguments: { roomId, workItemId, completionEventId } },
        verdict: { ...action, arguments: { ...action.arguments, requestId: `auto-review-${completionEventId}` } }
      };
    }
    // A later commit might have landed during workResult. Never advance over
    // it. On a lag hint, retain the cursor until the stream can replay it.
    if (change.sequence !== undefined) after = change.sequence;
  }
  signal?.throwIfAborted();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [directory, workItemId, priorCompletionEventId, cursor] = process.argv.slice(2);
  let ownership;
  try {
    if (process.argv.length !== 6 || !/^\d+$/.test(cursor ?? "")) throw new Error("Usage: node scripts/watch-corrected-review.mjs <private connection directory> <work ID> <prior completion ID> <cursor>");
    if (![workItemId, priorCompletionEventId].every(validId)) throw new Error("Choose a valid work and completion ID");
    const connection = readAgentConnection(directory);
    const key = createHash("sha256").update(JSON.stringify([connection.origin, connection.roomId, connection.memberId, workItemId])).digest("hex");
    // Use the existing watch lock so a second chat on this host cannot
    // arm the same reviewer and work while the first watch is still parked.
    ownership = new WatchJournal(join(directory, `corrected-review-${key}`));
    const result = await watchCorrectedReview(new RoomAgentClient(connection), {
      roomId: connection.roomId, memberId: connection.memberId, workItemId, priorCompletionEventId, after: Number(cursor)
    }, { signal: AbortSignal.timeout(15 * 60_000),
      onWaiting: after => console.error(JSON.stringify({ status: "waiting", after })) });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", code: typeof error.code === "string" ? error.code : error.name }));
    process.exitCode = 1;
  } finally {
    ownership?.close();
  }
}
