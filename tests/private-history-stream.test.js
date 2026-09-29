import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture();
  let now = Date.now(); f.store.now = () => now;
  f.store.dmConsents.request("commons", "producer", "reviewer", "synthetic privacy test");
  f.store.dmConsents.decide("commons", "reviewer", "producer", "approve");
  const post = (actor, body, toMemberId) => {
    now += 2100;
    return f.store.command(f.keys[actor], "commons", { id: randomUUID(), type: "message.posted", data: {
      messageId: randomUUID(), body, ...(toMemberId ? { toMemberId } : {})
    } });
  };
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const brief = async (actor, query = "") => {
    const response = await fetch(`${origin}/api/rooms/commons/return-brief${query}`, { headers: { Authorization: `Bearer ${f.keys[actor]}` } });
    assert.equal(response.status, 200); return response.json();
  };
  return { ...f, origin, post, brief };
}

test("return brief hides a targeted DM from unrelated owner and guest but keeps both participants", async t => {
  const f = await fixture(t), start = f.store.room("commons").sequence;
  const receipt = f.post("producer", "private-brief-body", "reviewer");
  for (const actor of ["owner", "guest", "producer", "reviewer"]) {
    const result = await f.brief(actor, `?after=${start}`);
    assert.equal(JSON.stringify(result).includes("private-brief-body"), ["producer", "reviewer"].includes(actor), actor);
    assert.equal(result.history.evaluatedThrough, receipt.sequence);
    assert.equal(result.history.continuation, null);
  }
});

test("a hidden return-brief page advances its scanned continuation and freezes the original horizon", async t => {
  const f = await fixture(t), start = f.store.room("commons").sequence;
  f.store.markCaughtUp(f.keys.guest, "commons", start);
  const hidden = f.post("producer", "hidden-page", "reviewer"), visible = f.post("owner", "visible-after-hidden");
  const first = await f.brief("guest", "?limit=1");
  assert.deepEqual(first.history.items, []);
  assert.deepEqual(first.history.continuation, { horizon: visible.sequence, after: hidden.sequence, cursor: start });
  f.post("owner", "arrived-after-horizon");
  const next = new URLSearchParams({ ...first.history.continuation, limit: 1 });
  const second = await f.brief("guest", `?${next}`);
  assert.equal(second.history.items[0].event.data.body, "visible-after-hidden");
  assert.equal(JSON.stringify(second.history).includes("arrived-after-horizon"), false);
  assert.equal(second.history.continuation, null);
  assert.equal(f.store.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get("commons", "guest").sequence, start);
});

test("live stream reaches a public event beyond a full invisible private page", async t => {
  const f = await fixture(t), start = f.store.room("commons").sequence;
  for (let i = 0; i < 100; i++) f.post("producer", `private-stream-${i}`, "reviewer");
  const visible = f.post("owner", "visible-after-private-stream-page");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  let text = "";
  try {
    const response = await fetch(`${f.origin}/api/rooms/commons/stream?after=${start}`, { headers: { Authorization: `Bearer ${f.keys.owner}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    try {
      while (!text.includes("visible-after-private-stream-page")) {
        const chunk = await reader.read(); if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
    } catch (error) { if (error.name !== "AbortError") throw error; }
    assert.match(text, /visible-after-private-stream-page/);
    assert.match(text, new RegExp(`id: ${visible.sequence}\\n`));
    assert.doesNotMatch(text, /private-stream-\d/);
    await reader.cancel().catch(() => {});
  } finally { clearTimeout(timeout); controller.abort(); }
});

test("return brief retains peer-DM identity filtering alongside targeted message filtering", async t => {
  const f = await fixture(t);
  const a = f.store.identities.create("Audit peer A"), b = f.store.identities.create("Audit peer B");
  for (const [identity, memberId] of [[a, "audit-peer-a"], [b, "audit-peer-b"]]) {
    f.store.identities.link(f.keys.owner, "commons", { identityId: identity.identityId, memberId, permissions: [] });
    setTier(f.store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: f.store.now() });
  }
  f.keys.peerA = a.secret; f.keys.peerB = b.secret;
  const command = (secret, type, data) => f.store.command(secret, "commons", { id: randomUUID(), type, data });
  const proposal = command(a.secret, "bond.propose", { to: b.identityId, scopes: ["peer.dm"], note: "synthetic peer privacy" });
  command(b.secret, "bond.accept", { bondId: proposal.event.data.bondId, scopes: ["peer.dm"] });
  command(a.secret, "dm.posted", { to: b.identityId, messageId: randomUUID(), body: "private-peer-brief-body" });
  for (const actor of ["owner", "guest", "peerA", "peerB"]) {
    const result = await f.brief(actor);
    assert.equal(JSON.stringify(result).includes("private-peer-brief-body"), actor.startsWith("peer"), actor);
  }
});

test("event polling reads fresh authority without decoding full projections", async t => {
  const f = await fixture(t), start = f.store.room("commons").sequence;
  f.post("producer", "private-authority-poll", "reviewer");
  const publicReceipt = f.post("owner", "public-authority-poll");
  const original = f.store.room.bind(f.store);
  let fullDecodes = 0;
  f.store.room = (...args) => { fullDecodes++; return original(...args); };
  try {
    const page = f.store.eventsAfter(f.keys.guest, "commons", start);
    assert.deepEqual(page.events.map(row => row.event.data.body), ["public-authority-poll"]);
    assert.equal(page.next, publicReceipt.sequence);
    assert.deepEqual(f.store.eventsAfter(f.keys.guest, "commons", page.next).events, []);
    assert.equal(fullDecodes, 0, "idle and populated polls need no full projection decode");
  } finally { f.store.room = original; }
});

test("authority optimization still rejects membership and credential revocation on the next poll", async t => {
  const f = await fixture(t), cursor = f.store.room("commons").sequence;
  assert.equal(f.store.eventsAfter(f.keys.guest, "commons", cursor).events.length, 0);
  const member = f.store.roomAuthority("commons").members.guest;
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "member.access_changed", data: {
    memberId: "guest", expectedMemberRevision: member.revision, permissions: member.permissions, active: false
  } });
  assert.throws(() => f.store.eventsAfter(f.keys.guest, "commons", cursor), error => [401, 403].includes(error.status));
  f.store.revoke(f.keys.owner);
  assert.throws(() => f.store.eventsAfter(f.keys.owner, "commons", cursor), error => error.status === 401);
});
