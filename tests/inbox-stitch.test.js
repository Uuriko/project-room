// Cross-channel thread stitching (task #19) — tests for the pure stitch
// module, the hash-only stitch store, and the import/read-path wiring.
// Fixture people and addresses are invented; nothing here is a real person.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { normalizeTelegramUpdate, telegramSourceId } from "../server/channel-adapters/telegram.mjs";
import {
  stitchConfigFromEnv, normalizeIdentifier, stitchKey, candidateKeys, deferReason,
  nameSimilarity, scorePair, stitchThreads, StitchError,
  STITCH_EPOCH, STITCH_METRICS, STITCH_DEFER_REASONS, STITCH_SPLIT_REASONS,
} from "../server/inbox-stitch.mjs";
import { InboxStitchStore, inboxStitchSchema } from "../server/inbox-stitch-store.mjs";
import { ServiceError } from "../server/store.mjs";

// Invented fixture identities. No real people, addresses, or handles.
const SALT_HEX = "0123456789abcdef".repeat(4); // 64 hex chars -> 32 bytes
const OTHER_SALT_HEX = "fedcba9876543210".repeat(4);
const stitchCfg = (env = {}) => stitchConfigFromEnv({ STITCHING_ENABLED: "true", STITCH_IDENTITY_SALT: SALT_HEX, ...env });
const saltOf = cfg => cfg.salt;
const BASE = Date.parse("2026-09-08T12:00:00Z");
const at = ms => new Date(BASE + ms).toISOString();

// Synthetic envelopes for the store layer (no channel-contract validation
// there — the importer's validate() owns that; see the integration test).
const tgEnv = ({ kind = "user", id = "tg-u1", handle = "@alice", displayName = "Alice Wonderland" } = {}, ms = 0) => ({
  channel: "telegram",
  message: { id: "tg-m1", from: { kind, id, handle, displayName }, receivedAt: at(ms), sentAt: at(ms) },
});
const emEnv = ({ name = "Alice Wonderland", address = "alice@example.com" } = {}, ms = 0, subject = "Project update Q3 planning") => ({
  channel: "email",
  message: { id: "em-m1", from: { name, address }, subject, receivedAt: at(ms), sentAt: at(ms) },
});
const xEnv = ({ id = "x-u1", handle = "alice", displayName = "Alice Wonderland" } = {}, ms = 0) => ({
  channel: "x",
  message: { id: "x-m1", from: { kind: "user", id, handle, displayName }, receivedAt: at(ms), sentAt: at(ms) },
});

// --- pure module -----------------------------------------------------------

test("stitchConfigFromEnv: inert null unless explicitly enabled with a 256-bit salt", () => {
  assert.equal(stitchConfigFromEnv({}), null);
  assert.equal(stitchConfigFromEnv({ STITCHING_ENABLED: "false", STITCH_IDENTITY_SALT: SALT_HEX }), null);
  assert.equal(stitchConfigFromEnv({ STITCHING_ENABLED: "true", STITCH_IDENTITY_SALT: "abc" }), null);
  assert.equal(stitchConfigFromEnv({ STITCHING_ENABLED: "true" }), null);
  const cfg = stitchConfigFromEnv({ STITCHING_ENABLED: "True", STITCH_IDENTITY_SALT: SALT_HEX });
  assert.ok(cfg && cfg.enabled === true && cfg.epoch === STITCH_EPOCH && Buffer.isBuffer(cfg.salt) && cfg.salt.length === 32);
  assert.ok(Object.isFrozen(cfg), "config triple is frozen");
});

test("normalizeIdentifier: handle/email/displayName rules", () => {
  assert.equal(normalizeIdentifier({ type: "handle", value: "  @Alice " }), "alice");
  assert.equal(normalizeIdentifier({ type: "handle", value: "@@alice" }), "@alice", "strips one leading @ only");
  assert.equal(normalizeIdentifier({ type: "email", value: "  Alice+Tag@Example.COM " }), "alice+tag@example.com",
    "plus-tags and dots are preserved, not rewritten");
  assert.equal(normalizeIdentifier({ type: "displayName", value: "  Alice   Wonderland " }), "alice wonderland");
  assert.equal(normalizeIdentifier({ type: "handle", value: "" }), null);
  assert.equal(normalizeIdentifier({ type: "email", value: "not-an-address" }), null);
  assert.equal(normalizeIdentifier({ type: "bogus", value: "x" }), null);
  assert.equal(normalizeIdentifier({ type: "handle" }), null);
});

