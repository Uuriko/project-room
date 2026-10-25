import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EVENT_TYPES as T } from "../src/events.js";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { executeAccountDeletion, planAccountDeletion } from "../server/account-deletion.mjs";

// Research r42: deleting an account archives each solely owned personal room
// and redacts every message in it. Each per-message redaction re-read and
// re-parsed the room's entire event log and rewrote the whole projection, so
// the pass was O(messages x events): locally a 1,600-message room took 14.9 s
// and a 3,200-message room 58.5 s (15.4M event rows read), past the Worker's
// 30 s CPU limit (cloudflare/wrangler.jsonc, production). The pass now reads
// the log once and writes the projection once.

const FULL_LOG = /^SELECT sequence, body FROM events WHERE room_id=\?( ORDER BY sequence)?$/;

async function setup(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const slot = f.store.createAccountSessionSlot();
  const res = await fetch(origin + "/api/auth/password/signup", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email: "delete-many@example.invalid", password: "fixture-password-1-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision })
  });
  assert.equal(res.status, 202, await res.clone().text());
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  const session = f.store.authenticateAccountSession(token);
  return { f, token, session };
}

function seedPersonalRoom({ f, token, session }, roomId, count) {
  f.store.createAccountRoom(token, session.sessionBinding, { roomId, title: "Solo", purpose: "Deletion scale", kind: "personal", displayName: "Owner" });
  const key = f.store.issueAccessKey(roomId, "owner");
  // The chat flood guard (30 burst, 1 per 2 s) is not what this test is about.
  f.store.roomFlood = { consume() { return false; }, refund() {} };
  for (let i = 0; i < count; i++) {
    f.store.command(key, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `m${i}`, body: `secret ${i}` } });
  }
}

function countFullLogReads(db) {
  const prepare = db.prepare.bind(db);
  const counter = { reads: 0, rows: 0 };
  db.prepare = sql => {
    const statement = prepare(sql);
    if (FULL_LOG.test(String(sql).trim())) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => { const rows = all(...args); counter.reads += 1; counter.rows += rows.length; return rows; };
    }
    return statement;
  };
  return { counter, restore: () => { db.prepare = prepare; } };
}

test("account deletion reads a solely owned room's log a fixed number of times, not once per message", async t => {
  const ctx = await setup(t);
  const roomId = "solo-many";
  const count = 60;
  seedPersonalRoom(ctx, roomId, count);
  const { plan } = planAccountDeletion(ctx.f.store, ctx.session.account.id);
  assert.ok(plan.rooms.archive.some(room => room.id === roomId || room.roomId === roomId), "the personal room is planned for archive");
  const { counter, restore } = countFullLogReads(ctx.f.store.db);
  try { executeAccountDeletion(ctx.f.store, plan); } finally { restore(); }
  // One read for the redaction pass, one for the remaining-bodies sweep.
  // Before the fix: count + 1 reads (61 here), growing with the room.
  assert.ok(counter.reads <= 3, `full event-log reads during deletion: ${counter.reads} (rows ${counter.rows})`);
  const events = ctx.f.store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id=?").get(roomId).n;
  assert.ok(counter.rows <= 3 * events, `event rows read ${counter.rows} for a ${events}-event log`);
});

test("the single-pass redaction still erases every body in the log, the rows and the projection", async t => {
  const ctx = await setup(t);
  const roomId = "solo-erasure";
  seedPersonalRoom(ctx, roomId, 25);
  const { plan } = planAccountDeletion(ctx.f.store, ctx.session.account.id);
  executeAccountDeletion(ctx.f.store, plan);
  const db = ctx.f.store.db;
  for (const row of db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence").all(roomId)) {
    assert.doesNotMatch(row.body, /secret \d+/, "no message text survives in the stored log");
  }
  const redacted = db.prepare("SELECT count(*) AS n FROM events WHERE room_id=? AND json_extract(body,'$.type')=?").get(roomId, T.MESSAGE_REDACTED).n;
  assert.equal(redacted, 25, "one message.redacted per message");
  for (const row of db.prepare("SELECT message_id, body FROM messages WHERE room_id=?").all(roomId)) assert.equal(row.body, null, `${row.message_id} body erased`);
  const head = db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
  const max = db.prepare("SELECT MAX(sequence) AS n FROM events WHERE room_id=?").get(roomId).n;
  assert.equal(head, max, "the room head matches the log");
  const state = ctx.f.store.room(roomId).state;
  assert.ok((state.messages ?? []).every(message => message.body == null), "the projection holds no body");
  assert.equal(JSON.stringify(ctx.f.store.rebuildProjection(roomId).state.messages), JSON.stringify(state.messages), "projection equals a replay of the redacted log");
});
