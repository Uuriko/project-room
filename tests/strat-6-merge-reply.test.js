// STRAT-6 / FIX11-3: a merged pull_request webhook posts one reply in the
// source message's own channel. A second delivery does not post again.
// The reply is message.posted (room_post_message), with that channelId and,
// for a DM, toMemberId. It does not record work.completed, so no member is
// credited for a pull they did not submit. A private channel the reply
// actor cannot see gets no post in the main room.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { applyPullRequestWebhook } from "../server/claim-pr-sync.mjs";

const URL_A = "https://github.com/Uuriko/project-room/pull/7";
const ROOM = "commons";

// Room projections are frozen, and no command marks a channel private.
// The merge reply reads the stored channel, so the privacy cases write
// that flag into the room projection the webhook loads.
function restrictChannel(store, channelId, memberIds) {
  store.room(ROOM);
  const row = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(ROOM);
  const projection = JSON.parse(row.projection);
  const channel = projection.channels?.[channelId];
  if (!channel) throw new Error(`missing channel ${channelId}`);
  channel.private = true;
  channel.memberIds = memberIds;
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), ROOM);
  store._dropProjectionCache();
}

function events(store, type) {
  return store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence")
    .all(ROOM).map(row => JSON.parse(row.body)).filter(event => event.type === type);
}

async function bugRoom(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM));
  t.after(() => store.close());
  const key = store.issueAccessKey(ROOM, "owner");
  const send = (id, type, data) => store.command(key, ROOM, { id, type, data });
  send("bug-msg-cmd", "message.posted", { messageId: "bug-msg", body: "Login fails on the second try." });
  send("bug-prop", "work.proposed", {
    workItemId: "bug-1", title: "Login bug", definitionOfDone: "Second try signs in",
    accountableMemberId: "owner", sourceMessageId: "bug-msg", mode: "read"
  });
  send("bug-acc", "work.accepted", { workItemId: "bug-1" });
  send("bug-start", "work.started", { workItemId: "bug-1" });
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body
  };
  const call = (route, id, body) => handleWorkClaims({
    req: { method: route === "read" ? "GET" : "POST", body },
    res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: ROOM,
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers,
    registry: store.workClaims
  });
  await call("create", null, { id: "lane", title: "Login bug", pullRequest: URL_A });
  await call("claim", "lane", {});
  const held = store.workClaims.get(ROOM, "lane");
  store.workClaims.set(ROOM, { ...held, workItemId: "bug-1" });
  const fanout = [];
  store.agentPlugin = { fanoutRoomEvent(payload) { fanout.push(payload); } };
  return { store, fanout };
}

test("a merge webhook replies once in the source channel when delivered twice", async t => {
  const { store, fanout } = await bugRoom(t);
  const payload = { action: "closed", pull_request: { html_url: URL_A, merged: true, state: "closed" } };
  const first = applyPullRequestWebhook(store, payload);
  const second = applyPullRequestWebhook(store, payload);
  assert.deepEqual(first.applied, [{ roomId: ROOM, claimId: "lane", outcome: "merged" }]);
  assert.deepEqual(second.applied, []);

  const claim = store.workClaims.get(ROOM, "lane");
  assert.equal(claim.state, "done");
  assert.equal(claim.deliveryMode, "merged");
  const replies = store.room(ROOM).state.messages.filter(message => message.replyToId === "bug-msg");
  assert.equal(replies.length, 1);
  const body = "Login bug is done. https://github.com/Uuriko/project-room/pull/7";
  assert.equal(replies[0].body, body);
  assert.equal(replies[0].authorId, "owner");
  assert.equal(replies[0].workItemId, "bug-1");
  assert.equal(replies[0].channelId, "general");
  assert.equal(replies[0].kind, undefined);

  const task = store.room(ROOM).state.workItems["bug-1"];
  assert.equal(task.state, "working");
  assert.equal(task.receipt, null);

  const posted = events(store, "message.posted").filter(event => event.data.replyToId === "bug-msg");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].data.channelId, "general");
  assert.equal(events(store, "work.completed").length, 0);

  const pushed = fanout.map(entry => entry.event);
  assert.equal(pushed.filter(event => event.type === "message.posted" && event.data.replyToId === "bug-msg").length, 1);
  assert.equal(pushed.some(event => event.type === "work.completed"), false);
  assert.equal(pushed.find(event => event.data.replyToId === "bug-msg").data.body, replies[0].body);
});