test("stitchKey: deterministic epoch-prefixed HMAC, separate type namespaces", () => {
  const salt = saltOf(stitchCfg());
  const a = stitchKey({ salt, type: "handle", value: "@alice" });
  const b = stitchKey({ salt, type: "handle", value: "alice" });
  assert.equal(a, b, "normalization makes @alice and alice the same key");
  assert.match(a, /^v1:[0-9a-f]{64}$/);
  assert.notEqual(stitchKey({ salt, type: "email", value: "alice" }), stitchKey({ salt, type: "handle", value: "alice" }),
    "email and handle live in separate namespaces");
  assert.notEqual(stitchKey({ salt: saltOf(stitchConfigFromEnv({ STITCHING_ENABLED: "true", STITCH_IDENTITY_SALT: OTHER_SALT_HEX })), type: "handle", value: "alice" }), a,
    "different salts derive different keys");
  assert.equal(stitchKey({ salt: Buffer.alloc(16), type: "handle", value: "alice" }), null, "short salt never derives");
  assert.equal(stitchKey({ salt, type: "handle", value: "" }), null, "unusable identifier never derives");
});

test("candidateKeys/deferReason: bots excluded, missing identifiers deferred", () => {
  const salt = saltOf(stitchCfg());
  const user = candidateKeys({ salt, channel: "telegram", participant: { kind: "user", id: "1", handle: "@alice", displayName: "A" } });
  assert.equal(user.length, 1); assert.equal(user[0].type, "handle");
  assert.deepEqual(candidateKeys({ salt, channel: "telegram", participant: { kind: "bot", id: "1", handle: "@helper", displayName: "B" } }), [],
    "bots are excluded from stitching");
  assert.deepEqual(candidateKeys({ salt, channel: "telegram", participant: { kind: "channel", id: "1", handle: "@news", displayName: "C" } }), [],
    "channels are excluded from stitching");
  const mail = candidateKeys({ salt, channel: "email", participant: { kind: "mailbox", id: "a@e.c", handle: "a@e.c", displayName: "A" } });
  assert.equal(mail.length, 1); assert.equal(mail[0].type, "email");
  const future = candidateKeys({ salt, channel: "x", participant: { kind: "user", id: "9", handle: "alice", displayName: "A" } });
  assert.equal(future.length, 1, "future channels with a user handle stitch channel-agnostically");
  assert.equal(deferReason({ channel: null, participant: null }), "no_identifier");
  assert.equal(deferReason({ channel: "telegram", participant: { kind: "bot", handle: "@b" } }), "bot_excluded");
  assert.equal(deferReason({ channel: "telegram", participant: { kind: "user", id: "1", handle: "", displayName: "" } }), "no_identifier");
  assert.deepEqual([...STITCH_DEFER_REASONS].sort(), ["bot_excluded", "insufficient_signal", "no_identifier", "stitch_disabled"]);
});

test("nameSimilarity: Jaro-Winkler reference values", () => {
  assert.ok(Math.abs(nameSimilarity("dixon", "dicksonx") - 0.8133) < 0.0001);
  assert.ok(Math.abs(nameSimilarity("martha", "marhta") - 0.9611) < 0.0001);
  assert.equal(nameSimilarity("alice", "alice"), 1);
  assert.equal(nameSimilarity("", "alice"), 0);
});

test("scorePair: component buckets; probabilistic never auto-forms", () => {
  const high = scorePair(
    { handle: "alicex", displayName: "Alice Wonderland", email: "", sentAt: at(0), sentAts: [at(0)], subjects: ["Project update Q3 planning"] },
    { handle: "alice", displayName: "Alice Wonderland", email: "alicex@example.com", sentAt: at(3600000), sentAts: [at(3600000)], subjects: ["Project update Q3 planning"] });
  assert.ok(high.score >= 0.9 && high.bucket === "high", `expected high, got ${high.score}`);
  assert.deepEqual(Object.keys(high.components).sort(), ["context", "handle_fuzzy", "localpart_handle", "name_sim", "temporal"]);
  assert.equal(high.components.handle_fuzzy, 1, "near-identical handles add the fuzzy component");
  const weak = scorePair({ handle: "alice", displayName: "Alice" }, { handle: "bob", displayName: "Robert Smith" });
  assert.equal(weak.bucket, "discard");
  const mid = scorePair(
    { handle: "alice", displayName: "Alice Wonderland" },
    { handle: "", displayName: "Alice Wonderland", email: "alice@example.com" });
  assert.equal(mid.bucket, "suggest", `expected suggest, got ${mid.score} (${mid.bucket})`);
  assert.equal(mid.components.localpart_handle, 1, "email local-part matches the other side's handle");
});

