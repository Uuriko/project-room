// stranger-qa-2 (wave300, confirmed): during busy hours the room-wide
// anonymous identity budget runs out and a stranger's mint answers a bare
// 429 "daily budget reached" with a flat Retry-After of one hour. The real
// wait can be most of a day, and the hint only says to retry unchanged,
// although redeeming a member's invite code mints without spending that
// budget. The refusal now gives the true wait and names the invite route,
// and an invite redeem still works while the budget is spent.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const HOUR = 60 * 60 * 1000;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "stranger-mint-"));
  const clock = { now: Date.UTC(2026, 9, 8, 12) };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  store.identities.anonymousDailyLimit = 1; // the room-wide budget, scaled down
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, token) => {
    const res = await fetch(origin + path, { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    return { status: res.status, retryAfter: res.headers.get("retry-after"), json: await res.json().catch(() => null) };
  };
  return { clock, ownerKey, post };
}

test("a spent room-wide mint budget gives the real wait and names the invite route", async t => {
  const { clock, post } = await serve(t);
  assert.equal((await post("/api/agent-identities", { displayName: "First Stranger" })).status, 201);
  clock.now += HOUR;
  const refused = await post("/api/agent-identities", { displayName: "Second Stranger" });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error.code, "rate_limited", "the code stays the documented one");
  assert.equal(refused.retryAfter, String(23 * 60 * 60), "the slot frees when the first mint leaves the 24h window");
  assert.match(refused.json.hint, /invite code/i);
  assert.ok(refused.json.next.some(step => step.path === "/api/agent-invites/redeem" && step.method === "POST"),
    JSON.stringify(refused.json.next));
});

test("an invite redeem still mints while the budget is spent, and the budget recovers", async t => {
  const { clock, ownerKey, post } = await serve(t);
  assert.equal((await post("/api/agent-identities", { displayName: "First Stranger" })).status, 201);
  assert.equal((await post("/api/agent-identities", { displayName: "Second Stranger" })).status, 429);
  const invite = await post("/api/rooms/commons/agent-invites", { permissions: ["accept_work"] }, ownerKey);
  assert.equal(invite.status, 201, JSON.stringify(invite.json));
  const redeemed = await post("/api/agent-invites/redeem", { code: invite.json.code, displayName: "Invited Friend" });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.json));
  clock.now += 24 * HOUR + 1000;
  assert.equal((await post("/api/agent-identities", { displayName: "Next Day Stranger" })).status, 201);
});
