// room-acp B6: ACP permission requests are asked in the Room thread and
// decided only by the agent's accountable human; silence means deny.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Bridge } from "../room-acp/src/bridge.mjs";
import { decisionOf } from "../room-acp/src/permission.mjs";
import { join } from "../room-acp/src/join.mjs";
import { startRoom, FAKE_AGENT } from "./room-acp-fixture.mjs";

const waitFor = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("timed out waiting");
};
async function startBridge(t, room, permissionTimeoutMs) {
  const connection = await join({ link: room.invite().link, displayName: "Coder", env: room.env });
  const bridge = new Bridge({ connection, candidate: { id: "fake", label: "Fake", command: process.execPath, args: [FAKE_AGENT] },
    env: { ...room.env, FAKE_ACP_MODE: "ask-permission" }, waitMs: 3000, permissionTimeoutMs, permissionPollMs: 50 });
  const done = bridge.run();
  t.after(async () => { bridge.stop(); await done; });
  await waitFor(() => bridge.members && bridge.fencingToken);
  return { bridge, connection };
}
const mine = (room, rootId, memberId) => room.messages().filter(message => message.replyToId === rootId && message.authorId === memberId);

test("decisionOf reads allow/deny with or without a mention", () => {
  assert.equal(decisionOf("allow"), "allow");
  assert.equal(decisionOf("@Coder yes please"), "allow");
  assert.equal(decisionOf("Deny."), "deny");
  assert.equal(decisionOf("maybe later"), null);
});

test("owner allow in the thread selects the allow option", async t => {
  const room = await startRoom(t);
  const { connection } = await startBridge(t, room, 20000);
  const rootId = room.say("@Coder clean the build");
  await waitFor(() => mine(room, rootId, connection.memberId).some(message => /^Permission needed: Run rm -rf build/.test(message.body)));
  // A guest saying allow does not count.
  const guestKey = room.f.store.issueAccessKey("commons", "guest");
  room.f.store.command(guestKey, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: "g-allow", body: "allow", replyToId: rootId } });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(!mine(room, rootId, connection.memberId).some(message => message.body.startsWith("Allowed")));
  room.say("@Coder allow", { replyToId: rootId });
  const final = await waitFor(() => mine(room, rootId, connection.memberId).find(message => /^permission: /.test(message.body)));
  assert.match(final.body, /permission: allow_once/);
  assert.ok(mine(room, rootId, connection.memberId).some(message => message.body.startsWith("Allowed:")));
});

test("no answer before the timeout denies", async t => {
  const room = await startRoom(t);
  const { connection } = await startBridge(t, room, 300);
  const rootId = room.say("@Coder clean the build");
  const final = await waitFor(() => mine(room, rootId, connection.memberId).find(message => /^permission: /.test(message.body)));
  assert.match(final.body, /permission: reject_once/);
  assert.ok(mine(room, rootId, connection.memberId).some(message => message.body.startsWith("No answer; denied")));
});

test("a permission ask in a Board claim turn goes to the owner as a DM; allow there selects allow", async t => {
  const room = await startRoom(t);
  const { connection } = await startBridge(t, room, 20000);
  const res = await fetch(`${room.origin}/api/rooms/commons/work-claims`, { method: "POST", headers: { authorization: `Bearer ${room.ownerKey}`, "content-type": "application/json" }, body: JSON.stringify({ id: "clean-build", title: "Clean the build", assignee: connection.memberId }) });
  assert.equal(res.status, 201);
  const ask = await waitFor(() => room.messages().find(message => message.authorId === connection.memberId && message.toMemberId && /^Permission needed on claim clean-build: Run rm -rf build/.test(message.body)));
  room.f.store.command(room.ownerKey, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: "o-allow", body: "allow", replyToId: ask.id, toMemberId: connection.memberId } });
  const claimNotes = async () => {
    const read = await fetch(`${room.origin}/api/rooms/commons/work-claims/clean-build`, { headers: { authorization: `Bearer ${room.ownerKey}` } }).then(r => r.json());
    return (read.history ?? []).filter(entry => entry.agentId === connection.memberId).map(entry => entry.note ?? "");
  };
  const end = Date.now() + 20000;
  let notes = [];
  while (Date.now() < end && !notes.some(note => /permission: allow_once/.test(note))) { notes = await claimNotes(); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(notes.some(note => /^Waiting for owner permission: Run rm -rf build/.test(note)), notes.join(" | "));
  assert.ok(notes.some(note => /permission: allow_once/.test(note)), notes.join(" | "));
});
