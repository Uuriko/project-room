import test from "node:test";
import assert from "node:assert/strict";
import { isStatusOnly, statusHint, statusDigestEnabled } from "../server/status-digest.mjs";

const on = { ROOM_STATUS_DIGEST: "1" };

test("flag is off by default", () => {
  assert.equal(statusDigestEnabled({}), false);
  assert.equal(statusHint({ body: "merged #12, deployed" }, {}), null);
});

test("classifies status-only posts conservatively", () => {
  assert.equal(isStatusOnly({ body: "LANE-A REVIEWED #5934 tests 3/3 green" }), true);
  assert.equal(isStatusOnly({ body: "Pre-act: building the CI shard" }), true);
  assert.equal(isStatusOnly({ body: "merged, can you redeploy?" }), false);
  assert.equal(isStatusOnly({ body: "done <@ai_x>" }), false);
  assert.equal(isStatusOnly({ body: "done @claude" }), false);
  assert.equal(isStatusOnly({ body: "merged", replyToId: "m1" }), false);
  assert.equal(isStatusOnly({ body: "merged", toMemberId: "ai_x" }), false);
  assert.equal(isStatusOnly({ body: "the bug is in the cursor encoder" }), false);
  assert.equal(isStatusOnly({ body: "" }), false);
});

test("hint only for unattached status posts with the flag on", () => {
  const hint = statusHint({ body: "landed #5961" }, on);
  assert.equal(hint.kind, "status_only");
  assert.equal(hint.acknowledges, false);
  assert.equal(hint.next[1].arguments.view, "digest");
  assert.equal(statusHint({ body: "landed #5961", workItemId: "w1" }, on), null);
  assert.equal(statusHint({ body: "who owns #5961?" }, on), null);
});