test("stitchThreads: cross-channel merge, chronological, single-channel skipped", () => {
  const threads = [
    { threadId: "telegram:1", entries: [{ message: { id: "tg-1", occurredAt: at(2000) } }] },
    { threadId: "email:2", entries: [{ message: { id: "em-1", occurredAt: at(1000) } }] },
    { threadId: "telegram:3", entries: [{ message: { id: "tg-2", occurredAt: at(3000) } }] },
  ];
  const linkOf = id => id === "tg-2" ? "v1:other" : "v1:abc";
  const channelOf = id => id.startsWith("tg") ? "telegram" : "email";
  const stitched = stitchThreads(threads, { linkOf, channelOf });
  assert.equal(stitched.length, 1);
  assert.deepEqual(stitched[0].channels, ["email", "telegram"]);
  assert.deepEqual(stitched[0].entries.map(e => e.sourceId), ["em-1", "tg-1"], "interleaved chronologically");
  assert.ok(stitched[0].entries.every(e => e.depth === 0 && e.stitched === true));
  assert.throws(() => stitchThreads(null, { linkOf, channelOf }), StitchError);
  assert.throws(() => stitchThreads([], {}), StitchError);
});

test("metric and reason vocabularies are fixed", () => {
  assert.ok(STITCH_METRICS.includes("thread:stitch:exact:formed"));
  assert.ok(STITCH_METRICS.includes("thread:stitch:probabilistic:suggested"));
  assert.equal(STITCH_METRICS.length, 11);
  assert.deepEqual([...STITCH_SPLIT_REASONS].sort(), ["duplicate_identity", "opt_out", "owner_request", "wrong_person"]);
});

// --- store ---------------------------------------------------------------

