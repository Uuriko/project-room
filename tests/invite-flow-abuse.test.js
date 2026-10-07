// Invite-flow abuse tests — hard task 92.
//
// Complements tests/share-link-join-concurrency.test.js (burn lane #1728,
// which proved the 50-concurrent join races): this file covers the abuse
// angles that one does not — mint-side spam idempotency, the HTTP join rate
// limit, same-session retry idempotency (duplicate:true), and the
// fresh-guest (non-membership-reuse) lost-cookie replay.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// A room with one owner and one live share link (25 join slots, the max).
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-invite-abuse-"));
  let now = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const linkToken = randomBytes(32).toString("base64url");
  store.shareLinks.create(ownerKey, "commons", {
    requestId: randomUUID(), linkToken, expiresAt: now + 3600000, maxJoins: 25, expectedMemberRevision: 0,
  }, null);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, linkToken, now: () => now };
}

function freshSlot(store) {
  const slot = store.createAccountSessionSlot();
  return { token: slot.token, binding: slot.session.sessionBinding, revision: slot.session.sessionRevision, csrf: slot.session.csrf };
}

// Run a batch of synchronous store calls "concurrently": each is wrapped in a
// promise so every call starts before any result is consumed, the way racing
// HTTP handlers interleave through the event loop.
async function race(calls) {
  return Promise.all(calls.map(fn => Promise.resolve().then(() => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      return { ok: false, status: error.status, code: error.code, message: String(error.message ?? error) };
    }
  })));
}

function joinCount(store) {
  return store.db.prepare("SELECT count(*) n FROM share_link_joins").get().n;
}

test("the same browser retrying one redemptionId 50 times: one guest, every retry duplicate:true", async t => {
  const { store, linkToken } = fixture(t);
  const redemptionId = randomUUID();
  const s = freshSlot(store);
  const args = () => {
    const slot = store.accountSessionSlot(s.token);
    return {
      displayName: "Alice", redemptionId,
      expectedSessionRevision: slot.sessionRevision, expectedSessionBinding: slot.sessionBinding,
    };
  };
  const first = store.shareLinks.join(s.token, linkToken, args());
  assert.equal(first.duplicate, false, "first join is fresh");
  const results = await race(Array.from({ length: 49 }, () => () => store.shareLinks.join(s.token, linkToken, args())));
  const wins = results.filter(r => r.ok);
  assert.equal(wins.length, 49, "every retry succeeds");
  for (const win of wins) {
    assert.equal(win.value.duplicate, true, "every retry is idempotent");
    assert.equal(win.value.session.member.id, first.session.member.id, "retries reuse the same seat");
  }
  assert.equal(joinCount(store), 1, "retries never write a second join row");
});

test("lost-cookie retry of a fresh guest join: 409 join_session_lost, no second guest", async t => {
  const { store, linkToken } = fixture(t);
  const redemptionId = randomUUID();
  const a = freshSlot(store);
  const first = store.shareLinks.join(a.token, linkToken, {
    displayName: "Alice", redemptionId,
    expectedSessionRevision: a.revision, expectedSessionBinding: a.binding,
  });
  assert.equal(first.duplicate, false);
  // The browser cookie is gone: a brand-new session retries the same
  // redemptionId. (The membership-reuse variant is covered in
  // share-link-join-concurrency.test.js; this is the fresh-guest path.)
  const b = freshSlot(store);
  let error = null;
  try {
    store.shareLinks.join(b.token, linkToken, {
      displayName: "Alice", redemptionId,
      expectedSessionRevision: b.revision, expectedSessionBinding: b.binding,
    });
  } catch (err) { error = err; }
  assert.ok(error, "the retry is rejected");
  assert.equal(error.code, "join_session_lost");
  assert.match(error.message, /No additional guest was created/);
  assert.equal(joinCount(store), 1, "no second guest was admitted");
});

test("50 concurrent link mints with one requestId: exactly one link (mint spam idempotent)", async t => {
  const { store, ownerKey, now } = fixture(t);
  const requestId = randomUUID();
  // Same requestId AND same link settings: a retried mint request. (A
  // retried request with different settings is an idempotency_conflict —
  // refused, not duplicated.)
  const linkToken = randomBytes(32).toString("base64url");
  const results = await race(Array.from({ length: 50 }, () => () =>
    store.shareLinks.create(ownerKey, "commons", {
      requestId, linkToken,
      expiresAt: now() + 3600000, maxJoins: 5, expectedMemberRevision: 0,
    }, null)));
  const failures = results.filter(r => !r.ok);
  assert.equal(failures.length, 0, `mint spam must not error: ${JSON.stringify(failures[0])}`);
  const fresh = results.filter(r => r.ok && r.value.duplicate === false);
  const dupes = results.filter(r => r.ok && r.value.duplicate === true);
  assert.equal(fresh.length, 1, "exactly one link is created");
  assert.equal(dupes.length, 49, "every other mint is answered as a duplicate");
  const links = store.db.prepare("SELECT count(*) n FROM share_links WHERE request_id=?").get(requestId).n;
  assert.equal(links, 1, "one link row in storage");
});

test("join spam from one IP is throttled at the HTTP door (20 joins/min)", async t => {
  const { store, linkToken } = fixture(t);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const statuses = [];
  for (let i = 0; i < 21; i++) {
    const s = freshSlot(store);
    const res = await fetch(`${origin}/api/share-links/join`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: `account_session=${s.token}`,
        "x-csrf-token": s.csrf,
        "x-session-binding": s.binding,
      },
      body: JSON.stringify({
        linkToken, displayName: `Spammer ${i}`, redemptionId: randomUUID(), expectedSessionRevision: 0,
      }),
    });
    statuses.push(res.status);
    await res.text();
  }
  assert.ok(statuses.slice(0, 20).every(s => s === 201), `first 20 rapid joins proceed: ${statuses.join(",")}`);
  assert.equal(statuses[20], 429, "the 21st rapid join from one IP is rate-limited");
});
