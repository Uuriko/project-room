// EXP-7 Variant B (rival hero, #3548): the /about front door leads with a
// real receipt and live counters, then the two doors. Counters must be
// computed from the public records themselves — never hand-typed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-hero-exp-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin, store };
}

function seedReceipt(store, { id, title, at, merged }) {
  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES (?, ?, 'work-claim', 'commons', 'commons', 'Commons', '["agent-a"]', '["human-b"]', ?, ?, '{}', ?, 'https://room.trydemigod.com/?start=room')`)
    .run(id, title, merged ? "https://github.com/Uuriko/project-room/pull/1" : null, merged ? at : null, at);
}

test("front door: proof first, live counters, two doors, no bounty copy", async t => {
  const { origin } = await serve(t);
  const response = await fetch(`${origin}/about`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Put AI teammates to work — and prove what they did\./);
  assert.match(html, /Put agents to work where humans can direct, review, and prove the results/);
  assert.match(html, /href="https:\/\/room\.trydemigod\.com\/receipts\/pwr_[a-f0-9]{64}"[^>]*>See a real receipt</);
  assert.match(html, /href="\/receipts"[^>]*>Browse all receipts</);
  assert.match(html, /id="fd-verified"/);
  assert.match(html, /id="fd-receipts"/);
  assert.match(html, /id="fd-work"/);
  assert.match(html, /href="\/\?start=room"[^>]*>Create a room for your team</);
  assert.match(html, /href="\/agent-signin"[^>]*>Send your agent to work</);
  assert.ok(!/bounty/i.test(html), "no bounty-first copy anywhere on the page");
  assert.ok(!html.includes("/api/auth/github"), "no GitHub sign-in door on the hero until OAuth is verified live");
  assert.ok(html.includes('src="/src/front-door.js"'), "live-facts script is wired");
});

test("front-door facts: empty store reports honest zeros", async t => {
  const { origin } = await serve(t);
  const facts = await (await fetch(`${origin}/api/public/front-door`)).json();
  assert.equal(facts.schema, "project-room-front-door/1");
  assert.deepEqual(facts.counters, { resultsVerified: 0, receiptsIssued: 0, workAvailableNow: 0 });
  assert.equal(facts.latestReceipt, null);
});

test("front-door facts: counters are computed from the public receipts", async t => {
  const { origin, store } = await serve(t);
  seedReceipt(store, { id: `pwr_${"a".repeat(64)}`, title: "Older verified work", at: "2026-10-01T00:00:00.000Z", merged: true });
  seedReceipt(store, { id: `pwr_${"b".repeat(64)}`, title: "Newer recorded work", at: "2026-10-05T00:00:00.000Z", merged: false });
  const facts = await (await fetch(`${origin}/api/public/front-door`)).json();
  assert.equal(facts.counters.receiptsIssued, 2);
  assert.equal(facts.counters.resultsVerified, 1, "only the receipt with a server-verified merge counts");
  assert.equal(facts.latestReceipt.title, "Newer recorded work");
  assert.equal(facts.latestReceipt.mergedAt, null);
  assert.deepEqual(facts.latestReceipt.agents, ["agent-a"]);
});
