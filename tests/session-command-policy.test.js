import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t) {
  let now = Date.parse("2026-09-12T12:00:00Z");
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom("policy"));
  const owner = store.issueAccessKey("policy", "owner");
  for (const [memberId, permissions] of [["worker", ["accept_work", "complete_work"]], ["steerer", ["steer"]]]) {
    store.command(owner, "policy", { id: randomUUID(), type: "member.added", data: { memberId, displayName: memberId, kind: "agent", permissions } });
  }
  const worker = store.issueAccessKey("policy", "worker"), steerer = store.issueAccessKey("policy", "steerer");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (endpoint, data, token = worker) => {
    const response = await fetch(`${origin}/api/rooms/policy/${endpoint}`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const item = id => store.room("policy").state.workItems[id];
  const propose = () => {
    const id = randomUUID();
    store.command(owner, "policy", { id: randomUUID(), type: "work.proposed", data: { workItemId: id,
      title: "Synthetic policy work", definitionOfDone: "Reviewed result", accountableMemberId: "worker", mode: "read" } });
    return id;
  };
  const command = (id, type, data = {}, token = worker) => post("commands", { id: randomUUID(), type,
    data: { workItemId: id, expectedRevision: item(id).revision, ...data } }, token);
  const mutate = (id, data = {}, token = worker) => post("work-sessions", { requestId: randomUUID(), workItemId: id,
    expectedRevision: item(id).revision, action: "set_status", status: "processing", ...data }, token);
  return { store, worker, owner, steerer, item, propose, command, mutate, advance: ms => { now += ms; } };
}

test("generic commands obey existing concurrency caps even when a new declaration is looser", async t => {
  const f = await fixture(t), first = f.propose(), next = f.propose();
  assert.equal((await f.mutate(first, { budget: { maxConcurrent: 1 } })).status, 201);
  for (const result of [await f.command(next, "session.started"),
    await f.command(next, "session.started", { budget: { maxConcurrent: 10 } }),
    await f.mutate(next, { budget: { maxConcurrent: 10 } })]) {
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "budget_exceeded");
  }
  assert.equal((await f.command(first, "session.stopped", { status: "failed" })).status, 201);
  assert.equal((await f.command(next, "session.started")).status, 201);
});

test("generic status changes cannot take another worker's live session; claim managers can", async t => {
  const f = await fixture(t), id = f.propose();
  await f.command(id, "session.started");
  const denied = await f.command(id, "session.status_changed", { status: "active" }, f.steerer);
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, "session_claimed");
  assert.equal(f.item(id).worker_member_id, "worker");
  assert.equal((await f.command(id, "session.status_changed", { status: "active" }, f.owner)).status, 201);
});

test("generic continuation rejects elapsed runtime and over-limit spend but permits failed cleanup", async t => {
  const f = await fixture(t), runtime = f.propose(), spend = f.propose();
  await f.command(runtime, "session.started", { budget: { maxRuntimeMs: 1000 } });
  await f.command(spend, "session.started", { budget: { maxSpendCents: 100 } });
  f.advance(2000);
  for (const result of [await f.command(runtime, "session.status_changed", { status: "active" }),
    await f.command(spend, "session.status_changed", { status: "active", spendCents: 101 }),
    await f.command(runtime, "session.stopped", { status: "done" })]) {
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "budget_exceeded");
  }
  assert.equal((await f.command(spend, "session.status_changed", { status: "active", spendCents: 100 })).status, 201);
  assert.equal((await f.command(runtime, "session.stopped", { status: "failed" })).status, 201);
});

test("taking over a session obeys the new worker's concurrency cap through both entry points", async t => {
  const f = await fixture(t), owned = f.propose(), takeover = f.propose();
  assert.equal((await f.command(owned, "session.started", { budget: { maxConcurrent: 1 } }, f.owner)).status, 201);
  assert.equal((await f.command(takeover, "session.started")).status, 201);
  for (const result of [await f.command(takeover, "session.status_changed", { status: "active" }, f.owner),
    await f.mutate(takeover, { status: "active" }, f.owner)]) {
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "budget_exceeded");
    assert.equal(f.item(takeover).worker_member_id, "worker");
  }
  assert.equal((await f.command(owned, "session.stopped", { status: "failed" }, f.owner)).status, 201);
  assert.equal((await f.command(takeover, "session.status_changed", { status: "active" }, f.owner)).status, 201);
  assert.equal(f.item(takeover).worker_member_id, "owner");
});

test("clients cannot fabricate enforcement facts; actual dedicated budget stops retain provenance", async t => {
  const f = await fixture(t), id = f.propose();
  await f.command(id, "session.started", { budget: { maxRuntimeMs: 1000 } });
  const forged = await f.command(id, "session.stopped", { status: "failed", budgetEnforced: true, reason: "budget_exceeded", limit: "maxSpendCents" });
  assert.equal(forged.status, 422);
  assert.equal(f.item(id).status, "processing");
  f.advance(2000);
  assert.equal((await f.mutate(id, { status: "active" })).body.error.code, "budget_exceeded");
  assert.equal(f.item(id).status, "failed");
  const last = f.store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence DESC LIMIT 1").get("policy");
  assert.equal(JSON.parse(last.body).data.budgetEnforced, true);
});

test("halt-all blocks session start and continuation while failed cleanup remains available", async t => {
  const f = await fixture(t), current = f.propose(), next = f.propose();
  assert.equal((await f.command(current, "work.accepted")).status, 201);
  await f.command(current, "session.started");
  const halt = await f.command(current, "work.handoff_recorded", { doneSummary: "Partial work", nextAction: "Owner reviews", limitReason: "Limit", haltAll: true });
  assert.equal(halt.status, 201, JSON.stringify(halt.body));
  for (const result of [await f.command(next, "session.started"), await f.mutate(next),
    await f.command(current, "session.status_changed", { status: "active" })]) {
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "halt_active");
  }
  assert.equal((await f.command(current, "session.stopped", { status: "failed" })).status, 201);
});

test("failed budget-stop persistence propagates failure and does not claim success", async t => {
  const f = await fixture(t), id = f.propose();
  await f.command(id, "session.started", { budget: { maxRuntimeMs: 1000 } });
  f.advance(2000);
  f.store.db.exec(`CREATE TEMP TRIGGER reject_session_stop BEFORE INSERT ON events
    WHEN json_extract(NEW.body, '$.type') = 'session.stopped'
    BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END;`);
  const failed = await f.mutate(id, { status: "active" });
  assert.equal(failed.status, 500);
  assert.equal(f.item(id).status, "processing");
  f.store.db.exec("DROP TRIGGER reject_session_stop");
  assert.equal((await f.mutate(id, { status: "active" })).body.error.code, "budget_exceeded");
  assert.equal(f.item(id).status, "failed");
});
