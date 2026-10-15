// #3259: agent-invite preview must take the credential in a POST body like
// the other four preview doors (referral, guest, share-link, guest-agent
// links). The GET form put the single-use code — a live membership
// credential — into server access logs, proxy/CDN logs, and browser
// history, and the server's own minted-invite `next` action taught agents
// to use it. These tests pin the POST door, the 405 retirement of the GET
// form (the sibling doors' shape), and a next action that no longer emits
// a code-bearing URL.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invite-preview-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function post(origin, path, body, token) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}
const mint = (origin, ownerKey, body) => post(origin, "/api/rooms/commons/agent-invites", body, ownerKey);
const previewPost = (origin, code) => post(origin, "/api/agent-invites/preview", { code });

test("POST preview returns the grant summary and consumes nothing", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey, { profile: "contribute", expiresInMinutes: 60, displayName: "Plug Bot" });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const preview = await previewPost(origin, minted.json.code);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.roomId, "commons");
  assert.deepEqual(preview.json.permissions, ["accept_work", "complete_work"]);
  assert.equal(preview.json.profile, "contribute");
  assert.ok(preview.json.expiresAt > Date.now());
  assert.ok(!("secret" in preview.json) && !("identityId" in preview.json) && !("memberId" in preview.json));
  // The code stays live: redeem after preview succeeds.
  const redeemed = await post(origin, "/api/agent-invites/redeem", { code: minted.json.code, displayName: "Redeemed Bot" });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.json));
});

test("POST preview folds failures like redeem (unknown, malformed, used)", async t => {
  const { origin, ownerKey } = await serve(t);
  const unknown = await previewPost(origin, "RM-AAAAAAAAAAAAAAAA");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, "invite_unavailable");
  const malformed = await previewPost(origin, "NOT-A-CODE");
  assert.equal(malformed.status, 404);
  assert.match(malformed.json.error.message, /wrong format/);
  const missing = await post(origin, "/api/agent-invites/preview", {});
  assert.equal(missing.status, 422);
  assert.equal(missing.json.error.code, "invalid_invite");
  const minted = await mint(origin, ownerKey, { profile: "chat", expiresInMinutes: 60 });
  assert.equal((await post(origin, "/api/agent-invites/redeem", { code: minted.json.code, displayName: "First" })).status, 201);
  const used = await previewPost(origin, minted.json.code);
  assert.equal(used.status, 409);
  assert.equal(used.json.error.code, "invite_already_used");
});

test("the GET form is retired with the sibling doors' 405 shape", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey, { profile: "chat", expiresInMinutes: 60 });
  const res = await fetch(`${origin}/api/agent-invites/preview?code=${encodeURIComponent(minted.json.code)}`, {
    headers: { Origin: origin },
  });
  assert.equal(res.status, 405, `GET preview must be retired, got ${res.status}`);
  assert.equal(res.headers.get("allow"), "POST");
  const json = await res.json().catch(() => null);
  assert.equal(json?.error?.code, "method_not_allowed");
  // Retiring the door did not burn the code.
  assert.equal((await previewPost(origin, minted.json.code)).status, 200);
});

test("the minted invite's next actions never put the code in a URL", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey, { profile: "chat", expiresInMinutes: 60 });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const actions = minted.json.next ?? minted.json.nextActions ?? [];
  const serialized = JSON.stringify(actions);
  assert.ok(!serialized.includes("preview?code="), `no next action may carry the code in a query string: ${serialized}`);
  assert.ok(actions.every(action => !String(action.path ?? "").includes(minted.json.code)),
    "no next action embeds the raw code in a path (share/preview descriptions may name it as body content)");
  const previewAction = actions.find(action => action.action === "preview-invite");
  assert.ok(previewAction, "the preview next action still exists");
  assert.equal(previewAction.method, "POST");
  assert.equal(previewAction.path, "/api/agent-invites/preview");
});
