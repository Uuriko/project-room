import test from "node:test";
import { DatabaseSync as TrailerDb } from "node:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonLines, exportTrailer, exportNdjsonStream, exportNdjsonText, operatorExportResponse, replayNdjson, sanitizeCell, REPLAY_SKIPPED_TABLES } from "../server/room-export.mjs";
import { backupTarget, writeDailyBackup, writeKvBackup } from "../cloudflare/room-backup.mjs";
import { assembleKvBackup, summarizeRoom } from "../scripts/restore-room-backup.mjs";
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
const restoreScript = fileURLToPath(new URL("../scripts/restore-room-backup.mjs", import.meta.url));

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

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key).value : null; },
    async put(key, value, options) {
      const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      map.set(key, { value: bytes, options });
    }
  };
}

function openStore(t, messages = 5) {
  const directory = mkdtempSync(join(tmpdir(), "room-backup-kv-"));
  const store = new RoomStore(join(directory, "live.sqlite"));
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < messages; i += 1) {
    store.command(key, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `m-${i}`, body: `message ${i} ${"x".repeat(300)}` } });
  }
  return { directory, store };
}

test("the KV target is used only when R2 is absent", () => {
  assert.equal(backupTarget({}), null);
  assert.equal(backupTarget({ ROOM_BACKUPS_KV: fakeKv() }), "kv");
  assert.equal(backupTarget({ ROOM_BACKUPS_KV: fakeKv(), ROOM_BACKUPS: { put() {}, head() {} } }), "r2");
  assert.throws(() => backupTarget({ ROOM_BACKUPS_KV: {} }), /put or get/);
});

test("the daily KV backup writes parts then a manifest, once a day, with a TTL", async t => {
  const { store } = openStore(t);
  const kv = fakeKv();
  const room = { exportRoomNdjson: () => exportNdjsonStream(store.db) };
  const when = new Date(Date.UTC(2026, 9, 8, 9));
  const wrote = await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, room, when);
  assert.equal(wrote.wrote, "room-backups/2026-10-08.ndjson");
  assert.equal(wrote.target, "kv");
  const manifest = JSON.parse(kv.map.get("room-backups/2026-10-08.ndjson").value.toString());
  assert.equal(manifest.kind, "room-backup-manifest");
  assert.equal(manifest.parts.length, wrote.parts);
  for (const { options } of kv.map.values()) assert.equal(options.expirationTtl, 35 * 24 * 60 * 60);
  const again = await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, { exportRoomNdjson: () => { throw new Error("must not export twice"); } }, when);
  assert.deepEqual(again, { skipped: "exists", key: "room-backups/2026-10-08.ndjson", target: "kv" });
});

test("a KV backup split into many parts reassembles byte-equal, replays, and catches tampering", async t => {
  const { directory, store } = openStore(t, 12);
  const kv = fakeKv();
  const text = exportNdjsonText(store.db);
  const manifest = await writeKvBackup(kv, "room-backups/2026-10-08.ndjson", exportNdjsonStream(store.db), { partBytes: 1000 });
  assert.ok(manifest.parts.length > 3, "expected several parts");
  assert.ok(manifest.parts.every(part => part.bytes <= 1000));
  const get = key => kv.map.get(key).value;
  const { ndjson } = assembleKvBackup(get(manifest.key), get);
  assert.equal(ndjson.replace(/"backedUpAt":\d+/, ""), text.replace(/"backedUpAt":\d+/, ""));

  const file = join(directory, "backup.ndjson");
  writeFileSync(file, ndjson, { mode: 0o600 });
  const target = join(directory, "restore", "room.sqlite");
  const out = JSON.parse(execFileSync(process.execPath, [restoreScript, "--from", file, "--to", target, "--room", "commons"], { encoding: "utf8" }));
  assert.equal(out.verified, true);
  const live = summarizeRoom(join(directory, "live.sqlite"), "commons");
  assert.deepEqual(out.rooms[0], live);
  assert.equal(out.rooms[0].messages, 12);

  assert.throws(() => execFileSync(process.execPath, [restoreScript, "--from", file, "--to", target], { encoding: "utf8", stdio: "pipe" }), /existing file/);
  const tampered = Buffer.from(get(manifest.parts[1].key));
  tampered[0] ^= 1;
  assert.throws(() => assembleKvBackup(get(manifest.key), key => key === manifest.parts[1].key ? tampered : get(key)), /does not match its manifest/);
  assert.equal(existsSync(join(directory, "restore", "other.sqlite")), false);
});

test("Durable Object BLOB cells (ArrayBuffer) export as base64, not {}", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const expected = { $base64: Buffer.from(bytes).toString("base64") };
  assert.deepEqual(sanitizeCell("bytes", bytes.buffer.slice(0)), expected);
  assert.deepEqual(sanitizeCell("bytes", new DataView(bytes.buffer)), expected);
  const padded = new Uint8Array(260); padded.set(bytes, 2);
  assert.deepEqual(sanitizeCell("bytes", new Uint8Array(padded.buffer, 2, 256)), expected);
  assert.notEqual(JSON.stringify(sanitizeCell("bytes", bytes.buffer)), "{}");
});

