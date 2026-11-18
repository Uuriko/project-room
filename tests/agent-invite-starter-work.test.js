// Optional starter work item on invite redeem: off unless the invite carries
// one, proposed to the new member only when the profile can use it, and a
// refused proposal never undoes the join.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invite-starter-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey, store };
}

async function send(origin, path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

const mint = (origin, ownerKey, body) => send(origin, "/api/rooms/commons/agent-invites", { method: "POST", token: ownerKey, body });
const redeem = (origin, code, displayName = "Starter Bot") => send(origin, "/api/agent-invites/redeem", { method: "POST", body: { code, displayName } });
const STARTER = { title: "Read the README and say hello", definitionOfDone: "A message in #general naming one thing you will pick up." };

test("an invite without starterWork creates no work item on redeem", async t => {
  const { origin, ownerKey, store } = await serve(t);
  const minted = await mint(origin, ownerKey, { profile: "contribute" });
  assert.equal(minted.status, 201, minted.text);
  assert.equal(minted.json.starterWork, undefined);
  const before = Object.keys(store.room("commons").state.workItems).length;
  const redeemed = await redeem(origin, minted.json.code);
  assert.equal(redeemed.status, 201, redeemed.text);
  assert.equal(redeemed.json.starterWorkItemId, undefined);
  assert.equal(Object.keys(store.room("commons").state.workItems).length, before);
});

test("redeeming an invite with starterWork proposes it to the new member", async t => {
  const { origin, ownerKey, store } = await serve(t);
  const minted = await mint(origin, ownerKey, { profile: "contribute", starterWork: { title: `  ${STARTER.title}  `, definitionOfDone: STARTER.definitionOfDone } });
  assert.equal(minted.status, 201, minted.text);
  assert.deepEqual(minted.json.starterWork, STARTER);
  const redeemed = await redeem(origin, minted.json.code);
  assert.equal(redeemed.status, 201, redeemed.text);
  const id = redeemed.json.starterWorkItemId;
  assert.match(id, /^starter-[a-f0-9]{8}$/);
  const item = store.room("commons").state.workItems[id];
  assert.ok(item, "starter item exists");
  assert.equal(item.title, STARTER.title);
  assert.equal(item.definitionOfDone, STARTER.definitionOfDone);
  assert.equal(item.accountableMemberId, redeemed.json.memberId);
  assert.equal(item.state, "proposed");
  assert.equal(item.mode, "read");
  assert.deepEqual(item.labels, ["starter"]);
  // The member can take it with the grants the profile already carries.
  const accepted = await send(origin, `/api/rooms/commons/commands`, {
    method: "POST", token: redeemed.json.identitySecret,
    body: { id: "accept-starter", type: "work.accepted", data: { workItemId: id, expectedRevision: item.revision } },
  });
  assert.equal(accepted.status, 201, accepted.text);
  assert.equal(store.room("commons").state.workItems[id].state, "accepted");
});

test("the starter is minted once per code: a replayed redeem does not add another", async t => {
  const { origin, ownerKey, store } = await serve(t);
  const minted = await mint(origin, ownerKey, { profile: "contribute", starterWork: STARTER });
  const first = await send(origin, "/api/agent-invites/redeem", { method: "POST", body: { code: minted.json.code, displayName: "Replay Bot", requestId: "starter-replay-1" } });
  assert.equal(first.status, 201, first.text);
  const count = () => Object.keys(store.room("commons").state.workItems).filter(id => id.startsWith("starter-")).length;
  assert.equal(count(), 1);
  const replay = await send(origin, "/api/agent-invites/redeem", { method: "POST", body: { code: minted.json.code, displayName: "Replay Bot", requestId: "starter-replay-1" } });
  assert.equal(replay.json.duplicate, true, replay.text);
  assert.equal(replay.json.starterWorkItemId, undefined);
  assert.equal(count(), 1);
});

test("starterWork is refused when it cannot be used or is malformed", async t => {
  const { origin, ownerKey } = await serve(t);
  const noSteer = await mint(origin, ownerKey, { profile: "chat", starterWork: STARTER });
  assert.equal(noSteer.status, 422, noSteer.text);
  assert.equal(noSteer.json.error?.code ?? noSteer.json.code, "invalid_starter_work");
  for (const bad of [
    "do it", [], { title: "x" }, { definitionOfDone: "x" }, { title: "", definitionOfDone: "x" },
    { title: "x".repeat(121), definitionOfDone: "x" }, { title: "x", definitionOfDone: "y".repeat(501) },
    { title: "x", definitionOfDone: "y", extra: 1 }, { title: 5, definitionOfDone: "y" },
  ]) {
    const res = await mint(origin, ownerKey, { profile: "contribute", starterWork: bad });
    assert.equal(res.status, 422, `${JSON.stringify(bad)} -> ${res.text}`);
  }
  // Null means "none" and mints a normal invite.
  const none = await mint(origin, ownerKey, { profile: "contribute", starterWork: null });
  assert.equal(none.status, 201, none.text);
  assert.equal(none.json.starterWork, undefined);
});

test("the starter never changes what the invite grants", async t => {
  const { origin, ownerKey, store } = await serve(t);
  const minted = await mint(origin, ownerKey, { profile: "contribute", starterWork: STARTER });
  const redeemed = await redeem(origin, minted.json.code);
  assert.deepEqual(redeemed.json.permissions, minted.json.permissions);
  const member = store.room("commons").state.members[redeemed.json.memberId];
  assert.deepEqual(member.permissions, minted.json.permissions);
});
