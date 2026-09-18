// Cross-channel thread stitching (task #19) — the stitch graph store.
// Hash-only persistence: stitch tables carry HMAC keys, channel names, and
// opaque source ids. Raw emails, handles, and display names are NEVER
// written here; they are read from envelopes in memory and only hashes cross
// the store boundary. The per-installation salt is injected, never stored.
//
// Design: docs/CROSS-CHANNEL-THREAD-STITCHING.md (PR #543).
import { randomUUID } from "node:crypto";
import { normalizeIdentifier, nameSimilarity, candidateKeys, deferReason, scorePair, stitchThreads, STITCH_EPOCH, STITCH_SPLIT_REASONS } from "./inbox-stitch.mjs";

export const inboxStitchSchema = `
CREATE TABLE IF NOT EXISTS stitch_identities (
  account_id   TEXT NOT NULL,
  stitch_key   TEXT NOT NULL,
  id_type      TEXT NOT NULL,
  channel      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  occurrences  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, stitch_key)
);
CREATE TABLE IF NOT EXISTS stitch_links (
  account_id   TEXT NOT NULL,
  stitch_key   TEXT NOT NULL,
  channel      TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  linked_at    TEXT NOT NULL,
  link_rule    TEXT NOT NULL,
  link_score   REAL,
  PRIMARY KEY (account_id, stitch_key, channel, source_id)
);
CREATE TABLE IF NOT EXISTS stitch_revocations (
  account_id   TEXT NOT NULL,
  stitch_key   TEXT NOT NULL,
  channel      TEXT,
  source_id    TEXT,
  reason       TEXT NOT NULL,
  revoked_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, stitch_key, channel, source_id)
);
CREATE TABLE IF NOT EXISTS stitch_suggestions (
  suggestion_id  TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  stitch_key_a   TEXT NOT NULL,
  stitch_key_b   TEXT NOT NULL,
  channel_a      TEXT NOT NULL,
  channel_b      TEXT NOT NULL,
  score          REAL NOT NULL,
  components_json TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stitch_receipts (
  receipt_id   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  action       TEXT NOT NULL,
  stitch_key   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stitch_links_source ON stitch_links(account_id, source_id);
CREATE INDEX IF NOT EXISTS idx_stitch_links_key ON stitch_links(account_id, stitch_key);
CREATE INDEX IF NOT EXISTS idx_stitch_suggestions_account ON stitch_suggestions(account_id, status);
CREATE INDEX IF NOT EXISTS idx_stitch_receipts_account ON stitch_receipts(account_id);
`;

const keyPattern = /^v[0-9]+:[0-9a-f]{64}$/;
const validSourceId = id => typeof id === "string" && id.length > 0 && id.length <= 512;
// Participant shape per adapter (server/channel-connection.mjs): { kind, id,
// handle, displayName }. Email envelopes carry { name, address } instead.
const participantOf = envelope => {
  const from = envelope?.message?.from;
  if (!from || typeof from !== "object") return null;
  if (typeof from.address === "string") {
    return { kind: "mailbox", id: from.address, handle: from.address, displayName: from.name ?? "" };
  }
  return { kind: from.kind ?? null, id: from.id ?? null, handle: from.handle ?? "", displayName: from.displayName ?? "" };
};
const envelopeSentAt = envelope => envelope?.message?.receivedAt ?? envelope?.message?.sentAt ?? null;
const envelopeSubjects = envelope => {
  const subject = envelope?.message?.subject;
  return typeof subject === "string" && subject.trim() ? [subject] : [];
};
// Bounded recent-envelope scan for the probabilistic pass: at most 200
// envelopes per account, newest first.
const RECENT_LIMIT = 200;

// Typed store error: stable machine code for HTTP mapping; the human
// message stays server-side for input errors that echo caller values.
const stitchError = (code, message) => { const error = new Error(message); error.code = code; return error; };

