// G2 revision: declared budgets, deny + unchanged state. Implementation not edited.
// Store under test: isolated identity-scope worktree (Codex). Canonical HTTP router.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const SCOPE = "/Users/johnpotter/src/project-room-identity-scope";
assert.equal(existsSync(`${SCOPE}/server/store.mjs`), true, "identity-scope store required for G2 revision");
const { RoomStore } = await import(`${SCOPE}/server/store.mjs`);
const { initialRoom } = await import(`${SCOPE}/server/bootstrap.mjs`);

async function fixture(t) {
  let clock = Date.parse("2026-09-12T18:00:00Z");
  const store = new RoomStore(":memory:", { now: () => clock });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (key, type, data) => store.command(key, "commons", { id: randomUUID(), type, data });
  for (const [id, permissions] of [["worker", ["accept_work", "complete_work"]], ["steerer", ["steer"]]]) {
    cmd(owner, T.MEMBER_ADDED, { memberId: id, displayName: id, kind: "agent", permissions });
  }
  const worker = store.issueAccessKey("commons", "worker");
  const steerer = store.issueAccessKey("commons", "steerer");
  cmd(owner, T.WORK_PROPOSED, { workItemId: "one", title: "One", definitionOfDone: "Fixture", accountableMemberId: "worker", mode: "read" });
  cmd(owner, T.WORK_PROPOSED, { workItemId: "two", title: "Two", definitionOfDone: "Fixture", accountableMemberId: "worker", mode: "read" });
  const server = createRoomServer({ store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(r => server.close(r));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { token, data } = {}) => {
    const res = await fetch(origin + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    let json;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, code: json?.error?.code ?? null };
  };
  const item = id => store.room("commons").state.workItems[id];
  const session = (token, workItemId, extra = {}) => request("/api/rooms/commons/work-sessions", {
    token,
    data: {
      requestId: randomUUID(), workItemId, expectedRevision: item(workItemId).revision,
      action: "set_status", status: "processing", ...extra
    }
  });
  const generic = (token, type, extra = {}) => request("/api/rooms/commons/commands", {
    token,
    data: {
      id: randomUUID(), type,
      data: { workItemId: extra.workItemId, expectedRevision: item(extra.workItemId).revision, ...extra }
    }
  });
  return { store, owner, worker, steerer, session, generic, item, request, advance: ms => { clock += ms; } };
}

function running(store) {
  return Object.values(store.room("commons").state.workItems)
    .filter(row => ["processing", "active", "suspended"].includes(row.status)).length;
}

test("positive: dedicated start with maxConcurrent 1", async t => {
  const { worker, session, item } = await fixture(t);
  const start = await session(worker, "one", { budget: { maxConcurrent: 1, maxRuntimeMs: 60000, maxSpendCents: 100 } });
  assert.equal(start.status, 201);
  assert.equal(item("one").status, "processing");
});

test("positive: GET lists the live session", async t => {
  const { worker, session, request } = await fixture(t);
  assert.equal((await session(worker, "one", { budget: { maxConcurrent: 1 } })).status, 201);
  const listed = await request("/api/rooms/commons/work-sessions", { token: worker });
  assert.equal(listed.status, 200);
  const blob = JSON.stringify(listed.json);
  assert.match(blob, /one/);
});

test("capped concurrency: dedicated and generic second starts denied, state unchanged", async t => {
  const { store, worker, session, generic, item } = await fixture(t);
  assert.equal((await session(worker, "one", { budget: { maxConcurrent: 1 } })).status, 201);
  const beforeTwo = item("two").status;
  const dedicated = await session(worker, "two", { budget: { maxConcurrent: 1 } });
  const viaGeneric = await generic(worker, T.SESSION_STARTED, { workItemId: "two", budget: { maxConcurrent: 1 } });
  assert.equal(dedicated.status, 409);
  assert.equal(dedicated.code, "budget_exceeded");
  assert.equal(viaGeneric.status, 409);
  assert.ok(["budget_exceeded", "command_rejected"].includes(viaGeneric.code));
  assert.equal(item("two").status, beforeTwo);
  assert.equal(running(store), 1);
  assert.equal(item("one").status, "processing");
});

test("steerer cannot take over via dedicated or generic; worker stays owner", async t => {
  const { worker, steerer, session, generic, item } = await fixture(t);
  assert.equal((await session(worker, "one", { budget: { maxConcurrent: 1 } })).status, 201);
  const viaSession = await session(steerer, "one", { status: "active" });
  const viaGeneric = await generic(steerer, T.SESSION_STATUS_CHANGED, { workItemId: "one", status: "active" });
  assert.ok(viaSession.status >= 400, `dedicated steerer ${viaSession.status} ${viaSession.code}`);
  assert.ok(viaGeneric.status >= 400, `generic steerer ${viaGeneric.status} ${viaGeneric.code}`);
  assert.equal(item("one").worker_member_id, "worker");
  assert.equal(item("one").status, "processing");
});

test("elapsed runtime denies continuation without spend", async t => {
  const { worker, session, generic, item, advance } = await fixture(t);
  assert.equal((await session(worker, "one", { budget: { maxConcurrent: 1, maxRuntimeMs: 1000, maxSpendCents: 99999 } })).status, 201);
  advance(2000);
  const overTime = await generic(worker, T.SESSION_STATUS_CHANGED, { workItemId: "one", status: "active" });
  assert.equal(overTime.status, 409);
  assert.equal(overTime.code, "budget_exceeded");
  assert.notEqual(item("one").status, "active");
});

test("over-spend denies continuation while runtime still valid", async t => {
  const { worker, session, generic, item } = await fixture(t);
  assert.equal((await session(worker, "one", { budget: { maxConcurrent: 1, maxRuntimeMs: 600000, maxSpendCents: 50 } })).status, 201);
  const overSpend = await generic(worker, T.SESSION_STATUS_CHANGED, { workItemId: "one", status: "active", spendCents: 51 });
  assert.equal(overSpend.status, 409);
  assert.equal(overSpend.code, "budget_exceeded");
  assert.equal(item("one").status, "processing");
});

test("forged budgetEnforced is not stored", async t => {
  const { worker, session, generic } = await fixture(t);
  assert.equal((await session(worker, "one", { budget: { maxConcurrent: 1 } })).status, 201);
  const forged = await generic(worker, T.SESSION_STOPPED, {
    workItemId: "two", status: "failed", budgetEnforced: true, reason: "budget_exceeded", limit: "maxSpendCents"
  });
  assert.ok(forged.status >= 400);
  assert.notEqual(forged.json?.event?.data?.budgetEnforced, true);
});
