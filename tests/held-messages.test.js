// Held messages are opt-in: off by default, and only a person who turns it
// on has wakes from other people's agents to their agents wait for approval.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { holdsFor } from "../server/held-messages.mjs";

async function boot(t) {
  const f = createAcceptanceFixture();
  // An agent that answers to the guest, not the owner.
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "member.added",
    data: { memberId: "gagent", displayName: "Guest Agent", kind: "agent", permissions: [], accountableHumanId: "guest" } });
  const gagentKey = f.store.issueAccessKey("commons", "gagent");
  const woke = [];
  const original = f.store.deliverMentionWake.bind(f.store);
  f.store.deliverMentionWake = (roomId, memberId, kind, messageId) => { woke.push(memberId); return original(roomId, memberId, kind, messageId); };
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (path, secret, method = "GET", body) => fetch(origin + path, { method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const post = (secret, text) => f.store.command(secret, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: text } });
  const mentionRows = () => f.store.db.prepare("SELECT COUNT(*) AS n FROM mention_states WHERE mentioned_member_id='producer'").get().n;
  return { f, gagentKey, woke, call, post, mentionRows };
}

test("off by default: another person's agent wakes my agent as before", async t => {
  const { f, gagentKey, woke, call, post, mentionRows } = await boot(t);
  post(gagentKey, "@Producer please look");
  assert.deepEqual(woke, ["producer"]);
  assert.equal(mentionRows(), 1);
  const listed = await (await call("/api/rooms/commons/held-messages", f.keys.owner)).json();
  assert.deepEqual(listed, { enabled: false, held: [] });
});

test("opted in: the wake waits, approve delivers it, drop discards it", async t => {
  const { f, gagentKey, woke, call, post, mentionRows } = await boot(t);
  const on = await call("/api/rooms/commons/held-messages/settings", f.keys.owner, "POST", { enabled: true });
  assert.equal(on.status, 200, await on.clone().text());
  post(gagentKey, "@Producer first");
  post(gagentKey, "@Producer second");
  assert.deepEqual(woke, []);
  assert.equal(mentionRows(), 0);
  const listed = await (await call("/api/rooms/commons/held-messages", f.keys.owner)).json();
  assert.equal(listed.enabled, true);
  assert.equal(listed.held.length, 2);
  const [first, second] = listed.held;
  assert.equal(first.senderId, "gagent");
  const ok = await call("/api/rooms/commons/held-messages/decide", f.keys.owner, "POST", { messageId: first.messageId, memberId: "producer", decision: "approve" });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual(woke, ["producer"]);
  assert.equal(mentionRows(), 1);
  await call("/api/rooms/commons/held-messages/decide", f.keys.owner, "POST", { messageId: second.messageId, memberId: "producer", decision: "drop" });
  assert.deepEqual(woke, ["producer"]);
  assert.equal((await (await call("/api/rooms/commons/held-messages", f.keys.owner)).json()).held.length, 0);
});

test("my own agents and people are never held; turning it off releases what waits", async t => {
  const { f, gagentKey, woke, call, post } = await boot(t);
  await call("/api/rooms/commons/held-messages/settings", f.keys.owner, "POST", { enabled: true });
  const members = f.store.room("commons").state.members;
  assert.equal(holdsFor(f.store.db, "commons", members, "reviewer", "producer"), null, "same person's agents");
  assert.equal(holdsFor(f.store.db, "commons", members, "guest", "producer"), null, "a person's message");
  assert.equal(holdsFor(f.store.db, "commons", members, "producer", "gagent"), null, "the guest did not opt in");
  post(gagentKey, "@Producer waiting");
  assert.deepEqual(woke, []);
  const off = await (await call("/api/rooms/commons/held-messages/settings", f.keys.owner, "POST", { enabled: false })).json();
  assert.deepEqual(off, { enabled: false, released: 1 });
  assert.deepEqual(woke, ["producer"]);
});

test("only a person can turn it on", async t => {
  const { gagentKey, call } = await boot(t);
  const refused = await call("/api/rooms/commons/held-messages/settings", gagentKey, "POST", { enabled: true });
  assert.equal(refused.status, 403);
});
