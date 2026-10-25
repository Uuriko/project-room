// C-06 ROOM-DIGEST contract tests.
// Pins: (1) seq coverage correctness — digest coverage sums exactly to the
// window and matches an eventsAfter walk of the same window (no gaps, no
// double-counts); (2) bodiesOmitted present exactly when message bodies in
// the window were not reproduced; (3) the size cap at scale — a generated
// 20,000-event room still returns a digest of at most DIGEST_MAX_BYTES with
// coverage intact; (4) the since-wake delta returns only post-wake changes.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { buildRoomDigest, DIGEST_CAPS, DIGEST_MAX_BYTES } from "../server/room-digest.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
const sumCounts = byType => Object.values(byType).reduce((a, b) => a + b, 0);

test("builder: caps, bodiesOmitted honesty, and the hard byte budget", () => {
  const base = {
    roomId: "r", viewerId: "v", since: 0, through: 20000, now: 0,
    context: { context_version: "a".repeat(64), roster: [{}], focusWork: [], decisions: [], locks: [], omitted: ["message_bodies"] },
    workChangedTotal: 400, actionable: { total: 0, byKind: {} }
  };
  // No messages in the window -> bodiesOmitted is absent, not zero.
  const quiet = buildRoomDigest({ ...base, byType: { "work_claim.updated": 5 }, workChanged: [], attention: [], messages: [], decisions: [] });
  assert.equal("bodiesOmitted" in quiet, false);
  assert.equal(quiet.coverage.eventsInWindow, 5);
  // Messages in the window -> bodiesOmitted counts every one of them.
  const loud = buildRoomDigest({
    ...base, byType: { "message.posted": 14000, "work_claim.updated": 6000 },
    workChanged: Array.from({ length: 25 }, (_, i) => ({ id: `claim-${i}`, seq: i + 1, action: "claimed", state: "claimed", title: "t".repeat(80) })),
    attention: Array.from({ length: 25 }, (_, i) => ({ kind: "mention", seq: i + 1, id: `m-${i}`, summary: "s".repeat(300) })),
    messages: Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, id: `msg-${i}`, actorId: "v", summary: "b".repeat(480) })),
    decisions: Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, type: "decision.recorded", actorId: "v" }))
  });
  assert.equal(loud.bodiesOmitted, 14000);
  assert.equal(loud.coverage.eventsInWindow, 20000);
  assert.equal(sumCounts(loud.coverage.byType), 20000);
  assert.ok(loud.work.length <= DIGEST_CAPS.work && loud.attention.length <= DIGEST_CAPS.attention);
  assert.ok(loud.messages.length <= DIGEST_CAPS.messages && loud.decisions.length <= DIGEST_CAPS.decisions);
  assert.ok(loud.messages.every(m => m.summary.length <= 140), "summaries ride the in-repo 140-char clip");
  assert.ok(bytes(loud) <= DIGEST_MAX_BYTES, `digest ${bytes(loud)} exceeds budget`);
  // Adversarial coverage: every event type in the vocabulary at once.
  // Coverage is never shed, so list sections must shed instead (truncated).
  const types = ["access.requested", "bond.activated", "bond.proposed", "bond.revoked", "capabilities.advertised", "channel.archived", "channel.created", "channel.renamed", "claim.acquired", "claim.released", "claim.renewed", "decision.recorded", "dm.consent_changed", "dm.posted", "land.updated", "member.access_changed", "member.added", "member.joined_via_invitation", "member.mute_set", "member.public_name_set", "member.status_updated", "message.deleted", "message.edited", "message.pinned", "message.posted", "message.reaction_set", "message.redacted", "message.unpinned", "notifications.preferences_set", "owner.decision_recorded", "ownership.transferred", "poll.voted", "receipt.evidence_withdrawn", "referral.completed", "room.archived", "room.created", "room.exported", "room.history_visibility_set", "room.join_link_set", "room.policy_set", "room.public_page_set", "room.public_receipts_set", "room.spend_allowance_set", "room.spend_pricing_set", "room.starter_seeded", "room.trust_set", "verification.recorded", "work.accepted", "work.blocked", "work.blocker_resolved", "work.completed", "work.halt_cleared", "work.handoff_recorded", "work.proposed", "work.public_set", "work.started", "work.superseded", "work_claim.updated"];
  const adversarial = buildRoomDigest({
    ...base, byType: Object.fromEntries(types.map(type => [type, 345])),
    workChanged: Array.from({ length: 25 }, (_, i) => ({ id: `claim-${"c".repeat(24)}${i}`, seq: i + 1, action: "state_changed", state: "in_progress", title: "t".repeat(80) })),
    attention: Array.from({ length: 25 }, (_, i) => ({ kind: "handoff", seq: i + 1, id: `msg-${"i".repeat(28)}${i}`, summary: "s".repeat(300) })),
    messages: Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, id: `msg-${"i".repeat(28)}${i}`, actorId: `member-${"u".repeat(24)}`, summary: "b".repeat(480) })),
    decisions: Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, type: "owner.decision_recorded", actorId: `member-${"u".repeat(24)}` }))
  });
  assert.ok(bytes(adversarial) <= DIGEST_MAX_BYTES, `adversarial digest ${bytes(adversarial)} exceeds budget`);
  assert.equal(sumCounts(adversarial.coverage.byType), adversarial.coverage.eventsInWindow, "coverage survives trimming");
  assert.ok(adversarial.truncated, "shedding is reported, not silent");
});

