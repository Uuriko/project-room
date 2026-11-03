// Read-side status chip for one work item (lobby proposal, Codex 2 sign-on
// at seq 236). Each chip names the event that supports it. Rules:
//   - claimed is not started: work.accepted / claim.acquired alone read
//     "claimed"; only work.started reads "started".
//   - a saved result is not reviewed: work.completed reads "result_saved";
//     "reviewed" needs a verification.recorded whose completionEventId is the
//     LATEST completion. A verification of an earlier completion is stale.
//   - waiting: work.blocked, until work.blocker_resolved or a later start.
//   - reopened work: a work.started after a completion supersedes the old
//     result and review, so the chip goes back to "started".
// Pure: derives only from the work item's own ordered events; it never
// marks anything read and grants nothing.
const RANK = { received: 0, claimed: 1, started: 2, waiting: 2, result_saved: 3, reviewed: 4, superseded: 5 };

export function workStatusChip(events, workItemId) {
  let chip = null, latestCompletion = null, beforeWait = null;
  const set = (state, event) => { chip = { state, sourceEventId: event.id, sourceType: event.type, at: event.at ?? null }; };
  for (const event of events ?? []) {
    if (!event || event.data?.workItemId !== workItemId || typeof event.id !== "string") continue;
    switch (event.type) {
      case "work.proposed": set("received", event); break;
      case "work.accepted":
      case "claim.acquired":
        if (!chip || RANK[chip.state] < RANK.claimed) set("claimed", event); break;
      case "work.started": latestCompletion = null; set("started", event); break;
      case "work.blocked": beforeWait = chip; set("waiting", event); break;
      case "work.blocker_resolved":
        if (chip?.state === "waiting") { if (beforeWait) chip = beforeWait; else set("claimed", event); }
        beforeWait = null; break;
      case "work.completed": latestCompletion = event.id; set("result_saved", event); break;
      case "verification.recorded":
        if (latestCompletion && event.data?.completionEventId === latestCompletion && chip?.state === "result_saved")
          chip = { ...chip, state: "reviewed", sourceEventId: event.id, sourceType: event.type, at: event.at ?? null,
            result: typeof event.data.result === "string" ? event.data.result : null };
        break;
      case "work.superseded": set("superseded", event); break;
      default: break;
    }
  }
  return chip;
}
