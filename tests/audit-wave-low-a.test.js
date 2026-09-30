/**
 * audit-wave-low-a.test.js — regression tests for LOW wave A findings:
 * L-1 (snooze delay units), L-2 (take() due check), L-3 (per-account
 * rotation receipts), L-11 (mention token boundaries), L-12 (inbox-spam
 * injected clock), L-13 (duplicate message ids), L-14 (attachment records
 * quota + expired-row purge), L-15 (regex ReDoS guard), L-44 (negative
 * threadDepth clamp).
 *
 * Each test fails on the pre-fix code for the intended reason and passes
 * after the owner-boundary repair. Run with:
 *   TMPDIR=<worktree>/.tmp node --test tests/audit-wave-low-a.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

import { actionsFor } from "../server/inbox-rules.mjs";
import { createSendLaterStore } from "../server/inbox-send-later.mjs";
import { InboxStitchStore, inboxStitchSchema } from "../server/inbox-stitch-store.mjs";
import { stitchConfigFromEnv } from "../server/inbox-stitch.mjs";
import { scoreMessage } from "../server/inbox-priority.mjs";
import { createQuarantineQueue } from "../server/inbox-spam.mjs";
import { buildThreads } from "../server/inbox-threads.mjs";
import { InboxAttachmentBytes, inboxAttachmentBytesSchema } from "../server/inbox-attachment-bytes.mjs";
import { attachmentLimits } from "../server/attachment-schema.mjs";
import { createInboxZeroTriage } from "../src/inbox-zero-triage.mjs";

// ---------------------------------------------------------------------------
// L-1: snooze delay validation admits m/h/d/w units (was: only <n>d)
// ---------------------------------------------------------------------------

const ruleMsg = { subject: "hello", body: "hi", hasAttachment: false, spamScore: 0 };
const snoozeRule = delay => [{
  id: "r1",
  conditions: [{ field: "subject", op: "contains", value: "hello" }],
  actions: [{ type: "snooze", delay }],
}];

test("L-1: snooze delays accept 2h, 2m, 2w, 30m (not only <n>d)", () => {
  for (const delay of ["2h", "2m", "2d", "2w", "30m", "1d"]) {
    const actions = actionsFor(snoozeRule(delay), ruleMsg);
    assert.equal(actions.length, 1, `${delay} should be accepted`);
    assert.equal(actions[0].delay, delay);
  }
  for (const delay of ["2H", "2x", "abc", ""]) {
    assert.throws(() => actionsFor(snoozeRule(delay), ruleMsg), /snooze actions need a delay/, `${delay} should be rejected`);
  }
});

// ---------------------------------------------------------------------------
// L-2: take() refuses sends that are not due yet
// ---------------------------------------------------------------------------

test("L-2: take() throws SL_NOT_DUE for a scheduled send before its sendAt", () => {
  let now = 1_700_000_000_000;
  const store = createSendLaterStore({ clock: () => now, id: () => "send-1" });
  const scheduled = store.schedule({ id: "m1" }, { sendAt: now + 60_000 });
  assert.equal(scheduled.state, "scheduled");
  assert.throws(() => store.take([scheduled.id]), err => err.code === "SL_NOT_DUE");
  // due() agrees: nothing is claimable before sendAt
  assert.equal(store.due(now).length, 0);
  // after the deadline both paths agree it is claimable
  now += 61_000;
  assert.equal(store.due(now).length, 1);
  const taken = store.take([scheduled.id]);
  assert.equal(taken[0].state, "ready");
});

// ---------------------------------------------------------------------------
// L-3: salt-rotation receipts carry per-account indexed counts
// ---------------------------------------------------------------------------

const SALT_HEX = randomBytes(32).toString("hex");
const OTHER_SALT_HEX = randomBytes(32).toString("hex");
const stitchCfg = (env = {}) =>
  stitchConfigFromEnv({ STITCHING_ENABLED: "true", STITCH_IDENTITY_SALT: SALT_HEX, ...env });
const tgEnv = (id, ms = 0) => ({
  channel: "telegram",
  message: { id, from: { kind: "user", id: "tg-u1", handle: "@alice", displayName: "Alice" },
    receivedAt: new Date(ms).toISOString(), sentAt: new Date(ms).toISOString() },
});
const putVersion = (db, accountId, sourceId, envelope) => {
  db.prepare("INSERT INTO private_inbox_sources(account_id,id,revision,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(accountId, sourceId, 1, Date.now(), Date.now());
  db.prepare("INSERT INTO private_inbox_versions(account_id,source_id,revision,data_json) VALUES(?,?,1,?)")
    .run(accountId, sourceId, JSON.stringify({ adapter: envelope.channel, envelope }));
};

test("L-3: stitch.rotate receipts report each account's own indexed count", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxStitchSchema);
  db.exec(`CREATE TABLE private_inbox_sources(account_id TEXT, id TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
           CREATE TABLE private_inbox_versions(account_id TEXT, source_id TEXT, revision INTEGER, data_json TEXT);`);
  const stitcher = new InboxStitchStore(db, stitchCfg());
  // acct-a indexes 1 envelope, acct-b indexes 2
  putVersion(db, "acct-a", "tg-1", tgEnv("tg-m1", 0));
  putVersion(db, "acct-b", "tg-2", tgEnv("tg-m2", 0));
  putVersion(db, "acct-b", "tg-3", tgEnv("tg-m3", 0));
  const rotated = stitcher.rebuild({ salt: Buffer.from(OTHER_SALT_HEX, "hex"), epoch: "v2" });
  assert.equal(rotated.accounts, 2);
  const rows = db.prepare("SELECT account_id, payload_json FROM stitch_receipts WHERE action='stitch.rotate'").all();
  assert.equal(rows.length, 2);
  const byAccount = Object.fromEntries(rows.map(r => [r.account_id, JSON.parse(r.payload_json)]));
  assert.equal(byAccount["acct-a"].indexedSources, 1, "acct-a receipt must say 1, not the running total");
  assert.equal(byAccount["acct-b"].indexedSources, 2, "acct-b receipt must say 2, not a cumulative count");
  db.close();
});

// ---------------------------------------------------------------------------
// L-11: mention matching respects token boundaries
// ---------------------------------------------------------------------------

test("L-11: @ann does not match @anna for the mention boost", () => {
  const opts = { mentionTokens: ["@ann"], now: 1_700_000_000_000 };
  const exact = scoreMessage({ id: "m1", body: "hey @ann, look", receivedAt: 1_699_999_900_000 }, opts);
  const prefix = scoreMessage({ id: "m2", body: "hey @anna, look", receivedAt: 1_699_999_900_000 }, opts);
  assert.ok(exact.components.mention > 0, "@ann should earn the mention boost");
  assert.equal(prefix.components.mention, 0, "@anna must not match token @ann");
});

// ---------------------------------------------------------------------------
// L-12: quarantine queue timestamps route through the injected clock
// ---------------------------------------------------------------------------

test("L-12: createQuarantineQueue uses the injected now() for at and reviewedAt", () => {
  let now = 1_700_000_000_000;
  const queue = createQuarantineQueue({ now: () => now });
  const flag = { score: 80, signals: [], quarantine: true };
  const rec = queue.quarantine({ messageId: "m1", flag, channel: "email" });
  assert.equal(rec.at, 1_700_000_000_000);
  now += 5_000;
  const reviewed = queue.review(rec.id, { decision: "confirm_spam", reviewer: "owner" });
  assert.equal(reviewed.reviewedAt, 1_700_000_005_000);
  // default still works without injection
  const live = createQuarantineQueue();
  const before = Date.now();
  const rec2 = live.quarantine({ messageId: "m2", flag, channel: "email" });
  assert.ok(rec2.at >= before && rec2.at <= Date.now());
});

// ---------------------------------------------------------------------------
// L-13: duplicate message ids cannot corrupt the thread tree
// ---------------------------------------------------------------------------

test("L-13: repeated message ids collapse to one node; messageCount excludes duplicates", () => {
  const at = "2026-09-08T12:00:00.000Z";
  const threads = buildThreads([
    { id: "m1", occurredAt: at, threadId: "t" },
    { id: "m1", occurredAt: at, threadId: "t" }, // duplicate occurrence
    { id: "m2", occurredAt: at, threadId: "t", inReplyTo: "m1" },
  ]);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].messageCount, 2, "duplicates must not inflate messageCount");
  assert.equal(threads[0].entries.length, 2, "the flattened tree must not repeat the node");
  const ids = threads[0].entries.map(e => e.message.id).sort();
  assert.deepEqual(ids, ["m1", "m2"]);
});

// ---------------------------------------------------------------------------
// L-14: records quota is a true COUNT(*); expired rows are purged
// ---------------------------------------------------------------------------

test("L-14: expired attachment rows are purged so the records quota stays bounded", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxAttachmentBytesSchema);
  let now = 1_700_000_000_000;
  const attachments = new InboxAttachmentBytes({ db, now: () => now, transaction: fn => fn() });
  const tiny = Buffer.from("x").toString("base64");
  const staged = attachments.put("acct-1", { id: "a1", filename: "a.txt", mediaType: "text/plain", data: tiny });
  assert.equal(staged.status, "staged");
  // advance past the attachment lifetime, then stage another: expiry must
  // purge the old row instead of NULLing its bytes and retaining it
  now += attachmentLimits.lifetimeMs + 1;
  attachments.put("acct-1", { id: "a2", filename: "b.txt", mediaType: "text/plain", data: tiny });
  const rows = db.prepare("SELECT id FROM inbox_attachment_bytes WHERE identity_id='acct-1'").all();
  assert.deepEqual(rows.map(r => r.id), ["a2"], "the expired row must be purged, not retained");
  db.close();
});

// ---------------------------------------------------------------------------
// L-15: caller regexes are length-bounded and reject nested quantifiers
// ---------------------------------------------------------------------------

test("L-15: matches conditions reject >200-char patterns and nested quantifiers", () => {
  const msg = { subject: "hello world", body: "", hasAttachment: false, spamScore: 0 };
  const ruleWith = pattern => [{
    id: "r1",
    conditions: [{ field: "subject", op: "matches", value: pattern }],
    actions: [{ type: "flag", label: "x" }],
  }];
  assert.throws(() => actionsFor(ruleWith("(a+)+$"), msg), /valid regex/, "(a+)+$ is a ReDoS shape");
  assert.throws(() => actionsFor(ruleWith("a*b*+c"), msg), /valid regex/, "stacked quantifiers rejected");
  assert.throws(() => actionsFor(ruleWith("x".repeat(201)), msg), /valid regex/, ">200 chars rejected");
  assert.throws(() => actionsFor(ruleWith("(["), msg), /valid regex/, "invalid regex still rejected");
  // sane patterns keep working, including bounded quantifiers
  const matched = actionsFor(ruleWith("^hello (world|there)$"), msg);
  assert.equal(matched.length, 1);
  const bounded = actionsFor(ruleWith("a{2,4}b"), { ...msg, subject: "aaab" });
  assert.equal(bounded.length, 1);
});

// ---------------------------------------------------------------------------
// L-44: negative threadDepth cannot drag triage scores below zero
// ---------------------------------------------------------------------------

test("L-44: negative threadDepth is clamped to 0 in the triage score", () => {
  const clock = { now: 1_700_000_000_000 };
  let n = 0;
  const triage = createInboxZeroTriage({
    clock: () => clock.now,
    id: () => `t-${(n += 1)}`,
    senderScore: () => 0.95,
  });
  triage.startSession([{
    id: "m-neg",
    sender: "boss@example.com",
    subject: "Quarterly plan",
    receivedAt: clock.now - 3_600_000,
    hasAttachment: false,
    threadDepth: -50,
  }]);
  const got = triage.get("m-neg");
  assert.ok(got.score >= 0, `score must not go negative (got ${got.score})`);
  assert.notEqual(got.bucket, "spam-candidate", "a trusted sender must not land in the spam bucket on depth alone");
});
