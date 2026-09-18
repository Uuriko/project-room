// Durable quarantine journal for the spam guard: held records survive a
// store reopen, release/dismiss transitions are final, and the journal's
// review() speaks the in-memory queue's decision vocabulary (release /
// confirm_spam) so the quarantine path can switch stores without rewording.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore, ServiceError } from "../server/store.mjs";
import { flagMessage, quarantineThreshold } from "../server/inbox-spam.mjs";
import { spamQuarantineStatuses, spamQuarantineLimits } from "../server/spam-quarantine-journal.mjs";
import { applicationTables } from "../server/writer-fence.mjs";
import { auditRecovery } from "../server/recovery.mjs";

const spammy = () => flagMessage({
  from: "Airdrop Official", subject: "URGENT!! FREE CRYPTO AIRDROP",
  body: "Send us your crypto to double your money! Log in here to confirm your identity and claim your free airdrop. Act now!",
  urls: ["https://claim-free-airdrop.xyz/verify"],
});
const clean = () => flagMessage({ from: "Avery", body: "Hey, are we still on for lunch tomorrow?" });
const entry = (messageId, channel = "telegram", extra = {}) => ({ messageId, channel, flag: spammy(), ...extra });

function fixture(t) {
  const f = createAcceptanceFixture();
  f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.journal = () => f.store.spamQuarantine;
  f.reopen = () => { f.store.close(); f.store = new RoomStore(f.filename); return f.journal(); };
  return f;
}
const isServiceError = (error, status, code) => error instanceof ServiceError && error.status === status && error.code === code;
const rejects = async (promise, status, code) => {
  await assert.rejects(promise, error => isServiceError(error, status, code), `expected ServiceError ${status}/${code}`);
};

test("spammy messages trip quarantine and the journal write is id-less but stable", t => {
  assert.ok(spammy().quarantine && spammy().score >= quarantineThreshold, "fixture message must trip the spam guard");
  assert.equal(clean().quarantine, false);
  const f = fixture(t);
  const first = f.journal().quarantine(entry("msg-1"));
  assert.equal(first.id, "qz-1");
  assert.deepEqual({ messageId: first.messageId, channel: first.channel, status: first.status, score: first.score,
    reviewedBy: first.reviewedBy, note: first.note }, { messageId: "msg-1", channel: "telegram", status: "held", score: spammy().score, reviewedBy: null, note: null });
  assert.deepEqual(first.reason, spammy().signals.map(s => ({ key: s.key, weight: s.weight, detail: s.detail })), "reason is the flag's signal list");
  assert.equal(f.journal().get("qz-1").id, "qz-1");
  assert.equal(f.journal().get("nope"), null);
  assert.deepEqual(f.journal().counts(), { held: 1, released: 0, dismissed: 0 });
});

test("held records survive a store reopen and ids keep counting across restarts", t => {
  const f = fixture(t);
  f.journal().quarantine(entry("msg-1"));
  f.journal().quarantine(entry("msg-2", "email", { connectionId: "conn-1" }));
  const reopened = f.reopen();
  assert.deepEqual(reopened.held().map(r => r.id), ["qz-1", "qz-2"]);
  assert.equal(reopened.get("qz-2").connectionId, "conn-1");
  assert.deepEqual(reopened.counts(), { held: 2, released: 0, dismissed: 0 });
  assert.deepEqual(reopened.verify(), { held: 2, released: 0, dismissed: 0 });
  const third = reopened.quarantine(entry("msg-3"));
  assert.equal(third.id, "qz-3", "the id counter must not reset on restart");
  assert.deepEqual(reopened.held().map(r => r.messageId), ["msg-1", "msg-2", "msg-3"]);
});