export class InboxStitchStore {
  #db; #now;
  constructor(db, { salt = null, epoch = STITCH_EPOCH, enabled = false, now = () => Date.now() } = {}) {
    if (!db || typeof db.prepare !== "function") throw new Error("InboxStitchStore needs a database");
    this.#db = db;
    this.#now = now;
    this.salt = Buffer.isBuffer(salt) && salt.length === 32 ? salt : null;
    this.epoch = typeof epoch === "string" && /^v[0-9]+$/.test(epoch) ? epoch : STITCH_EPOCH;
    // Inert by default: the importer never calls indexEnvelope and the read
    // path returns empty stitched views until the flag is on.
    this.enabled = Boolean(enabled) && this.salt !== null;
    this.counters = new Map();
  }
  #count(name, n = 1) { this.counters.set(name, (this.counters.get(name) ?? 0) + n); }
  // thread:stitch:* counters. Labels never carry hashed keys or identifier
  // material; the {reason} slot carries only the fixed defer-reason codes.
  snapshot() { return Object.fromEntries(this.counters); }
  verifySchema({ allowAbsent = false } = {}) {
    const missing = [];
    for (const table of ["stitch_identities", "stitch_links", "stitch_revocations", "stitch_suggestions", "stitch_receipts"]) {
      const row = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!row) missing.push(table);
    }
    if (missing.length && !allowAbsent) throw new Error(`stitch schema missing tables: ${missing.join(", ")}`);
    return { present: missing.length === 0, missing };
  }
  // Index one imported envelope. Never throws for unusable input: missing
  // identifiers defer with a fixed reason code and the import proceeds.
  // Must run inside the importer's transaction; callers wrap it so a stitch
  // failure can never roll back ingestion.
  indexEnvelope(accountId, envelope, { sourceId, suggest = true, backfill = true } = {}) {
    if (!this.enabled) { this.#count("thread:stitch:unstitched:stitch_disabled"); return { indexed: false, reason: "stitch_disabled" }; }
    if (typeof accountId !== "string" || !accountId || !validSourceId(sourceId)) return { indexed: false, reason: "no_identifier" };
    const channel = envelope?.channel ?? null;
    const participant = participantOf(envelope);
    const candidates = candidateKeys({ salt: this.salt, epoch: this.epoch, channel, participant });
    if (candidates.length === 0) {
      const reason = deferReason({ channel, participant });
      this.#count(`thread:stitch:unstitched:${reason}`);
      return { indexed: false, reason };
    }
    const now = this.#now(), iso = new Date(now).toISOString();
    let conflicted = false;
    const formed = [];
    for (const { key, type } of candidates) {
      const existing = this.#db.prepare("SELECT * FROM stitch_identities WHERE account_id=? AND stitch_key=?").get(accountId, key);
      if (existing) {
        this.#db.prepare("UPDATE stitch_identities SET last_seen=?, occurrences=occurrences+1 WHERE account_id=? AND stitch_key=?").run(iso, accountId, key);
      } else {
        this.#db.prepare("INSERT INTO stitch_identities(account_id,stitch_key,id_type,channel,kind,first_seen,last_seen,occurrences) VALUES(?,?,?,?,?,?,?,1)")
          .run(accountId, key, type, channel, participant.kind ?? "", iso, iso);
        this.#count("thread:stitch:identity:indexed");
      }
      // Handle-reuse / address-reassignment guard: a second participant with a
      // sharply different display name on the same key quarantines the key.
      const priorNames = this.#db.prepare("SELECT DISTINCT channel, source_id FROM stitch_links WHERE account_id=? AND stitch_key=? AND link_rule != 'quarantined'").all(accountId, key);
      if (existing && priorNames.length > 0) {
        const clash = this.#nameClash(accountId, key, participant);
        if (clash) {
          this.#db.prepare("UPDATE stitch_links SET link_rule='quarantined' WHERE account_id=? AND stitch_key=?").run(accountId, key);
          this.#count("thread:stitch:conflict");
          conflicted = true;
        }
      }
      const inserted = this.#db.prepare(
        "INSERT OR IGNORE INTO stitch_links(account_id,stitch_key,channel,source_id,linked_at,link_rule,link_score) VALUES(?,?,?,?,?,?,NULL)")
        .run(accountId, key, channel, sourceId, iso, conflicted ? "quarantined" : "exact").changes;
      if (inserted && !conflicted) { this.#count("thread:stitch:exact:formed"); formed.push({ key, rule: "exact" }); }
      else formed.push({ key, rule: conflicted ? "quarantined" : "exact", duplicate: !inserted });
    }
    // Probabilistic pass: score this envelope's participant against recent
    // participants on OTHER channels. The per-key suppression inside
    // #suggestPeers (excluding this source) keeps already-established
    // identities from re-suggesting; a brand-new key always gets scored.
    if (suggest && !conflicted) this.#suggestPeers(accountId, { participant, channel, sourceId, sentAt: envelopeSentAt(envelope), candidates, now });
    if (backfill) this.#backfill(accountId, { participant, channel, now });
    return { indexed: true, keys: candidates.map(c => c.key) };
  }
  // Display-name clash detection for the handle-reuse guard. Compares the
  // incoming display name against names on already-linked sources of the same
  // key; a similarity below 0.5 with a non-empty established name flags reuse.
  #nameClash(accountId, key, participant) {
    const incoming = normalizeIdentifier({ type: "displayName", value: participant?.displayName }) ?? "";
    if (!incoming) return false;
    const rows = this.#db.prepare("SELECT source_id FROM stitch_links WHERE account_id=? AND stitch_key=? AND link_rule != 'quarantined' LIMIT 20").all(accountId, key);
    for (const { source_id } of rows) {
      const envelope = this.#latestEnvelope(accountId, source_id);
      const name = normalizeIdentifier({ type: "displayName", value: participantOf(envelope)?.displayName }) ?? "";
      if (name && nameSimilarity(incoming, name) < 0.5) return true;
    }
    return false;
  }
  #latestEnvelope(accountId, sourceId) {
    try {
      const row = this.#db.prepare("SELECT data_json FROM private_inbox_versions WHERE account_id=? AND source_id=? ORDER BY revision DESC LIMIT 1")
        .get(accountId, sourceId);
      return row ? JSON.parse(row.data_json)?.envelope ?? null : null;
    } catch { return null; }
  }
  // One bounded backfill pass: sources already journaled from the same
  // channel-native participant id that have no links yet get linked under the
  // group's established keys. Emits thread:stitch:backfilled.
  #backfill(accountId, { participant, channel, now }) {
    if (!participant?.id) return 0;
    const iso = new Date(now).toISOString();
    let linked = 0;
    for (const { sourceId, envelope } of this.#scanEnvelopes(accountId, channel)) {
      const peer = participantOf(envelope);
      if (!peer || String(peer.id) !== String(participant.id)) continue;
      const keys = candidateKeys({ salt: this.salt, epoch: this.epoch, channel, participant: peer });
      for (const { key } of keys) {
        const done = this.#db.prepare("INSERT OR IGNORE INTO stitch_links(account_id,stitch_key,channel,source_id,linked_at,link_rule,link_score) VALUES(?,?,?,?,?,?,NULL)")
          .run(accountId, key, channel, sourceId, iso, "exact").changes;
        if (done) { linked++; this.#count("thread:stitch:exact:formed"); }
      }
    }
    if (linked > 0) this.#count("thread:stitch:backfilled", linked);
    return linked;
  }
  // One O(N) backfill pass used by rebuild: group sources by (channel,
  // channel-native participant id) and link members that have no links yet
  // under the group's already-established keys.
  #backfillAll(accountId, now) {
    const groups = new Map();
    for (const { sourceId, envelope } of this.#scanEnvelopes(accountId, null)) {
      const channel = envelope?.channel ?? null, participant = participantOf(envelope);
      if (!channel || !participant?.id) continue;
      const gkey = `${channel}:${participant.id}`;
      let group = groups.get(gkey);
      if (!group) { group = { channel, participant, members: [] }; groups.set(gkey, group); }
      group.members.push(sourceId);
    }
    let linked = 0;
    const iso = new Date(now).toISOString();
    for (const { channel, participant, members } of groups.values()) {
      const keys = candidateKeys({ salt: this.salt, epoch: this.epoch, channel, participant });
      if (!keys.length) continue;
      const have = new Set(this.#db.prepare(
        `SELECT source_id FROM stitch_links WHERE account_id=? AND stitch_key IN (${keys.map(() => "?").join(",")}) AND channel=?`)
        .all(accountId, ...keys.map(k => k.key), channel).map(r => r.source_id));
      for (const sourceId of members) {
        if (have.has(sourceId)) continue;
        for (const { key } of keys) {
          if (this.#db.prepare("INSERT OR IGNORE INTO stitch_links(account_id,stitch_key,channel,source_id,linked_at,link_rule,link_score) VALUES(?,?,?,?,?,?,NULL)")
            .run(accountId, key, channel, sourceId, iso, "exact").changes) linked++;
        }
      }
    }
    return linked;
  }
  // Scan journaled envelopes for an account (optionally one channel), newest
  // first, bounded. Reads the existing version journal; never envelopes'
  // bodies beyond the participant fields.
  *#scanEnvelopes(accountId, channel) {
    let rows;
    try {
      rows = this.#db.prepare(
        `SELECT v.source_id AS source_id, v.data_json AS data_json FROM private_inbox_versions v
         JOIN (SELECT source_id, MAX(revision) AS rev FROM private_inbox_versions WHERE account_id=? GROUP BY source_id) m
         ON v.source_id = m.source_id AND v.revision = m.rev
         WHERE v.account_id=? ORDER BY v.rowid DESC LIMIT ?`).all(accountId, accountId, RECENT_LIMIT);
    } catch {
      // No version journal (or an otherwise unreadable one): stitching
      // degrades to the envelope in hand rather than breaking the caller.
      return;
    }
    for (const row of rows) {
      let envelope = null;
      try { envelope = JSON.parse(row.data_json)?.envelope ?? null; } catch { continue; }
      if (!envelope) continue;
      if (channel && envelope.channel !== channel) continue;
      yield { sourceId: row.source_id, envelope };
    }
  }
  // Probabilistic suggestion pass. Scores this envelope's participant against
  // recent participants on other channels; pairs in the suggest/high buckets
  // enter the review queue. Never auto-links. Suggestions dedupe on the
  // unordered key pair.
  #suggestPeers(accountId, { participant, channel, sourceId, sentAt, candidates, now }) {
    const peers = new Map();
    for (const { sourceId: peerId, envelope } of this.#scanEnvelopes(accountId, null)) {
      if (peerId === sourceId) continue;
      if (envelope.channel === channel) continue;
      const peer = participantOf(envelope);
      if (!peer) continue;
      for (const { key } of candidateKeys({ salt: this.salt, epoch: this.epoch, channel: envelope.channel, participant: peer })) {
        let snap = peers.get(key);
        const at = envelopeSentAt(envelope);
        if (!snap) { snap = { key, channel: envelope.channel, handle: peer.handle, displayName: peer.displayName,
          email: envelope.channel === "email" ? peer.handle : "", sentAt: null, sentAts: [], subjects: [] }; peers.set(key, snap); }
        if (at) { snap.sentAts.push(at); if (snap.sentAt === null || at > snap.sentAt) snap.sentAt = at; }
        for (const subject of envelopeSubjects(envelope)) if (!snap.subjects.includes(subject)) snap.subjects.push(subject);
      }
    }
    const current = { handle: participant?.handle ?? "", displayName: participant?.displayName ?? "",
      email: channel === "email" ? (participant?.handle ?? "") : "", sentAt, sentAts: sentAt ? [sentAt] : [], subjects: envelopeSubjects(this.#latestEnvelope(accountId, sourceId)) };
    let made = 0;
    for (const { key: keyA } of candidates) {
      // Suppress keys whose identity is already exactly established by OTHER
      // sources: the envelope's own just-written link must not suppress its
      // first probabilistic pass.
      if (this.#db.prepare("SELECT 1 FROM stitch_links WHERE account_id=? AND stitch_key=? AND source_id != ? AND link_rule IN ('exact','verified') LIMIT 1").get(accountId, keyA, sourceId)) {
        this.#count("thread:stitch:probabilistic:suppressed");
        continue;
      }
      for (const snap of peers.values()) {
        if (snap.channel === channel) continue;
        const keyB = snap.key;
        const pairId = ["sg", ...[keyA, keyB].sort()].join(":");
        if (this.#db.prepare("SELECT 1 FROM stitch_suggestions WHERE account_id=? AND suggestion_id=?").get(accountId, pairId)) continue;
        if (this.#db.prepare("SELECT 1 FROM stitch_revocations WHERE account_id=? AND ((stitch_key=? AND source_id IS NULL) OR (stitch_key IN (?,?) AND source_id IS NOT NULL)) LIMIT 1")
          .get(accountId, keyA, keyA, keyB)) continue;
        const scored = scorePair(current, snap);
        if (scored.bucket === "discard") { this.#count("thread:stitch:probabilistic:discarded"); continue; }
        this.#db.prepare(`INSERT OR IGNORE INTO stitch_suggestions(suggestion_id,account_id,stitch_key_a,stitch_key_b,channel_a,channel_b,
          score,components_json,status,created_at) VALUES(?,?,?,?,?,?,?,?, 'pending', ?)`)
          .run(pairId, accountId, keyA, keyB, channel, snap.channel, scored.score, JSON.stringify(scored.components), now);
        if (this.#db.prepare("SELECT 1 FROM stitch_suggestions WHERE account_id=? AND suggestion_id=?").get(accountId, pairId)) {
          made++; this.#count("thread:stitch:probabilistic:suggested");
        }
      }
      if (made >= 10) break;
    }
    return made;
  }
  // Resolve stitch keys for a batch of source ids (quarantined excluded).
  // stitch_links carries no account column: keys are per-install salted
  // hashes, so cross-account joins are impossible by construction; account
  // scoping happens through the caller's source list.
  linksForSources(accountId, sourceIds) {
    const out = new Map();
    if (!this.enabled || !Array.isArray(sourceIds) || !sourceIds.length) return out;
    const wanted = new Set(sourceIds);
    const rows = this.#db.prepare(
      "SELECT source_id, stitch_key, channel, link_rule, link_score FROM stitch_links WHERE account_id=?").all(accountId);
    for (const row of rows) {
      if (row.link_rule === "quarantined") continue;
      if (wanted.has(row.source_id) && !out.has(row.source_id)) {
        out.set(row.source_id, { stitchKey: row.stitch_key, channel: row.channel, rule: row.link_rule, score: row.link_score });
      }
    }
    return out;
  }
  // Stitched timelines for already-built native threads. Pure merge over the
  // link graph; quarantined links are excluded upstream by linksForSources.
  stitchedTimelines(accountId, threads, { channelOf } = {}) {
    if (!this.enabled || !Array.isArray(threads) || !threads.length) return [];
    const sourceIds = [];
    for (const thread of threads) for (const entry of thread?.entries ?? []) if (entry?.sourceId) sourceIds.push(entry.sourceId);
    const links = this.linksForSources(accountId, sourceIds);
    const linkOf = sourceId => links.get(sourceId)?.stitchKey ?? null;
    // Note: no per-thread channel prefilter here. Native threads are
    // single-channel by construction; stitching merges ACROSS threads, so a
    // per-thread diversity check would filter out everything. The pure merge
    // skips single-channel groups itself.
    return stitchThreads(threads, { linkOf, channelOf: channelOf ?? (sourceId => links.get(sourceId)?.channel ?? null) });
  }
  // Pending review queue, newest/highest score first. Participant briefs are
  // resolved in-session from envelopes (never persisted as review artifacts).
  suggestions(accountId, { limit = 25, resolveParticipant = null } = {}) {
    if (!this.enabled) return [];
    const rows = this.#db.prepare("SELECT * FROM stitch_suggestions WHERE account_id=? AND status='pending' ORDER BY score DESC, created_at DESC LIMIT ?")
      .all(accountId, Math.max(1, Math.min(100, limit ?? 25)));
    return rows.map(row => ({
      suggestionId: row.suggestion_id, channelA: row.channel_a, channelB: row.channel_b,
      score: row.score, components: JSON.parse(row.components_json), createdAt: row.created_at,
      participantA: typeof resolveParticipant === "function" ? this.#briefForKey(accountId, row.stitch_key_a, resolveParticipant) : null,
      participantB: typeof resolveParticipant === "function" ? this.#briefForKey(accountId, row.stitch_key_b, resolveParticipant) : null,
    }));
  }
  #briefForKey(accountId, key, resolveParticipant) {
    const row = this.#db.prepare("SELECT source_id FROM stitch_links WHERE account_id=? AND stitch_key=? LIMIT 1").get(accountId, key);
    return row ? resolveParticipant(row.source_id) : null;
  }
  // Owner confirms a suggestion: both keys' links merge under key A as
  // 'verified', a receipt is journaled, the suggestion resolves.
  // Must run inside a transaction.
  confirm(accountId, { suggestionId, confirmedBy } = {}) {
    if (!this.enabled) throw stitchError("stitch_not_enabled", "stitching is not enabled");
    const sg = this.#db.prepare("SELECT * FROM stitch_suggestions WHERE suggestion_id=? AND account_id=?").get(suggestionId, accountId);
    if (!sg) { const err = new Error("stitch suggestion not found"); err.code = "stitch_suggestion_not_found"; throw err; }
    if (sg.status !== "pending") { const err = new Error("stitch suggestion already resolved"); err.code = "stitch_suggestion_resolved"; throw err; }
    const now = this.#now(), iso = new Date(now).toISOString();
    const keyA = sg.stitch_key_a, keyB = sg.stitch_key_b;
    const mergedSources = this.#db.prepare("SELECT DISTINCT source_id FROM stitch_links WHERE account_id=? AND stitch_key=?").all(accountId, keyB).map(r => r.source_id);
    for (const row of this.#db.prepare("SELECT channel, source_id FROM stitch_links WHERE account_id=? AND stitch_key=?").all(accountId, keyB)) {
      this.#db.prepare("INSERT OR IGNORE INTO stitch_links(account_id,stitch_key,channel,source_id,linked_at,link_rule,link_score) VALUES(?,?,?,?,?,?,?)")
        .run(accountId, keyA, row.channel, row.source_id, iso, "verified", sg.score);
    }
    this.#db.prepare("DELETE FROM stitch_links WHERE account_id=? AND stitch_key=?").run(accountId, keyB);
    this.#db.prepare("UPDATE stitch_suggestions SET status='confirmed' WHERE suggestion_id=?").run(suggestionId);
    const receiptId = this.#receipt(accountId, { action: "stitch.confirm", stitchKey: keyA,
      payload: { suggestionId, mergedSources, score: sg.score, confirmedBy: confirmedBy ?? accountId, at: iso }, now });
    this.#count("thread:stitch:verified:confirmed");
    this.#count("thread:stitch:merged");
    return { suggestionId, stitchKey: keyA, mergedSources, receiptId };
  }
  // Owner dismisses a suggestion: it leaves the review queue, no links form.
  dismiss(accountId, { suggestionId } = {}) {
    if (!this.enabled) throw stitchError("stitch_not_enabled", "stitching is not enabled");
    const sg = this.#db.prepare("SELECT * FROM stitch_suggestions WHERE suggestion_id=? AND account_id=?").get(suggestionId, accountId);
    if (!sg) { const err = new Error("stitch suggestion not found"); err.code = "stitch_suggestion_not_found"; throw err; }
    if (sg.status !== "pending") { const err = new Error("stitch suggestion already resolved"); err.code = "stitch_suggestion_resolved"; throw err; }
    this.#db.prepare("UPDATE stitch_suggestions SET status='dismissed' WHERE suggestion_id=?").run(suggestionId);
    return { suggestionId, dismissed: true };
  }
  // Owner splits a stitched identity. scope "link" (default) removes one
  // source's links; scope "identity" removes every link under the key and
  // writes a key-wide deny-list entry (per-contact opt-out). Splits journal
  // a receipt and are permanent unless the owner re-verifies.
  split(accountId, { stitchKey, sourceId = null, channel = null, reason, scope = "link" } = {}) {
    if (!this.enabled) throw stitchError("stitch_not_enabled", "stitching is not enabled");
    if (typeof stitchKey !== "string" || !keyPattern.test(stitchKey)) throw stitchError("stitch_invalid_input", "split needs a stitch key");
    // Fixed reason vocabulary only: free text could carry a raw identifier
    // into the stitch tables and the immutable receipt.
    if (!STITCH_SPLIT_REASONS.includes(reason)) throw stitchError("stitch_invalid_input", "split reason must be one of " + STITCH_SPLIT_REASONS.join(", "));
    if (!["link", "identity"].includes(scope)) throw stitchError("stitch_invalid_input", "split scope must be link or identity");
    const now = this.#now();
    let removed;
    if (scope === "identity" || !sourceId) {
      removed = this.#db.prepare("DELETE FROM stitch_links WHERE account_id=? AND stitch_key=?").run(accountId, stitchKey).changes;
      this.#db.prepare("INSERT OR IGNORE INTO stitch_revocations(account_id, stitch_key, channel, source_id, reason, revoked_at) VALUES(?,?,NULL,NULL,?,?)")
        .run(accountId, stitchKey, reason, now);
    } else {
      if (!validSourceId(sourceId)) throw stitchError("stitch_invalid_input", "split needs a source id");
      const params = [accountId, stitchKey];
      let sql = "DELETE FROM stitch_links WHERE account_id=? AND stitch_key=?";
      if (channel !== null) { if (typeof channel !== "string" || !channel) throw stitchError("stitch_invalid_input", "split needs a channel"); sql += " AND channel=?"; params.push(channel); }
      sql += " AND source_id=?"; params.push(sourceId);
      removed = this.#db.prepare(sql).run(...params).changes;
      this.#db.prepare("INSERT OR IGNORE INTO stitch_revocations(account_id, stitch_key, channel, source_id, reason, revoked_at) VALUES(?,?,?,?,?,?)")
        .run(accountId, stitchKey, channel, sourceId, reason, now);
    }
    const receiptId = this.#receipt(accountId, { action: "stitch.split", stitchKey,
      payload: { sourceId, channel, scope, reason, removedLinks: removed, at: now }, now });
    this.#count("thread:stitch:split");
    return { stitchKey, removedLinks: removed, receiptId };
  }
  // Immutable receipt journal (mirrors the room's claim/receipt discipline).
  // Payloads carry hashes, scores, and fixed-vocabulary reasons only.
  #receipt(accountId, { action, stitchKey, payload, now }) {
    const receiptId = randomUUID();
    this.#db.prepare("INSERT INTO stitch_receipts(receipt_id,account_id,action,stitch_key,payload_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(receiptId, accountId, action, stitchKey, JSON.stringify(payload ?? {}), now);
    return receiptId;
  }
  // Salt rotation: bump the epoch, drop old-epoch rows, and rebuild the
  // index in one pass from stored envelopes. There is no in-place re-keying.
  // Receipts are audit history and are kept. Must run inside a transaction.
  rebuild({ salt, epoch } = {}) {
    if (!Buffer.isBuffer(salt) || salt.length !== 32) throw stitchError("stitch_invalid_input", "rebuild needs a 32-byte salt");
    if (typeof epoch !== "string" || !/^v[0-9]+$/.test(epoch) || epoch === this.epoch) throw stitchError("stitch_invalid_input", "rebuild needs a new epoch");
    const now = this.#now(), oldPrefix = `${this.epoch}:`;
    // Accounts are derived from stitch state and the source journal, not the
    // accounts table: rotation must work for every store shape that carries
    // stitch tables. Captured before the old-epoch rows are dropped.
    const accountIds = new Set();
    for (const table of ["stitch_revocations", "stitch_suggestions", "stitch_receipts"]) {
      for (const row of this.#db.prepare(`SELECT DISTINCT account_id AS id FROM ${table}`).all()) accountIds.add(row.id);
    }
    try {
      for (const row of this.#db.prepare("SELECT DISTINCT account_id AS id FROM private_inbox_sources").all()) accountIds.add(row.id);
    } catch { /* source journal absent: stitch tables alone still rebuild */ }
    const like = oldPrefix.replace(/[%_\\]/g, "\\$&") + "%";
    this.#db.prepare("DELETE FROM stitch_links WHERE stitch_key LIKE ? ESCAPE '\\'").run(like);
    this.#db.prepare("DELETE FROM stitch_identities WHERE stitch_key LIKE ? ESCAPE '\\'").run(like);
    this.#db.prepare("DELETE FROM stitch_suggestions WHERE stitch_key_a LIKE ? ESCAPE '\\' OR stitch_key_b LIKE ? ESCAPE '\\'").run(like, like);
    this.#db.prepare("DELETE FROM stitch_revocations WHERE stitch_key LIKE ? ESCAPE '\\'").run(like);
    this.salt = salt; this.epoch = epoch; this.enabled = true;
    let indexed = 0, accounts = 0;
    for (const accountId of accountIds) {
      accounts++;
      for (const { sourceId, envelope } of this.#scanEnvelopes(accountId, null)) {
        const result = this.indexEnvelope(accountId, envelope, { sourceId, suggest: false, backfill: false });
        if (result.indexed) indexed++;
      }
      const backfilled = this.#backfillAll(accountId, now);
      if (backfilled > 0) this.#count("thread:stitch:backfilled", backfilled);
      this.#receipt(accountId, { action: "stitch.rotate", stitchKey: `${epoch}:rotation`,
        payload: { fromEpoch: oldPrefix.replace(":", ""), toEpoch: epoch, indexedSources: indexed, at: now }, now });
    }
    return { epoch, accounts, indexed };
  }
}
