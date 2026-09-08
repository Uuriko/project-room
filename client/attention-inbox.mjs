import { AssignmentWatcher } from "./assignment-watcher.mjs";
import { WatchJournal, WatchError } from "./watch-journal.mjs";
import { validId } from "../src/events.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

// One explicitly requested read/ack, never a background poller or model runner. The directory
// belongs to the configured operator, not to tool arguments or Room content.
export async function currentAttention({ client, origin, roomId, directory, noticeId, signal, now = Date.now }) {
  if (noticeId !== undefined && !validId(noticeId)) throw new WatchError("invalid_notice");
  if (typeof directory !== "string" || !directory.trim()) throw new WatchError("private_state_required");
  if (signal?.aborted) throw new WatchError("stopped");
  // Failed first access must not leave a new private inbox behind. Reuse this
  // authenticated snapshot for the first reconciliation, not another fetch.
  const initialSnapshot = existsSync(join(directory, "watch.sqlite")) ? undefined : await client.snapshot({ signal });
  if (signal?.aborted) throw new WatchError("stopped");
  const journal = new WatchJournal(directory, { version: 2, create: noticeId === undefined });
  const controller = new AbortController(), activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let monitorError;
  const monitor = setInterval(() => {
    try { if (journal.shouldStop()) controller.abort(); }
    catch (error) { monitorError = error; controller.abort(); }
  }, 250);
  try {
    const watcher = new AssignmentWatcher({ client, journal, origin, roomId, signal: activeSignal, now, context: true });
    await watcher.reconcile(initialSnapshot);
    // Recheck access/current conditions before returning queued content or acking.
    await watcher.reconcile();
    if (monitorError) throw monitorError;
    if (activeSignal.aborted || journal.shouldStop()) throw new WatchError("stopped");
    const state = journal.state();
    if (noticeId !== undefined) return { schemaVersion: 2, noticeId, status: journal.acknowledge(noticeId),
      roomId, memberId: state.binding.memberId, evaluatedThrough: state.sequence, notifyOnly: true,
      scope: "local_observer_only", message: "Local acknowledgement only. No read marker, work acceptance, completion or approval changed." };
    const items = journal.pending(20), count = journal.status().pending;
    return { schemaVersion: 2, roomId, memberId: state.binding.memberId, evaluatedThrough: state.sequence,
      items, pending: count, hasMore: count > items.length, notifyOnly: true, scope: "current_conditions",
      message: "Notices remain pending until explicitly acknowledged. Their versions are observed references; nextRead refreshes current context, not permission. Intermediate changes between checks may be omitted." };
  } finally { clearInterval(monitor); journal.close(); }
}
