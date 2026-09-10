import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { validAgentNext } from "../src/agent-error.mjs";
import {
  classifyJoinToken, guestAgentLinkContract, guestAgentMemberId,
  GUEST_AGENT_TOKEN_PREFIX, GUEST_AGENT_KIND, GUEST_AGENT_PERMISSIONS,
  GUEST_AGENT_HASH_PATH, HUMAN_SHARE_HASH_PATH, GUEST_AGENT_TTL_MS, GUEST_AGENT_MAX_JOINS
} from "../server/guest-agent-links.mjs";

const guestToken = () => GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
const humanToken = () => randomBytes(32).toString("base64url");
const PEOPLE = /@gmail|John |Potter |acct-|accountId|people-data/i;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-agent-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
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
  return { store, origin, request, ownerKey, advance: ms => { clock += ms; } };
}

function mintBody(extras = {}) {
  return { requestId: randomUUID(), linkToken: guestToken(), expectedOwnerRevision: 0, ...extras };
}

test("guest-agent tokens are a different shape from human share tokens", () => {
  const agent = guestToken(), human = humanToken();
  assert.equal(classifyJoinToken(agent), "guest-agent");
  assert.equal(classifyJoinToken(human), "human-share");
  assert.equal(classifyJoinToken("not-a-token"), "invalid");
  assert.notEqual(GUEST_AGENT_HASH_PATH, HUMAN_SHARE_HASH_PATH);
  const contract = guestAgentLinkContract();
  assert.equal(contract.kind, GUEST_AGENT_KIND);
  assert.deepEqual(contract.permissions, [...GUEST_AGENT_PERMISSIONS]);
  assert.equal(contract.mint, "owner_issued");
  assert.equal(contract.status, "live");
  assert.equal(contract.anyoneWithLink, false);
  assert.equal(contract.schemaBump, false);
  assert.equal(contract.separateFromHumanShareLinks, true);
  assert.equal(contract.account, false);
  assert.equal(contract.ttlMs, GUEST_AGENT_TTL_MS);
  assert.equal(contract.maxJoins, GUEST_AGENT_MAX_JOINS);
});

test("unauthenticated mint is 401 with next pointing at owner Add agent", async t => {
  const { request } = await serve(t);
  const contract = await request("/api/guest-agent-links");
  assert.equal(contract.status, 200);
  assert.deepEqual(await contract.json(), guestAgentLinkContract());
  assert.equal((await request("/api/guest-agent-links", { method: "HEAD" })).status, 200);
  const mint = await request("/api/guest-agent-links", { method: "POST", data: {} });
  assert.equal(mint.status, 401);
  const body = await mint.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.equal(body.reason, "unauthenticated");
  assert.match(body.hint, /Add agent/i);
  assert.ok(validAgentNext(body.next));
  assert.ok(body.next.some(step => /Add agent|mint/i.test(step.command || "")));
});

test("owner mint issues an ephemeral agent member and ga1. credential", async t => {
  const { store, request, ownerKey, origin } = await serve(t);
  const body = mintBody();
  const minted = await request("/api/rooms/commons/guest-agent-links", { method: "POST", token: ownerKey, data: body });
  assert.equal(minted.status, 201);
  const value = await minted.json();
  assert.equal(value.token, body.linkToken);
  assert.equal(value.member.kind, GUEST_AGENT_KIND);
  assert.deepEqual(value.member.permissions, []);
  assert.ok(value.member.id.startsWith("guest-agent-"));
  assert.equal(value.member.id, guestAgentMemberId(store.authenticate(ownerKey, "commons").account.id, body.requestId));
  assert.equal(value.access, "read_chat");
  assert.equal(value.account, false);
  assert.equal(value.hashPath, GUEST_AGENT_HASH_PATH);
  assert.ok(value.expiresAt > Date.now());
  assert.equal(store.room("commons").state.members[value.member.id].kind, "agent");

  const preview = await request("/api/guest-agent-links/preview", { method: "POST", data: { linkToken: body.linkToken } });
  assert.equal(preview.status, 200);
  const shown = await preview.json();
  assert.equal(shown.room.id, "commons");
  assert.equal(shown.kind, "agent");
  assert.equal(shown.account, false);
  assert.equal(Object.hasOwn(shown, "memberId"), false);
  assert.doesNotMatch(JSON.stringify(shown), PEOPLE);

  const joined = await request("/api/guest-agent-links/join", { method: "POST", data: { linkToken: body.linkToken } });
  assert.equal(joined.status, 200);
  const session = await joined.json();
  assert.equal(session.memberId, value.member.id);
  assert.doesNotMatch(JSON.stringify(session), PEOPLE);

  const client = new RoomAgentClient({ origin, roomId: "commons", token: body.linkToken, memberId: value.member.id });
  const orientation = await client.orient();
  assert.equal(orientation.member.id, value.member.id);
  assert.equal(orientation.member.kind, "agent");
  await client.command({ id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "ga-hello", body: "Guest agent can chat." } });
  await assert.rejects(client.command({
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "stranger", displayName: "Nope", kind: "human", permissions: [] }
  }), error => error.status === 422 || error.status === 409 || error.code === "command_rejected");

  const retry = await request("/api/rooms/commons/guest-agent-links", { method: "POST", token: ownerKey, data: body });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);

  const other = { ...body, linkToken: guestToken() };
  const conflict = await request("/api/rooms/commons/guest-agent-links", { method: "POST", token: ownerKey, data: other });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");
});

