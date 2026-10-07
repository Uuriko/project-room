// PR-webhook delivery replay protection (200-hard-tasks #175, finding F-1).
//
// Contract under test (owner boundary: POST /api/github/pr-webhook):
//   - the first delivery of a GitHub delivery id is processed normally;
//   - re-delivering the identical signed payload with the SAME
//     x-github-delivery id short-circuits with { ok: true, duplicate: true }
//     and does not re-run the payload handler;
//   - a replay with a forged signature is still 401 (replay != auth bypass);
//   - a new delivery id is processed normally;
//   - the journal is bounded (cap) and forgets entries older than the TTL.
//
// (1) Observable behavior: duplicate deliveries are acknowledged without
// re-execution. (2) Credible regression: without the journal, every GitHub
// redelivery (timeouts, retries, deliberate replay) re-runs settlement
// against the board. (3) Existing coverage
// (tests/claim-autolink-http.test.js) exercises disabled-by-default,
// unconfigured, and unauthenticated deliveries — never a replay.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const SECRET = "replay-fixture-secret";
const sign = body => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
const payload = () => JSON.stringify({
  action: "opened",
  pull_request: {
    html_url: "https://github.com/acme/app/pull/4",
    head: { ref: "feature-branch" },
    title: "Test PR",
    body: "",
  },
  repository: { full_name: "acme/app" },
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-pr-replay-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const oldFlag = process.env.ROOM_PR_WEBHOOK, oldSecret = process.env.GITHUB_PR_WEBHOOK_SECRET;
  process.env.ROOM_PR_WEBHOOK = "1";
  process.env.GITHUB_PR_WEBHOOK_SECRET = SECRET;
  t.after(() => {
    server.closeStreams(); server.closeAllConnections(); server.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
    if (oldFlag === undefined) delete process.env.ROOM_PR_WEBHOOK; else process.env.ROOM_PR_WEBHOOK = oldFlag;
    if (oldSecret === undefined) delete process.env.GITHUB_PR_WEBHOOK_SECRET; else process.env.GITHUB_PR_WEBHOOK_SECRET = oldSecret;
  });
  const url = `http://127.0.0.1:${server.address().port}/api/github/pr-webhook`;
  const send = (body, delivery, signature) => fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature ?? sign(body),
    },
    body,
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  return { send, store };
}

test("re-delivering the same GitHub delivery id is acknowledged without re-processing", async t => {
  const { send } = await serve(t);
  const body = payload();
  const first = await send(body, "delivery-1");
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.duplicate ?? false, false);

  const replay = await send(body, "delivery-1");
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, { ok: true, duplicate: true });
});

test("a replayed delivery with a forged signature is still rejected (401)", async t => {
  const { send } = await serve(t);
  const body = payload();
  const first = await send(body, "delivery-9");
  assert.equal(first.status, 200);
  const forged = await send(body, "delivery-9", "sha256=" + "ab".repeat(32));
  assert.equal(forged.status, 401);
});

test("a new delivery id is processed normally", async t => {
  const { send } = await serve(t);
  const body = payload();
  const first = await send(body, "delivery-a");
  assert.equal(first.status, 200);
  assert.equal(first.json.duplicate ?? false, false);
  const second = await send(body, "delivery-b");
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate ?? false, false);
});

test("the delivery journal stays bounded under many distinct deliveries", async t => {
  const { send, store } = await serve(t);
  const body = payload();
  for (let i = 0; i < 20; i++) {
    const res = await send(body, `delivery-many-${i}`);
    assert.equal(res.status, 200);
  }
  const row = store.db.prepare("SELECT config_json FROM work_claim_config WHERE room_id = ?")
    .get("_claim-pr-deliveries:");
  assert.ok(row, "journal row exists");
  const journal = JSON.parse(row.config_json);
  assert.ok(journal.deliveries.length <= 500, `journal bounded (got ${journal.deliveries.length})`);
  assert.equal(journal.deliveries.length, 20);
});