test("a version 1 KV manifest for today is rewritten; a current one is kept", async t => {
  const { store } = openStore(t, 2);
  const kv = fakeKv();
  const room = { exportRoomNdjson: () => exportNdjsonStream(store.db) };
  const when = new Date(Date.UTC(2026, 9, 8, 9));
  await kv.put("room-backups/2026-10-08.ndjson", JSON.stringify({ kind: "room-backup-manifest", version: 1, parts: [] }), {});
  const wrote = await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, room, when);
  assert.equal(wrote.wrote, "room-backups/2026-10-08.ndjson");
  assert.equal(JSON.parse(kv.map.get("room-backups/2026-10-08.ndjson").value.toString()).version, 2);
  assert.equal((await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, room, when)).skipped, "exists");
});

test("replay skips Durable Object runtime and retired tables and reports them", t => {
  const { directory, store } = openStore(t, 3);
  const extra = [
    { table: "room_writer_permit", row: { singleton: 1, version: 41 } },
    { table: "room_runtime_version", row: { singleton: 1, version: 41 } },
    { table: "emissary_journal", row: { room_id: "commons", id: "j1" } },
    { table: "abuse_rate_buckets", row: { id: "login:x", family: "login", n: 3, until_ms: 1 } }
  ].map(line => JSON.stringify(line)).join("\n");
  assert.ok(REPLAY_SKIPPED_TABLES.includes("room_writer_permit"));
  assert.ok(REPLAY_SKIPPED_TABLES.includes("abuse_rate_buckets"));
  const ndjson = `${exportNdjsonText(store.db)}${extra}\n`;
  const result = replayNdjson(ndjson, join(directory, "skip", "room.sqlite"));
  assert.equal(result.verified, true);
  assert.deepEqual(result.skippedTables, { room_runtime_version: 1, room_writer_permit: 1, emissary_journal: 1, abuse_rate_buckets: 1 });
  const unknown = `${exportNdjsonText(store.db)}${JSON.stringify({ table: "not_a_table", row: { a: 1 } })}\n`;
  assert.throws(() => replayNdjson(unknown, join(directory, "unknown", "room.sqlite")), /does not have/);
});

test("audit report restores a store whose stored projection drifted from the reducer, strict refuses it", t => {
  const { directory, store } = openStore(t, 2);
  store.db.prepare("UPDATE rooms SET projection=json_set(projection, '$.drift', 1) WHERE id='commons'").run();
  const ndjson = exportNdjsonText(store.db);
  assert.throws(() => replayNdjson(ndjson, join(directory, "strict", "room.sqlite")), /reconciliation/);
  const report = replayNdjson(ndjson, join(directory, "report", "room.sqlite"), { audit: "report" });
  assert.equal(report.verified, true);
  assert.equal(report.audit.ok, false);
  assert.match(report.audit.error, /reconciliation/);
  assert.equal(replayNdjson(exportNdjsonText(openStore(t, 1).store.db), join(directory, "clean", "room.sqlite"), { audit: "report" }).audit.ok, true);
  assert.throws(() => replayNdjson(ndjson, join(directory, "bad", "room.sqlite"), { audit: "loose" }), /strict or report/);
});

// Drives the export generator line by line, exactly like the Durable Object's
// stream pulls, so a write can land between two tables' scans. `interleave`
// runs once the events table has been fully dumped but before the next table
// is scanned. Returns the reassembled NDJSON of the torn export.
async function tornExportNdjson(t, interleave) {
  const directory = mkdtempSync(join(tmpdir(), "room-backup-torn-"));
  const store = new RoomStore(join(directory, "live.sqlite"));
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  store.createAccount("joiner", "repro");
  const gen = exportNdjsonLines(store.db);
  const lines = [];
  const first = await gen.next();
  lines.push(first.value);
  const watermark = JSON.parse(first.value);
  let eventsSeen = 0;
  for (;;) {
    const { value, done } = await gen.next();
    if (done) break;
    lines.push(value);
    if (JSON.parse(value).table === "events" && ++eventsSeen === watermark.events) await interleave(store);
  }
  store.close();
  return { directory, ndjson: lines.join("") };
}

test("a backup torn by a mid-stream write fails replay loudly instead of verifying", async t => {
  const { directory, ndjson } = await tornExportNdjson(t, async store => {
    // A member joins after the events table was scanned: the join event is
    // missed by the dump, but the member_accounts row is captured. The
    // watermark's event count cannot see this tear.
    const seq = store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence + 1;
    store.db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES ('commons', ?, ?, ?)")
      .run(seq, crypto.randomUUID(), JSON.stringify({ id: crypto.randomUUID(), type: T.MESSAGE_POSTED, roomId: "commons", actorId: "owner", at: new Date().toISOString(), data: { messageId: "m-phantom", body: "phantom" } }));
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run(seq);
    store.db.prepare("INSERT INTO member_accounts (room_id, member_id, account_id, origin) VALUES ('commons', 'phantom', 'joiner', 'repro')").run();
  });
  assert.throws(() => replayNdjson(ndjson, join(directory, "restore", "room.sqlite")), /torn/);
});