test("release and dismiss transitions are final and review fields are recorded", t => {
  const f = fixture(t);
  const one = f.journal().quarantine(entry("msg-1"));
  const two = f.journal().quarantine(entry("msg-2"));
  const released = f.journal().release(one.id, { reviewer: "owner", note: "false positive" });
  assert.deepEqual({ status: released.status, reviewedBy: released.reviewedBy, note: released.note },
    { status: "released", reviewedBy: "owner", note: "false positive" });
  assert.ok(released.reviewedAt >= released.quarantinedAt);
  const dismissed = f.journal().dismiss(two.id, { reviewer: "owner" });
  assert.deepEqual({ status: dismissed.status, reviewedBy: dismissed.reviewedBy, note: dismissed.note },
    { status: "dismissed", reviewedBy: "owner", note: null });
  assert.deepEqual(f.journal().held().map(r => r.id), [], "reviewed rows leave the held backlog");
  assert.deepEqual(f.journal().counts(), { held: 0, released: 1, dismissed: 1 });
  rejects(Promise.resolve().then(() => f.journal().release(one.id, { reviewer: "owner" })), 409, "quarantine_already_reviewed");
  rejects(Promise.resolve().then(() => f.journal().dismiss(two.id, { reviewer: "owner" })), 409, "quarantine_already_reviewed");
  rejects(Promise.resolve().then(() => f.journal().release("qz-404", { reviewer: "owner" })), 404, "unknown_quarantine");
  const reopened = f.reopen();
  assert.deepEqual(reopened.counts(), { held: 0, released: 1, dismissed: 1 }, "reviews survive a restart too");
  assert.deepEqual(reopened.verify(), { held: 0, released: 1, dismissed: 1 });
});

test("review() bridges the in-memory queue's decision vocabulary", t => {
  const f = fixture(t);
  const one = f.journal().quarantine(entry("msg-1"));
  const two = f.journal().quarantine(entry("msg-2"));
  assert.equal(f.journal().review(one.id, { decision: "release", reviewer: "owner" }).status, "released");
  assert.equal(f.journal().review(two.id, { decision: "confirm_spam", reviewer: "owner" }).status, "dismissed",
    "confirm_spam dismisses the message as spam; it is not a release");
  rejects(Promise.resolve().then(() => f.journal().review(one.id, { decision: "release", reviewer: "owner" })), 409, "quarantine_already_reviewed");
  rejects(Promise.resolve().then(() => f.journal().review(two.id, { decision: "nuke", reviewer: "owner" })), 422, "invalid_quarantine");
});

test("accountId/sourceId are explicit on write and read, null for legacy rows", t => {
  const f = fixture(t);
  const scoped = f.journal().quarantine(entry("msg-1", "telegram", { accountId: "acct-1", sourceId: "src-1", connectionId: "conn-1" }));
  assert.deepEqual({ accountId: scoped.accountId, sourceId: scoped.sourceId, connectionId: scoped.connectionId },
    { accountId: "acct-1", sourceId: "src-1", connectionId: "conn-1" });
  const fetched = f.journal().get(scoped.id);
  assert.equal(fetched.accountId, "acct-1");
  assert.equal(fetched.sourceId, "src-1");
  assert.deepEqual(f.journal().held().map(r => ({ accountId: r.accountId, sourceId: r.sourceId })),
    [{ accountId: "acct-1", sourceId: "src-1" }], "list() exposes the scope fields");
  const legacy = f.journal().quarantine(entry("msg-2"));
  assert.equal(legacy.accountId, null, "rows filed without the scope fields read back null (backward compatible)");
  assert.equal(legacy.sourceId, null);
  assert.deepEqual(f.journal().verify(), { held: 2, released: 0, dismissed: 0 }, "null-scoped rows still verify");
  const reopened = f.reopen();
  assert.equal(reopened.get(scoped.id).sourceId, "src-1", "the scope fields survive a restart");
});

