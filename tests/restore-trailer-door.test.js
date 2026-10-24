// Ruling 34 (2026-10-20), from HUNT-RECOVERY-ADVERSARIAL case 1c: a
// tail-torn modern export (trailer + a messages row + an
// agent_autonomy_tiers row lost, event log intact) restored ACCEPTED at
// the operator door with verified:true / contentVerification
// "watermark-only", the loss never enumerated. The operator restore
// endpoints now refuse trailer-absent exports unless the explicit legacy
// flag is passed (?legacy=true, or "legacy": true in the
// restore-from-backup body). Library-level legacy replay
// (replayNdjsonInto with no door option) keeps its semantics and is
// pinned unchanged below.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonText } from "../server/room-export.mjs";
import { replayNdjsonInto, operatorRestoreResponse, operatorRestoreFromBackupResponse } from "../server/restore-ndjson.mjs";
import { backupPartKey, BACKUP_MANIFEST_VERSION } from "../cloudflare/room-backup.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const OPERATOR_TOKEN = "restore-trailer-operator-token-0123456789";
const KEY = "room-backups/2026-10-14.ndjson";
const sha256 = value => createHash("sha256").update(value).digest("hex");

function openStore(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return store;
}

// The QA report's seed: initial room + 1 agent member + 2 posted
// messages (5 events). The export carries 2 messages rows and 1
// agent_autonomy_tiers row (the agent's enrollment tier) plus a trailer.
function seed(t) {
  const store = openStore(t, "restore-trailer-seed-");
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Restore agent", kind: "agent", permissions: ["accept_work"] } });
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "first message" } });
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "second message" } });
  const ndjson = exportNdjsonText(store.db);
  const tables = {};
  for (const line of ndjson.trim().split("\n")) {
    const record = JSON.parse(line);
    if (record.table) tables[record.table] = (tables[record.table] ?? 0) + 1;
  }
  assert.equal(tables.messages, 2, "seed export carries 2 messages rows");
  assert.equal(tables.agent_autonomy_tiers, 1, "seed export carries 1 tier row");
  assert.match(ndjson.trim().split("\n").at(-1), /"kind":"trailer"/, "seed export ends with a trailer");
  return { store, ndjson };
}

// Case 1c: cut the trailer, 1 of 2 messages rows, and the tier row.
function case1c(ndjson) {
  let droppedMessages = false, droppedTier = false;
  return ndjson.trim().split("\n").filter(line => {
    const record = JSON.parse(line);
    if (record.kind === "trailer") return false;
    if (record.table === "messages" && !droppedMessages) { droppedMessages = true; return false; }
    if (record.table === "agent_autonomy_tiers" && !droppedTier) { droppedTier = true; return false; }
    return true;
  }).join("\n") + "\n";
}

// Case 4a-faithful: a genuine pre-#3599 legacy shape — no trailer, the
// watermark carries no sanitizePolicy, and the cell the old exporter
// over-hashed (accounts.password_reset_required) carries sha256 of its
// value under the old name-regex rule.
function faithfulLegacy(ndjson) {
  return ndjson.trim().split("\n").filter(line => JSON.parse(line).kind !== "trailer").map(line => {
    const record = JSON.parse(line);
    if (record.kind === "watermark") { delete record.sanitizePolicy; return JSON.stringify(record); }
    if (record.table === "accounts") record.row.password_reset_required = sha256(String(record.row.password_reset_required));
    return JSON.stringify(record);
  }).join("\n") + "\n";
}

