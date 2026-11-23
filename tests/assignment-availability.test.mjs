import assert from "node:assert/strict";
import test from "node:test";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { buildReplyCommand } from "../client/reply-actions.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";

const roomId = "commons";
const grok = "grok-fixture";
const alternate = "ready-fixture";
const minute = 60_000;

function fixture(t, representation) {
  let now = Date.parse("2026-11-22T12:00:00Z");
  const store = new RoomStore(":memory:", { now: () => now });
  t.after(() => store.close());
  store.initialize(initialRoom(), representation ? { representation } : undefined);
  const owner = store.issueAccessKey(roomId, "owner");
  for (const memberId of [grok, alternate]) {
    store.command(owner, roomId, { id: "add-" + memberId, type: "member.added",
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["steer", "accept_work","complete_work"] } });
  }
  const keys = { owner, [grok]: store.issueAccessKey(roomId, grok), [alternate]: store.issueAccessKey(roomId, alternate) };
  const request = (requestId, toMemberId, sender = "owner") =>
    store.command(keys[sender], roomId, buildReplyCommand({ roomId, memberId: sender }, "room_request_reply",
      { requestId, toMemberId, body: "Verify one exact result." }));
  const propose = (id, accountableMemberId) => store.command(owner, roomId, { id, type: "work.proposed",
    data: { workItemId: id, title: id, definitionOfDone: "One accepted result", accountableMemberId, mode: "read" } });
  const pause = () => store.wakeQueue.pause(owner, roomId, { requestId: "usage-exhausted", reason: "Out of usage" }, null, { memberId: grok });
  const resume = () => store.wakeQueue.resume(owner, roomId, { requestId: "usage-returned" }, null, { memberId: grok });
  return { store, keys, request, propose, pause, resume, advance: ms => { now += ms; } };
}

for (const representation of [undefined, "normalized-current-v1"]) {
  const label = representation ?? "legacy";
  test(`assignment pause preserves eligible work and exact retries in ${label}`, t => {
    const f = fixture(t, representation);
    const first = f.request("before-hold", grok);
    f.pause();
    const sequence = f.store.headSequence(roomId);
    assert.throws(() => f.request("after-hold", grok), { code: "assignment_paused" });
    assert.throws(() => f.propose("held-proposal", grok), { code: "assignment_paused" });
    assert.equal(f.store.headSequence(roomId), sequence, "a refused allocation creates no assignment event");
    assert.equal(f.request("before-hold", grok).event.id, first.event.id);
    assert.equal(f.store.headSequence(roomId), sequence);
    assert.ok(f.propose("other-work", alternate).event);
    assert.ok(f.request("other-agent", alternate).event);
    f.advance(10_001);
    assert.throws(() => f.request("after-hold", grok), { code: "assignment_paused" });
    f.resume();
    assert.ok(f.request("after-hold", grok).event);
    assert.equal(f.request("after-hold", grok).duplicate, true);
  });

  test(`unanswered requests back off without suppressing another sender in ${label}`, t => {
    const f = fixture(t, representation);
    f.request("first", grok);
    f.advance(10_001);
    assert.throws(() => f.request("second", grok), { code: "assignment_waiting_for_recipient" });
    assert.ok(f.request("different-sender", grok, alternate).event);
    f.advance(30 * minute);
    const second = f.request("second", grok);
    f.advance(30 * minute);
    assert.throws(() => f.request("third", grok), { code: "assignment_waiting_for_recipient" });
    const id = second.event.data.messageId;
    f.store.command(f.keys[grok], roomId, { id: "back-online", type: "reply_request.progressed",
      data: { requestMessageId: id, expectedRequestRevision: 0, progress: "acknowledged" } });
    assert.ok(f.request("third", grok).event);
  });
}

test("Board reassign leaves available work claimable while its suggested owner is paused", async t => {
  const f = fixture(t);
  const helpers = {
    body: async req => req.body, json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { throw Object.assign(new Error(message), { status, code }); },
  };
  const call = async (route, memberId, body, id = null) => handleWorkClaims({
    req: { method: "POST", body }, res: {}, url: new URL("https://fixture.test"),
    store: f.store, roomId, auth: f.store.authenticate(f.keys[memberId], roomId),
    workClaimRoute: route, workClaimId: id, helpers, registry: f.store.workClaims,
  });
  const created = await call("create", "owner", { id: "board-work", title: "Verify evidence" });
  assert.equal(created.value.state, "unclaimed");
  f.pause();
  await assert.rejects(call("reassign", "owner", { newOwner: grok,
    expectedClaimedAt: null, expectedHistoryLength: created.value.history.length }, "board-work"),
  { code: "assignment_paused" });
  assert.equal(f.store.workClaims.get(roomId, "board-work").state, "unclaimed");
  const claimed = await call("claim", alternate, { leaseHours: 1 }, "board-work");
  assert.equal(claimed.value.owner, alternate);
  f.resume();
  assert.equal(f.store.workClaims.get(roomId, "board-work").owner, alternate);
});