test("a same-count tear (delete plus insert mid-stream) fails on the trailer hash", async t => {
  const { directory, ndjson } = await tornExportNdjson(t, async store => {
    // Net-zero on the event count: one childless bootstrap event is deleted
    // and a new one inserted. The counts match; the row sets do not.
    const victim = store.db.prepare("SELECT id FROM events WHERE room_id='commons' ORDER BY sequence LIMIT 1").get().id;
    store.db.prepare("DELETE FROM events WHERE id=?").run(victim);
    const seq = store.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS m FROM events WHERE room_id='commons'").get().m + 1;
    store.db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES ('commons', ?, ?, ?)")
      .run(seq, crypto.randomUUID(), JSON.stringify({ id: crypto.randomUUID(), type: T.MESSAGE_POSTED, roomId: "commons", actorId: "owner", at: new Date().toISOString(), data: { messageId: "m-swap", body: "swapped" } }));
  });
  assert.throws(() => replayNdjson(ndjson, join(directory, "restore", "room.sqlite")), /torn/);
});

test("writeKvBackup refuses a manifest for a torn export", async t => {
  const { store } = openStore(t, 3);
  const text = exportNdjsonText(store.db);
  const torn = text.replace(/\{"kind":"trailer"[^\n]*\}/, trailer => {
    const record = JSON.parse(trailer);
    return JSON.stringify({ ...record, events: record.events + 1 });
  });
  assert.notEqual(torn, text, "the fixture tear must change the export");
  const kv = fakeKv();
  await assert.rejects(() => writeKvBackup(kv, "room-backups/2026-10-08.ndjson", torn), /torn/);
  assert.equal(kv.map.has("room-backups/2026-10-08.ndjson"), false, "no manifest is written for a torn export");
});

test("an untorn export carries a verified trailer; older trailer-less exports still replay", async t => {
  const { directory, store } = openStore(t, 3);
  const text = exportNdjsonText(store.db);
  const good = replayNdjson(text, join(directory, "restore-new", "room.sqlite"));
  assert.equal(good.verified, true);
  assert.equal(good.trailer, "verified");
  const old = text.split("\n").filter(line => !line.includes('"kind":"trailer"')).join("\n");
  const legacy = replayNdjson(old, join(directory, "restore-old", "room.sqlite"));
  assert.equal(legacy.verified, true);
  assert.equal(legacy.trailer, "absent");
});

test("Durable Object BLOB cells (bare SharedArrayBuffer) export as base64, not {}", () => {
  // JSON.stringify(new SharedArrayBuffer(n)) is '{}' -- the same trap PR #2029
  // closed for ArrayBuffer. A bare SAB is neither an ArrayBuffer nor a view.
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
  const sab = new SharedArrayBuffer(64);
  new Uint8Array(sab).set(bytes);
  const expected = { $base64: Buffer.from(bytes).toString("base64") };
  assert.deepEqual(sanitizeCell("bytes", sab), expected);
  assert.notEqual(JSON.stringify(sanitizeCell("bytes", sab)), "{}");
});

test("exportTrailer pages the event log and hashes exactly what one full read would", () => {
  const db = new TrailerDb(":memory:");
  db.exec("CREATE TABLE events (room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL, PRIMARY KEY (room_id, sequence))");
  const insert = db.prepare("INSERT INTO events (room_id, sequence, id) VALUES (?,?,?)");
  db.exec("BEGIN");
  for (const room of ["room-a", "room-b", "room-c"]) for (let n = 1; n <= 1700; n += 1) insert.run(room, n, `${room}-evt-${n}`);
  db.exec("COMMIT");
  const reference = createHash("sha256");
  for (const row of db.prepare("SELECT room_id, sequence, id FROM events ORDER BY room_id, sequence").all()) reference.update(`${row.room_id}\t${row.sequence}\t${row.id}\n`);
  // Count the rows each query hands back: no single read may return the whole log.
  let biggest = 0;
  const spy = { prepare: sql => { const st = db.prepare(sql); return { all: (...a) => { const rows = st.all(...a); biggest = Math.max(biggest, rows.length); return rows; } }; } };
  const trailer = exportTrailer(spy);
  assert.equal(trailer.events, 5100);
  assert.equal(trailer.eventsHash, reference.digest("hex"));
  assert.ok(biggest < 5100, `trailer read ${biggest} rows at once`);
  db.close();
  // An empty log still yields a valid trailer.
  const empty = new TrailerDb(":memory:");
  empty.exec("CREATE TABLE events (room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL)");
  assert.equal(exportTrailer(empty).events, 0);
  empty.close();
});
