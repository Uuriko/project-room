import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { workIndependentVerdicts } from "../server/work-context.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, command) => store.command(keys[actor], "commons", command);
  for (const [memberId, kind, permissions] of [
    ["guest", "human", []],
    ["agent", "agent", ["accept_work", "complete_work"]],
    ["reviewer", "agent", ["verify"]],
    ["lander", "agent", ["accept_work"]]
  ]) {
    send("owner", { id: `add-${memberId}`, type: "member.added", data: { memberId, displayName: memberId, kind, permissions } });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  for (const memberId of ["agent", "reviewer", "lander"])
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  for (const a of ["owner", "guest", "agent", "reviewer", "lander"])
    for (const b of ["owner", "guest", "agent", "reviewer", "lander"])
      if (a !== b) {
        store.dmConsents.request("commons", a, b, "test fixture");
        store.dmConsents.decide("commons", b, a, "approve");
      }
  send("owner", { id: "propose-qualify", type: "work.proposed", data: {
    workItemId: "qualify-work", title: "Qualify a source change",
    definitionOfDone: "An independent verifier records a readable source verdict",
    accountableMemberId: "agent", verifierMemberId: "reviewer", mode: "read",
    independentVerificationRequired: true
  } });
  return { store, keys, send };
}

async function eventsFor(origin, token) {
  const res = await fetch(`${origin}/api/rooms/commons/events?after=0&limit=100`, {
    headers: { Authorization: "Bearer " + token }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return (body.events ?? []).map(row => row.event?.data?.messageId ?? row.data?.messageId ?? row.messageId);
}

test("a lander can read the designated verifier's work-item verdict without seeing the private DM", async t => {
  const f = fixture(t);
  const secretNote = `session token ${f.keys.owner}`;
  f.send("reviewer", { id: "private-chatter", type: "message.posted", data: {
    messageId: "private-chatter", body: secretNote, toMemberId: "owner"
  } });
  const ask = f.send("owner", { id: "ask-verdict", type: "message.posted", data: {
    messageId: "ask-verdict", body: "Please give an exact-head source verdict on the candidate.",
    toMemberId: "reviewer", workItemId: "qualify-work", requestKind: "reply"
  } });
  const answer = f.send("reviewer", { id: "answer-verdict", type: "message.posted", data: {
    messageId: "answer-verdict",
    body: "SOURCE PASS on the exact head. Recovery and the contract pin both hold.",
    responseToRequestId: "ask-verdict", expectedRequestRevision: 0, responseOutcome: "answered",
    contextEventId: ask.event.id, contextSequence: ask.sequence,
    replyToId: "ask-verdict", toMemberId: "owner", workItemId: "qualify-work"
  } });

  f.send("owner", { id: "ask-lander", type: "message.posted", data: {
    messageId: "ask-lander", body: "Please source-land once the independent verdict is readable.",
    toMemberId: "lander", workItemId: "qualify-work", requestKind: "reply"
  } });

  const context = f.store.workContext(f.keys.lander, "commons", "qualify-work");
  assert.equal(context.work.verifierMemberId, "reviewer");
  assert.deepEqual(context.independentVerdicts, [{
    requestMessageId: "ask-verdict",
    responseMessageId: "answer-verdict",
    eventId: answer.event.id,
    verifierId: "reviewer",
    outcome: "answered",
    at: f.store.room("commons").state.replyRequests["ask-verdict"].closedAt,
    summary: "SOURCE PASS on the exact head. Recovery and the contract pin both hold."
  }]);
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes(f.keys.lander), false);
  assert.equal(serialized.includes(f.keys.owner), false);
  assert.equal(serialized.includes(f.keys.reviewer), false);
  assert.equal(serialized.includes(secretNote), false);

  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const landerIds = await eventsFor(origin, f.keys.lander);
  const guestIds = await eventsFor(origin, f.keys.guest);
  const reviewerIds = await eventsFor(origin, f.keys.reviewer);
  assert.equal(landerIds.includes("ask-lander"), true);
  for (const ids of [landerIds, guestIds]) {
    assert.equal(ids.some(id => ["ask-verdict", "answer-verdict", "private-chatter"].includes(id)), false);
  }
  assert.equal(reviewerIds.includes("answer-verdict"), true);
  assert.equal(reviewerIds.includes("private-chatter"), true);

  const discussion = f.store.workDiscussion(f.keys.lander, "commons", "qualify-work");
  assert.equal(discussion.discussion.items.some(row =>
    row.message?.id === "answer-verdict" || row.message?.id === "ask-verdict" || row.message?.id === "private-chatter"), false);

  assert.throws(() => f.store.workContext(f.keys.guest, "commons", "qualify-work"), { status: 403, code: "work_private" });
});

test("ordinary private DMs and non-verifier answers are not published as work verdicts", t => {
  const f = fixture(t);
  const ask = f.send("agent", { id: "agent-ask", type: "message.posted", data: {
    messageId: "agent-ask", body: "Can I take this?", toMemberId: "owner", workItemId: "qualify-work", requestKind: "reply"
  } });
  f.send("owner", { id: "owner-answer", type: "message.posted", data: {
    messageId: "owner-answer", body: "Not a designated-verifier verdict.",
    responseToRequestId: "agent-ask", expectedRequestRevision: 0, responseOutcome: "answered",
    contextEventId: ask.event.id, contextSequence: ask.sequence,
    replyToId: "agent-ask", toMemberId: "agent", workItemId: "qualify-work"
  } });
  f.send("reviewer", { id: "side-dm", type: "message.posted", data: {
    messageId: "side-dm", body: "Private coordination only", toMemberId: "owner", workItemId: "qualify-work"
  } });
  f.send("owner", { id: "ask-lander-two", type: "message.posted", data: {
    messageId: "ask-lander-two", body: "Please check whether a verdict is on this work.",
    toMemberId: "lander", workItemId: "qualify-work", requestKind: "reply"
  } });
  const context = f.store.workContext(f.keys.lander, "commons", "qualify-work");
  assert.deepEqual(context.independentVerdicts, []);
  assert.equal(workIndependentVerdicts(f.store.room("commons").state, "qualify-work").length, 0);
});
