// Public receipts: a private room stays off the page until its owner opts in,
// a non-owner cannot opt in, and an already-public work receipt does not
// wait for that switch. Served by the real HTTP server and RoomStore.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { collectPublicReceipts, projectPublicWorkReceipt } from "../server/receipts-live.mjs";

const HASH = `sha256:${"ab".repeat(32)}`;
const PWR = `pwr_${"cd".repeat(32)}`;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-receipts-route-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added", data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  const adaKey = store.issueAccessKey("commons", "ada");
  store.workClaims.set("commons", {
    id: "claim-1", title: "Ship the door", state: "done", owner: "ada",
    history: [{ action: "pr_merged", agentId: "owner", actor: "ada", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/9", outcome: "merged", syncedAt: "2026-10-01T12:00:00.000Z" },
    blobs: [HASH], updatedAt: "2026-10-01T12:00:00.000Z",
  });
  const publicWork = { schema: "public-work-receipt/1", receiptId: PWR, namespaceId: "commons", identityId: "ai_public", title: "Public task", createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: "cd".repeat(32) } };
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    PWR, "offer-1", "commons", 1, "ai_public", "note", "cd".repeat(32), 4, JSON.stringify(publicWork), Date.now());
  projectPublicWorkReceipt(store, publicWork, "cd".repeat(32));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, ownerKey, adaKey };
}

async function raw(origin, path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...headers }, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

test("a private room's claim stays hidden until the owner publishes, and a non-owner cannot publish", async t => {
  const { origin, store, ownerKey, adaKey } = await serve(t);
  const hidden = await raw(origin, "/receipts");
  assert.equal(hidden.status, 200);
  assert.equal(hidden.headers.get("x-robots-tag"), "all");
  const publicPolicy = hidden.headers.get("content-security-policy");
  assert.equal(publicPolicy.split("; ").find(d => d.startsWith("connect-src ")), `connect-src https://cloudflareinsights.com ${origin}/cdn-cgi/rum`);
  assert.doesNotMatch(publicPolicy, /connect-src 'self'|script-src 'self'|\*/);
  assert.equal(hidden.text.includes("Ship the door"), false);
  assert.equal(hidden.text.includes("Project Room Commons"), false);
  assert.match(hidden.text, /Public task/);
  const missing = await raw(origin, "/receipts/wcr_doesnotexist0123456789abcdef");
  assert.equal(missing.status, 404);
  const denied = await raw(origin, "/api/rooms/commons/commands", {
    method: "POST",
    headers: { authorization: `Bearer ${adaKey}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "nope", type: "room.public_receipts_set", data: { enabled: true } }),
  });
  assert.equal(denied.status, 422);
  assert.equal(store.room("commons").state.room.publicReceipts, undefined);
  assert.equal((await raw(origin, "/receipts")).text.includes("Ship the door"), false);
  const allowed = await raw(origin, "/api/rooms/commons/commands", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "publish", type: "room.public_receipts_set", data: { enabled: true } }),
  });
  assert.equal(allowed.status, 201);
  const listed = await raw(origin, "/receipts");
  assert.match(listed.text, /Ship the door/);
  assert.equal(listed.text.includes("Project Room Commons"), false);
  const id = collectPublicReceipts(store).find(item => item.title === "Ship the door")?.id;
  assert.match(id, /^wcr_[a-f0-9]{32}$/);
  const page = await raw(origin, `/receipts/${id}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy"), publicPolicy);
  assert.match(page.text, /<main>/);
  assert.match(page.text, /<footer>/);
  assert.match(page.text, /Made in Project Room — start your own room/);
  assert.match(page.text, /ref=Room(\+|%20)owner/);
  assert.match(page.text, new RegExp(HASH));
  assert.match(page.text, /github.com\/Uuriko\/project-room\/pull\/9/);
  assert.equal(page.text.includes("Project Room Commons"), false);
  const json = await raw(origin, `/receipts/${id}.json`);
  assert.doesNotMatch(json.headers.get("content-security-policy"), /cdn-cgi\/rum/);
  const body = JSON.parse(json.text);
  assert.equal(body.schema, "project-room-public-receipt/1");
  assert.equal(body.room, null);
  assert.deepEqual(body.agents, ["Ada"]);
  assert.deepEqual(body.humans, ["Room owner"]);
  assert.equal(page.text.includes("ada"), false);
  store.roomDirectory.set("commons", "owner", true);
  store.command(ownerKey, "commons", { id: "publish-room-page", type: "room.public_page_set", data: { enabled: true } });
  const roomPage = await raw(origin, "/r/commons");
  assert.equal(roomPage.status, 200);
  assert.equal(roomPage.headers.get("content-security-policy"), publicPolicy);
  const named = await raw(origin, `/receipts/${id}`);
  assert.match(named.text, /Project Room Commons/);
  const off = await raw(origin, "/api/rooms/commons/commands", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "unpublish", type: "room.public_receipts_set", data: { enabled: false } }),
  });
  assert.equal(off.status, 201);
  assert.equal((await raw(origin, `/receipts/${id}`)).status, 404);
  assert.match((await raw(origin, "/receipts")).text, /Public task/);
});

