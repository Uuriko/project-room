// DM report privacy: a moderation report must not become a backdoor for
// reading direct messages.
//
// RC-2026-09-19-070 / SEC-19: DMs are fully private to the two parties —
// non-participants (the room owner included) see no DM existence, count,
// metadata, or contents on any read surface. The moderation report list is
// a read surface too: reporting an abusive DM must hand the owner
// actionable metadata (who, when, why) without handing them the body.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const DM_BODY = "dm-secret-body-8k2n";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-dm-report-"));
  const clock = Date.parse("2026-10-07T12:00:00Z");
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const [memberId, kind, permissions] of [["guest", "human", []], ["producer", "agent", ["accept_work"]], ["reviewer", "agent", ["verify"]]]) {
    send("owner", T.MEMBER_ADDED, { memberId, displayName: `Test ${memberId}`, kind, permissions, ...(kind === "agent" ? { accountableHumanId: "owner" } : {}) });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  for (const memberId of ["producer", "reviewer"])
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: clock });
  return { store, keys, send };
}

test("reported DM: the room owner gets metadata, never the body", t => {
  const f = fixture(t);
  // producer -> reviewer DM (default-open: no consent rows needed).
  f.send("producer", T.MESSAGE_POSTED, { messageId: "dm-1", body: DM_BODY, toMemberId: "reviewer" });
  // The recipient reports the abusive DM.
  const filed = f.store.moderation.report(f.keys.reviewer, "commons", { messageId: "dm-1", reason: "harassment" });
  assert.equal(filed.report.messageId, "dm-1");
  // The owner lists reports: actionable metadata, but the DM body stays private.
  const listed = f.store.moderation.list(f.keys.owner, "commons");
  assert.equal(listed.reports.length, 1);
  const entry = listed.reports[0];
  assert.equal(entry.reporterId, "reviewer");
  assert.equal(entry.authorId, "producer");
  assert.equal(entry.reason, "harassment");
  assert.equal(entry.message, entry.message && typeof entry.message === "object" ? entry.message : null);
  assert.equal(entry.message.authorId, "producer");
  assert.equal(entry.message.body, null, "owner must not read a DM body via the report list");
});

test("a non-party cannot report a DM they cannot read", t => {
  const f = fixture(t);
  f.send("producer", T.MESSAGE_POSTED, { messageId: "dm-1", body: DM_BODY, toMemberId: "reviewer" });
  // guest is a bystander: the DM is invisible to them (404, like a missing message).
  try {
    f.store.moderation.report(f.keys.guest, "commons", { messageId: "dm-1", reason: "noise" });
  } catch (error) {
    assert.equal(error.status, 404);
    assert.equal(error.code, "message_not_found");
    return;
  }
  assert.fail("expected a 404 for a non-party reporting a DM");
});

test("regression: a reported public message still carries its body for the owner", t => {
  const f = fixture(t);
  f.send("producer", T.MESSAGE_POSTED, { messageId: "pub-1", body: "public body here" });
  f.store.moderation.report(f.keys.guest, "commons", { messageId: "pub-1", reason: "off-topic" });
  const listed = f.store.moderation.list(f.keys.owner, "commons");
  assert.equal(listed.reports.length, 1);
  assert.equal(listed.reports[0].message.body, "public body here");
});

test("owner as DM party still sees the reported DM body", t => {
  const f = fixture(t);
  // owner -> producer DM; the owner IS a party, so the body is theirs to see.
  f.send("owner", T.MESSAGE_POSTED, { messageId: "dm-2", body: "owner dm body", toMemberId: "producer" });
  f.store.moderation.report(f.keys.producer, "commons", { messageId: "dm-2", reason: "spammy" });
  const listed = f.store.moderation.list(f.keys.owner, "commons");
  assert.equal(listed.reports.length, 1);
  assert.equal(listed.reports[0].message.body, "owner dm body");
});
