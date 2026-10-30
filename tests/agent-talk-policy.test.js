import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { talkAllowed } from "../server/agent-talk-policy.mjs";
import { TALK_POLICY_ROUTES } from "../server/routes/talk-policy.mjs";
import { assertRouteRow } from "../server/routes/table.mjs";

test("talk-policy route rows are well-formed", () => {
  assert.equal(TALK_POLICY_ROUTES.length, 2);
  for (const row of TALK_POLICY_ROUTES) assert.deepEqual(assertRouteRow(row), []);
});

const state = {
  room: { ownerId: "owner" },
  members: {
    owner: { id: "owner", kind: "human" },
    other: { id: "other", kind: "human" },
    bot: { id: "bot", kind: "agent", accountableHumanId: "owner" },
    mybot2: { id: "mybot2", kind: "agent", accountableHumanId: "owner" },
    theirbot: { id: "theirbot", kind: "agent", accountableHumanId: "other" },
  },
};

test("#5384 talkAllowed: owner policy hears the owner and the owner's agents only", () => {
  const owner = { policy: "owner", allowed: [] };
  assert.equal(talkAllowed(state, owner, "owner", "bot"), true);
  assert.equal(talkAllowed(state, owner, "mybot2", "bot"), true);
  assert.equal(talkAllowed(state, owner, "other", "bot"), false);
  assert.equal(talkAllowed(state, owner, "theirbot", "bot"), false);
  assert.equal(talkAllowed(state, { policy: "members", allowed: ["other"] }, "other", "bot"), true);
  assert.equal(talkAllowed(state, { policy: "members", allowed: ["other"] }, "theirbot", "bot"), false);
  assert.equal(talkAllowed(state, { policy: "room", allowed: [] }, "theirbot", "bot"), true);
  assert.equal(talkAllowed(state, { policy: "nobody", allowed: [] }, "owner", "bot"), false);
  // Humans are never gated by this setting.
  assert.equal(talkAllowed(state, owner, "theirbot", "other"), true);
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "talk-policy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}
async function call(origin, method, path, body, token) {
  const res = await fetch(`${origin}${path}`, { method, headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("#5384 a newly joined agent defaults to owner; only its owner can change it; older members read room", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await call(origin, "POST", "/api/rooms/commons/agent-invites", {}, ownerKey);
  assert.equal(minted.status, 201);
  const joined = await call(origin, "POST", "/api/agent-invites/redeem", { code: minted.json.code, displayName: "Talk Bot" });
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  const memberId = joined.json.memberId;
  const agentKey = joined.json.mcpToken?.credential ?? joined.json.token;
  const readRoute = TALK_POLICY_ROUTES.find(route => route.id === "talk-policy-read");
  const read = await call(origin, readRoute.method, readRoute.path.replace("{roomId}", "commons").replace("{memberId}", memberId), undefined, ownerKey);
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.equal(read.json.policy, "owner");
  const legacy = await call(origin, "GET", "/api/rooms/commons/members/owner/talk-policy", undefined, ownerKey);
  assert.equal(legacy.json.policy, "room");
  assert.equal(legacy.json.explicit, false);
  if (agentKey) {
    const self = await call(origin, "PUT", `/api/rooms/commons/members/${memberId}/talk-policy`, { policy: "room" }, agentKey);
    assert.equal(self.status, 403);
  }
  const bad = await call(origin, "PUT", `/api/rooms/commons/members/${memberId}/talk-policy`, { policy: "everyone" }, ownerKey);
  assert.equal(bad.status, 422);
  const set = await call(origin, "PUT", `/api/rooms/commons/members/${memberId}/talk-policy`, { policy: "nobody" }, ownerKey);
  assert.equal(set.status, 200, JSON.stringify(set.json));
  const after = await call(origin, "GET", `/api/rooms/commons/members/${memberId}/talk-policy`, undefined, ownerKey);
  assert.equal(after.json.policy, "nobody");
});
