// Group DMs (3-8 members): the same consent-gating and scoping semantics as
// pair DMs (data.toMemberId), extended to data.toMemberIds. A group DM is
// created by sending a message.posted addressed to 3-8 members — no separate
// create step, exactly like pair DMs. Pair-DM behavior is unchanged and stays
// covered by tests/dm-privacy.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  DmError,
  DM_GROUP_MIN_MEMBERS,
  DM_GROUP_MAX_MEMBERS,
  dmTargetIds,
  assertGroupDmMembers,
} from "../server/dm-rooms.mjs";

const GROUP_BODY = "group-dm-secret-k7p2";
const PUBLIC_BODY = "public-hello-z4w9";

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, key) => fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  const send = (actor, data) => f.store.command(f.keys[actor], "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data });
  // A fifth member so group-DM tests have a non-participant with a key.
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "extra", displayName: "Extra", kind: "human", permissions: [] } });
  f.keys.extra = f.store.issueAccessKey("commons", "extra");
  return { ...f, origin, get, send };
}

const throwsDm = (fn, code) => assert.throws(fn,
  error => error instanceof DmError && error.code === code);
const throwsStatus = (fn, status, code) => assert.throws(fn,
  error => error.status === status && (!code || error.code === code));

// ---- unit: addressing ----------------------------------------------------

test("dmTargetIds: public, pair, and group addressing", () => {
  assert.deepEqual(dmTargetIds({}), []);
  assert.deepEqual(dmTargetIds({ body: "hi" }), []);
  assert.deepEqual(dmTargetIds({ toMemberId: "bob" }), ["bob"]);
  assert.deepEqual(dmTargetIds({ toMemberIds: ["bob", "carol", "dave"] }), ["bob", "carol", "dave"]);
  // Message views carry the addressing top-level, not under data.
  assert.deepEqual(dmTargetIds({ toMemberId: "bob", authorId: "ada" }), ["bob"]);
  assert.deepEqual(dmTargetIds({ toMemberIds: ["bob", "carol", "x"], authorId: "ada" }), ["bob", "carol", "x"]);
  // Malformed addressing never throws and never addresses anyone.
  assert.deepEqual(dmTargetIds(null), []);
  assert.deepEqual(dmTargetIds({ toMemberIds: "bob" }), []);
  assert.deepEqual(dmTargetIds({ toMemberIds: [1, null] }), []);
});

test("assertGroupDmMembers: 3-8 distinct members, sender excluded", () => {
  assert.equal(DM_GROUP_MIN_MEMBERS, 3);
  assert.equal(DM_GROUP_MAX_MEMBERS, 8);
  assert.deepEqual(assertGroupDmMembers(["b", "c", "d"], "a"), ["b", "c", "d"]);
  assert.deepEqual(assertGroupDmMembers(["b", "c", "d", "e", "f", "g", "h", "i"], "a").length, 8);
  throwsDm(() => assertGroupDmMembers(["b", "c"], "a"), "invalid_dm");
  throwsDm(() => assertGroupDmMembers(["b", "c", "d", "e", "f", "g", "h", "i", "j"], "a"), "invalid_dm");
  throwsDm(() => assertGroupDmMembers(["b", "b", "c"], "a"), "invalid_dm");
  throwsDm(() => assertGroupDmMembers(["a", "b", "c"], "a"), "invalid_dm");
  throwsDm(() => assertGroupDmMembers("nope", "a"), "invalid_dm");
  throwsDm(() => assertGroupDmMembers(["b", "", "c"], "a"), "invalid_dm");
  throwsDm(() => assertGroupDmMembers(["b", 7, "c"], "a"), "invalid_dm");
});

// ---- integration: send + scoping ------------------------------------------

