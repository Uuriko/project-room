// Task 46: webhook replay/dedupe hardening.
// Telegram redelivers webhook updates on provider retries, network hiccups, and
// out-of-order batches; every redelivery must be a no-op for update ids already
// journaled. The journal dedupes via ON CONFLICT DO NOTHING on
// (account_id, connection_id, update_id), and these tests verify the full
// ChannelWebhookInbox.receive path holds that invariant under duplicate,
// out-of-order, replayed, and interleaved ("concurrent") deliveries.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { ChannelWebhookInbox } from "../server/channel-import.mjs";

const SECRET = "fixture-webhook-secret-0123456789";

function fixture(t) {
  const f = createAcceptanceFixture();
  f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const telegram = telegramContractFixture();
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const login = f.store.loginAccountSession(slot.token, key, 0);
  telegram.connection.accountId = account.id;
  const apply = request => f.store.connections.apply(slot.token, request, login.sessionBinding);
  apply({ action: "connection.configure", requestId: randomUUID(), connectionId: telegram.connection.id, expectedRevision: 0, profile: structuredClone(telegram.connection) });
  apply({ action: "connection.webhook", requestId: randomUUID(), connectionId: telegram.connection.id, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(SECRET) });
  return { store: f.store, accountId: account.id, connectionId: telegram.connection.id, chat: telegram.chat };
}

const makeUpdate = (i, chat) => ({
  update_id: 1000 + i,
  message: { message_id: 100 + i, date: 1788948000 + i, chat,
    from: { id: 5000000001, is_bot: false, first_name: "Avery" }, text: "Property update " + i },
});

// Deterministic PRNG so the property run is reproducible; the seed varies per round.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(rand, array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}

test("replayed webhook deliveries never double-journal: property over random replay schedules", t => {
  for (let round = 0; round < 20; round++) {
    const rand = mulberry32(0xD3D946 + round * 7919);
    const f = fixture(t);
    const N = 3 + Math.floor(rand() * 40);
    const updates = Array.from({ length: N }, (_, i) => makeUpdate(i, f.chat));
    const byId = new Map(updates.map(u => [u.update_id, u]));
    const ids = updates.map(u => u.update_id);

    // Fresh deliveries: partition a shuffled id order into batches. Single-id
    // batches sometimes use the bare-update body shape (Telegram posts one
    // update per request; a replayed batch uses { updates: [...] }).
    const deliveries = [];
    let i = 0;
    const order = shuffled(rand, ids);
    while (i < order.length) {
      const size = 1 + Math.floor(rand() * 5);
      const batch = order.slice(i, i + size); i += size;
      deliveries.push({ batch, single: batch.length === 1 && rand() < 0.5 });
    }
    // Replays: verbatim redeliveries of earlier batches, single-update retries
    // (in either body shape), and overlapping batches mixing seen and unseen ids.
    const replays = [];
    const replayCount = Math.floor(rand() * deliveries.length * 2);
    for (let r = 0; r < replayCount; r++) {
      const source = deliveries[Math.floor(rand() * deliveries.length)];
      const style = rand();
      if (style < 0.4) replays.push({ batch: [...source.batch], single: source.single }); // verbatim redelivery
      else if (style < 0.7) { // single-update retry
        const id = source.batch[Math.floor(rand() * source.batch.length)];
        replays.push({ batch: [id], single: rand() < 0.5 });
      } else { // overlapping batch: mostly seen ids plus one possibly-unseen id
        const extra = ids[Math.floor(rand() * ids.length)];
        replays.push({ batch: shuffled(rand, [...source.batch, extra]) });
      }
    }
    // Interleave fresh deliveries and replays in a random schedule delivered
    // through two alternating inboxes: the delivery streams a retrying provider
    // (or two racing webhook endpoints) would produce.
    const schedule = shuffled(rand, [...deliveries, ...replays]);
    const inboxA = new ChannelWebhookInbox(f.store), inboxB = new ChannelWebhookInbox(f.store);
    const seen = new Set();
    let acceptedTotal = 0, step = 0;
    for (const entry of schedule) {
      step++;
      const clone = id => structuredClone(byId.get(id));
      const body = entry.batch.length === 1 && entry.single ? clone(entry.batch[0]) : { updates: entry.batch.map(clone) };
      const inbox = step % 2 ? inboxA : inboxB;
      const result = inbox.receive({ connectionId: f.connectionId, secret: SECRET, body });
      const fresh = [...new Set(entry.batch)].filter(id => !seen.has(id));
      assert.equal(result.received, entry.batch.length, `round ${round} step ${step}: received counts the delivery`);
      assert.equal(result.accepted, fresh.length, `round ${round} step ${step}: accepted counts only first-seen ids (in-batch duplicates journal once)`);
      acceptedTotal += result.accepted;
      for (const id of entry.batch) seen.add(id);
      assert.equal(inbox.pending(f.accountId, f.connectionId).length, seen.size,
        `round ${round} step ${step}: journal holds each seen id exactly once`);
    }
    // End state: exactly the N distinct ids, each journaled exactly once.
    const rows = f.store.db.prepare("SELECT update_id, count(*) n FROM pending_channel_updates WHERE account_id=? AND connection_id=? GROUP BY update_id")
      .all(f.accountId, f.connectionId);
    assert.equal(rows.length, N, `round ${round}: every delivered update is journaled`);
    for (const row of rows) assert.equal(row.n, 1, `round ${round}: update ${row.update_id} journals exactly once`);
    assert.deepEqual(rows.map(r => r.update_id).sort((a, b) => a - b), [...ids].sort((a, b) => a - b),
      `round ${round}: journaled ids match delivered ids exactly`);
    assert.equal(acceptedTotal, N, `round ${round}: accepted total equals the distinct-id count`);
    assert.deepEqual(inboxA.journal(f.accountId, f.connectionId), { pending: N, imported: 0, failed: 0 },
      `round ${round}: journal summary agrees`);
    f.store.channelUpdates.verify();
  }
});

