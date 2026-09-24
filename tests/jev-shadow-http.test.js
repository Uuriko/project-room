// Jev-harness wiring: shadow gates journal decisions at the live edges
// (admission on join paths, receipt on the work-claim done transition),
// read-only owner review route, and needs-attention surfacing.
// Shadow semantics under test: admission stays admitted, work stays done.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey: fixture.keys.owner, store: fixture.store };
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const shadow = (origin, ownerKey, query = "") =>
  get(origin, `/api/rooms/commons/jev-shadow${query}`, ownerKey).then(async res => ({ res, json: await res.json() }));

test("join via invite journals a shadow admission decision and still admits", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await post(origin, "/api/rooms/commons/agent-invites", { permissions: ["accept_work"] }, ownerKey);
  assert.equal(minted.status, 201);
  const joined = await post(origin, "/join", { displayName: "Shadow Prospect", inviteCode: (await minted.json()).code });
  assert.equal(joined.status, 201);
  assert.equal((await joined.json()).via, "invite"); // admitted, not shadow-blocked

  const { res, json } = await shadow(origin, ownerKey, "?gate=admission");
  assert.equal(res.status, 200, JSON.stringify(json));
  const entry = json.entries.find(e => e.path === "join:invite");
  assert.ok(entry, JSON.stringify(json.entries.map(e => e.path)));
  assert.ok(typeof entry.score === "number" && entry.score >= 0 && entry.score <= 1);
  assert.ok(["admit", "review", "reject"].includes(entry.decision));
  assert.ok(Array.isArray(entry.signals) && entry.signals.length >= 3);
  for (const signal of entry.signals) assert.ok(typeof signal.key === "string" && typeof signal.weight === "number");
  assert.equal(json.counts.admission >= 1, true);
});

test("first-room join journals with path join:first-room", async t => {
  const { origin, store } = await serve(t);
  const joined = await post(origin, "/join", { displayName: "Fresh Human" });
  assert.equal(joined.status, 201);
  const joinedJson = await joined.json();
  // The entry is journaled under the new personal room (the personal room's
  // owner member does not carry manage_members, so assert on the journal
  // directly — the route-level owner gating is covered on commons).
  const entries = store.jevShadow.list({ roomId: joinedJson.roomId, gate: "admission" });
  assert.ok(entries.some(e => e.path === "join:first-room"), JSON.stringify(entries.map(e => e.path)));
});

test("agent-invite redeem journals with path agent-invite:redeem", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await post(origin, "/api/rooms/commons/agent-invites", { permissions: ["accept_work"] }, ownerKey);
  assert.equal(minted.status, 201);
  const identity = await post(origin, "/join", { displayName: "Redeemer Agent" });
  const secret = (await identity.json()).identitySecret;
  const redeemed = await post(origin, "/api/agent-invites/redeem",
    { code: (await minted.json()).code, displayName: "Redeemer Agent" }, secret);
  assert.equal(redeemed.status, 201, JSON.stringify(await redeemed.json())); // admitted
  const { json } = await shadow(origin, ownerKey, "?gate=admission");
  assert.ok(json.entries.some(e => e.path === "agent-invite:redeem" && e.gate === "admission"),
    JSON.stringify(json.entries.map(e => e.path)));
});

test("work-claim done journals a shadow receipt and the work stays done", async t => {
  const { origin, ownerKey } = await serve(t);
  const created = await post(origin, "/api/rooms/commons/work-claims", { id: "w-jev-thin", title: "Thin receipt" }, ownerKey);
  assert.equal(created.status, 201);
  const claimed = await post(origin, "/api/rooms/commons/work-claims/w-jev-thin/claim", {}, ownerKey);
  assert.equal(claimed.status, 200);
  const started = await post(origin, "/api/rooms/commons/work-claims/w-jev-thin/update", { state: "in_progress" }, ownerKey);
  assert.equal(started.status, 200);
  const done = await post(origin, "/api/rooms/commons/work-claims/w-jev-thin/update",
    { state: "done", note: "done" }, ownerKey);
  const doneJson = await done.json();
  assert.equal(done.status, 200, JSON.stringify(doneJson));
  assert.equal(doneJson.state, "done"); // accepted, not shadow-blocked

  const { res, json } = await shadow(origin, ownerKey, "?gate=receipt");
  assert.equal(res.status, 200);
  const entry = json.entries.find(e => e.subject === "w-jev-thin");
  assert.ok(entry, JSON.stringify(json.entries));
  assert.equal(entry.gate, "receipt");
  assert.equal(entry.path, "work-claim:done");
  assert.ok(["accept", "request-changes", "escalate"].includes(entry.decision));
  assert.equal(entry.escalate, true); // thin bare receipt: escalated, still accepted
});

test("escalated receipts surface read-only in needs-attention", async t => {
  const { origin, ownerKey } = await serve(t);
  await post(origin, "/api/rooms/commons/work-claims", { id: "w-jev-na", title: "Needs attention" }, ownerKey);
  await post(origin, "/api/rooms/commons/work-claims/w-jev-na/claim", {}, ownerKey);
  await post(origin, "/api/rooms/commons/work-claims/w-jev-na/update", { state: "in_progress" }, ownerKey);
  const done = await post(origin, "/api/rooms/commons/work-claims/w-jev-na/update", { state: "done", note: "x" }, ownerKey);
  assert.equal(done.status, 200);
  const res = await get(origin, "/api/rooms/commons/needs-attention", ownerKey);
  assert.equal(res.status, 200);
  const json = await res.json();
  const item = json.items.find(i => i.kind === "jev_escalation" && i.title.includes("w-jev-na"));
  assert.ok(item, JSON.stringify(json.items.map(i => i.kind)));
  assert.equal(item.severity, "info");
});

test("jev-shadow is owner-only and validates its query", async t => {
  const { origin, ownerKey } = await serve(t);
  // A joined non-owner member (guest agent identity via invite).
  const minted = await post(origin, "/api/rooms/commons/agent-invites", { permissions: ["accept_work"] }, ownerKey);
  const joined = await post(origin, "/join", { displayName: "Just A Member", inviteCode: (await minted.json()).code });
  const memberSecret = (await joined.json()).identitySecret;

  const forbidden = await get(origin, "/api/rooms/commons/jev-shadow", memberSecret);
  assert.equal(forbidden.status, 403, JSON.stringify(await forbidden.json()));

  const badGate = await get(origin, "/api/rooms/commons/jev-shadow?gate=bogus", ownerKey);
  assert.equal(badGate.status, 422, JSON.stringify(await badGate.json()));
  const badLimit = await get(origin, "/api/rooms/commons/jev-shadow?limit=999", ownerKey);
  assert.equal(badLimit.status, 422);
  const ok = await get(origin, "/api/rooms/commons/jev-shadow?gate=admission&escalate=false&limit=5", ownerKey);
  assert.equal(ok.status, 200);
  const json = await ok.json();
  assert.equal(json.roomId, "commons");
  assert.ok(Array.isArray(json.entries));
});