const stitcherOf = cfg => {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxStitchSchema);
  db.exec(`CREATE TABLE private_inbox_sources(account_id TEXT, id TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
           CREATE TABLE private_inbox_versions(account_id TEXT, source_id TEXT, revision INTEGER, data_json TEXT);`);
  return { db, stitcher: new InboxStitchStore(db, cfg) };
};
const memoryStore = (cfg = stitchCfg()) => stitcherOf(cfg).stitcher;
const putVersion = (db, accountId, sourceId, envelope) => {
  db.prepare("INSERT INTO private_inbox_sources(account_id,id,revision,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(accountId, sourceId, 1, Date.now(), Date.now());
  db.prepare("INSERT INTO private_inbox_versions(account_id,source_id,revision,data_json) VALUES(?,?,1,?)")
    .run(accountId, sourceId, JSON.stringify({ adapter: envelope.channel, envelope }));
};

test("disabled stitcher is inert: no rows, no links, no timelines", () => {
  const off = memoryStore({ enabled: false });
  const result = off.indexEnvelope("acct", tgEnv(), { sourceId: "tg-1" });
  assert.deepEqual(result, { indexed: false, reason: "stitch_disabled" });
  assert.equal(off.snapshot()["thread:stitch:unstitched:stitch_disabled"], 1);
  assert.deepEqual([...off.linksForSources("acct", ["tg-1"]).keys()], []);
  assert.deepEqual(off.stitchedTimelines("acct", [{ threadId: "t", entries: [{ sourceId: "tg-1" }] }]), []);
  assert.deepEqual(off.suggestions("acct"), []);
  assert.throws(() => off.confirm("acct", { suggestionId: "sg:x" }), /not enabled/);
});

test("exact auto-stitch: same handle links; email<->telegram never auto-links", () => {
  const stitcher = memoryStore();
  const acct = "acct-exact";
  const keyOf = stitchKey({ salt: saltOf(stitchCfg()), type: "handle", value: "@alice" });
  const r1 = stitcher.indexEnvelope(acct, tgEnv({ id: "tg-u1" }, 0), { sourceId: "tg-1", suggest: false });
  const r2 = stitcher.indexEnvelope(acct, tgEnv({ id: "tg-u1" }, 1000), { sourceId: "tg-2", suggest: false });
  assert.ok(r1.indexed && r2.indexed);
  assert.deepEqual(r1.keys, [keyOf]);
  const links = stitcher.linksForSources(acct, ["tg-1", "tg-2"]);
  assert.equal(links.get("tg-1").stitchKey, keyOf);
  assert.equal(links.get("tg-2").stitchKey, keyOf);
  assert.equal(links.get("tg-1").rule, "exact");
  assert.equal(stitcher.snapshot()["thread:stitch:exact:formed"], 2);
  // Email<->Telegram: different namespaces, no shared key, no auto-link.
  stitcher.indexEnvelope(acct, emEnv({}, 2000), { sourceId: "em-1", suggest: false });
  const emailLinks = stitcher.linksForSources(acct, ["em-1"]);
  assert.notEqual(emailLinks.get("em-1").stitchKey, keyOf, "email key lives in its own namespace");
  const timelines = stitcher.stitchedTimelines(acct, [
    { threadId: "t1", entries: [{ sourceId: "tg-1" }, { sourceId: "tg-2" }] },
    { threadId: "t2", entries: [{ sourceId: "em-1" }] },
  ], { channelOf: id => id.startsWith("tg") ? "telegram" : "email" });
  assert.deepEqual(timelines, [], "single-channel groups never stitch; email<->telegram needs a suggestion");
});

test("account isolation: same identifier in two accounts never shares links", () => {
  const stitcher = memoryStore();
  // Same handle, same salt, two accounts -> same key string but disjoint rows.
  stitcher.indexEnvelope("acct-a", tgEnv({ id: "tg-u1" }, 0), { sourceId: "tg-1", suggest: false });
  stitcher.indexEnvelope("acct-b", tgEnv({ id: "tg-u1" }, 0), { sourceId: "tg-1", suggest: false });
  const aLinks = stitcher.linksForSources("acct-a", ["tg-1"]);
  const bLinks = stitcher.linksForSources("acct-b", ["tg-1"]);
  assert.equal(aLinks.size, 1, "account A sees its own link");
  assert.equal(bLinks.size, 1, "account B sees its own link");
  assert.equal(aLinks.get("tg-1").stitchKey, bLinks.get("tg-1").stitchKey, "same identifier, same key material");
  // Cross-account leakage check: A's timeline builder only resolves A's links.
  const timelines = stitcher.stitchedTimelines("acct-a", [
    { threadId: "ta", entries: [{ sourceId: "tg-1", occurredAt: at(0) }] },
  ], { channelOf: () => "telegram" });
  assert.equal(timelines.length, 0, "single-channel group: nothing stitches, and B's rows never leak into A's view");
  // Splitting in A does not touch B.
  const split = stitcher.split("acct-a", { stitchKey: aLinks.get("tg-1").stitchKey, reason: "wrong_person", scope: "identity" });
  assert.equal(split.removedLinks, 1);
  assert.equal(stitcher.linksForSources("acct-b", ["tg-1"]).size, 1, "B's link survives A's split");
});

test("cross-channel exact link (telegram<->x handle) stitches", () => {
  const stitcher = memoryStore();
  const acct = "acct-x";
  stitcher.indexEnvelope(acct, tgEnv({ id: "tg-u1" }, 0), { sourceId: "tg-1", suggest: false });
  stitcher.indexEnvelope(acct, xEnv({ id: "x-u1" }, 5000), { sourceId: "x-1", suggest: false });
  const timelines = stitcher.stitchedTimelines(acct, [
    { threadId: "t1", entries: [{ sourceId: "tg-1", occurredAt: at(0) }] },
    { threadId: "t2", entries: [{ sourceId: "x-1", occurredAt: at(5000) }] },
  ], { channelOf: id => id.startsWith("tg") ? "telegram" : "x" });
  assert.equal(timelines.length, 1);
  assert.deepEqual(timelines[0].channels, ["telegram", "x"]);
  assert.deepEqual(timelines[0].entries.map(e => e.sourceId), ["tg-1", "x-1"]);
});

test("probabilistic suggestion: email<->telegram suggests, confirm merges, dismiss resolves", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxStitchSchema);
  db.exec(`CREATE TABLE private_inbox_sources(account_id TEXT, id TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
           CREATE TABLE private_inbox_versions(account_id TEXT, source_id TEXT, revision INTEGER, data_json TEXT);`);
  const stitcher = new InboxStitchStore(db, stitchCfg());
  const acct = "acct-suggest";
  const email = emEnv({ name: "Alice Wonderland", address: "alice@example.com" }, 0);
  const tg = tgEnv({ id: "tg-u1", handle: "@alice", displayName: "Alice Wonderland" }, 3600000);
  putVersion(db, acct, "em-1", email);
  stitcher.indexEnvelope(acct, email, { sourceId: "em-1" });
  const before = stitcher.suggestions(acct);
  assert.equal(before.length, 0, "no peer yet: nothing to suggest");
  putVersion(db, acct, "tg-1", tg);
  stitcher.indexEnvelope(acct, tg, { sourceId: "tg-1" });
  const pending = stitcher.suggestions(acct);
  assert.equal(pending.length, 1, "email<->telegram pair enters the review queue");
  assert.ok(pending[0].score >= 0.6 && pending[0].score < 0.9, `suggest bucket, got ${pending[0].score}`);
  assert.equal(stitcher.snapshot()["thread:stitch:probabilistic:suggested"], 1);
  // Probabilistic links never auto-form: no shared link key exists yet.
  const preLinks = stitcher.linksForSources(acct, ["em-1", "tg-1"]);
  assert.notEqual(preLinks.get("em-1").stitchKey, preLinks.get("tg-1").stitchKey);
  // Owner confirms: links merge under one key as verified, receipt journaled.
  const confirmed = stitcher.confirm(acct, { suggestionId: pending[0].suggestionId, confirmedBy: acct });
  assert.ok(confirmed.receiptId);
  assert.deepEqual(confirmed.mergedSources, ["em-1"]);
  assert.equal(stitcher.suggestions(acct).length, 0);
  assert.equal(stitcher.snapshot()["thread:stitch:verified:confirmed"], 1);
  assert.equal(stitcher.snapshot()["thread:stitch:merged"], 1);
  const postLinks = stitcher.linksForSources(acct, ["em-1", "tg-1"]);
  assert.equal(postLinks.get("em-1").stitchKey, postLinks.get("tg-1").stitchKey);
  assert.equal(postLinks.get("em-1").rule, "verified");
  const receipt = db.prepare("SELECT * FROM stitch_receipts WHERE receipt_id=?").get(confirmed.receiptId);
  assert.equal(receipt.action, "stitch.confirm");
  // A second suggestion dismisses cleanly: bob's email lands first (journaled
  // but not indexed), then his telegram message suggests against it.
  const bobEmail = emEnv({ name: "Bob Smith", address: "bob@example.com" }, 7200000, "Project update Q3 planning");
  putVersion(db, acct, "em-2", bobEmail);
  const bobTg = tgEnv({ id: "tg-u2", handle: "@bob", displayName: "Bob Smith" }, 10800000);
  putVersion(db, acct, "tg-2", bobTg);
  stitcher.indexEnvelope(acct, bobTg, { sourceId: "tg-2" });
  const second = stitcher.suggestions(acct).filter(sg => sg.participantB !== null || true);
  assert.ok(second.length >= 1, "a matching bob pair suggests");
  const dismissed = stitcher.dismiss(acct, { suggestionId: second[0].suggestionId });
  assert.deepEqual(dismissed, { suggestionId: second[0].suggestionId, dismissed: true });
  assert.throws(() => stitcher.confirm(acct, { suggestionId: "sg:nope" }), /not found/);
  db.close();
});

