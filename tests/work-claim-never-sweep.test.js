// Low-hanging #12 (follow-up to #2341): an item tagged "never-sweep" is never
// closed by the stale sweep, but still goes dormant so it never jams the cap.
import test from "node:test";
import assert from "node:assert/strict";
import { closeStaleUnclaimed, isSweepPinned, isDormantClaim, NEVER_SWEEP_TAG, STALE_UNCLAIMED_DAYS } from "../server/work-claims.mjs";

const DAY = 24 * 3600 * 1000;

test("never-sweep: a pinned dormant item stays open but still does not count as active", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const old = new Date(now - (STALE_UNCLAIMED_DAYS + 1) * DAY).toISOString();
  const base = { state: "unclaimed", owner: null, createdAt: old, updatedAt: old, history: [] };
  const pinned = { ...base, id: "standing", tags: [NEVER_SWEEP_TAG] };
  const plain = { ...base, id: "stale", tags: [] };
  assert.equal(isSweepPinned(pinned), true);
  assert.equal(isSweepPinned({ ...pinned, tags: ["Never-Sweep"] }), true);
  assert.equal(isSweepPinned(plain), false);
  assert.equal(isDormantClaim(pinned, now), true, "pinned backlog still leaves the cap count");
  const swept = closeStaleUnclaimed([pinned, plain], now).map(([before]) => before.id);
  assert.deepEqual(swept, ["stale"]);
});
