// G7 (#940): error shapes teach. The body-cap rejection must name the limit,
// the actual size, and the next step; malformed bond/dm field shapes must get
// errors that enumerate the expected shape. Error codes and HTTP statuses are
// the contract and stay unchanged — only hint/next (and the too_large message
// detail) are enriched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { agentErrorAx, agentErrorBody, validAgentNext } from "../src/agent-error.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
});

async function roomWithMember(origin, fixture) {
  const owner = fixture.store.identities.create("g7 owner");
  const friend = fixture.store.identities.create("g7 friend");
  const roomId = "g7-room";
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "G7", purpose: "probe", kind: "personal", displayName: "G7",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  const requestId = "g7-req-1";
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Friend",
    requestedPermissions: ["accept_work"], note: null, requestId,
  });
  assert.equal(reqRes.status, 201);
  const decideRes = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null,
  }, owner.secret);
  assert.equal(decideRes.status, 200);
  return { ownerSecret: owner.secret, friendSecret: friend.secret, friendIdentityId: friend.identityId, roomId };
}

const command = (origin, roomId, secret, type, data) => post(origin, `/api/rooms/${roomId}/commands`, {
  id: randomUUID(), type, data,
}, secret);

// (a) Body-cap rejection names the limit, the actual size, and the next step.
test("oversized JSON body: 413 names the limit and the actual size, hint/next teach", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const owner = fixture.store.identities.create("g7 big body owner");
  const payload = { title: "x".repeat(20000), purpose: "p", kind: "personal", displayName: "G7" };
  const actualBytes = Buffer.byteLength(JSON.stringify(payload));
  assert.ok(actualBytes > 16384);
  const res = await post(origin, "/api/agent-rooms", payload, owner.secret);
  assert.equal(res.status, 413);
  const json = await res.json();
  assert.equal(json.error.code, "too_large", "code is the contract: unchanged");
  assert.match(json.error.message, /16384/, "message names the limit");
  assert.match(json.error.message, new RegExp(String(actualBytes)), "message names the actual size");
  assert.match(json.hint, /16384/, "hint names the limit");
  assert.match(json.hint, new RegExp(String(actualBytes)), "hint names the actual size");
  assert.ok(validAgentNext(json.next), "next steps stay valid");
  assert.match(JSON.stringify(json.next), /smaller|shrink/i, "next teaches the recovery");
});

test("too_large AX: sized message yields limit + actual + next step", () => {
  const ax = agentErrorAx({ httpStatus: 413, code: "too_large", message: "Request body is 20030 bytes; the limit is 16384 bytes" });
  assert.equal(ax.status, "action_required");
  assert.equal(ax.reason, "input_refused");
  assert.match(ax.hint, /20030/);
  assert.match(ax.hint, /16384/);
  assert.ok(validAgentNext(ax.next));
  assert.match(JSON.stringify(ax.next), /smaller|shrink/i);
  assert.doesNotMatch(ax.hint, /Fix the refused fields/);
});

test("too_large AX: command-size refusal names both caps and the next step", () => {
  const ax = agentErrorAx({ httpStatus: 413, code: "too_large", message: "Command is too large" });
  assert.match(ax.hint, /524288/, "names the message-command cap");
  assert.match(ax.hint, /16384/, "names the other-command cap");
  assert.match(JSON.stringify(ax.next), /same id/i);
});

test("too_large AX: generic refusal still teaches instead of naming fields", () => {
  const ax = agentErrorAx({ httpStatus: 413, code: "too_large", message: "Request is too large" });
  assert.doesNotMatch(ax.hint, /Fix the refused fields/);
  assert.match(ax.hint, /smaller/i);
  assert.ok(validAgentNext(ax.next));
});

// (b) Malformed bond/dm field shapes enumerate the expected shape.
test("bond.propose with a wrong field enumerates the expected data shape", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friendSecret, friendIdentityId, roomId } = await roomWithMember(origin, fixture);
  const res = await command(origin, roomId, friendSecret, "bond.propose", { toIdentityId: friendIdentityId });
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.equal(json.error.code, "invalid_command", "code is the contract: unchanged");
  assert.match(json.error.message, /Unexpected field: toIdentityId/);
  assert.match(json.hint, /bond\.propose/);
  assert.match(json.hint, /\{\s*to,\s*scopes\?,\s*note\?\s*\}/, "hint enumerates the expected data shape");
  assert.doesNotMatch(json.hint, /Fix the refused fields/);
  assert.ok(validAgentNext(json.next));
});

test("dm.posted with a wrong field enumerates the expected data shape", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friendSecret, friendIdentityId, roomId } = await roomWithMember(origin, fixture);
  const res = await command(origin, roomId, friendSecret, "dm.posted",
    { to: friendIdentityId, body: "hi", messageId: randomUUID(), bogus: 1 });
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.equal(json.error.code, "invalid_command");
  assert.match(json.error.message, /Unexpected field: bogus/);
  assert.match(json.hint, /\{\s*to,\s*body,\s*messageId\?\s*\}/, "hint enumerates the expected data shape");
  assert.ok(validAgentNext(json.next));
});

test("invalid_command AX: bond.accept wrong field names data { bondId, scopes? }", () => {
  const ax = agentErrorAx({
    httpStatus: 422, code: "invalid_command", message: "Unexpected field: from",
    commandType: "bond.accept", roomId: "room-1",
  });
  assert.equal(ax.reason, "input_refused");
  assert.match(ax.hint, /bond\.accept/);
  assert.match(ax.hint, /\{\s*bondId,\s*scopes\?\s*\}/);
  assert.ok(validAgentNext(ax.next));
});

test("invalid_bond AX: missing to enumerates the bond.propose shape", () => {
  const ax = agentErrorAx({
    httpStatus: 422, code: "invalid_bond", message: "to is the other agent identity",
    commandType: "bond.propose",
  });
  assert.equal(ax.reason, "input_refused");
  assert.match(ax.hint, /\{\s*to,\s*scopes\?,\s*note\?\s*\}/);
  assert.ok(validAgentNext(ax.next));
});

test("invalid_bond AX: missing bondId enumerates the accept/decline/revoke shape", () => {
  const ax = agentErrorAx({
    httpStatus: 422, code: "invalid_bond", message: "bondId is required",
    commandType: "bond.decline",
  });
  assert.match(ax.hint, /\{\s*bondId\s*\}/);
  assert.ok(validAgentNext(ax.next));
});

test("invalid_dm AX: missing body enumerates the dm.posted shape", () => {
  const ax = agentErrorAx({
    httpStatus: 422, code: "invalid_dm", message: "data.body is required",
    commandType: "dm.posted",
  });
  assert.equal(ax.reason, "input_refused");
  assert.match(ax.hint, /\{\s*to,\s*body,\s*messageId\?\s*\}/);
  assert.match(ax.hint, /4096/, "keeps the known body cap visible");
  assert.ok(validAgentNext(ax.next));
});

test("envelope stays backward compatible: codes, statuses, reason, next shape", () => {
  const body = agentErrorBody({
    httpStatus: 413, code: "too_large",
    message: "Request body is 20030 bytes; the limit is 16384 bytes",
  });
  assert.equal(body.error.code, "too_large");
  assert.equal(body.status, "action_required");
  assert.equal(body.reason, "input_refused");
  assert.ok(typeof body.hint === "string" && body.hint.length > 0);
  assert.ok(validAgentNext(body.next));
  assert.ok(!("commandType" in body), "the refused command type never leaks onto the wire envelope");
});
