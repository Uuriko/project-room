// WAVE-2000 GUILD-02 worker-44 — FAIL-FIRST test (fails on current code).
// Finding: a JSON request body that is not valid UTF-8 is lossy-decoded
// (Node StringDecoder replaces bad bytes with U+FFFD) and then processed as
// if it were fine, instead of being rejected. Repro:
//   POST /api/rooms/{roomId}/signoff-loops/{recordId}/submit
//   body: {"requestId":"utf8-1","deliverableRef":"<0xff 0xfe 0x80>",...}
// Current behavior: 200, stores deliverable.ref === "\ufffd\ufffd\ufffd".
// Expected: 400 invalid_json (consistent with every other body-parse error
// in server/http.mjs's body()).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const HEX64 = "a".repeat(64);

async function boot(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(r => server.close(r)); store.close();
  });
  return { store, ownerKey, origin: `http://127.0.0.1:${server.address().port}` };
}
function enroll(store, ownerKey, name) {
  const identity = store.identities.create(name);
  const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId, displayName: name,
    permissions: ["accept_work", "complete_work"]
  });
  return { memberId, key: store.issueAccessKey("commons", memberId) };
}

test("invalid-UTF8 JSON body is rejected with 400 invalid_json (not lossy-decoded)", async t => {
  const { store, ownerKey, origin } = await boot(t);
  const cand = enroll(store, ownerKey, "Cand44");
  const now = Date.now();
  store.db.prepare("INSERT INTO buyer_signoff_loops VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("loopU", "commons", "trialU", null, "cand44", "open", 0, 3, "[]", now, now);
  store.db.prepare("INSERT INTO room_trial_tasks VALUES (?,?,?)")
    .run("commons", "trialU", JSON.stringify({ id: "trialU", state: "submitted", buyerId: "cand44", candidateId: "cand44" }));
  const template = JSON.stringify({
    requestId: "utf8-ff-1", deliverableRef: "PLACEHOLDER",
    sha256: HEX64, summary: "ok", candidateId: "cand44"
  });
  const raw = Buffer.concat([
    Buffer.from(template.slice(0, template.indexOf("PLACEHOLDER"))),
    Buffer.from([0xff, 0xfe, 0x80]),
    Buffer.from(template.slice(template.indexOf("PLACEHOLDER") + "PLACEHOLDER".length)),
  ]);
  const res = await fetch(`${origin}/api/rooms/commons/signoff-loops/loopU/submit`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${cand.key}`, "content-type": "application/json" },
    body: raw,
  });
  const value = await res.json();
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(value).slice(0, 120)}`);
  assert.equal(value.error.code, "invalid_json");
});

test("invalid-UTF8 JSON body on wants-work is rejected with 400 invalid_json", async t => {
  const { store, ownerKey, origin } = await boot(t);
  const agent = enroll(store, ownerKey, "Fuzz Worker 44 Ag");
  const raw = Buffer.concat([
    Buffer.from('{"labels":["'),
    Buffer.from([0xff, 0xfe, 0x80]),
    Buffer.from('"]}'),
  ]);
  const res = await fetch(`${origin}/api/rooms/commons/members/me/wants-work`, {
    method: "PUT", redirect: "manual", signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${agent.key}`, "content-type": "application/json" },
    body: raw,
  });
  const value = await res.json();
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(value).slice(0, 120)}`);
  assert.equal(value.error.code, "invalid_json");
});
