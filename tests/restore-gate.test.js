// IR-2 acceptance: the restore gate at the doors (Fix Programme v2 §1A).
//
// The charter's executed tests:
//   1. a door-level fixture — authority planted in blind classes, backed
//      up, revoked in the live store, restored through the REAL door
//      handlers — comes back with every revocation re-applied and
//      journaled, through both doors (buffered body + streamed KV);
//   2. an abandoned streamed session leaves the store locked, and a
//      fresh session reconciles against the extract the first attempt
//      persisted with its stamp;
//   3. PLUG-B2: a seat whose exit postdates the backup watermark cannot
//      authenticate after the gate (its exit is re-applied as its own
//      leave event), while a surviving seat can;
//   4. the honest restore — no intervening revocations — reconciles
//      quiet, and a fresh-store restore completes unlocked;
//   5. the file swap: a backup artifact opened directly boots
//      restored-unreconciled; the gate clears it against a surviving
//      current store, and the operator acknowledgement clears a copy
//      when no reference survives;
//   6. the extract facade is equivalent to the live store it serialises,
//      including through its persisted JSON round-trip;
//   7. A5 re-apply: joins spent after the backup cancel the restored link
//      (its scope is immutable, so the slots cannot be re-accounted).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ensureOAuthProviderSchema } from "../server/oauth-provider-store.mjs";
import { exportNdjsonText, exportNdjsonStream } from "../server/room-export.mjs";
import { backupRoom, reconcileRestoredAuthority } from "../server/backup.mjs";
import {
  captureAuthorityExtract, extractAsCurrentStore, runRestoreGate,
  storeRestoredUnreconciled,
  serializeAuthorityExtract, parseAuthorityExtract,
} from "../server/restore-reconcile.mjs";
import {
  createBackupReplaySession, operatorRestoreResponse,
  operatorRestoreFromBackupResponse, operatorRestoreAcknowledgeResponse,
} from "../server/restore-ndjson.mjs";
import { writeKvBackup } from "../cloudflare/room-backup.mjs";
import { issueSpendGrant, revokeSpendGrant } from "../server/spend-grants.mjs";
import { generateEd25519KeyPair } from "../server/agent-key-registry.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const OPERATOR_TOKEN = "<MASKED_SECRET_001>";
const KEY = "room-backups/2026-10-14.ndjson";
const PLANTED_KINDS = ["capability_grant", "membership_delegation", "owner_delegate_grant",
  "claim_key", "rak_key", "attestation", "link_code", "share_link", "member"];

function boot(t, label) {
  const dir = mkdtempSync(join(tmpdir(), `ir2-${label}-`));
  const dest = mkdtempSync(join(tmpdir(), `ir2-${label}-backup-`));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); });
  const filename = join(dir, "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom("commons"));
  ensureOAuthProviderSchema(store.db);
  const owner = store.issueAccessKey("commons", "owner");
  const ownerMemberId = store.room("commons").state.room.ownerId;
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  return { store, filename, dest, owner, ownerMemberId };
}

const memberIdOf = (store, identityId) =>
  Object.values(store.room("commons").state.members).find(m => m.identityId === identityId)?.id;

// Authority across nine reconcile classes, all live at backup time.
function plantAll(store, owner, ownerMemberId) {
  const X = store.identities.create("Gate Agent");
  store.identities.link(owner, "commons", { identityId: X.identityId, permissions: ["accept_work"] });
  const memberX = memberIdOf(store, X.identityId);
  const Y = store.identities.create("Exit Seat");
  store.identities.link(owner, "commons", { identityId: Y.identityId, permissions: ["accept_work"] });
  const memberY = memberIdOf(store, Y.identityId);
  const yKey = store.issueAccessKey("commons", memberY);
  const xKey = store.issueAccessKey("commons", memberX);
  store.delegation.grant(owner, "commons", { identityId: X.identityId });
  store.ownerDelegates.grant(owner, "commons", { identityId: X.identityId });
  issueSpendGrant(store.db, "commons", memberX, { grantedBy: ownerMemberId, capCents: "5000", perTxCapCents: "1000" });
  const kp = generateEd25519KeyPair();
  store.keyRegistry.registerKey(X.identityId, kp.publicKey);
  const rak = store.agentPlugin.issueApiKey({ identityId: X.identityId, scopes: ["mcp:room:commons", "rooms:read", "rooms:write"] });
  store.agentPlugin.verifyIdentity({ identityId: X.identityId, verifiedBy: "owner" });
  const W = store.identities.create("Code Holder");
  const { linkCode } = store.identities.mintLinkCode(W.identityId, W.secret);
  const link = store.shareLinks.create(owner, "commons", { requestId: randomUUID(),
    linkToken: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 3600000,
    maxJoins: 10, expectedMemberRevision: 0 }, null).link;
  return { X, Y, memberX, memberY, xKey, yKey, kp, rak, W, linkCode, link };
}