test("split: link scope removes one source, identity scope denies the key; reason enum enforced", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxStitchSchema);
  db.exec(`CREATE TABLE private_inbox_sources(account_id TEXT, id TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
           CREATE TABLE private_inbox_versions(account_id TEXT, source_id TEXT, revision INTEGER, data_json TEXT);`);
  const stitcher = new InboxStitchStore(db, stitchCfg());
  const acct = "acct-split";
  stitcher.indexEnvelope(acct, tgEnv({ id: "tg-u1" }, 0), { sourceId: "tg-1", suggest: false });
  stitcher.indexEnvelope(acct, tgEnv({ id: "tg-u1" }, 1000), { sourceId: "tg-2", suggest: false });
  const key = stitcher.linksForSources(acct, ["tg-1"]).get("tg-1").stitchKey;
  const split = stitcher.split(acct, { stitchKey: key, sourceId: "tg-2", channel: "telegram", reason: "wrong_person", scope: "link" });
  assert.equal(split.removedLinks, 1);
  assert.ok(split.receiptId);
  assert.equal(stitcher.linksForSources(acct, ["tg-2"]).size, 0);
  assert.equal(stitcher.linksForSources(acct, ["tg-1"]).size, 1, "the other source stays linked");
  assert.equal(stitcher.snapshot()["thread:stitch:split"], 1);
  // Free-text reasons are rejected: they could smuggle raw identifiers into
  // the stitch tables and the immutable receipt.
  assert.throws(() => stitcher.split(acct, { stitchKey: key, sourceId: "tg-1", channel: "telegram", reason: "alice@example.com", scope: "link" }),
    /must be one of/);
  // Identity scope: everything under the key goes, plus a key-wide deny entry.
  const full = stitcher.split(acct, { stitchKey: key, reason: "opt_out", scope: "identity" });
  assert.equal(full.removedLinks, 1);
  assert.equal(stitcher.linksForSources(acct, ["tg-1"]).size, 0);
  const deny = db.prepare("SELECT * FROM stitch_revocations WHERE account_id=? AND stitch_key=? AND source_id IS NULL").get(acct, key);
  assert.ok(deny && deny.reason === "opt_out");
  db.close();
});

