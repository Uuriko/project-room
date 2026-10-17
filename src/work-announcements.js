import { EVENT_TYPES as T } from "./events.js";
import { uiText } from "./strings.js";

// Polite live-region text for work arrivals (#3687). While a member watches
// the room, another member claiming, completing, reviewing or deciding work
// changes what the watcher can do next, but the timeline only ever pinged a
// generic "New changes available" — and a second arrival changed no text at
// all, so nothing was announced. Each announcement is one complete catalog
// sentence naming the actor, the item and the new state; several arrivals in
// one snapshot join into a single region update, one sentence per arrival.
// The watcher's own events are skipped: their own actions already announce
// through the #status path, and an arrival is only news when it is not theirs.
const DECISION_KEYS = {
  approved: "work.announce.decision_approved",
  changes_requested: "work.announce.decision_changes_requested",
  rejected: "work.announce.decision_rejected",
};

export function workArrivalAnnouncement(event, { selfId, actorName, titleFor }) {
  if (!event || event.actorId == null || event.actorId === selfId) return null;
  const workItemId = event.data?.workItemId;
  if (typeof workItemId !== "string") return null;
  const title = titleFor(workItemId);
  if (!title) return null;
  const actor = actorName(event.actorId);
  switch (event.type) {
    case T.WORK_ACCEPTED:
      return uiText("work.announce.claimed", { actor, title });
    case T.WORK_COMPLETED:
      return uiText("work.announce.completed", { actor, title });
    case T.VERIFICATION_RECORDED: {
      const key = event.data.result === "pass" ? "work.announce.review_passed"
        : event.data.result === "fail" ? "work.announce.review_failed"
          : "work.announce.review_recorded";
      return uiText(key, { actor, title });
    }
    case T.OWNER_DECISION_RECORDED:
      return uiText(DECISION_KEYS[event.data.decision] ?? "work.announce.decision_recorded", { actor, title });
    default:
      return null;
  }
}

export function workArrivalAnnouncements(events, context) {
  return events.map(event => workArrivalAnnouncement(event, context)).filter(Boolean).join(" ");
}