test("a merge reply stays inside a direct-message thread and does not enter someone else's", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const send = (key, id, type, data) => store.command(key, ROOM, { id, type, data });
  for (const memberId of ["ada", "bob"]) {
    send(ownerKey, `add-${memberId}`, "member.added", {
      memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner"
    });
  }
  const adaKey = store.issueAccessKey(ROOM, "ada");
  send(adaKey, "secret-cmd", "message.posted", { messageId: "secret-msg", body: "Fails only for Bob.", toMemberId: "bob" });
  send(ownerKey, "own-dm-cmd", "message.posted", { messageId: "own-dm", body: "Fails on the owner's thread.", toMemberId: "ada" });
  send(ownerKey, "secret-prop", "work.proposed", {
    workItemId: "secret-bug", title: "Secret bug", definitionOfDone: "Bob can sign in",
    accountableMemberId: "owner", sourceMessageId: "secret-msg", mode: "read"
  });
  send(ownerKey, "own-prop", "work.proposed", {
    workItemId: "own-bug", title: "Owner bug", definitionOfDone: "Owner can sign in",
    accountableMemberId: "owner", sourceMessageId: "own-dm", mode: "read"
  });
  for (const id of ["secret-bug", "own-bug"]) {
    send(ownerKey, `${id}-acc`, "work.accepted", { workItemId: id });
    send(ownerKey, `${id}-start`, "work.started", { workItemId: id });
  }
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body
  };
  const call = (route, id, body) => handleWorkClaims({
    req: { method: "POST", body }, res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: ROOM,
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims
  });
  await call("create", null, { id: "secret-lane", pullRequest: "https://github.com/Uuriko/project-room/pull/8" });
  await call("claim", "secret-lane", {});
  await call("create", null, { id: "own-lane", pullRequest: "https://github.com/Uuriko/project-room/pull/9" });
  await call("claim", "own-lane", {});
  for (const [claimId, workItemId] of [["secret-lane", "secret-bug"], ["own-lane", "own-bug"]]) {
    const held = store.workClaims.get(ROOM, claimId);
    store.workClaims.set(ROOM, { ...held, workItemId });
  }
  applyPullRequestWebhook(store, { action: "closed", pull_request: { html_url: "https://github.com/Uuriko/project-room/pull/8", merged: true } });
  applyPullRequestWebhook(store, { action: "closed", pull_request: { html_url: "https://github.com/Uuriko/project-room/pull/9", merged: true } });
  const messages = store.room(ROOM).state.messages;
  assert.equal(messages.some(message => message.replyToId === "secret-msg"), false);
  assert.equal(store.room(ROOM).state.workItems["secret-bug"].state, "working");
  const own = messages.filter(message => message.replyToId === "own-dm");
  assert.equal(own.length, 1);
  assert.equal(own[0].toMemberId, "ada");
  assert.equal(own[0].body, "Owner bug is done. https://github.com/Uuriko/project-room/pull/9");
  assert.equal(store.room(ROOM).state.workItems["own-bug"].state, "working");
  assert.equal(events(store, "work.completed").length, 0);
});

test("a close without a merge does not reply or finish the task", async t => {
  const { store, fanout } = await bugRoom(t);
  const payload = { action: "closed", pull_request: { html_url: URL_A, merged: false, state: "closed" } };
  applyPullRequestWebhook(store, payload);
  applyPullRequestWebhook(store, payload);
  assert.equal(store.workClaims.get(ROOM, "lane").state, "unclaimed");
  assert.equal(store.room(ROOM).state.workItems["bug-1"].state, "working");
  assert.equal(store.room(ROOM).state.messages.filter(message => message.replyToId === "bug-msg").length, 0);
  assert.equal(events(store, "work.completed").length, 0);
  assert.equal(fanout.some(entry => entry.event?.data?.replyToId === "bug-msg"), false);
});