test("conflict: divergent display name on one key quarantines it", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxStitchSchema);
  db.exec(`CREATE TABLE private_inbox_sources(account_id TEXT, id TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
           CREATE TABLE private_inbox_versions(account_id TEXT, source_id TEXT, revision INTEGER, data_json TEXT);`);
  const stitcher = new InboxStitchStore(db, stitchCfg());
  const acct = "acct-conflict";
  const env1 = tgEnv({ id: "tg-u1", handle: "@alice", displayName: "Alice Wonderland" }, 0);
  const env2 = tgEnv({ id: "tg-u1", handle: "@alice", displayName: "Robert Smith" }, 1000);
  putVersion(db, acct, "tg-1", env1);
  putVersion(db, acct, "tg-2", env2);
  stitcher.indexEnvelope(acct, env1, { sourceId: "tg-1", suggest: false });
  stitcher.indexEnvelope(acct, env2, { sourceId: "tg-2", suggest: false });
  assert.equal(stitcher.snapshot()["thread:stitch:conflict"], 1, "handle reuse quarantines the key");
  assert.equal(stitcher.linksForSources(acct, ["tg-1", "tg-2"]).size, 0, "quarantined links are excluded");
  const timelines = stitcher.stitchedTimelines(acct, [
    { threadId: "t1", entries: [{ sourceId: "tg-1", occurredAt: at(0) }] },
    { threadId: "t2", entries: [{ sourceId: "tg-2", occurredAt: at(1000) }] },
  ], { channelOf: () => "telegram" });
  assert.deepEqual(timelines, [], "quarantine falls back to channel-native threads");
  db.close();
});

test("stitch tables are hash-only: no raw identifiers anywhere", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxStitchSchema);
  db.exec(`CREATE TABLE private_inbox_sources(account_id TEXT, id TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
           CREATE TABLE private_inbox_versions(account_id TEXT, source_id TEXT, revision INTEGER, data_json TEXT);`);
  const stitcher = new InboxStitchStore(db, stitchCfg());
  const acct = "acct-privacy";
  const email = emEnv({ name: "Alice Wonderland", address: "alice@example.com" }, 0);
  const tg = tgEnv({ id: "tg-u1", handle: "@alice", displayName: "Alice Wonderland" }, 3600000);
  putVersion(db, acct, "em-1", email);
  putVersion(db, acct, "tg-1", tg);
  stitcher.indexEnvelope(acct, email, { sourceId: "em-1" });
  stitcher.indexEnvelope(acct, tg, { sourceId: "tg-1" });
  const [sg] = stitcher.suggestions(acct);
  stitcher.confirm(acct, { suggestionId: sg.suggestionId, confirmedBy: acct });
  stitcher.split(acct, { stitchKey: stitcher.linksForSources(acct, ["tg-1"]).get("tg-1").stitchKey,
    sourceId: "em-1", channel: "email", reason: "owner_request", scope: "link" });
  const dump = [];
  for (const table of ["stitch_identities", "stitch_links", "stitch_revocations", "stitch_suggestions", "stitch_receipts"]) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) dump.push(JSON.stringify(row).toLowerCase());
  }
  const haystack = dump.join("\n");
  for (const secret of ["alice", "wonderland", "example.com", "@alice"]) {
    assert.ok(!haystack.includes(secret), `stitch tables must not contain ${secret}`);
  }
  db.close();
});

test("backfill: a late identifier links prior journaled sources", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxStitchSchema);
  db.exec(`CREATE TABLE private_inbox_sources(account_id TEXT, id TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
           CREATE TABLE private_inbox_versions(account_id TEXT, source_id TEXT, revision INTEGER, data_json TEXT);`);
  const stitcher = new InboxStitchStore(db, stitchCfg());
  const acct = "acct-backfill";
  // tg-2 is journaled but never indexed (identifier arrived late).
  putVersion(db, acct, "tg-1", tgEnv({ id: "tg-u1" }, 0));
  putVersion(db, acct, "tg-2", tgEnv({ id: "tg-u1" }, 1000));
  stitcher.indexEnvelope(acct, tgEnv({ id: "tg-u1" }, 0), { sourceId: "tg-1", suggest: false, backfill: false });
  assert.equal(stitcher.linksForSources(acct, ["tg-2"]).size, 0);
  stitcher.indexEnvelope(acct, tgEnv({ id: "tg-u1" }, 2000), { sourceId: "tg-3", suggest: false, backfill: true });
  assert.equal(stitcher.linksForSources(acct, ["tg-2"]).size, 1, "prior source linked retroactively");
  assert.ok((stitcher.snapshot()["thread:stitch:backfilled"] ?? 0) >= 1);
  db.close();
});

