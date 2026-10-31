// A freshly joined agent that the owner assigned Board work to, or
// @mentioned, must not read "nothing open" as its first step.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invite-link-"));
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
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function send(origin, path, { method = "GET", token, headers = {}, body } = {}) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* page or plain text */ }
  return { status: res.status, text, json, headers: res.headers };
}

async function mint(origin, ownerKey) {
  const minted = await send(origin, "/api/rooms/commons/agent-invites", {
    method: "POST", token: ownerKey, body: { profile: "contribute", expiresInMinutes: 30 },
  });
  assert.equal(minted.status, 201, minted.text);
  return minted.json;
}

async function joined(t) {
  const { origin, ownerKey } = await serve(t);
  const invite = await mint(origin, ownerKey);
  const redeemed = await send(origin, "/api/agent-invites/redeem", { method: "POST", body: { code: invite.code, displayName: "Brief-Friend" } });
  assert.equal(redeemed.status, 201, redeemed.text);
  return { origin, ownerKey, secret: redeemed.json.identitySecret, memberId: redeemed.json.memberId };
}
const brief = async (origin, secret) => (await send(origin, "/api/rooms/commons/activation-pack?view=brief", { token: secret })).json;

test("brief: Board work assigned to the agent is its first step", async t => {
  const { origin, ownerKey, secret, memberId } = await joined(t);
  const created = await send(origin, "/api/rooms/commons/work-claims", { method: "POST", token: ownerKey,
    body: { id: "assigned-1", title: "One-line result", note: "Reply with one line", assignee: memberId } });
  assert.equal(created.status, 201, created.text);
  const b = await brief(origin, secret);
  assert.deepEqual(b.yourWork.map(item => [item.id, item.kind, item.state]), [["assigned-1", "claim", "claimed"]]);
  assert.equal(b.next.why, "continue your current work");
  assert.equal(b.next.endpoint, "/api/rooms/commons/work-claims/assigned-1/thread");
  const thread = await send(origin, b.next.endpoint, { token: secret });
  assert.equal(thread.status, 200, thread.text);
});

test("brief: with nothing to pick up, point at what needs the agent, not 'nothing open'", async t => {
  const { origin, ownerKey, secret } = await joined(t);
  const posted = await send(origin, "/api/rooms/commons/commands", { method: "POST", token: ownerKey,
    body: { id: "m-1", type: "message.posted", data: { messageId: "m-1", body: "@Brief-Friend please summarize" } } });
  assert.equal(posted.status, 201, posted.text);
  const b = await brief(origin, secret);
  assert.doesNotMatch(b.next.why, /nothing open/);
  assert.equal(b.next.endpoint, "/api/needs-me?roomId=commons");
  const inbox = await send(origin, b.next.endpoint, { token: secret });
  assert.equal(inbox.status, 200, inbox.text);
  assert.match(inbox.text, /Brief-Friend please summarize|mention/);
});