// The post-watermark timeline: every planted authority is withdrawn, and
// seat Y exits (its credential is deliberately NOT revoked — the exit is
// the only thing the gate may stop it with).
function withdrawAll(store, owner, p) {
  store.delegation.revoke(owner, "commons", { identityId: p.X.identityId });
  store.ownerDelegates.revoke(owner, "commons", { identityId: p.X.identityId });
  revokeSpendGrant(store.db, "commons", p.memberX);
  store.keyRegistry.revokeKey(p.X.identityId, { identitySecret: p.X.secret, publicKey: p.kp.publicKey });
  store.agentPlugin.revokeApiKey({ identityId: p.X.identityId, keyId: p.rak.keyId });
  store.agentPlugin.unverifyIdentity({ identityId: p.X.identityId });
  store.identities.consumeLinkCode(p.W.identityId, p.linkCode);
  store.shareLinks.cancel(owner, "commons", p.link.id, null);
  const yMember = store.room("commons").state.members[p.memberY];
  store.command(p.yKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: p.memberY, expectedMemberRevision: yMember.revision,
      permissions: [...yMember.permissions], active: false } });
}

function authCode(store, token) {
  try { store.authenticate(token, "commons"); return null; }
  catch (error) { return error.code ?? String(error.message); }
}

function fakeRestoreRequest(body) {
  const headers = new Headers({ "content-type": "application/x-ndjson" });
  headers.set("authorization", `Bearer ${OPERATOR_TOKEN}`);
  return { method: "POST", url: "https://room.example/api/operator/restore", headers, text: async () => body };
}

function fakeKv() {
  const map = new Map();
  return { map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, typeof value === "string" ? value : Buffer.from(value)); },
    async delete(key) { map.delete(key); } };
}