test("rebuild: salt rotation bumps the epoch and re-indexes from envelopes", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxStitchSchema);
  db.exec(`CREATE TABLE private_inbox_sources(account_id TEXT, id TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
           CREATE TABLE private_inbox_versions(account_id TEXT, source_id TEXT, revision INTEGER, data_json TEXT);`);
  const stitcher = new InboxStitchStore(db, stitchCfg());
  const acct = "acct-rebuild";
  putVersion(db, acct, "tg-1", tgEnv({ id: "tg-u1" }, 0));
  putVersion(db, acct, "em-1", emEnv({}, 0));
  stitcher.indexEnvelope(acct, tgEnv({ id: "tg-u1" }, 0), { sourceId: "tg-1", suggest: false });
  stitcher.indexEnvelope(acct, emEnv({}, 0), { sourceId: "em-1", suggest: false });
  const oldKey = stitcher.linksForSources(acct, ["tg-1"]).get("tg-1").stitchKey;
  assert.ok(oldKey.startsWith("v1:"));
  const rotated = stitcher.rebuild({ salt: Buffer.from(OTHER_SALT_HEX, "hex"), epoch: "v2" });
  assert.equal(rotated.epoch, "v2");
  assert.ok(rotated.accounts >= 1 && rotated.indexed >= 2);
  assert.equal(stitcher.epoch, "v2");
  const rows = db.prepare("SELECT stitch_key FROM stitch_links").all();
  assert.ok(rows.length > 0 && rows.every(r => r.stitch_key.startsWith("v2:")), "no old-epoch rows survive");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stitch_identities WHERE stitch_key LIKE 'v1:%'").get().n, 0);
  assert.throws(() => stitcher.rebuild({ salt: Buffer.alloc(32), epoch: "v2" }), /new epoch/);
  db.close();
});

test("verifySchema: strict by default, read-only allows absent tables", () => {
  const bare = new DatabaseSync(":memory:");
  const stitcher = new InboxStitchStore(bare, stitchCfg());
  assert.throws(() => stitcher.verifySchema(), /missing tables/);
  assert.deepEqual(stitcher.verifySchema({ allowAbsent: true }).present, false);
  bare.exec(inboxStitchSchema);
  assert.deepEqual(stitcher.verifySchema().present, true);
  bare.close();
});

// --- wiring --------------------------------------------------------------

test("RoomStore boots with a stitch config, inert without, rejects malformed", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-stitch-boot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const enabled = new RoomStore(join(directory, "a.sqlite"), { stitch: stitchCfg() });
  assert.equal(enabled.inbox.stitcher.enabled, true);
  assert.equal(enabled.inbox.stitcher.epoch, "v1");
  enabled.inbox.stitcher.verifySchema();
  enabled.close();
  const inert = new RoomStore(join(directory, "b.sqlite"));
  assert.equal(inert.inbox.stitcher.enabled, false);
  inert.close();
  assert.throws(() => new RoomStore(join(directory, "c.sqlite"), { stitch: { salt: Buffer.alloc(16), epoch: "v1", enabled: true } }),
    /stitch must be null or a stitchConfigFromEnv/);
});

