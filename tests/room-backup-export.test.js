import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonStream, exportNdjsonText, operatorExportResponse, replayNdjson } from "../server/room-export.mjs";
import { KV_RETENTION_SECONDS, writeDailyBackup } from "../cloudflare/room-backup.mjs";
import { fetchKvBackup, restoreDrill, summarizeEvents } from "../scripts/restore-room-backup.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const sha = value => createHash("sha256").update(value).digest("hex");
const VERIFIER = "pkce-verifier-do-not-export";
const SLOT = "slot-token-do-not-export";
const HOOK = "hook-secret-do-not-export";
const SEED = "ed25519-private-seed-value";
const PUBLIC_KEY = "ed25519-public-key-material";
const CIPHER = "ciphertext-of-refresh-token";
const PUSH_AUTH = "push-auth-secret-value";
const P256 = "p256dh-key-material-value";
const PRI = "pri_abcdefghijklmnop";
const RAK = "rak_abcdefghij12";
const KEPT_HASH = "cd".repeat(32);
const OPERATOR = "operator-token-value";
const replayScript = fileURLToPath(new URL("../scripts/replay-room-export.mjs", import.meta.url));

function r2(methods) {
  return new Proxy({}, {
    get(_target, prop) {
      if (Object.hasOwn(methods, prop)) return methods[prop];
      throw new Error(`unexpected R2 method ${String(prop)}`);
    }
  });
}

function openFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-backup-export-"));
  const store = new RoomStore(join(directory, "live.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { body: "Export me plainly" } });
  const account = store.db.prepare("SELECT id FROM accounts").get();
  store.transaction(() => {
    store.db.prepare("UPDATE accounts SET auth_epoch=17, display_name=?, avatar_url=? WHERE id=?").run(PRI, RAK, account.id);
    store.db.prepare(`INSERT INTO oauth_pending_states
      (state_hash, provider, slot_token, expected_revision, verifier, expires_at, link, used, created_at)
      VALUES (?, 'google', ?, 0, ?, 9999999999999, 0, 0, 1)`).run("ab".repeat(32), SLOT, VERIFIER);
    store.db.prepare(`INSERT INTO agent_webhook_subs
      (subscription_id, agent_id, url, events_json, secret, enabled, created_at)
      VALUES ('sub-export', 'agent-export', 'https://example.com/hook', '[]', ?, 1, 1)`).run(HOOK);
    store.db.prepare("INSERT INTO referral_invite_keys (room_id, public_key, private_seed, created_at) VALUES ('commons', ?, ?, 1)").run(PUBLIC_KEY, SEED);
    store.db.prepare("INSERT INTO gmail_mailboxes (account_id, auth_epoch, encrypted) VALUES (?, 1, ?)").run(account.id, CIPHER);
    store.db.prepare(`INSERT INTO human_push_subscriptions
      (endpoint, room_id, member_id, p256dh, auth, expiration_time, created_at)
      VALUES ('https://push.example/a', 'commons', 'owner', ?, ?, NULL, 1)`).run(P256, PUSH_AUTH);
    store.db.prepare("INSERT INTO account_credentials (hash, account_id, account_auth_epoch, expires_at, created_at) VALUES (?, ?, 1, 9999999999999, 1)")
      .run(KEPT_HASH, account.id);
  });
  return { directory, store, key };
}

test("an export hashes secrets and replays the room into a fresh store", t => {
  const { directory, store, key } = openFixture(t);
  const ndjson = exportNdjsonText(store.db);
  const fixture = join(directory, "export.ndjson");
  writeFileSync(fixture, ndjson, { mode: 0o600 });
  for (const secret of [VERIFIER, SLOT, HOOK, SEED, CIPHER, PUSH_AUTH, P256, PRI, RAK, key]) {
    assert.equal(ndjson.includes(secret), false, secret);
  }
  for (const secret of [VERIFIER, SLOT, HOOK, SEED, CIPHER, PUSH_AUTH, P256, PRI, RAK]) assert.equal(ndjson.includes(sha(secret)), true, secret);
  assert.equal(ndjson.includes(PUBLIC_KEY), true);
  assert.equal(ndjson.includes(KEPT_HASH), true);
  assert.equal(ndjson.includes("Export me plainly"), true);
  assert.match(ndjson, /"auth_epoch":17\b/);
  const restoredPath = join(directory, "restored", "room.sqlite");
  const cli = execFileSync(process.execPath, [replayScript, "--from", fixture, "--to", restoredPath], { encoding: "utf8" });
  const receipt = JSON.parse(cli);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.events, store.db.prepare("SELECT count(*) AS n FROM events").get().n);
  assert.equal(statSync(restoredPath).mode & 0o777, 0o600);
  const restored = new RoomStore(restoredPath, { readOnly: true });
  try {
    assert.deepEqual(restored.room("commons"), store.room("commons"));
    assert.equal(restored.db.prepare("SELECT public_key FROM referral_invite_keys").get().public_key, PUBLIC_KEY);
    assert.equal(restored.db.prepare("SELECT private_seed FROM referral_invite_keys").get().private_seed, sha(SEED));
    assert.equal(restored.db.prepare("SELECT auth_epoch FROM accounts").get().auth_epoch, 17);
  } finally { restored.close(); }
  const again = join(directory, "again.sqlite");
  writeFileSync(join(directory, "broken.ndjson"), `{"kind":"watermark"}\n${VERIFIER}\n`, { mode: 0o600 });
  assert.throws(() => execFileSync(process.execPath, [replayScript, "--from", join(directory, "broken.ndjson"), "--to", again], { encoding: "utf8" }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /Replay failed verification/);
    assert.equal(error.stderr.includes(VERIFIER), false);
    assert.equal(error.stdout ?? "", "");
    return true;
  });
  assert.throws(() => replayNdjson(ndjson, restoredPath), /existing store/);
});

