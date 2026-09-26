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