function bodyRequest({ body = "", token = OPERATOR_TOKEN, query = "" } = {}) {
  const headers = new Headers({ "content-type": "application/x-ndjson" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return { method: "POST", url: `https://room.example/api/operator/restore${query}`, headers, text: async () => body };
}

test("operator restore refuses the case-1c tail-torn export without the legacy flag", async t => {
  const { ndjson } = seed(t);
  const target = openStore(t, "restore-trailer-1c-refused-");
  const response = await operatorRestoreResponse(bodyRequest({ body: case1c(ndjson) }), OPERATOR_TOKEN, target);
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(payload.error.code, "restore_verification_failed");
  assert.match(payload.error.message, /no trailer/);
  assert.match(payload.error.message, /legacy/);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0, "refused restore leaves the store empty");
});

test("operator restore lands the case-1c export with ?legacy=true, weaker level named", async t => {
  const { ndjson } = seed(t);
  const target = openStore(t, "restore-trailer-1c-legacy-");
  const response = await operatorRestoreResponse(bodyRequest({ body: case1c(ndjson), query: "?legacy=true" }), OPERATOR_TOKEN, target);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.equal(payload.trailer, "absent");
  assert.equal(payload.contentVerification, "watermark-only", "the weaker verification level is named in the result");
  // The flag is an explicit operator acceptance of exactly this loss:
  // 1 of 2 messages rows and the tier row are what the cut removed.
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM agent_autonomy_tiers").get().n, 0);
});

test("operator restore lands a faithful legacy (case 4a) export only via the flag", async t => {
  const { ndjson } = seed(t);
  const legacy = faithfulLegacy(ndjson);
  const refusedTarget = openStore(t, "restore-trailer-4a-refused-");
  const refused = await operatorRestoreResponse(bodyRequest({ body: legacy }), OPERATOR_TOKEN, refusedTarget);
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error.code, "restore_verification_failed");
  assert.equal(refusedTarget.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0);

  const target = openStore(t, "restore-trailer-4a-legacy-");
  const response = await operatorRestoreResponse(bodyRequest({ body: legacy, query: "?legacy=true" }), OPERATOR_TOKEN, target);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.equal(payload.trailer, "absent");
  assert.equal(payload.contentVerification, "watermark-only");
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM messages").get().n, 2, "the faithful legacy export loses nothing");
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM agent_autonomy_tiers").get().n, 1);
});

test("operator restore: trailer-present export needs no flag; a bogus flag value is 422", async t => {
  const { ndjson } = seed(t);
  const target = openStore(t, "restore-trailer-clean-");
  const response = await operatorRestoreResponse(bodyRequest({ body: ndjson }), OPERATOR_TOKEN, target);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.trailer, "verified");
  assert.equal(payload.contentVerification, "full");

  const badTarget = openStore(t, "restore-trailer-badflag-");
  const bad = await operatorRestoreResponse(bodyRequest({ body: ndjson, query: "?legacy=yes" }), OPERATOR_TOKEN, badTarget);
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, "invalid_restore");
  assert.equal(badTarget.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0);
});

test("library replay keeps its legacy semantics: replayNdjsonInto accepts trailer-absent by default", t => {
  const { ndjson } = seed(t);
  const target = openStore(t, "restore-trailer-library-");
  const result = replayNdjsonInto(case1c(ndjson), target);
  assert.equal(result.verified, true);
  assert.equal(result.trailer, "absent");
  assert.equal(result.contentVerification, "watermark-only");
});

// --- KV door (restore-from-backup) ---

function fakeKvWith(ndjson) {
  const map = new Map();
  const bytes = new TextEncoder().encode(ndjson);
  const partKey = backupPartKey(KEY, 0);
  map.set(partKey, bytes);
  map.set(KEY, JSON.stringify({
    kind: "room-backup-manifest", version: BACKUP_MANIFEST_VERSION, key: KEY,
    bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    parts: [{ key: partKey, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }],
  }));
  return { map, async get(k) { return map.has(k) ? map.get(k) : null; } };
}

function kvRequest({ body = "", query = "" } = {}) {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${OPERATOR_TOKEN}`);
  return { method: "POST", url: `https://room.example/api/operator/restore-from-backup${query}`, headers, text: async () => body };
}

test("restore-from-backup refuses a trailer-absent backup without the legacy flag and cleans up", async t => {
  const { ndjson } = seed(t);
  const kv = fakeKvWith(case1c(ndjson));
  const target = openStore(t, "restore-trailer-kv-refused-");
  const response = await operatorRestoreFromBackupResponse(
    kvRequest({ body: JSON.stringify({ key: KEY }) }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(payload.error.code, "restore_verification_failed");
  assert.match(payload.error.message, /no trailer/);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0, "the streaming refusal deletes everything it landed");
});

test("restore-from-backup lands a trailer-absent backup with the legacy flag (body and query forms)", async t => {
  const { ndjson } = seed(t);
  const kv = fakeKvWith(case1c(ndjson));
  const target = openStore(t, "restore-trailer-kv-legacy-body-");
  const response = await operatorRestoreFromBackupResponse(
    kvRequest({ body: JSON.stringify({ key: KEY, legacy: true }) }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.equal(payload.trailer, "absent");
  assert.equal(payload.contentVerification, "watermark-only");

  const target2 = openStore(t, "restore-trailer-kv-legacy-query-");
  const response2 = await operatorRestoreFromBackupResponse(
    kvRequest({ body: JSON.stringify({ key: KEY }), query: "?legacy=true" }), OPERATOR_TOKEN, target2, kv);
  assert.equal(response2.status, 200);
  assert.equal((await response2.json()).contentVerification, "watermark-only");
});