test("the operator export route stays closed until the backup token is set", async t => {
  const { store } = openFixture(t);
  const url = "https://room.example/api/operator/export";
  const closed = operatorExportResponse(new Request(url), "too-short", store.db);
  assert.equal(closed.status, 404);
  assert.equal(await closed.text(), "Not found\n");
  const missing = operatorExportResponse(new Request(url), null, store.db);
  assert.equal(missing.status, 404);
  const wrong = operatorExportResponse(new Request(url, { headers: { authorization: "Bearer not-the-token" } }), OPERATOR, store.db);
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.text()).includes(VERIFIER), false);
  const post = operatorExportResponse(new Request(url, { method: "POST", headers: { authorization: `Bearer ${OPERATOR}` } }), OPERATOR, store.db);
  assert.equal(post.status, 405);
  const head = operatorExportResponse(new Request(url, { method: "HEAD", headers: { authorization: `Bearer ${OPERATOR}` } }), OPERATOR, store.db);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const down = operatorExportResponse(new Request(url, { headers: { authorization: `Bearer ${OPERATOR}` } }), OPERATOR, null);
  assert.equal(down.status, 503);
  const ok = operatorExportResponse(new Request(url, { headers: { authorization: `Bearer ${OPERATOR}` } }), OPERATOR, store.db);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /application\/x-ndjson/);
  const body = await ok.text();
  assert.equal(body.includes(VERIFIER), false);
  assert.equal(body.includes(sha(VERIFIER)), true);
  assert.equal(operatorExportResponse(new Request("https://room.example/api/health"), OPERATOR, store.db), null);
});

test("the daily backup writes one object when R2 is bound and skips otherwise", async t => {
  const { store } = openFixture(t);
  const room = { exportRoomNdjson: () => exportNdjsonStream(store.db) };
  const when = new Date(Date.UTC(2026, 9, 2));
  assert.deepEqual(await writeDailyBackup({}, room, when), { skipped: "unconfigured" });
  await assert.rejects(() => writeDailyBackup({ ROOM_BACKUPS: {} }, room, when), /put or head/);
  await assert.rejects(() => writeDailyBackup({ ROOM_BACKUPS_KV: {} }, room, when), /put or get/);
  let puts = 0;
  const existing = r2({
    head: async () => ({ key: "room-backups/2026-10-02.ndjson" }),
    put: async () => { puts += 1; }
  });
  assert.deepEqual(await writeDailyBackup({ ROOM_BACKUPS: existing }, room, when), { skipped: "exists", key: "room-backups/2026-10-02.ndjson" });
  assert.equal(puts, 0);
  const seen = [];
  const bucket = r2({
    head: async () => null,
    put: async (key, body, options) => { seen.push({ key, text: await new Response(body).text(), type: options.httpMetadata.contentType }); }
  });
  assert.deepEqual(await writeDailyBackup({ ROOM_BACKUPS: bucket }, room, when), { wrote: "room-backups/2026-10-02.ndjson" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, "room-backups/2026-10-02.ndjson");
  assert.equal(seen[0].type, "application/x-ndjson");
  assert.equal(seen[0].text.includes(HOOK), false);
  assert.equal(seen[0].text.includes(sha(HOOK)), true);
});

test("without R2 the daily backup writes KV parts and a manifest that the restore drill replays into a new room", async t => {
  const { store } = openFixture(t);
  for (let i = 0; i < 5; i += 1) {
    const key = store.issueAccessKey("commons", "owner");
    store.command(key, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { body: `kv backup message ${i} ${"x".repeat(3000)}` } });
  }
  const room = { exportRoomNdjson: () => exportNdjsonStream(store.db) };
  const when = new Date(Date.UTC(2026, 9, 8));
  const values = new Map();
  const kv = r2({
    get: async key => values.has(key) ? new TextDecoder().decode(values.get(key).value) : null,
    put: async (key, value, options) => { values.set(key, { value: typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value), options }); }
  });
  const result = await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, room, when, { partBytes: 4096 });
  assert.equal(result.wrote, "room-backups/2026-10-08/manifest");
  assert.ok(result.parts > 1, "small part size splits the export");
  assert.equal(values.get("room-backups/2026-10-08/manifest").options.expirationTtl, KV_RETENTION_SECONDS);
  assert.deepEqual(await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, room, when), { skipped: "exists", key: "room-backups/2026-10-08/manifest" });
  for (const { value } of values.values()) assert.equal(new TextDecoder().decode(value).includes(HOOK), false);

  const get = key => Buffer.from(values.get(key).value);
  const { manifest, ndjson } = fetchKvBackup("2026-10-08", get);
  assert.equal(manifest.events, store.db.prepare("SELECT count(*) AS n FROM events").get().n);
  const directory = mkdtempSync(join(tmpdir(), "room-restore-drill-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const drill = restoreDrill(ndjson, directory);
  assert.equal(drill.match, true);
  assert.equal(drill.restored.events, manifest.events);
  assert.ok(drill.restored.messages >= 6);
  assert.equal(drill.restored.digest, summarizeEvents(store.db.prepare("SELECT room_id, sequence, id, body FROM events").all()).digest, "restored rows equal the live rows");
  assert.throws(() => restoreDrill(ndjson, directory), /existing store/, "never overwrites a room");

  const part = manifest.parts[1].key;
  const flipped = new Uint8Array(values.get(part).value); flipped[10] ^= 1;
  assert.throws(() => fetchKvBackup("2026-10-08", key => key === part ? Buffer.from(flipped) : get(key)), /does not match its manifest/);
});
