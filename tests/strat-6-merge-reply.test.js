// STRAT-6: a merged pull_request webhook closes the task the claim names and
// posts one reply in that task's source thread. A second delivery of the
// same payload does not post again. Agents see the same facts as room
// events: message.posted (room_post_message) and work.completed with
// room_text evidence (room_submit_text_result).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { applyPullRequestWebhook } from "../server/claim-pr-sync.mjs";

const URL_A = "https://github.com/Uuriko/project-room/pull/7";
const ROOM = "commons";

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

test("a merge webhook closes the linked task and replies once when delivered twice", async t => {
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
  assert.equal(replies[0].kind, undefined);

  const task = store.room(ROOM).state.workItems["bug-1"];
  assert.equal(task.state, "completed");
  assert.equal(task.receipt.nativeText.kind, "room_text");
  assert.equal(task.receipt.nativeText.messageId, replies[0].id);
  assert.equal(task.receipt.summary, body);

  const posted = events(store, "message.posted").filter(event => event.data.replyToId === "bug-msg");
  const completed = events(store, "work.completed").filter(event => event.data.workItemId === "bug-1");
  assert.equal(posted.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].data.evidenceKind, "room_text");
  assert.equal(completed[0].data.evidenceMessageId, posted[0].data.messageId);
  assert.equal(completed[0].data.evidenceUrl, undefined);
  assert.equal(completed[0].actorId, "owner");

  const pushed = fanout.map(entry => entry.event);
  assert.equal(pushed.filter(event => event.type === "message.posted" && event.data.replyToId === "bug-msg").length, 1);
  assert.equal(pushed.filter(event => event.type === "work.completed" && event.data.workItemId === "bug-1").length, 1);
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
  assert.equal(store.room(ROOM).state.workItems["own-bug"].state, "completed");
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
