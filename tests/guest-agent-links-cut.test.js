// Characterization for the guest-agent-links v0 cut (issue #3216).
//
// v0 (owner-minted ga1. link exchange: mint/preview/join/refresh + the
// GET contract) is removed. What must survive:
// - the shared guest-agent tier helpers (classifyJoinToken,
//   guestAgentMemberId, isGuestAgentMemberId) that guest-invites v1 and
//   ~25 modules classify members/tokens with;
// - the v1 guest-invites door itself (GET /api/guest-invites contract);
// - the guest_link_exchanges table, kept read-only for audit (no DROP).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  classifyJoinToken, guestAgentMemberId, isGuestAgentMemberId,
  GUEST_AGENT_TOKEN_PREFIX, GUEST_AGENT_MEMBER_PREFIX
} from "../server/guest-agent-links.mjs";

const guestToken = () => GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
const humanToken = () => randomBytes(32).toString("base64url");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-cut-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, request, ownerKey };
}

test("v0 guest-agent-links route family is gone", async t => {
  const { request, ownerKey } = await serve(t);
  const token = guestToken();
  assert.equal((await request("/api/guest-agent-links")).status, 404, "GET contract");
  assert.equal((await request("/api/guest-agent-links", { method: "HEAD" })).status, 404, "HEAD contract");
  assert.equal((await request("/api/guest-agent-links", { method: "POST", token: ownerKey, data: { roomId: "commons" } })).status, 404, "global mint");
  assert.equal((await request("/api/guest-agent-links/preview", { method: "POST", data: { linkToken: token } })).status, 404, "preview");
  assert.equal((await request("/api/guest-agent-links/join", { method: "POST", data: { linkToken: token } })).status, 404, "join");
  assert.equal((await request("/api/guest-agent-links/refresh", { method: "POST", data: { linkToken: token } })).status, 404, "refresh");
  assert.equal((await request("/api/rooms/commons/guest-agent-links", { method: "POST", token: ownerKey, data: {} })).status, 404, "room-scoped mint");
});

test("shared guest-agent tier helpers survive the cut", () => {
  assert.equal(classifyJoinToken(guestToken()), "guest-agent");
  assert.equal(classifyJoinToken(humanToken()), "human-share");
  assert.equal(classifyJoinToken("not-a-token"), "invalid");
  const memberId = guestAgentMemberId("acct-1", "req-1");
  assert.ok(memberId.startsWith(GUEST_AGENT_MEMBER_PREFIX));
  assert.equal(isGuestAgentMemberId(memberId), true);
  assert.equal(isGuestAgentMemberId("member-1"), false);
});

test("v1 guest-invites door is untouched by the v0 cut", async t => {
  const { request } = await serve(t);
  const contract = await request("/api/guest-invites");
  assert.equal(contract.status, 200);
});

test("guest_link_exchanges table is retained read-only for audit", async t => {
  const { store } = await serve(t);
  const row = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='guest_link_exchanges'").get();
  assert.ok(row, "guest_link_exchanges must not be dropped");
});