test("a pre-gap-#2 table converges on reopen: rows survive, new columns read back null", t => {
  const f = fixture(t);
  // Simulate a database written before the account_id/source_id columns:
  // strip them, file a legacy row with raw SQL (as the old code did), then
  // reopen through the normal path.
  f.store.db.exec("ALTER TABLE spam_quarantine DROP COLUMN account_id");
  f.store.db.exec("ALTER TABLE spam_quarantine DROP COLUMN source_id");
  f.store.db.prepare(`INSERT INTO spam_quarantine (id,message_id,channel,connection_id,reason,score,quarantined_at,status,reviewed_by,reviewed_at,note,updated_at)
    VALUES('qz-1','legacy-msg','telegram','conn-1','[{"key":"k","weight":80,"detail":"d"}]',80,?, 'held',NULL,NULL,NULL,?)`)
    .run(Date.now(), Date.now());
  const reopened = f.reopen();
  assert.ok(reopened.verifySchema(), "migrated columns converge to the checked-in schema");
  const held = reopened.held();
  assert.equal(held.length, 1, "the legacy row survives the migration");
  assert.equal(held[0].messageId, "legacy-msg");
  assert.equal(held[0].accountId, null, "pre-column rows read back null account_id");
  assert.equal(held[0].sourceId, null, "pre-column rows read back null source_id");
  assert.deepEqual(reopened.verify(), { held: 1, released: 0, dismissed: 0 }, "legacy rows still verify after migration");
  const fresh = reopened.quarantine(entry("new-msg", "email", { accountId: "acct-9", sourceId: "src-9" }));
  assert.deepEqual({ accountId: fresh.accountId, sourceId: fresh.sourceId }, { accountId: "acct-9", sourceId: "src-9" });
  assert.equal(fresh.id, "qz-2", "the id counter keeps counting across the migration");
});

test("validation rejects bad quarantine writes and reviews", async t => {
  const f = fixture(t);
  await rejects((async () => f.journal().quarantine(entry("msg-1", "telegram", { flag: clean() })))(), 422, "invalid_quarantine");
  await rejects((async () => f.journal().quarantine({ ...entry(""), }))(), 422, "invalid_quarantine");
  await rejects((async () => f.journal().quarantine(entry("msg-1", "x".repeat(200))))(), 422, "invalid_quarantine");
  await rejects((async () => f.journal().quarantine(entry("msg-9", "telegram",
    { accountId: "x".repeat(spamQuarantineLimits.accountIdChars + 1) })))(), 422, "invalid_quarantine");
  await rejects((async () => f.journal().quarantine(entry("msg-9", "telegram", { sourceId: "" })))(), 422, "invalid_quarantine");
  const held = f.journal().quarantine(entry("msg-1"));
  await rejects((async () => f.journal().release(held.id, { reviewer: "" }))(), 422, "invalid_quarantine");
  await rejects((async () => f.journal().dismiss(held.id, { reviewer: "owner", note: "x".repeat(spamQuarantineLimits.noteChars + 1) }))(), 422, "invalid_quarantine");
  await rejects((async () => f.journal().held({ limit: 0 }))(), 422, "invalid_quarantine");
  assert.deepEqual(spamQuarantineStatuses, ["held", "released", "dismissed"]);
});

test("held() respects the page size and verify() names the statuses", t => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) f.journal().quarantine(entry(`msg-${i}`));
  assert.deepEqual(f.journal().held({ limit: 2 }).map(r => r.id), ["qz-1", "qz-2"]);
  assert.equal(f.journal().held().length, 3);
  assert.deepEqual(f.journal().verify(), { held: 3, released: 0, dismissed: 0 });
});

test("the journal table is registered, unfenced, and audited", t => {
  const f = fixture(t);
  assert.ok(f.journal().verifySchema(), "schema objects match the checked-in definition");
  assert.ok(applicationTables.includes("spam_quarantine"), "recovery audit's table list names the journal");
  f.journal().quarantine(entry("msg-1"));
  f.journal().dismiss("qz-1", { reviewer: "owner" });
  const audit = auditRecovery(f.store);
  const row = audit.tables.find(entry => entry.table === "spam_quarantine");
  assert.equal(row.rows, 1, "the recovery audit sees the journal's row");
});

test("the new journal module is registered in the runtime package allowlist", async t => {
  const { readFileSync } = await import("node:fs");
  const allowlist = readFileSync(join(import.meta.dirname, "../scripts/runtime-package.mjs"), "utf8");
  assert.ok(allowlist.includes('"server/spam-quarantine-journal.mjs"'), "store.mjs imports the journal, so the exact-contract runtime package must allowlist it");
});