test("strangers and non-owners cannot mint; human join tokens stay wrong_link_kind", async t => {
  const { store, request, ownerKey } = await serve(t);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "guest", displayName: "Test guest", kind: "human", permissions: [] } });
  const guestKey = store.issueAccessKey("commons", "guest");
  const denied = await request("/api/rooms/commons/guest-agent-links", { method: "POST", token: guestKey, data: mintBody() });
  assert.equal(denied.status, 403);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.error.code, "owner_required");
  assert.match(deniedBody.hint, /Add agent/i);
  assert.ok(validAgentNext(deniedBody.next));

  const human = humanToken(), agent = guestToken();
  const wrongKind = await request("/api/guest-agent-links/preview", { method: "POST", data: { linkToken: human } });
  assert.equal(wrongKind.status, 422);
  const wrong = await wrongKind.json();
  assert.equal(wrong.error.code, "wrong_link_kind");
  assert.equal(wrong.reason, "wrong_link_kind");
  assert.match(wrong.hint, /#join\/|Add agent/i);
  assert.ok(validAgentNext(wrong.next));
  assert.equal((await request("/api/guest-agent-links/join", { method: "POST", data: { linkToken: human } })).status, 422);
  const missing = await request("/api/guest-agent-links/join", { method: "POST", data: { linkToken: agent } });
  assert.equal(missing.status, 410);
  assert.equal((await missing.json()).error.code, "link_unavailable");
  const share = await request("/api/share-links/preview", { method: "POST", data: { linkToken: agent } });
  assert.equal(share.status, 422);
  assert.equal((await share.json()).error.code, "wrong_link_kind");
  assert.throws(() => store.shareLinks.preview(agent), { code: "wrong_link_kind" });
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'guest_agent%'").all().length, 0);
});

test("expiry stops the credential; next owner mint ends the member", async t => {
  const { store, request, ownerKey, advance } = await serve(t);
  const body = mintBody();
  const minted = await (await request("/api/rooms/commons/guest-agent-links", { method: "POST", token: ownerKey, data: body })).json();
  advance(GUEST_AGENT_TTL_MS + 1);
  assert.throws(() => store.authenticate(body.linkToken, "commons"), { status: 401, code: "unauthenticated" });
  assert.equal((await request("/api/guest-agent-links/preview", { method: "POST", data: { linkToken: body.linkToken } })).status, 410);
  const next = mintBody();
  const again = await request("/api/rooms/commons/guest-agent-links", { method: "POST", token: ownerKey, data: next });
  assert.equal(again.status, 201);
  assert.equal(store.room("commons").state.members[minted.member.id].active, false);
});

test("room cap of 10 live guest-agents and top-level owner mint", async t => {
  const { request, ownerKey } = await serve(t);
  for (let i = 0; i < GUEST_AGENT_MAX_JOINS; i++) {
    const minted = await request("/api/guest-agent-links", {
      method: "POST", token: ownerKey,
      data: { roomId: "commons", ...mintBody() }
    });
    assert.equal(minted.status, 201, i);
  }
  const overflow = await request("/api/rooms/commons/guest-agent-links", { method: "POST", token: ownerKey, data: mintBody() });
  assert.equal(overflow.status, 429);
  assert.equal((await overflow.json()).error.code, "rate_limited");
});
