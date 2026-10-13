import { validId } from "../src/events.js";
import { workContextMarkdown } from "./room-agent.mjs";

// Compose existing authenticated reads; no writes, acknowledgements or dispatch.
// A bounded window keeps a busy task from consuming an entire agent context.
export async function prepareWork(client, workItemId, { includeSource = false, includeOffers = false, discussionSince, signal } = {}) {
  if (discussionSince !== undefined && (!Number.isSafeInteger(discussionSince) || discussionSince < 0)) throw new Error("Use a nonnegative discussion checkpoint from a completed read of this task");
  signal?.throwIfAborted();
  const options = { includeSource, includeOffers, signal };
  const initial = await client.workContext(workItemId, options);
  const items = [], cursors = new Set();
  let cursor, page;
  for (let count = 0; count < 4; count++) {
    signal?.throwIfAborted();
    const result = await client.workDiscussion(workItemId, { ...(cursor ? { cursor } : discussionSince === undefined ? {} : { since: discussionSince }), limit: 25, signal });
    page = result.discussion;
    items.push(...page.items);
    if (!page.hasMore) break;
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error("Discussion cursor did not advance");
    cursor = page.nextCursor;
    cursors.add(cursor);
  }
  signal?.throwIfAborted();
  const current = await client.workContext(workItemId, options);
  signal?.throwIfAborted();
  return { ...current, preparation: {
    version: 1,
    changedDuringRead: initial.work.revision !== current.work.revision,
    eventsAfterDiscussion: current.evaluatedThrough > page.horizon,
    discussion: { items, since: discussionSince ?? 0, horizon: page.horizon, checkpoint: page.checkpoint,
      hasMore: page.hasMore, nextCursor: page.nextCursor },
    nextRead: page.hasMore ? { tool: "room_read_work_discussion", arguments: { workItemId, cursor: page.nextCursor, limit: 25 } } : null,
    guidance: "Current task plus a frozen discussion window. Follow nextRead when present. Numeric checkpoints are not recovery-safe; discard them after known or suspected history recovery or replacement. Later room events may be unrelated; refresh relevant context before acting. Reading does not start work or change existing authority."
  } };
}

class WorkBatchTooLarge extends Error {}
export function workReadRefusal(error) {
  return error instanceof WorkBatchTooLarge ? { type: "work_read_refused", code: "batch_too_large",
    message: "Read fewer tasks or omit source/discussion. Batch output is limited to 128 KiB; no partial content was returned." } : null;
}

// A single selection keeps its existing response. Batches reuse the same reads,
// preserve caller order and fail closed; no partial successful packet is returned.
export async function readWorkSelection(client, args, { signal } = {}) {
  const batch = args.workItemIds !== undefined;
  const ids = batch ? args.workItemIds : [args.workItemId];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 4 || !ids.every(validId)
    || new Set(ids).size !== ids.length || batch && (args.workItemId !== undefined || args.discussionSince !== undefined)) {
    throw new Error("Choose one workItemId or 1–4 unique workItemIds; discussionSince requires one task");
  }
  const stop = new AbortController();
  const readSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const results = new Array(ids.length);
  let next = 0, bytes = 64;
  const read = async id => {
    readSignal.throwIfAborted();
    const options = { includeSource: args.includeSource ?? false, includeOffers: args.includeOffers ?? false, signal: readSignal };
    const context = args.includeDiscussion ? await prepareWork(client, id, { ...options, discussionSince: args.discussionSince })
      : await client.workContext(id, options);
    readSignal.throwIfAborted();
    if (context.preparation?.nextRead) context.preparation.nextRead.arguments.roomId = context.roomId;
    for (const request of context.replyRequestContext?.requests ?? []) request.nextRead.arguments.roomId = context.roomId;
    if (context.replyRequestContext?.nextRead) context.replyRequestContext.nextRead.arguments.roomId = context.roomId;
    return (args.brief ?? batch) ? { roomId: context.roomId, workItemId: context.work.id, revision: context.work.revision,
      evaluatedThrough: context.evaluatedThrough, ...(context.toolFocus ? { toolFocus: context.toolFocus } : {}),
      brief: workContextMarkdown(context), ...(context.preparation ? { preparation: context.preparation } : {}) } : context;
  };
  const worker = async () => {
    try {
      while (next < ids.length) {
        readSignal.throwIfAborted();
        const index = next++;
        results[index] = await read(ids[index]);
        if (batch) {
          bytes += new TextEncoder().encode(JSON.stringify(results[index])).byteLength + 1;
          if (bytes > 131072) throw new WorkBatchTooLarge("Batch output limit exceeded");
        }
      }
    } catch (error) { stop.abort(error); throw error; }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(2, ids.length) }, worker));
  if (settled.some(result => result.status === "rejected")) throw stop.signal.reason;
  return batch ? { items: results, readOnly: true, atomicSnapshot: false } : results[0];
}
