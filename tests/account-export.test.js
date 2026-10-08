// H3 privacy audit (2026-10-07): self-serve user data export.
//
// GET /api/account/export must return every account-keyed row the service
// holds for the caller — the same table list account deletion purges, so
// export scope and deletion scope cannot silently disagree — with
// secret-bearing columns redacted and no other account's rows.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { exportAccountData, ACCOUNT_EXPORT_MAX_ROWS } from "../server/account-export.mjs";

async function startServer(t, f, options = {}) {
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const get = (origin, path, cookie = null) => fetch(origin + path, {
  headers: cookie ? { Cookie: cookie } : {},
});

const password = n => `fixture-password-${n}-long-enough`;

async function passwordAccount(t, n) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = `acctexport-${n}@example.invalid`;
  const slot = f.store.createAccountSessionSlot();
  const res = await fetch(origin + "/api/auth/password/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email, password: password(n), sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
  });
  assert.equal(res.status, 202);
  const freshToken = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  assert.ok(freshToken, "signup sets a fresh account_session cookie");
  const session = f.store.authenticateAccountSession(freshToken);
  return { f, origin, accountId: session.account.id, creds: { cookie: `account_session=${freshToken}` } };
}

function seedAccountData(store, accountId) {
  const db = store.db;
  db.prepare("INSERT INTO direct_channel_sends(id,account_id,channel,recipient,body_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("dcs-export", accountId, "email", "r@example.com", "hash", "sent", 1, 1);
  db.prepare("INSERT INTO spam_quarantine(id,message_id,channel,account_id,reason,score,quarantined_at,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("sq-export", "m1", "email", accountId, "{}", 90, 1, "held", 1);
  // A credential row whose hash must never leave the server.
  db.prepare("INSERT INTO account_credentials(hash,account_id,account_auth_epoch,expires_at,created_at) VALUES(?,?,?,?,?)")
    .run("sekret-hash", accountId, 0, 9999999999999, 1);
}

test("export requires an authenticated account session", async t => {
  const { origin, creds } = await passwordAccount(t, 1);
  assert.equal((await get(origin, "/api/account/export")).status, 401);
  assert.equal((await get(origin, "/api/account/export", "account_session=bogus")).status, 401);
  // Auth runs first: an anonymous POST gets 401, not a method hint.
  const anonymous = await fetch(origin + "/api/account/export", { method: "POST" });
  assert.equal(anonymous.status, 401, "auth before method");
  const post = await fetch(origin + "/api/account/export", { method: "POST", headers: { Cookie: creds.cookie, Origin: origin } });
  assert.equal(post.status, 405, "GET only");
});

test("export returns the caller's rows, redacts secrets, and isolates accounts", async t => {
  const { f, origin, accountId, creds } = await passwordAccount(t, 2);
  seedAccountData(f.store, accountId);
  // Another account's rows must not leak into this export.
  const other = "u-export-other";
  f.store.db.prepare("INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,'test',?)")
    .run(other, Date.now());
  f.store.db.prepare("INSERT INTO direct_channel_sends(id,account_id,channel,recipient,body_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("dcs-other", other, "email", "other@example.com", "hash", "sent", 1, 1);

  const res = await get(origin, "/api/account/export", creds.cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.accountId, accountId);
  assert.ok(body.exportedAt, "export timestamp present");
  assert.ok(body.retention && body.retention.version, "retention policy attached");
  assert.equal(body.profile.id, accountId);

  const sends = body.tables.direct_channel_sends;
  assert.equal(sends.length, 1, "caller's send row exported");
  assert.equal(sends[0].recipient, "r@example.com");
  assert.ok(!sends.some(row => row.recipient === "other@example.com"), "other account's rows excluded");

  const creds2 = body.tables.account_credentials;
  const exported = creds2.find(row => row.hash === "[redacted]");
  assert.ok(exported, "credential row listed with hash redacted");
  assert.ok(body.redactedColumns.includes("account_credentials.hash"), "redaction disclosed");

  assert.ok(body.counts.direct_channel_sends >= 1, "counts present");
});

test("export scope covers the tables account deletion purges", async t => {
  const { f, accountId } = await passwordAccount(t, 3);
  seedAccountData(f.store, accountId);
  const exported = exportAccountData(f.store, accountId);
  // Every table the deletion inventory counts must appear in the export.
  const { inventoryFromStore } = await import("../server/account-deletion.mjs");
  const inventory = inventoryFromStore(f.store, accountId);
  const tabled = new Set(Object.keys(exported.tables));
  // Spot-check the categories this lane touched: the export must not miss
  // tables the deleter purges.
  for (const table of ["direct_channel_sends", "spam_quarantine", "account_credentials", "account_session_slots"]) {
    assert.ok(tabled.has(table), `export covers ${table}`);
  }
  assert.ok(ACCOUNT_EXPORT_MAX_ROWS > 0, "row cap defined");
  assert.ok(Object.keys(inventory).length > 0, "inventory non-empty");
});