async function serve(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (token, type, data, id = randomUUID()) => store.command(token, "commons", { id, type, data });
  send(ownerKey, T.MEMBER_ADDED, { memberId: "worker", displayName: "Worker", kind: "agent", permissions: ["accept_work", "write_external", "complete_work"] });
  setTier(store.db, "commons", "worker", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const workerKey = store.issueAccessKey("commons", "worker");
  const longBody = `LONG-BODY ${"x".repeat(400)}`;
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m-public", body: longBody });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m-mention", body: "@Worker please review the plan" });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m-dm", body: "DM-BODY for worker only", toMemberId: "worker" });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const request = (path, token) => fetch(origin + path, { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { store, ownerKey, workerKey, send, origin, request, longBody };
}

test("digest over HTTP: coverage matches the event walk, bodies stay out, delta is post-wake only", async t => {
  const f = await serve(t);
  // One work-claim change + one decision land directly in the journal (the
  // idiom analytics-budget.test.js uses for journal-shaped fixtures).
  const head = f.store.room("commons").sequence;
  const insert = f.store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)");
  insert.run("commons", head + 1, "wc-1", JSON.stringify({ id: "wc-1", type: "work_claim.updated", actorId: "owner", roomId: "commons", at: new Date().toISOString(), data: { workClaim: "claim-1", action: "created", claimState: "unclaimed", title: "Digest me" } }));
  insert.run("commons", head + 2, "dec-1", JSON.stringify({ id: "dec-1", type: "decision.recorded", actorId: "owner", roomId: "commons", at: new Date().toISOString(), data: {} }));
  f.store.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run(head + 2);

  const anonymous = await f.request("/api/rooms/commons/digest");
  assert.equal(anonymous.status, 401);
  const bad = await f.request("/api/rooms/commons/digest?since=nope", f.ownerKey);
  assert.equal(bad.status, 422);
  const ahead = await f.request("/api/rooms/commons/digest?since=999999", f.ownerKey);
  assert.equal(ahead.status, 409);

  const response = await f.request("/api/rooms/commons/digest", f.workerKey);
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.ok(Buffer.byteLength(raw) <= DIGEST_MAX_BYTES, "HTTP digest respects the byte budget");
  const digest = JSON.parse(raw);
  // Seq coverage: the digest's window is the whole log, and its counts sum
  // exactly to an independent eventsAfter walk of the same window.
  assert.equal(digest.since, 0);
  assert.equal(digest.through, head + 2);
  assert.equal(digest.coverage.eventsInWindow, head + 2);
  assert.equal(sumCounts(digest.coverage.byType), digest.coverage.eventsInWindow);
  let walked = 0, after = 0;
  for (;;) {
    const page = f.store.eventsAfter(f.workerKey, "commons", after, 100);
    walked += page.events.length;
    if (!page.hasMore) break;
    after = page.next;
  }
  assert.equal(walked, digest.coverage.eventsInWindow, "no gaps or double-counts vs the event walk");
  // Composition: context_version is the room-context projection's own hash.
  assert.equal(digest.context.context_version, f.store.roomContext(f.workerKey, "commons").context_version);
  // Bodies: the long public body is clipped to a summary, never reproduced.
  assert.equal(raw.includes(f.longBody), false);
  assert.ok(digest.messages.some(m => m.id === "m-public" && m.summary.length <= 140));
  assert.equal(digest.bodiesOmitted, digest.coverage.messagesTotal);
  assert.ok(digest.coverage.messagesTotal >= 3);
  // Work + decisions from the window, attention for the caller.
  assert.ok(digest.work.some(w => w.id === "claim-1" && w.state === "unclaimed"));
  assert.equal(digest.coverage.workChangedTotal, 1);
  assert.ok(digest.decisions.some(d => d.type === "decision.recorded"));
  assert.ok(digest.attention.some(a => a.kind === "mention"), "the @Worker mention reaches the worker's digest");
  // The DM body is not visible to a third party: owner's digest may carry
  // counts, but the worker is the DM's reader.
  assert.ok(digest.messages.some(m => m.id === "m-dm"), "DM summary visible to its addressee");

  // Since-wake delta: everything returned is strictly post-wake.
  const wakeSeq = digest.through;
  f.send(f.ownerKey, T.MESSAGE_POSTED, { messageId: "m-after", body: "@Worker fresh after the wake" });
  const deltaResponse = await f.request(`/api/rooms/commons/digest?since=${wakeSeq}`, f.workerKey);
  const delta = await deltaResponse.json();
  assert.equal(delta.coverage.eventsInWindow, delta.through - wakeSeq);
  assert.equal(sumCounts(delta.coverage.byType), delta.coverage.eventsInWindow);
  assert.ok(delta.messages.every(m => m.seq > wakeSeq));
  assert.ok(delta.attention.every(a => a.seq > wakeSeq));
  assert.ok(delta.work.every(w => w.seq > wakeSeq));
  assert.ok(delta.messages.some(m => m.id === "m-after"));
  assert.equal(delta.bodiesOmitted, delta.coverage.messagesTotal);
  // A caught-up digest is quiet and carries no bodiesOmitted.
  const quiet = await (await f.request(`/api/rooms/commons/digest?since=${delta.through}`, f.workerKey)).json();
  assert.equal(quiet.coverage.eventsInWindow, 0);
  assert.equal("bodiesOmitted" in quiet, false);
});

