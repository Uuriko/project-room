import { contributorsForReturnBrief } from "./brief.js";

/**
 * Attach the thin Contributors read-model to a Phase 0 return-brief payload.
 * Pure. Does not acknowledge, mutate work, or mint Events.
 *
 * Call this from `buildReturnBrief` with the Room's Events through the frozen
 * horizon H (not the paged history page). Pass `workItems` so designated
 * roles still resolve when `work.proposed` sits before the last-visit cursor.
 *
 * `items` may be Phase 0 `{ sequence, event }` rows through H. When `since` is
 * omitted, the last-visit bound is the `at` of the Event at `cursor`.
 */
export function attachContributorsToReturnBrief(brief = {}, input = {}, options = {}) {
  const events = Array.isArray(input) ? input : input.events ?? eventsFromHistoryItems(input.items);
  const items = Array.isArray(input) ? [] : input.items ?? [];
  const workItems = Array.isArray(input) ? undefined : input.workItems;
  const since = options.since ?? sinceFromCursor(items, options.cursor ?? 0);
  return {
    ...brief,
    contributors: contributorsForReturnBrief({ events, workItems }, { since, workItemId: options.workItemId })
  };
}

/** Unwrap Phase 0 `{ sequence, event }` history rows into Event envelopes. */
export function eventsFromHistoryItems(items = []) {
  const events = [];
  for (const item of items) {
    if (item?.event && typeof item.event === "object") events.push(item.event);
    else if (item && typeof item === "object" && item.id && item.type) events.push(item);
  }
  return events;
}

/**
 * Last-visit bound for `contributorsForReturnBrief({ since })`.
 * Cursor 0 means "never caught up" — no since filter.
 * The Event at sequence C was already seen; rows use created_at > since.
 */
export function sinceFromCursor(items = [], cursor = 0) {
  if (!Number.isSafeInteger(cursor) || cursor <= 0) return null;
  for (const item of items) {
    if (item?.sequence === cursor && item.event?.at) return item.event.at;
  }
  return null;
}
