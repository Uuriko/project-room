// Board attention badges: per-card "needs you" flags computed from the same
// classification the needs-me panel uses, so attention follows the card into
// its column. pushAskVisible owns the rule for when the push soft ask may
// appear inside the needs-me surface.
import test from "node:test";
import assert from "node:assert/strict";
import { attentionMap, QUIET_MS } from "../src/board-mine.js";
import { pushAskVisible } from "../src/board-ui.js";
import { urgentNeedsMeCount } from "../src/board-mine.js";

const now = Date.parse("2026-10-06T04:00:00Z");
const iso = ms => new Date(ms).toISOString();
const me = "ai_me", other = "ai_other";
const members = { [me]: { id: me, displayName: "Codex QA", kind: "agent" }, [other]: { id: other, displayName: "Jill", kind: "human" } };
const claim = (id, extra = {}) => ({ id, title: `Title ${id}`, state: "claimed", owner: me, tags: [], reviews: [],
  updatedAt: iso(now - 5 * 60000), leaseExpiresAt: iso(now + 5 * 3600000), ...extra });

test("attentionMap flags leases ending soon, ended leases, review requests and changes requested", () => {
  const items = [
    claim("ending", { leaseExpiresAt: iso(now + 20 * 60000) }),
    claim("ended", { leaseExpiresAt: iso(now - 60000) }),
    claim("review", { owner: other, tags: [`rev-${me}`] }),
    claim("changes", { reviews: [{ memberId: other, verdict: "changes_requested" }] }),
    claim("fine"),
    claim("unrelated", { owner: other, leaseExpiresAt: iso(now + 60000) }),
  ];
  const flags = attentionMap(items, me, members, now);
  assert.deepEqual(flags.get("ending"), ["lease-ending"]);
  assert.deepEqual(flags.get("ended"), ["lease-ended"]);
  assert.deepEqual(flags.get("review"), ["review-requested"]);
  assert.deepEqual(flags.get("changes"), ["changes-requested"]);
  assert.equal(flags.has("fine"), false);
  assert.equal(flags.has("unrelated"), false, "someone else's expiring lease is not my attention");
  assert.ok(flags instanceof Map);
});

test("attentionMap is empty without a viewer or items", () => {
  assert.equal(attentionMap([claim("a")], null, members, now).size, 0);
  assert.equal(attentionMap([], me, members, now).size, 0);
  assert.equal(attentionMap(null, me, members, now).size, 0);
});

test("attentionMap never writes claim state", () => {
  const items = [claim("a", { leaseExpiresAt: iso(now + 60000) })];
  const before = structuredClone(items);
  attentionMap(items, me, members, now);
  assert.deepEqual(items, before);
});

test("pushAskVisible: humans with urgent needs-you items may see the ask", () => {
  assert.equal(pushAskVisible({ urgentCount: 0, memberKind: "human" }), false);
  assert.equal(pushAskVisible({ urgentCount: 2, memberKind: "human" }), true);
  assert.equal(pushAskVisible({ urgentCount: 2, memberKind: "agent" }), false, "agents keep the human push path");
  assert.equal(pushAskVisible({ urgentCount: 2, memberKind: undefined }), false);
});

test("urgentNeedsMeCount matches the panel's urgent rows: expiring, reviews, quiet", () => {
  const items = [
    claim("ending", { leaseExpiresAt: iso(now + 20 * 60000) }),
    claim("review", { owner: other, tags: [`rev-${me}`] }),
    claim("quiet", { updatedAt: iso(now - QUIET_MS - 60000), history: [{ at: iso(now - QUIET_MS - 60000) }] }),
    claim("fine"),
  ];
  assert.equal(urgentNeedsMeCount(items, me, members, now), 3);
  assert.equal(urgentNeedsMeCount(items, null, members, now), 0);
  assert.equal(urgentNeedsMeCount([], me, members, now), 0);
});