function fakeKvRequest() {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${OPERATOR_TOKEN}`);
  return { method: "POST", url: "https://room.example/api/operator/restore-from-backup",
    headers, text: async () => JSON.stringify({ key: KEY }) };
}

function assertReapplied(store, p) {
  const db = store.db;
  assert.ok(db.prepare("SELECT revoked_at FROM agent_capability_grants WHERE room_id='commons' AND agent_id=?").get(p.memberX)?.revoked_at !== null,
    "spend grant edge re-revoked");
  assert.ok(db.prepare("SELECT revoked_at FROM membership_delegation_grants WHERE room_id='commons' AND identity_id=?").get(p.X.identityId)?.revoked_at !== null,
    "membership delegation re-revoked");
  assert.ok(db.prepare("SELECT revoked_at FROM owner_delegate_grants WHERE room_id='commons' AND identity_id=?").get(p.X.identityId)?.revoked_at !== null,
    "owner delegate grant re-revoked");
  assert.ok(db.prepare("SELECT revoked_at FROM agent_key_registry WHERE identity_id=? AND public_key=?").get(p.X.identityId, p.kp.publicKey)?.revoked_at !== null,
    "claim key re-revoked");
  // The restored API-key row carries the exporter's scrubbed key_id
  // (sha256 of the token-shaped id); the gate re-revoked that row.
  const scrubbedKeyId = createHash("sha256").update(p.rak.keyId).digest("hex");
  assert.equal(db.prepare("SELECT revoked FROM agent_api_keys WHERE key_id=?").get(scrubbedKeyId)?.revoked, 1,
    "API key re-revoked");
  assert.ok(!db.prepare("SELECT 1 FROM agent_identity_verification WHERE identity_id=?").get(p.X.identityId),
    "attestation re-withdrawn (row deleted)");
  assert.ok(db.prepare("SELECT consumed_at FROM identity_link_codes WHERE identity_id=?").get(p.W.identityId)?.consumed_at !== null,
    "link code re-consumed");
  assert.ok(db.prepare("SELECT revoked_at FROM share_links WHERE id=?").get(p.link.id)?.revoked_at !== null,
    "share link re-cancelled");
  assert.equal(store.room("commons").state.members[p.memberY]?.active, false,
    "exited seat re-deactivated (PLUG-B2)");
}

function gateJournal(store) {
  const summaries = store.db.prepare("SELECT counts_json FROM operator_actions WHERE action='restore_reconcile' AND result='reconciled'").all();
  assert.equal(summaries.length, 1, "exactly one reconcile summary row");
  const reapplied = store.db.prepare("SELECT target_kind FROM operator_actions WHERE action='restore_reconcile_reapply'").all();
  return { counts: JSON.parse(summaries[0].counts_json), reappliedKinds: reapplied.map(row => row.target_kind) };
}

test("1. buffered door: planted revocations are re-applied and journaled", async t => {
  const { store, owner, ownerMemberId } = boot(t, "door-body");
  const p = plantAll(store, owner, ownerMemberId);
  const ndjson = exportNdjsonText(store.db);
  withdrawAll(store, owner, p);
  const response = await operatorRestoreResponse(fakeRestoreRequest(ndjson), OPERATOR_TOKEN, store);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.reconcile.status, "reconciled");
  assert.ok(payload.reconcile.stale >= PLANTED_KINDS.length, `stale covers the planted classes; got ${payload.reconcile.stale}`);
  assert.equal(payload.reconcile.reapplied, payload.reconcile.stale, "every named revocation re-applied");
  assert.equal(payload.reconcile.skipped, 0, "nothing named was left un-applied");
  assertReapplied(store, p);
  const { counts, reappliedKinds } = gateJournal(store);
  for (const kind of PLANTED_KINDS) {
    assert.ok(counts.stale.some(entry => entry.kind === kind), `journal stale list names ${kind}`);
    assert.ok(reappliedKinds.includes(kind), `journal carries a re-apply row for ${kind}`);
  }
  assert.equal(reappliedKinds.length, counts.stale.length, "one re-apply row per stale entry");
  assert.equal(storeRestoredUnreconciled(store.db), false, "the gate cleared the boot lock");
  assert.equal(authCode(store, p.X.secret), null, "the surviving seat authenticates after the gate");
  assert.equal(authCode(store, p.xKey), null, "the surviving seat's credential authenticates");
  assert.equal(authCode(store, p.yKey), "unauthenticated", "the exited seat's live credential is refused — its exit was re-applied, not the lock");
});

test("2a. streamed KV door: the same gate runs at finish()", async t => {
  const { store, owner, ownerMemberId } = boot(t, "door-kv");
  const p = plantAll(store, owner, ownerMemberId);
  const kv = fakeKv();
  await writeKvBackup(kv, KEY, exportNdjsonStream(store.db), { partBytes: 2048 });
  withdrawAll(store, owner, p);
  const response = await operatorRestoreFromBackupResponse(fakeKvRequest(), OPERATOR_TOKEN, store, kv);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.reconcile.status, "reconciled");
  assert.equal(payload.reconcile.reapplied, payload.reconcile.stale);
  assert.equal(payload.reconcile.skipped, 0);
  assertReapplied(store, p);
  gateJournal(store);
  assert.equal(authCode(store, p.X.secret), null);
  assert.equal(authCode(store, p.yKey), "unauthenticated");
});

test("2b. abandoned session locks the store; a fresh session reconciles against the persisted extract", async t => {
  const { store, owner, ownerMemberId } = boot(t, "door-abandoned");
  const p = plantAll(store, owner, ownerMemberId);
  const ndjson = exportNdjsonText(store.db);
  withdrawAll(store, owner, p);
  const first = createBackupReplaySession(store);
  first.writeText(ndjson.slice(0, Math.floor(ndjson.length / 2)));
  // No finish(), no abort(): the session is abandoned mid-replay.
  assert.equal(storeRestoredUnreconciled(store.db), true, "partial data sits behind the boot lock");
  assert.equal(authCode(store, p.X.secret), "restored_unreconciled", "agent auth is refused while unreconciled");
  const second = createBackupReplaySession(store);
  second.writeText(ndjson);
  const result = second.finish();
  assert.equal(result.reconcile.status, "reconciled");
  assert.equal(result.reconcile.skipped.length, 0);
  const { counts } = gateJournal(store);
  assert.equal(counts.extractReused, true, "the retry reconciled against the first attempt's persisted extract");
  assertReapplied(store, p);
  assert.equal(authCode(store, p.X.secret), null, "the surviving seat authenticates after the remedy restore");
  assert.equal(authCode(store, p.xKey), null);
  assert.equal(authCode(store, p.yKey), "unauthenticated", "the exited seat stays out");
});

test("3. PLUG-B2: the re-applied exit is the seat's own leave event in the restored log", async t => {
  const { store, owner, ownerMemberId } = boot(t, "plug-b2");
  const p = plantAll(store, owner, ownerMemberId);
  const ndjson = exportNdjsonText(store.db);
  withdrawAll(store, owner, p);
  const response = await operatorRestoreResponse(fakeRestoreRequest(ndjson), OPERATOR_TOKEN, store);
  assert.equal(response.status, 200);
  const gateEvents = store.db.prepare("SELECT body FROM events WHERE id LIKE 'rr%'").all();
  assert.equal(gateEvents.length, 1, "exactly one gate-written event");
  const applied = JSON.parse(gateEvents[0].body);
  assert.equal(applied.type, "member.access_changed");
  assert.equal(applied.actorId, p.memberY, "the exit is re-applied as the seat's own leave");
  assert.equal(applied.data.memberId, p.memberY);
  assert.equal(applied.data.active, false);
  assert.equal(authCode(store, p.yKey), "unauthenticated");
  assert.equal(authCode(store, p.X.secret), null);
});

test("4. honest restore: quiet reconcile, and a fresh store completes unlocked", async t => {
  const { store, owner, ownerMemberId } = boot(t, "honest");
  const p = plantAll(store, owner, ownerMemberId);
  const ndjson = exportNdjsonText(store.db);
  // No intervening revocations: the restore must change nothing.
  const response = await operatorRestoreResponse(fakeRestoreRequest(ndjson), OPERATOR_TOKEN, store);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.reconcile.status, "reconciled");
  assert.equal(payload.reconcile.stale, 0);
  assert.equal(payload.reconcile.reapplied, 0);
  assert.equal(authCode(store, p.X.secret), null);
  // A migrated-but-empty store (the fresh-DO case): vacuous gate.
  const dir = mkdtempSync(join(tmpdir(), "ir2-fresh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fresh = new RoomStore(join(dir, "room.sqlite"));
  t.after(() => { try { fresh.close(); } catch { /* already closed */ } });
  const freshResponse = await operatorRestoreResponse(fakeRestoreRequest(ndjson), OPERATOR_TOKEN, fresh);
  assert.equal(freshResponse.status, 200);
  const freshPayload = await freshResponse.json();
  assert.equal(freshPayload.reconcile.status, "reconciled");
  assert.equal(storeRestoredUnreconciled(fresh.db), false, "a fresh-store restore is not locked");
  assert.equal(authCode(fresh, p.X.secret), null, "restored seats authenticate in the fresh store");
});

test("5. file swap: a backup artifact boots locked; gate and acknowledgement are the remedies", async t => {
  const { store, filename, dest, owner, ownerMemberId } = boot(t, "swap");
  const p = plantAll(store, owner, ownerMemberId);
  const first = await backupRoom(filename, dest);
  const second = await backupRoom(filename, dest);
  const backedUpAt = JSON.parse(readFileSync(first.watermark, "utf8")).backedUpAt;
  withdrawAll(store, owner, p);

  const copy = new RoomStore(first.filename);
  t.after(() => { try { copy.close(); } catch { /* already closed */ } });
  assert.equal(storeRestoredUnreconciled(copy.db), true, "the swapped-in store boots restored-unreconciled");
  assert.equal(authCode(copy, p.X.secret), "restored_unreconciled", "agent auth names the lock");
  const report = copy.transaction(() => runRestoreGate(copy, captureAuthorityExtract(store), { backedUpAt, source: "test" }));
  assert.equal(report.status, "reconciled");
  assert.equal(report.skipped.length, 0);
  assert.equal(storeRestoredUnreconciled(copy.db), false);
  assert.equal(authCode(copy, p.X.secret), null, "the gate restores the surviving seat");
  assert.ok(copy.db.prepare("SELECT revoked_at FROM agent_capability_grants WHERE room_id='commons' AND agent_id=?").get(p.memberX)?.revoked_at !== null,
    "the gate re-applied the spend revocation in the swapped store");
  assert.equal(copy.room("commons").state.members[p.memberY]?.active, false);

  // The acknowledgement remedy, through the real door: no reference
  // survives, the restore stands as of its watermark, on the record.
  const copy2 = new RoomStore(second.filename);
  t.after(() => { try { copy2.close(); } catch { /* already closed */ } });
  assert.equal(authCode(copy2, p.X.secret), "restored_unreconciled");
  const ackRequest = body => ({ method: "POST", url: "https://room.example/api/operator/restore-acknowledge",
    headers: new Headers({ authorization: `Bearer ${OPERATOR_TOKEN}` }), text: async () => body });
  const acked = await operatorRestoreAcknowledgeResponse(ackRequest(JSON.stringify({ reason: "test: no surviving reference" })), OPERATOR_TOKEN, copy2);
  assert.equal(acked.status, 200);
  assert.equal(authCode(copy2, p.X.secret), null, "the acknowledgement unlocks agent auth");
  assert.equal(copy2.db.prepare("SELECT revoked_at FROM agent_capability_grants WHERE room_id='commons' AND agent_id=?").get(p.memberX)?.revoked_at, null,
    "acknowledged, not reconciled: backup-time authority stands, on the record");
  const journal = copy2.db.prepare("SELECT result FROM operator_actions WHERE action='restore_reconcile'").all();
  assert.deepEqual(journal.map(row => row.result), ["acknowledged_no_reference"]);
  const again = await operatorRestoreAcknowledgeResponse(ackRequest(""), OPERATOR_TOKEN, copy2);
  assert.equal(again.status, 409, "a second acknowledgement has nothing to clear");
  assert.equal((await again.json()).error.code, "restore_not_locked");
});

test("6. extract facade equivalence, including the persisted round-trip", async t => {
  const { store, filename, dest, owner, ownerMemberId } = boot(t, "facade");
  const p = plantAll(store, owner, ownerMemberId);
  const backup = await backupRoom(filename, dest);
  const restored = new RoomStore(backup.filename);
  t.after(() => { try { restored.close(); } catch { /* already closed */ } });
  withdrawAll(store, owner, p);
  const extract = captureAuthorityExtract(store);
  const live = reconcileRestoredAuthority(restored, store);
  const viaFacade = reconcileRestoredAuthority(restored, extractAsCurrentStore(extract));
  assert.ok(live.stale.length >= PLANTED_KINDS.length, "the fixture produces the planted stale set");
  assert.deepEqual(viaFacade.stale, live.stale, "facade names exactly what the live store names");
  assert.deepEqual(viaFacade.checked, live.checked);
  assert.deepEqual(viaFacade.checkedClasses, live.checkedClasses);
  const revived = parseAuthorityExtract(serializeAuthorityExtract(extract));
  assert.ok(revived, "the persisted extract parses back");
  const viaRevived = reconcileRestoredAuthority(restored, extractAsCurrentStore(revived));
  assert.deepEqual(viaRevived.stale, live.stale, "the persisted extract reconciles identically");
});

test("7. A5 re-apply: joins spent after the backup cancel the link (its scope is immutable)", async t => {
  const { store, owner } = boot(t, "a5");
  const link = store.shareLinks.create(owner, "commons", { requestId: randomUUID(),
    linkToken: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 3600000,
    maxJoins: 5, expectedMemberRevision: 0 }, null).link;
  // The extract is the store itself, plus three joins the live timeline
  // spent after the backup (fabricated rows: the facade and the re-apply
  // read link_id only; no restored row is ever fabricated).
  const extract = captureAuthorityExtract(store);
  extract.tables.share_link_joins = [1, 2, 3].map(n => ({ link_id: link.id,
    invitation_id: `inv-${n}`, slot_hash: `slot-${n}`, redemption_id: `red-${n}`,
    session_revision: 1, fingerprint: `fp-${n}` }));
  const report = store.transaction(() => runRestoreGate(store, extract, { backedUpAt: Date.now(), source: "test" }));
  assert.equal(report.stale.length, 1);
  assert.equal(report.stale[0].kind, "share_link");
  assert.equal(report.reapplied.length, 1);
  assert.equal(report.compensated.length, 1, "the compensation is journaled by name");
  assert.match(report.compensated[0].note, /cannot be re-accounted/);
  assert.ok(store.db.prepare("SELECT revoked_at FROM share_links WHERE id=?").get(link.id)?.revoked_at !== null,
    "the link is cancelled rather than left holding resurrected join slots");
  assert.equal(store.db.prepare("SELECT max_joins FROM share_links WHERE id=?").get(link.id)?.max_joins, 5,
    "the immutable scope itself is untouched");
});