// producer -> [reviewer, guest, extra] group DM; the owner is the bystander
// (non-participant on purpose — the owner is not exempt from the filter,
// exactly like pair DMs in tests/dm-privacy.test.js).
async function seedGroup(t) {
  const f = await fixture(t);
  f.send("producer", { messageId: "gdm-1", body: GROUP_BODY, toMemberIds: ["reviewer", "guest", "extra"] });
  f.send("owner", { messageId: "public-1", body: PUBLIC_BODY });
  return f;
}

test("group DM: every member sees it; the owner sees nothing", async t => {
  const f = await seedGroup(t);
  const seenBy = async key => {
    const res = await f.get("/api/rooms/commons", key);
    assert.equal(res.status, 200);
    return res.json();
  };
  for (const [label, key] of [["producer", f.keys.producer], ["reviewer", f.keys.reviewer], ["guest", f.keys.guest], ["extra", f.keys.extra]]) {
    const snapshot = await seenBy(key);
    const inMessages = (snapshot.state.messages ?? []).some(m => m.id === "gdm-1");
    const inEvents = (snapshot.state.eventLog ?? []).some(e => e?.data?.messageId === "gdm-1");
    assert.ok(inMessages && inEvents, `${label} (a group member) must see the group DM`);
    assert.equal((snapshot.state.messages ?? []).find(m => m.id === "gdm-1").body, GROUP_BODY);
  }
  const snapshot = await seenBy(f.keys.owner);
  assert.equal((snapshot.state.messages ?? []).some(m => m.id === "gdm-1"), false, "owner must not see the group DM");
  assert.equal(JSON.stringify(snapshot).includes(GROUP_BODY), false, "owner must not see the group DM body anywhere");
  assert.ok((snapshot.state.messages ?? []).some(m => m.id === "public-1" && m.body === PUBLIC_BODY),
    "owner still sees public messages");
});

test("group DM: thread and search follow the same scoping", async t => {
  const f = await seedGroup(t);
  const reviewerThread = await f.get("/api/rooms/commons/messages/gdm-1/thread", f.keys.reviewer);
  assert.equal(reviewerThread.status, 200, "a group member reads the thread");
  assert.equal((await reviewerThread.json()).thread.body, GROUP_BODY);
  const ownerThread = await f.get("/api/rooms/commons/messages/gdm-1/thread", f.keys.owner);
  assert.equal(ownerThread.status, 404, "non-member gets 404 for the group DM thread");
  const search = (key, q) => f.get(`/api/rooms/commons/search?q=${encodeURIComponent(q)}`, key).then(r => r.json());
  assert.equal((await search(f.keys.guest, GROUP_BODY)).messages.length, 1, "member finds the group DM");
  assert.deepEqual((await search(f.keys.owner, GROUP_BODY)).messages, [], "non-member must not find the group DM");
});

// ---- integration: validation ---------------------------------------------

