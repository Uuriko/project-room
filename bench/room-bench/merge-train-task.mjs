// Room-Bench task T11: enqueue a ready PR and see it on the merge train.
// Append to TASKS in bench/room-bench/tasks.mjs (Room-Bench, PR #4339).
// Shared state: s.room, s.repo (owner/name), s.pr (an open docs-only PR).
// Landing takes a test run, so the check accepts any live train state for
// the PR; a full run polls list until "landed".
const LIVE = new Set(["queued", "held", "in_batch", "landed", "confirmed"]);

export const MERGE_TRAIN_TASK = Object.freeze({
  id: "T11-land",
  goal: "Hand your ready PR to Room to land.",
  steps: [
    { tool: "room_land", args: (s) => ({ roomId: s.room, action: "enqueue", repo: s.repo, prNumber: s.pr }) },
    { tool: "room_land", args: (s) => ({ roomId: s.room, action: "list" }) }
  ],
  check: (s, r) => Boolean(r[0]?.ok && LIVE.has(r[0]?.out?.entry?.state)
    && (r[1]?.out?.entries ?? []).some(e => e.prNumber === s.pr && LIVE.has(e.state)))
});