test("a private-channel task is answered in that channel and not in the main room", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM));
  t.after(() => store.close());
  const key = store.issueAccessKey(ROOM, "owner");
  const send = (id, type, data) => store.command(key, ROOM, { id, type, data });
  send("ch-bugs", "channel.created", { channelId: "bugs", name: "bugs" });
  send("bug-msg-cmd", "message.posted", { messageId: "bug-msg", body: "Fails in the bugs channel.", channelId: "bugs" });
  send("bug-prop", "work.proposed", {
    workItemId: "bug-1", title: "Channel bug", definitionOfDone: "The channel stays private",
    accountableMemberId: "owner", sourceMessageId: "bug-msg", mode: "read"
  });
  send("bug-acc", "work.accepted", { workItemId: "bug-1" });
  send("bug-start", "work.started", { workItemId: "bug-1" });
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body
  };
  const call = (route, id, body) => handleWorkClaims({
    req: { method: "POST", body }, res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: ROOM,
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims
  });
  await call("create", null, { id: "lane", title: "Channel bug", pullRequest: URL_A });
  await call("claim", "lane", {});
  const held = store.workClaims.get(ROOM, "lane");
  store.workClaims.set(ROOM, { ...held, workItemId: "bug-1" });
  restrictChannel(store, "bugs", ["owner"]);
  const beforeGeneral = store.room(ROOM).state.messages.filter(message => message.channelId === "general").length;
  applyPullRequestWebhook(store, { action: "closed", pull_request: { html_url: URL_A, merged: true, state: "closed" } });
  const messages = store.room(ROOM).state.messages;
  const replies = messages.filter(message => message.replyToId === "bug-msg");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].channelId, "bugs");
  assert.equal(replies[0].body, "Channel bug is done. https://github.com/Uuriko/project-room/pull/7");
  const posted = events(store, "message.posted").filter(event => event.data.replyToId === "bug-msg");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].data.channelId, "bugs");
  assert.equal(messages.filter(message => message.channelId === "general").length, beforeGeneral);
  assert.equal(store.room(ROOM).state.workItems["bug-1"].state, "working");
  assert.equal(events(store, "work.completed").some(event => event.actorId === "owner" && event.data.workItemId === "bug-1"), false);
});

test("a private channel the reply actor cannot see gets no merge reply", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM));
  t.after(() => store.close());
  const key = store.issueAccessKey(ROOM, "owner");
  const send = (id, type, data) => store.command(key, ROOM, { id, type, data });
  send("add-ada", "member.added", {
    memberId: "ada", displayName: "ada", kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner"
  });
  send("ch-bugs", "channel.created", { channelId: "bugs", name: "bugs" });
  send("bug-msg-cmd", "message.posted", { messageId: "bug-msg", body: "Only Ada's channel.", channelId: "bugs" });
  send("bug-prop", "work.proposed", {
    workItemId: "bug-1", title: "Hidden bug", definitionOfDone: "Stays in Ada's channel",
    accountableMemberId: "owner", sourceMessageId: "bug-msg", mode: "read"
  });
  send("bug-acc", "work.accepted", { workItemId: "bug-1" });
  send("bug-start", "work.started", { workItemId: "bug-1" });
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body
  };
  const call = (route, id, body) => handleWorkClaims({
    req: { method: "POST", body }, res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: ROOM,
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims
  });
  await call("create", null, { id: "lane", pullRequest: URL_A });
  await call("claim", "lane", {});
  const held = store.workClaims.get(ROOM, "lane");
  store.workClaims.set(ROOM, { ...held, workItemId: "bug-1" });
  restrictChannel(store, "bugs", ["ada"]);
  const before = store.room(ROOM).state.messages.length;
  applyPullRequestWebhook(store, { action: "closed", pull_request: { html_url: URL_A, merged: true, state: "closed" } });
  const messages = store.room(ROOM).state.messages;
  assert.equal(messages.length, before);
  assert.equal(messages.some(message => message.channelId === "general" && message.replyToId === "bug-msg"), false);
  assert.equal(messages.some(message => message.body?.includes("pull/7")), false);
  assert.equal(store.workClaims.get(ROOM, "lane").state, "done");
  assert.equal(store.room(ROOM).state.workItems["bug-1"].state, "working");
  assert.equal(events(store, "work.completed").length, 0);
});