test("group DM: malformed membership is refused", async t => {
  const f = await fixture(t);
  // [label, toMemberIds, expectedCode]: semantic violations reach the DM
  // gate (invalid_dm); a non-array never gets past the field-shape gate
  // (invalid_command) — both are 422.
  const cases = [
    ["two members", ["reviewer", "guest"], "invalid_dm"],
    ["nine members", ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"], "invalid_dm"],
    ["duplicate members", ["reviewer", "reviewer", "guest"], "invalid_dm"],
    ["sender included", ["producer", "reviewer", "guest"], "invalid_dm"],
    ["not an array", "reviewer", "invalid_command"],
  ];
  for (const [label, toMemberIds, code] of cases) {
    throwsStatus(() => f.send("producer", { messageId: randomUUID(), body: "x", toMemberIds }), 422, code, label);
  }
  throwsStatus(() => f.send("producer", { messageId: randomUUID(), body: "x", toMemberId: "reviewer", toMemberIds: ["reviewer", "guest", "extra"] }),
    422, "invalid_dm", "toMemberId and toMemberIds together");
});

test("group DM: unknown members are refused like pair DMs", async t => {
  const f = await fixture(t);
  throwsStatus(() => f.send("producer", { messageId: randomUUID(), body: "x", toMemberIds: ["reviewer", "guest", "ghost"] }),
    422, "command_rejected");
});

// ---- integration: consent gating ------------------------------------------

test("group DM: a member who blocked the sender refuses the whole send", async t => {
  const f = await fixture(t);
  // DMs are open by default — no consent rows, the send lands.
  f.send("producer", { messageId: "gdm-open", body: GROUP_BODY, toMemberIds: ["reviewer", "guest", "extra"] });
  // The reviewer blocks the producer: the same 403 pair DMs get.
  f.store.dmConsents.block("commons", "reviewer", "producer");
  throwsStatus(() => f.send("producer", { messageId: randomUUID(), body: "x", toMemberIds: ["reviewer", "guest", "extra"] }),
    403, "dm_blocked");
  // The block is directional, like pair DMs: guest can still address the
  // same group, including the reviewer.
  f.send("guest", { messageId: "gdm-ok", body: GROUP_BODY, toMemberIds: ["producer", "reviewer", "extra"] });
  const snapshot = await f.get("/api/rooms/commons", f.keys.reviewer).then(r => r.json());
  assert.ok((snapshot.state.messages ?? []).some(m => m.id === "gdm-ok" && m.body === GROUP_BODY),
    "reviewer sees the group DM from a sender they did not block");
});

// ---- pair-DM regression guard ----------------------------------------------

test("pair DMs still work unchanged alongside group DMs", async t => {
  const f = await fixture(t);
  f.send("producer", { messageId: "dm-1", body: "pair-secret", toMemberId: "reviewer" });
  const snapshot = await f.get("/api/rooms/commons", f.keys.reviewer).then(r => r.json());
  assert.ok((snapshot.state.messages ?? []).some(m => m.id === "dm-1" && m.body === "pair-secret"));
  const outsiderKey = Object.entries(f.keys).find(([name]) => !["producer", "reviewer"].includes(name))[1];
  const outsider = await f.get("/api/rooms/commons", outsiderKey).then(r => r.json());
  assert.equal(JSON.stringify(outsider).includes("pair-secret"), false);
});

// ---- read-model parity: group DMs behave like pair DMs everywhere ---------

test("group DM: public face never lists a group DM", async t => {
  const { PublicFace } = await import("../server/public-face.mjs");
  const face = new PublicFace({ db: {} });
  const state = {
    room: { id: "r1", title: "t", purpose: "p", ownerId: "a", createdAt: 1 },
    members: {
      a: { id: "a", displayName: "A", active: true, kind: "human", permissions: [] },
      b: { id: "b", displayName: "B", active: true, kind: "human", permissions: [] },
      c: { id: "c", displayName: "C", active: true, kind: "human", permissions: [] },
      d: { id: "d", displayName: "D", active: true, kind: "human", permissions: [] },
    },
    messages: [
      { id: "m1", authorId: "a", body: "public", createdAt: 1 },
      { id: "m2", authorId: "a", toMemberId: "b", body: "pair secret", createdAt: 2 },
      { id: "m3", authorId: "a", toMemberIds: ["b", "c", "d"], body: "group secret", createdAt: 3 },
    ],
  };
  const out = face.sanitize(state);
  const bodies = (out.messages ?? []).map(m => m.body);
  assert.ok(bodies.includes("public"), "public message listed");
  assert.equal(bodies.includes("pair secret"), false, "pair DM hidden");
  assert.equal(bodies.includes("group secret"), false, "group DM hidden");
});

test("group DM: attachment visibility matches pair DMs", async t => {
  const { RoomAttachmentBytes } = await import("../server/room-attachment-bytes.mjs");
  const attachments = new RoomAttachmentBytes({ db: {} });
  const pair = new Map([["m1", { id: "m1", authorId: "a", toMemberId: "b" }]]);
  const group = new Map([["m2", { id: "m2", authorId: "a", toMemberIds: ["b", "c", "d"] }]]);
  const row = id => ({ state: "committed", message_id: id, uploader_id: "a" });
  assert.equal(attachments.visibleTo(row("m1"), pair, "a"), true, "pair DM author");
  assert.equal(attachments.visibleTo(row("m1"), pair, "b"), true, "pair DM recipient");
  assert.equal(attachments.visibleTo(row("m1"), pair, "c"), false, "pair DM outsider");
  assert.equal(attachments.visibleTo(row("m2"), group, "a"), true, "group DM author");
  assert.equal(attachments.visibleTo(row("m2"), group, "c"), true, "group DM member");
  assert.equal(attachments.visibleTo(row("m2"), group, "e"), false, "group DM outsider");
});

test("group DM: notifications address recipients only", async t => {
  const { deriveNotifications } = await import("../server/notifications.mjs");
  const members = {
    a: { id: "a", displayName: "A", active: true, kind: "human", permissions: [] },
    b: { id: "b", displayName: "B", active: true, kind: "human", permissions: [] },
    c: { id: "c", displayName: "C", active: true, kind: "human", permissions: [] },
    d: { id: "d", displayName: "D", active: true, kind: "human", permissions: [] },
    e: { id: "e", displayName: "E", active: true, kind: "human", permissions: [] },
  };
  const message = { id: "gm1", authorId: "a", toMemberIds: ["b", "c", "d"], body: "hello group", createdAt: 1 };
  const state = { room: { id: "r1", ownerId: "a" }, members, messages: [message] };
  const events = [{ sequence: 1, event: { id: "ev1", type: T.MESSAGE_POSTED, at: 1, actorId: "a", data: { messageId: "gm1", body: "hello group", toMemberIds: ["b", "c", "d"] } } }];
  const forB = deriveNotifications({ events, state, member: members.b });
  assert.ok(forB.some(i => i.messageId === "gm1" && i.kind === "mention"), "recipient b is notified");
  const forE = deriveNotifications({ events, state, member: members.e });
  assert.equal(forE.some(i => i.messageId === "gm1"), false, "outsider e gets nothing");
});

// ---- SEC-19 parity: group DM follow-ups follow the DM's visibility --------

test("group DM: edits and reactions stay with the DM parties (SEC-19 parity)", async t => {
  const f = await fixture(t);
  f.send("producer", { messageId: "gdm-edit", body: "first text", toMemberIds: ["reviewer", "guest", "extra"] });
  f.store.command(f.keys.producer, "commons", { id: randomUUID(), type: T.MESSAGE_EDITED,
    data: { messageId: "gdm-edit", body: "EDITED_GROUP_DM_TEXT", expectedMessageRevision: 0 } });
  f.store.command(f.keys.reviewer, "commons", { id: randomUUID(), type: T.MESSAGE_REACTION_SET,
    data: { messageId: "gdm-edit", reaction: "👍", active: true } });
  const outsider = await f.get("/api/rooms/commons/events", f.keys.owner).then(r => r.json());
  const leaked = (outsider.events ?? []).map(r => r.event)
    .filter(e => e?.data?.messageId === "gdm-edit" || e?.id === "gdm-edit");
  assert.deepEqual(leaked.map(e => e.type), [], "owner sees no group DM or follow-up");
  assert.equal(JSON.stringify(outsider).includes("EDITED_GROUP_DM_TEXT"), false,
    "edited group DM body never reaches a non-party");
  const party = await f.get("/api/rooms/commons/events", f.keys.guest).then(r => r.json());
  const seen = new Set((party.events ?? []).map(r => r.event)
    .filter(e => e?.data?.messageId === "gdm-edit").map(e => e.type));
  assert.ok(seen.has(T.MESSAGE_EDITED), "party sees the edit");
  assert.ok(seen.has(T.MESSAGE_REACTION_SET), "party sees the reaction");
});