test("a duplicate racing the original journals once: two interleaved delivery streams", t => {
  const f = fixture(t);
  const updates = Array.from({ length: 12 }, (_, i) => makeUpdate(i, f.chat));
  const inboxA = new ChannelWebhookInbox(f.store), inboxB = new ChannelWebhookInbox(f.store);
  const single = i => structuredClone(updates[i]);
  const batch = () => ({ updates: structuredClone(updates) });
  for (let race = 0; race < 5; race++) {
    // Both inboxes deliver overlapping content in the same "instant"; only the
    // first race can journal anything new.
    const first = race % 2
      ? [inboxA.receive({ connectionId: f.connectionId, secret: SECRET, body: batch() }), inboxB.receive({ connectionId: f.connectionId, secret: SECRET, body: single(race) })]
      : [inboxA.receive({ connectionId: f.connectionId, secret: SECRET, body: single(race) }), inboxB.receive({ connectionId: f.connectionId, secret: SECRET, body: batch() })];
    const newlyAccepted = first[0].accepted + first[1].accepted;
    assert.equal(newlyAccepted, race === 0 ? 12 : 0, `race ${race}: exactly one side journals new ids on first contact, replays journal none`);
    assert.equal(first[0].received + first[1].received, 12 + 1, `race ${race}: received still counts each delivery`);
  }
  assert.equal(inboxA.pending(f.accountId, f.connectionId).length, 12, "12 distinct updates, one row each");
  assert.deepEqual(inboxB.journal(f.accountId, f.connectionId), { pending: 12, imported: 0, failed: 0 });
  f.store.channelUpdates.verify();
});

test("out-of-order single deliveries journal once and stay retrievable oldest-first", t => {
  const f = fixture(t);
  const updates = Array.from({ length: 8 }, (_, i) => makeUpdate(i, f.chat));
  const inbox = new ChannelWebhookInbox(f.store);
  // Deliver descending, twice: the second pass is the provider retrying everything.
  for (const pass of [0, 1]) {
    for (let i = updates.length - 1; i >= 0; i--) {
      const result = inbox.receive({ connectionId: f.connectionId, secret: SECRET, body: structuredClone(updates[i]) });
      assert.equal(result.accepted, pass === 0 ? 1 : 0, `pass ${pass}, update ${i}: retry is a no-op`);
      assert.equal(result.pending, pass === 0 ? updates.length - i : updates.length,
        `pass ${pass}, update ${i}: pending counts each update once`);
    }
  }
  assert.deepEqual(inbox.pending(f.accountId, f.connectionId).map(u => u.update_id),
    updates.map(u => u.update_id), "pending backlog stays ordered by update id");
});