test("share surfaces: JSON-LD and the share block ride the same owner toggle; the poster routes are deleted", async t => {
  const { origin, store, ownerKey } = await serve(t);
  // The public-work receipt is public from the start: its page carries
  // structured data and the share block. The generated posters (EXP-5's
  // per-receipt OG card and badge) are deleted — the page names only the
  // static site image, and the card routes answer 404 like any unknown
  // path, whatever the toggle says.
  const pwrPage = await raw(origin, `/receipts/${PWR}`);
  assert.equal(pwrPage.status, 200);
  assert.match(pwrPage.text, /application\/ld\+json/);
  assert.doesNotMatch(pwrPage.text, /og\.png/);
  assert.doesNotMatch(pwrPage.text, /badge\.svg/);
  assert.doesNotMatch(pwrPage.text, /og:image:alt/);
  assert.equal((await fetch(`${origin}/receipts/${PWR}/og.png`)).status, 404);
  assert.equal((await fetch(`${origin}/receipts/${PWR}/badge.svg`)).status, 404);
  const post = await raw(origin, `/receipts/${PWR}/og.png`, { method: "POST" });
  assert.equal(post.status, 404);
  // The share block shows the exact pre-filled text and one-tap targets.
  assert.match(pwrPage.text, /Share this receipt/);
  assert.match(pwrPage.text, /Work, verified: Public task — Artifact hash recorded/);
  assert.match(pwrPage.text, /twitter\.com\/intent\/tweet/);
  // A claim receipt joins once the owner publishes; unpublishing removes
  // the page — the toggle still governs everything that remains.
  await raw(origin, "/api/rooms/commons/commands", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "publish", type: "room.public_receipts_set", data: { enabled: true } }),
  });
  const id = collectPublicReceipts(store).find(item => item.title === "Ship the door")?.id;
  assert.match(id, /^wcr_/);
  assert.equal((await fetch(`${origin}/receipts/${id}/og.png`)).status, 404);
  const claimPage = await raw(origin, `/receipts/${id}`);
  assert.equal(claimPage.status, 200);
  assert.doesNotMatch(claimPage.text, /og:image:alt/);
  await raw(origin, "/api/rooms/commons/commands", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "unpublish", type: "room.public_receipts_set", data: { enabled: false } }),
  });
  assert.equal((await fetch(`${origin}/receipts/${id}/og.png`)).status, 404);
  assert.equal((await fetch(`${origin}/receipts/${id}/badge.svg`)).status, 404);
  assert.equal((await raw(origin, `/receipts/${id}`)).status, 404);
  assert.equal((await fetch(`${origin}/receipts/wcr_${"0".repeat(32)}/og.png`)).status, 404);
});
