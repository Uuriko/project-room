import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EVENT_TYPES as T } from "../src/events.js";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

// Account deletion in an already-archived room (bug sweep findings-02 F1,
// verified end-to-end). The redaction rewrites the stored log and — through
// commitMessageRedaction's archived branch — nulls the room's messages
// rows (record_json NULL: the erasure). The deletion then rebuilds the
// projection from the redacted log, so projection and log agree — but
// nothing rewrote the rows, so messages parity compared a NULL record
// against the redacted truth and mismatched the room forever: the room
// could never be certified (and therefore never archived), and the failure
// surfaced as a standing corruption record for data that was in fact
// consistent. The rebuild now re-derives the room's rows from the rebuilt
// projection, so the table certifies exactly the redacted truth. The
// erasure itself is unchanged: bodies stay NULL everywhere.

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const postJson = (origin, path, data, cookie = null) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(data)
});

async function deletionAccount(origin, f) {
  const email = "delete-parity@example.invalid";
  const slot = f.store.createAccountSessionSlot();
  const res = await postJson(origin, "/api/auth/password/signup", {
    email, password: "fixture-password-1-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision
  });
  assert.equal(res.status, 202, await res.clone().text());
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  assert.ok(token, "signup sets a fresh account_session cookie");
  const session = f.store.authenticateAccountSession(token);
  f.store.accountLogins.markEmailVerified(session.account.id, email);
  return { token, binding: session.sessionBinding, creds: { cookie: `account_session=${token}`, csrf: session.csrf } };
}

function parityAtSeq(store, roomId) {
  return store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId)?.parity_at_seq ?? null;
}

function certify(store, roomId) {
  for (let i = 0; i < 40 && parityAtSeq(store, roomId) === null; i++) store.checkMessagesParity();
  assert.ok(parityAtSeq(store, roomId) !== null, `parity certifies ${roomId}`);
}

test("account deletion in an already-archived room leaves rows parity can certify", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ctx = await deletionAccount(origin, f);
  const roomId = "solo-parity";
  f.store.createAccountRoom(ctx.token, ctx.binding, {
    roomId, title: "Solo parity", purpose: "Deletion parity coverage", kind: "personal", displayName: "Owner"
  });
  const key = f.store.issueAccessKey(roomId, "owner");
  const send = (type, data) => f.store.command(key, roomId, { id: randomUUID(), type, data });
  send(T.MESSAGE_POSTED, { messageId: "note-1", body: "first secret" });
  send(T.MESSAGE_POSTED, { messageId: "note-2", body: "second secret" });

  // The production steady state the defect needs: backfill caught up and
  // parity certified at the room head.
  assert.equal(f.store.backfillMessages({ limit: 1000 }).done, true);
  certify(f.store, roomId);

  // The owner archives the room, and the machinery catches up again.
  send(T.ROOM_ARCHIVED, {});
  assert.equal(f.store.backfillMessages({ limit: 1000 }).done, true);
  certify(f.store, roomId);

  // Delete the account through the real confirm-then-delete routes.
  const planned = await (await fetch(`${origin}/api/account/deletion/plan`, { headers: { Cookie: ctx.creds.cookie } })).json();
  const res = await fetch(`${origin}/api/account/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: ctx.creds.cookie, "X-CSRF-Token": ctx.creds.csrf },
    body: JSON.stringify({ confirmationToken: planned.confirmationToken })
  });
  assert.equal(res.status, 200, await res.clone().text());

  // The erasure held: no stored body survives anywhere in the rows.
  const rows = f.store.db.prepare("SELECT message_id, body, record_json FROM messages WHERE room_id=? ORDER BY message_id").all(roomId);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.body, null, `${row.message_id}: body is erased`);
    assert.ok(typeof row.record_json === "string", `${row.message_id}: the record was rewritten, not left NULL`);
    const record = JSON.parse(row.record_json);
    assert.equal(record.body, null, `${row.message_id}: the rewritten record is the redacted truth`);
    assert.equal(record.redacted, true);
  }

  // Parity certifies the room again instead of mismatching it forever...
  certify(f.store, roomId);

  // ...and because the rows are consistent (not merely tolerated), the
  // deferred batch records no standing parity failure for the room.
  for (let i = 0; i < 12; i++) await f.store.runDeferredIntegrityBatch({});
  const parityRecords = f.store.integrityFailures()
    .filter(failure => failure.step === "messages_parity" && failure.recordId === roomId);
  assert.deepEqual(parityRecords, [], "no standing parity failure: the deletion left consistent rows");
});