test("digest at 20,000 events: one read, capped bytes, exact coverage", t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const COUNT = 20000;
  const insert = store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)");
  store.db.exec("BEGIN");
  store.db.prepare("DELETE FROM events WHERE room_id='commons'").run();
  const distinctClaims = new Set();
  for (let seq = 1; seq <= COUNT; seq++) {
    const isMessage = seq % 10 < 7;
    const isWork = !isMessage && seq % 3 === 0;
    if (isWork) distinctClaims.add(`claim-${seq % 400}`);
    const id = `ev-${seq}`;
    insert.run("commons", seq, id, JSON.stringify({
      id, type: isMessage ? "message.posted" : isWork ? "work_claim.updated" : "room.policy_set",
      actorId: "owner", roomId: "commons", at: "2026-10-01T00:00:00.000Z",
      data: isMessage ? { messageId: id, body: "b".repeat(480) }
        : isWork ? { workClaim: `claim-${seq % 400}`, action: "state_changed", claimState: "in_progress", title: "A realistically titled work item for the digest" }
        : {}
    }));
  }
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run(COUNT);
  store.db.exec("COMMIT");
  const digest = store.roomDigest(ownerKey, "commons", { since: 0 });
  assert.equal(digest.coverage.eventsInWindow, COUNT);
  assert.equal(sumCounts(digest.coverage.byType), COUNT);
  assert.equal(digest.bodiesOmitted, digest.coverage.byType["message.posted"]);
  assert.equal(digest.coverage.workChangedTotal, distinctClaims.size);
  assert.ok(bytes(digest) <= DIGEST_MAX_BYTES, `20k-event digest is ${bytes(digest)} B`);
  const delta = store.roomDigest(ownerKey, "commons", { since: COUNT - 100 });
  assert.equal(delta.coverage.eventsInWindow, 100);
  assert.ok(delta.messages.every(m => m.seq > COUNT - 100));
  assert.ok(bytes(delta) <= DIGEST_MAX_BYTES);
});
