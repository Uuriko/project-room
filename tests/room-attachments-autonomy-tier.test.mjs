// Issue #998: t1_readonly agents could stage/discard/commit room files over
// hosted MCP because RoomAttachmentBytes.stage/commit/discard write rows
// directly and never pass through store.command(), so enforceAutonomyTiers
// never saw them. The fix runs the same tier gate inside those methods.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { demoteToReadonly, setTier } from "../server/autonomy-tiers.mjs";

function serve(t, { start = Date.parse("2026-09-26T12:00:00Z") } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-attachments-tier-"));
  const clock = { now: start };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest human", kind: "human", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  send("owner", T.MEMBER_ADDED, { memberId: "agent2", displayName: "Second agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  keys.guest = store.issueAccessKey("commons", "guest");
  keys.agent = store.issueAccessKey("commons", "agent");
  keys.agent2 = store.issueAccessKey("commons", "agent2");
  const demote = memberId => demoteToReadonly(store.db, "commons", memberId, { updatedBy: "owner", nowMs: clock.now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, clock, send, demote };
}

const fileData = bytes => Buffer.alloc(bytes || 4, "x").toString("base64");

const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };

test("t1_readonly agent cannot stage room files; humans and t2 agents are unaffected", t => {
  const f = serve(t);
  f.demote("agent");

  const refused = capture(() => f.store.roomAttachments.stage(f.keys.agent, "commons", {
    id: "f1", filename: "n.txt", mediaType: "text/plain", data: fileData()
  }));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");

  // Human members are never tier-restricted.
  const guest = f.store.roomAttachments.stage(f.keys.guest, "commons", {
    id: "f2", filename: "n.txt", mediaType: "text/plain", data: fileData()
  });
  assert.equal(guest.status, "staged");

  // A t2_standard agent keeps full member access.
  const agent2 = f.store.roomAttachments.stage(f.keys.agent2, "commons", {
    id: "f3", filename: "n.txt", mediaType: "text/plain", data: fileData()
  });
  assert.equal(agent2.status, "staged");
});

test("t1_readonly agent cannot discard or commit files it staged before demotion (issue #998 repro)", t => {
  const f = serve(t);

  // agent2 stages while at t2_standard, then gets demoted: the staged file
  // must not be discardable or committable by the demoted agent.
  f.store.roomAttachments.stage(f.keys.agent2, "commons", {
    id: "own", filename: "n.txt", mediaType: "text/plain", data: fileData()
  });
  f.demote("agent2");

  const discard = capture(() => f.store.roomAttachments.discard(f.keys.agent2, "commons", "own"));
  assert.equal(discard.status, 403);
  assert.equal(discard.code, "agent_readonly");

  const messageId = randomUUID();
  f.send("owner", T.MESSAGE_POSTED, { messageId, body: "owner message for commit target" });
  const commit = capture(() => f.store.roomAttachments.commit(f.keys.agent2, "commons", { id: "own", messageId }));
  assert.equal(commit.status, 403);
  assert.equal(commit.code, "agent_readonly");
});

test("room owner is exempt from the tier gate on attachments", t => {
  const f = serve(t);

  const staged = f.store.roomAttachments.stage(f.keys.owner, "commons", {
    id: "f9", filename: "n.txt", mediaType: "text/plain", data: fileData()
  });
  assert.equal(staged.status, "staged");

  // An agent owner would also pass: ownership implies full authority. The
  // human owner here discards a file staged by the now-demoted agent.
  f.store.roomAttachments.stage(f.keys.agent2, "commons", {
    id: "f10", filename: "n.txt", mediaType: "text/plain", data: fileData()
  });
  f.demote("agent2");
  const discarded = f.store.roomAttachments.discard(f.keys.owner, "commons", "f10");
  assert.equal(discarded.status, "discarded");
});

test("guest-agent members are denied staging, discarding and committing room files; reads stay open", t => {
  const f = serve(t);
  // Production guest admission mints member ids carrying the guest-agent-
  // prefix exactly; the denial keys on that shape, so the fixture does too.
  const guestId = "guest-agent-att-01";
  f.send("owner", T.MEMBER_ADDED, { memberId: guestId, displayName: "Guest visit", kind: "agent", permissions: [], accountableHumanId: "owner" });
  // t2_standard so the guest passes the autonomy tier gate and reaches the
  // guest denial (the tier gate precedes it, mirroring referral-invites).
  setTier(f.store.db, "commons", guestId, "t2_standard", { updatedBy: "owner", nowMs: f.clock.now });
  const guestKey = f.store.issueAccessKey("commons", guestId);

  const staged = capture(() => f.store.roomAttachments.stage(guestKey, "commons", {
    id: "g1", filename: "n.txt", mediaType: "text/plain", data: fileData()
  }));
  assert.equal(staged.status, 403);
  assert.equal(staged.code, "guest_scope_denied");

  // The guest denial fires before the uploader/owner checks, so discard and
  // commit on another member's staged file are refused as guest_scope_denied.
  f.store.roomAttachments.stage(f.keys.agent2, "commons", {
    id: "own", filename: "n.txt", mediaType: "text/plain", data: fileData()
  });
  const discarded = capture(() => f.store.roomAttachments.discard(guestKey, "commons", "own"));
  assert.equal(discarded.status, 403);
  assert.equal(discarded.code, "guest_scope_denied");

  const messageId = randomUUID();
  f.send("owner", T.MESSAGE_POSTED, { messageId, body: "owner message for commit target" });
  const committed = capture(() => f.store.roomAttachments.commit(guestKey, "commons", { id: "own", messageId }));
  assert.equal(committed.status, 403);
  assert.equal(committed.code, "guest_scope_denied");

  // Nothing landed for the guest; the read surface still answers.
  const rows = f.store.db.prepare("SELECT id FROM room_attachments WHERE room_id=? AND state IN ('staged','committed')").all("commons");
  assert.deepEqual(rows.map(row => row.id), ["own"]);
  assert.ok(Array.isArray(f.store.roomAttachments.list(guestKey, "commons").files), "guest reads remain open");
});
