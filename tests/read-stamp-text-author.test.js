// STAMP-SWEEP: the search, reply-read and work-discussion doors serve a
// message's CURRENT body, so their trust stamp must key on the author of
// the served text — the last editor when the message was edited — not the
// original poster. An owner rewrite of the viewer's own message must not
// arrive as the viewer's own unmarked text on any of these doors, and the
// editor reading their own rewrite must not see it marked as foreign.
// Legacy records (editedAt set, editedBy never recorded) fail closed:
// marked for every viewer, the editor being unknowable.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { stampSearch, stampReplyRead, stampDiscussion } from "../server/content-trust.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const memberId of ["agent", "peer"]) {
    send("owner", T.MEMBER_ADDED, { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work"] });
    keys[memberId] = store.issueAccessKey("commons", memberId);
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  for (const a of ["owner", "agent", "peer"]) for (const b of ["owner", "agent", "peer"])
    if (a !== b) { store.dmConsents.request("commons", a, b, "specimen"); store.dmConsents.decide("commons", b, a, "approve"); }
  const post = (actor, messageId, body, extra = {}) => send(actor, T.MESSAGE_POSTED, { messageId, body, ...extra });
  const edit = (actor, messageId, body) => send(actor, T.MESSAGE_EDITED, { messageId, body, expectedMessageRevision: 0 });
  return { store, keys, send, post, edit };
}

test("search door keys the stamp on the served text's author", t => {
  const f = fixture(t);
  f.post("agent", "s1", "zebra original text");
  f.edit("owner", "s1", "zebra owner rewrite");
  f.post("agent", "s2", "zebra self text");
  f.edit("agent", "s2", "zebra self rewrite");
  f.post("agent", "s3", "zebra plain text");
  const row = (viewer, id) => f.store.search(f.keys[viewer], "commons", "zebra").messages.find(m => m.id === id);
  // The poster reading the owner's rewrite of their own message: marked.
  assert.equal(row("agent", "s1").untrusted, true, "owner rewrite is marked for the poster");
  assert.equal(row("agent", "s1").body, "zebra owner rewrite");
  // The editor reading their own rewrite: unmarked.
  assert.equal(Object.hasOwn(row("owner", "s1"), "untrusted"), false, "owner rewrite is unmarked for the editor");
  // Self-edit and unedited controls keep today's marking.
  assert.equal(Object.hasOwn(row("agent", "s2"), "untrusted"), false, "self-edited message unmarked for its author");
  assert.equal(row("peer", "s2").untrusted, true, "self-edited message marked for a peer");
  assert.equal(Object.hasOwn(row("agent", "s3"), "untrusted"), false, "own unedited message unmarked");
  assert.equal(row("peer", "s3").untrusted, true, "another member's message marked for a peer");
  // The legacy fail-closed leg (editedAt without editedBy) is covered by
  // the unit specimen below: live projection records are frozen, so a
  // legacy record cannot be simulated by mutating the store's state.
});

test("work discussion door keys the stamp on the served text's author", t => {
  const f = fixture(t);
  f.post("agent", "dsrc", "discussion source text");
  f.send("owner", T.WORK_PROPOSED, { workItemId: "w1", title: "w1", definitionOfDone: "A useful answer",
    accountableMemberId: "agent", mode: "read", independentVerificationRequired: false,
    ownerDecisionRequired: true, humanDecisionMakerId: "owner", sourceMessageId: "dsrc" });
  f.post("agent", "drep", "discussion reply text", { replyToId: "dsrc" });
  f.edit("owner", "dsrc", "discussion owner rewrite");
  const item = (viewer, id) => f.store.workDiscussion(f.keys[viewer], "commons", "w1", {})
    .discussion.items.find(row => row.message.id === id);
  assert.equal(item("agent", "dsrc").message.untrusted, true, "owner rewrite is marked for the poster");
  assert.equal(item("agent", "dsrc").message.body, "discussion owner rewrite");
  assert.equal(Object.hasOwn(item("owner", "dsrc").message, "untrusted"), false, "owner rewrite is unmarked for the editor");
  assert.equal(Object.hasOwn(item("agent", "drep").message, "untrusted"), false, "own unedited reply unmarked");
  assert.equal(item("peer", "drep").message.untrusted, true, "another member's reply marked for a peer");
});

test("reply read door keys page items and previous exchanges on the text author", t => {
  const f = fixture(t);
  const q1 = f.post("agent", "q1", "reply door question text", { toMemberId: "owner", requestKind: "reply" });
  f.edit("owner", "q1", "reply door owner rewrite");
  const pageItem = (viewer) => f.store.replyRequests.selected(f.keys[viewer], "commons", "q1", {})
    .page.items.find(item => item.message?.id === "q1");
  assert.equal(pageItem("agent").message.untrusted, true, "owner rewrite is marked for the poster on the page");
  assert.equal(Object.hasOwn(pageItem("owner").message, "untrusted"), false, "owner rewrite is unmarked for the editor on the page");
  // Answer Q1, then open a follow-up: Q1 rides in Q2's previous exchanges.
  f.post("owner", "r1", "Use the simple option.", { responseToRequestId: "q1", expectedRequestRevision: 0,
    responseOutcome: "answered", contextEventId: q1.event.id, contextSequence: q1.sequence,
    replyToId: "q1", toMemberId: "agent", workItemId: null });
  f.post("agent", "q2", "reply door follow-up text", { toMemberId: "owner", requestKind: "reply", replyToId: "r1" });
  const read = f.store.replyRequests.selected(f.keys.agent, "commons", "q2", {});
  const prior = read.preparation.previousExchanges.flatMap(exchange => exchange.messages);
  assert.equal(prior.find(m => m.id === "q1").untrusted, true, "owner rewrite is marked for the poster in previous exchanges");
  assert.equal(prior.find(m => m.id === "r1").untrusted, true, "the owner's answer is marked for the agent (control)");
});

test("stampers fail closed on legacy records and key on editedBy when present (unit)", t => {
  const legacy = { id: "m1", authorId: "agent", body: "legacy text", createdAt: "2026-01-01T00:00:00.000Z", editedAt: "2026-01-02T00:00:00.000Z" };
  const edited = { ...legacy, id: "m2", editedBy: "owner" };
  const search = stampSearch({ messages: [legacy, edited], workItems: [] }, "agent");
  assert.equal(search.messages[0].untrusted, true, "search: legacy record marked for the poster");
  assert.equal(search.messages[1].untrusted, true, "search: owner-edited record marked for the poster");
  assert.equal(Object.hasOwn(stampSearch({ messages: [edited], workItems: [] }, "owner").messages[0], "untrusted"), false,
    "search: owner-edited record unmarked for the editor");
  const page = stampReplyRead({ page: { items: [{ message: legacy }] } }, "agent");
  assert.equal(page.page.items[0].message.untrusted, true, "reply page: legacy record marked for the poster");
  const prep = stampReplyRead({ page: { items: [] }, preparation: { room: {}, previousExchanges: [{ messages: [legacy] }], work: null } }, "agent");
  assert.equal(prep.preparation.previousExchanges[0].messages[0].untrusted, true, "previous exchanges: legacy record marked for the poster");
  const discussion = stampDiscussion({ viewerId: "agent", discussion: { items: [{ message: legacy }] } });
  assert.equal(discussion.discussion.items[0].message.untrusted, true, "discussion: legacy record marked for the poster");
});