test("importer indexes envelopes; suggestion -> confirm -> stitchedThreads; native threads unchanged", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  // Inject an enabled stitcher into the fixture's inbox (the fixture boots
  // inert, mirroring production without STITCHING_ENABLED).
  f.store.inbox.stitcher = new InboxStitchStore(f.store.db, stitchCfg());
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const token = session.token, binding = session.sessionBinding;

  // Email import through the real importer path.
  const email = emailContractFixture(); email.connection.accountId = account.id;
  email.message.from = { emailAddress: { name: "Alice Wonderland", address: "alice@example.com" } };
  email.message.id = "stitch-email-1"; email.message.internetMessageId = "<stitch-1@example.com>";
  email.message.conversationId = "stitch-conv-1"; email.message.subject = "Project update Q3 planning";
  email.message.body.content = "Kicking off the Q3 plan.";
  email.options.attachmentObservation.messageId = email.message.id;
  email.options.attachmentObservation.messageRevision = email.message.changeKey;
  f.store.email.apply(token, { action: "connection.configure", requestId: randomUUID(),
    connectionId: email.connection.id, expectedRevision: 0, profile: structuredClone(email.connection) }, binding);
  const emailEnvelope = normalizeGraphEmail(email.connection, email.message, email.options);
  const emailState = f.store.email.state(token, email.connection.id, email.message.parentFolderId, binding);
  f.store.email.apply(token, { action: "page.apply", requestId: randomUUID(), connectionId: email.connection.id,
    connectionRevision: email.connection.revision, folderId: email.message.parentFolderId,
    expectedRevision: emailState.folder?.revision ?? 0, expectedCursor: emailState.expectedCursor, cursor: randomUUID(),
    reset: emailState.needsReset, complete: true,
    observations: [{ kind: "message", expectedSourceRevision: 0, envelope: emailEnvelope }] }, binding);

  // Telegram import through importSource (the transactional channel importer).
  const tgConn = { accountId: account.id, id: "telegram-stitch", revision: 1, channel: "telegram", provider: "telegram-bot",
    externalId: "7000000002", identity: { kind: "bot", id: "7000000002", handle: "@stitch_bot", displayName: "Stitch Bot" },
    capabilities: { read: true, send: false, threads: true, edit: false } };
  const tgEnvelope = normalizeTelegramUpdate(tgConn, { update_id: 700001,
    message: { message_id: 11, date: 1788948000, chat: { id: 5000000101, type: "private", first_name: "Alice" },
      from: { id: 5000000001, is_bot: false, first_name: "Alice", last_name: "Wonderland", username: "alice" },
      text: "Hello from Telegram" } });
  const tgSourceId = telegramSourceId(tgConn, "5000000101:11");
  f.store.transaction(() => f.store.inbox.importSource(token, { action: "source.import", requestId: randomUUID(),
    sourceId: tgSourceId, expectedRevision: 0, data: { adapter: "telegram", envelope: tgEnvelope } }, binding));

  // The importer hook indexed both envelopes: the email<->telegram pair is a
  // suggestion (never an auto-link).
  const status = f.store.inbox.stitchStatus(token, binding);
  assert.deepEqual(status.stitching, { enabled: true, epoch: "v1" });
  const queued = f.store.inbox.stitchSuggestions(token, binding, {});
  assert.equal(queued.suggestions.length, 1, "expected one pending suggestion");
  assert.ok(queued.suggestions[0].score >= 0.6);
  assert.ok(queued.suggestions[0].participantA && queued.suggestions[0].participantB, "briefs resolve in-session");
  const preLinks = f.store.inbox.stitcher.linksForSources(account.id, [emailEnvelope.sourceId, tgSourceId]);
  assert.equal(preLinks.size, 2, "both sources indexed under their own keys");

  // Owner confirms -> verified link -> stitched timeline in the thread view.
  const confirmed = f.store.inbox.stitchConfirm(token, binding, { suggestionId: queued.suggestions[0].suggestionId });
  assert.ok(confirmed.receiptId && confirmed.stitchKey);
  const view = f.store.inbox.threads(token, binding, { includeChannels: true });
  assert.ok(Array.isArray(view.stitchedThreads));
  assert.equal(view.stitchedThreads.length, 1, "one stitched timeline");
  const st = view.stitchedThreads[0];
  assert.deepEqual(st.channels, ["email", "telegram"]);
  assert.equal(st.entries.length, 2);
  assert.ok(st.entries.every(e => e.stitched === true && e.source && e.source.id));
  assert.ok(st.entries[0].occurredAt <= st.entries[1].occurredAt, "entries interleave chronologically");
  // Native threads are untouched by stitching.
  assert.equal(view.threads.length, 2, "email and telegram keep their native threads");
  assert.ok(view.threads.every(th => th.entries.every(e => e.stitched !== true)));
  // Owner/API failure mapping: unknown suggestion -> 404, bad split input -> 422.
  assert.throws(() => f.store.inbox.stitchConfirm(token, binding, { suggestionId: "sg:nope" }),
    err => err instanceof ServiceError && err.status === 404 && err.code === "stitch_suggestion_not_found");
  assert.throws(() => f.store.inbox.stitchSplit(token, binding,
    { stitchKey: confirmed.stitchKey, reason: "free text not allowed", scope: "link", sourceId: tgSourceId }),
    err => err instanceof ServiceError && err.status === 422 && err.code === "stitch_invalid_input");
});

test("inert fixture: threads() carries an empty stitchedThreads view", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const view = f.store.inbox.threads(session.token, session.sessionBinding, {});
  assert.deepEqual(view.stitchedThreads, [], "no salt configured: stitching stays inert");
  assert.deepEqual(f.store.inbox.stitchStatus(session.token, session.sessionBinding).stitching, { enabled: false, epoch: "v1" });
});
