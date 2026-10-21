// Shared agent memory and owner-taught rules, one store per person (account).
//
// Every agent a person connects (Claude Code, Codex, Cursor, Grok Bot) reads
// and writes the same store through REST and MCP. The store is keyed by the
// caller's own account, resolved server side: a person member through
// member_accounts, an agent through its agent_connections sponsor or the
// invite it joined by. Nobody can name another account.
//
// Memories (facts): ADD-only with valid_at/invalid_at, every entry carries its
// source and trust. Retrieval is top 5 above a relevance floor, scored by
// relevance, recency and importance. Low-trust entries come back fenced as data.
//
// Rules (standing instructions), following docs/agent-memory.md:
//   only the owner's own turns create rules; room content, tool output and
//   other agents never do
//   one trigger plus one action, at most 200 characters; vague rules rejected
//   scope global | room:<id> | tool:<name> | path:<glob>, optional trigger
//   new rules are proposed; active after owner confirm or a repeated correction
//   write path compares one candidate with its top 5 neighbours: add, merge,
//   conflict or noop. Merges and cross-author conflicts wait for the owner and
//   can be undone. Superseded rules get invalid_at and stay in history.
//   caps: 8 global, 8 per room, 4 per-agent overrides; injected per turn at
//   most 12 rules and 600 tokens, hard constraints first, then helpful minus
//   harmful, then recency
//   dormancy keys on triggers: 30 days scoped, 60 days global; never deleted
//   automatically; a rule with harmful >= 2 is flagged
import { randomUUID } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { ownMember } from "../src/events.js";

export const LIMITS = Object.freeze({ ruleMaxChars: 200, noteMaxChars: 1000, globalCap: 8, roomCap: 8, agentCap: 4,
  injectRules: 12, injectTokens: 600, onboardingTokens: 400, topK: 5, relevanceFloor: 0.34,
  dormantScopedDays: 30, dormantGlobalDays: 60, flagHarmful: 2 });
const DAY = 24 * 3600 * 1000;
export const AGENT_MEMORY_TABLES = Object.freeze(["agent_memories", "agent_rules", "agent_memory_scans"]);
const TRUST = Object.freeze({ owner: "high", agent: "medium", room: "low", tool: "low", web: "low", email: "low" });

const SCHEMA = `CREATE TABLE IF NOT EXISTS agent_memories (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, text TEXT NOT NULL, norm TEXT NOT NULL, topic TEXT,
  source TEXT NOT NULL, trust TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 3, author_id TEXT NOT NULL,
  request_id TEXT NOT NULL, valid_at INTEGER NOT NULL, invalid_at INTEGER, UNIQUE(account_id, request_id));
CREATE INDEX IF NOT EXISTS agent_memories_account ON agent_memories(account_id, invalid_at);
CREATE TABLE IF NOT EXISTS agent_rules (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, text TEXT NOT NULL, trigger TEXT, scope TEXT NOT NULL,
  agent_key TEXT NOT NULL DEFAULT '*', hard INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('proposed','active','superseded')), pending TEXT, prev_text TEXT,
  author_id TEXT NOT NULL, source_turn TEXT NOT NULL, request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, valid_at INTEGER, invalid_at INTEGER, superseded_by TEXT,
  helpful INTEGER NOT NULL DEFAULT 0, harmful INTEGER NOT NULL DEFAULT 0, corrections INTEGER NOT NULL DEFAULT 1,
  last_triggered_at INTEGER, UNIQUE(account_id, request_id));
CREATE INDEX IF NOT EXISTS agent_rules_account ON agent_rules(account_id, status);
CREATE TABLE IF NOT EXISTS agent_memory_scans (room_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)`;
const ready = new WeakSet();
export function ensureAgentMemory(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
export const tokens = text => Math.ceil(String(text).length / 4);
const STOP = new Set("a an the to of and or in on for with is are be it this that you your my our at by as from i me".split(" "));
const NEG = new Set(["no", "not", "never", "dont", "don't", "avoid", "stop", "without"]);
export const normalize = text => String(text).toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
function words(text) {
  const all = normalize(text).split(" ").filter(Boolean);
  return { neg: all.some(w => NEG.has(w)), keys: new Set(all.filter(w => !STOP.has(w) && !NEG.has(w)).map(w => w.replace(/'/g, ""))) };
}
const jaccard = (a, b) => { const inter = [...a].filter(w => b.has(w)).length; const union = new Set([...a, ...b]).size; return union ? inter / union : 0; };
export function similarity(a, b) { return jaccard(words(a).keys, words(b).keys); }
// One candidate against one neighbour: duplicate, conflict, merge or null.
export function relation(newText, oldText) {
  if (normalize(newText) === normalize(oldText)) return "duplicate";
  const a = words(newText), b = words(oldText), sim = jaccard(a.keys, b.keys);
  if (sim >= 0.6) return a.neg === b.neg ? "duplicate" : "conflict";
  if (sim >= 0.35) return "merge";
  return null;
}
const SECRET = /\b(rak_|ghp_|gho_|github_pat_|sk-|xox[bp]-|AKIA)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const VAGUE = /^(be (careful|better|smart|good|nice)|do (better|good)|try harder|pay attention|think)\b/i;
const TRIGGERISH = /\b(when|whenever|before|after|if|during|on|in|for|always|never|every|each|while|unless)\b/i;
export function vague(text, trigger) {
  const n = normalize(text);
  if (VAGUE.test(n) || words(text).keys.size < 3) return true;
  return !trigger && !TRIGGERISH.test(n);
}

// Whose memory is this? Never taken from the request.
export function ownerOf(store, auth, roomId) {
  const db = store.db, memberId = auth?.member?.id;
  if (!memberId) fail(401, "unauthenticated", "Room membership required");
  const key = `${roomId}/${memberId}`;
  const person = db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(roomId, memberId);
  if (person && auth.member.kind !== "agent") return { accountId: person.account_id, person: true, agentKey: key };
  const one = sql => { try { return db.prepare(sql).get(roomId, memberId); } catch { return null; } };
  const sponsor = one("SELECT sponsor_account_id a FROM agent_connections WHERE room_id=? AND member_id=? AND status='issued'")
    // An identity agent that joined through an invite belongs to the person who made the invite.
    ?? one(`SELECT ma.account_id a FROM identity_links l JOIN agent_invite_codes c ON c.room_id=l.room_id AND c.redeemed_identity_id=l.identity_id
      JOIN member_accounts ma ON ma.room_id=c.room_id AND ma.member_id=c.created_by WHERE l.room_id=? AND l.member_id=? ORDER BY c.redeemed_at DESC LIMIT 1`);
  if (sponsor) return { accountId: sponsor.a, person: false, agentKey: key };
  if (person) return { accountId: person.account_id, person: false, agentKey: key };
  return fail(403, "no_owner_account", "This member is not connected by a person account, so it has no shared memory");
}
const requireOwner = owner => { if (!owner.person) fail(403, "owner_required", "Only the owner does this"); };
const iso = ms => ms == null ? null : new Date(ms).toISOString();
function requestIdOf(data) {
  if (!data || typeof data.requestId !== "string" || !data.requestId || data.requestId.length > 128) fail(422, "invalid_memory", "Supply requestId and text");
  return data.requestId;
}
function cleanText(text, max, code) {
  const clean = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  if (!clean || clean.length > max) fail(422, code, `text is 1 to ${max} characters`);
  return clean;
}

// ---- memories -------------------------------------------------------------

const fence = text => `<untrusted-data>${text}</untrusted-data>`;
const memoryView = (row, extra = {}) => ({ id: row.id, text: row.trust === "low" ? fence(row.text) : row.text, source: row.source, trust: row.trust,
  ...(row.trust === "low" ? { untrusted: true } : {}), importance: row.importance, topic: row.topic ?? null, validAt: iso(row.valid_at), ...extra });

function allowedTopics(store, roomId, memberId) {
  try { const row = store.db.prepare("SELECT share FROM sharing_limits WHERE room_id=? AND member_id=?").get(roomId, memberId); return row ? JSON.parse(row.share) : ["code"]; }
  catch { return ["code"]; }
}
// Notes tagged with a sharing kind are withheld from agents whose sharing limit leaves that kind out.
const visible = (store, roomId, owner, memberId) => row => owner.person || !row.topic || allowedTopics(store, roomId, memberId).includes(row.topic);
const liveNotes = (db, accountId) => db.prepare("SELECT * FROM agent_memories WHERE account_id=? AND invalid_at IS NULL ORDER BY valid_at DESC").all(accountId);

export function writeNote(store, auth, roomId, data) {
  const db = ensureAgentMemory(store.db), owner = ownerOf(store, auth, roomId), now = store.now();
  const requestId = requestIdOf(data);
  const prior = db.prepare("SELECT * FROM agent_memories WHERE account_id=? AND request_id=?").get(owner.accountId, requestId);
  if (prior) return { memory: memoryView(prior), action: "noop" };
  const text = cleanText(data.text, LIMITS.noteMaxChars, "invalid_memory");
  // Hard constraint in code, not text: secrets never enter shared memory.
  if (SECRET.test(text)) fail(422, "secret_in_memory", "That looks like a secret or token; shared memory never stores secrets");
  // The owner's own words are high trust; an agent says where it learned the fact.
  const source = owner.person ? "owner" : (Object.hasOwn(TRUST, data.source) && data.source !== "owner" ? data.source : "agent");
  const topic = typeof data.topic === "string" && /^[a-z]{2,20}$/.test(data.topic) ? data.topic : null;
  const importance = Number.isSafeInteger(data.importance) && data.importance >= 1 && data.importance <= 5 ? data.importance : 3;
  const same = db.prepare("SELECT * FROM agent_memories WHERE account_id=? AND norm=? AND invalid_at IS NULL").get(owner.accountId, normalize(text));
  if (same) return { memory: memoryView(same), action: "noop" };
  // ADD-only: a correction of an earlier fact invalidates it rather than rewriting it.
  if (typeof data.replaces === "string") db.prepare("UPDATE agent_memories SET invalid_at=? WHERE account_id=? AND id=? AND invalid_at IS NULL").run(now, owner.accountId, data.replaces);
  const id = `mem_${randomUUID()}`;
  db.prepare("INSERT INTO agent_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)").run(id, owner.accountId, text, normalize(text), topic, source, TRUST[source], importance, auth.member.id, requestId, now);
  return { memory: memoryView(db.prepare("SELECT * FROM agent_memories WHERE id=?").get(id)), action: "added" };
}

export function searchMemory(store, auth, roomId, { query, limit } = {}) {
  const db = ensureAgentMemory(store.db), owner = ownerOf(store, auth, roomId), now = store.now();
  const k = Number.isSafeInteger(limit) && limit >= 1 && limit <= 20 ? limit : LIMITS.topK;
  const notes = liveNotes(db, owner.accountId).filter(visible(store, roomId, owner, auth.member.id));
  const q = typeof query === "string" && query.trim() ? [...words(query).keys] : null;
  const scored = notes.map(n => {
    const keys = words(n.text).keys;
    const relevance = q ? q.filter(w => keys.has(w) || [...keys].some(x => x.startsWith(w) || w.startsWith(x))).length / q.length : 1;
    const recency = Math.exp(-(now - n.valid_at) / (30 * DAY));
    return { n, relevance, score: 0.6 * relevance + 0.2 * recency + 0.2 * (n.importance / 5) };
  }).filter(x => x.relevance >= LIMITS.relevanceFloor).sort((a, b) => b.score - a.score);
  return { total: notes.length, memories: scored.slice(0, k).map(x => memoryView(x.n, { relevance: Math.round(x.relevance * 100) / 100 })) };
}

export function forgetMemory(store, auth, roomId, id) {
  const db = ensureAgentMemory(store.db), owner = ownerOf(store, auth, roomId);
  const row = typeof id === "string" ? db.prepare("SELECT * FROM agent_memories WHERE account_id=? AND id=? AND invalid_at IS NULL").get(owner.accountId, id) : null;
  if (!row) fail(404, "memory_not_found", "No such memory");
  db.prepare("UPDATE agent_memories SET invalid_at=? WHERE id=?").run(store.now(), row.id);
  return { id: row.id, forgotten: true };
}

// ---- rules ----------------------------------------------------------------

const scopeOk = scope => scope === "global" || /^(room|tool):[A-Za-z0-9_.:-]{1,128}$/.test(scope) || /^path:[^\s]{1,200}$/.test(scope);
const isDormant = (row, now) => {
  const days = row.scope === "global" ? LIMITS.dormantGlobalDays : LIMITS.dormantScopedDays;
  return row.status === "active" && now - Math.max(row.valid_at ?? row.created_at, row.last_triggered_at ?? 0) > days * DAY;
};
const ruleView = (row, now) => ({ id: row.id, text: row.text, trigger: row.trigger ?? null, scope: row.scope,
  agent: row.agent_key === "*" ? "all" : row.agent_key, hard: !!row.hard, status: row.status,
  dormant: isDormant(row, now), flagged: row.harmful >= LIMITS.flagHarmful, helpful: row.helpful, harmful: row.harmful,
  pending: row.pending ? JSON.parse(row.pending) : null, source: row.source_turn,
  validAt: iso(row.valid_at), invalidAt: iso(row.invalid_at), lastTriggeredAt: iso(row.last_triggered_at) });
const getRule = (db, accountId, id) => typeof id === "string" ? db.prepare("SELECT * FROM agent_rules WHERE account_id=? AND id=?").get(accountId, id) : null;
const rulesOf = (db, accountId, statuses) => db.prepare(`SELECT * FROM agent_rules WHERE account_id=? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at DESC`).all(accountId, ...statuses);

function capBucket(db, accountId, rule) {
  const active = rulesOf(db, accountId, ["active"]).filter(r => r.id !== rule.id);
  if (rule.agent_key !== "*") return { cap: LIMITS.agentCap, name: "per-agent", rules: active.filter(r => r.agent_key === rule.agent_key) };
  if (rule.scope === "global") return { cap: LIMITS.globalCap, name: "global", rules: active.filter(r => r.agent_key === "*" && r.scope === "global") };
  return { cap: LIMITS.roomCap, name: "scoped", rules: active.filter(r => r.agent_key === "*" && r.scope === rule.scope) };
}

function activate(store, accountId, rule, now, replaceId) {
  const db = store.db, bucket = capBucket(db, accountId, rule);
  if (bucket.rules.length >= bucket.cap) {
    const drop = replaceId ? bucket.rules.find(r => r.id === replaceId) : null;
    if (!drop) return { action: "cap_reached", cap: bucket.cap, bucket: bucket.name, choices: ["replace", "merge", "reject"],
      message: `${bucket.rules.length} active ${bucket.name} rules is the cap. Confirm again with replaceId, merge two, or reject this one`,
      rule: ruleView(rule, now), rules: bucket.rules.map(r => ruleView(r, now)) };
    db.prepare("UPDATE agent_rules SET status='superseded', invalid_at=?, superseded_by=? WHERE id=?").run(now, rule.id, drop.id);
  }
  db.prepare("UPDATE agent_rules SET status='active', valid_at=?, pending=NULL WHERE id=?").run(now, rule.id);
  return { action: "activated", rule: ruleView(getRule(db, accountId, rule.id), now) };
}

function ruleTarget(store, owner, roomId, data) {
  if (typeof data.agentId !== "string") return owner.person ? "*" : (data.allAgents === true ? "*" : owner.agentKey);
  const theirs = (() => { try { return ownerOf(store, { member: { id: data.agentId, kind: "agent" } }, roomId); } catch { return null; } })();
  if (!theirs || theirs.accountId !== owner.accountId) fail(404, "agent_not_found", "No agent of yours with that id in this room");
  return theirs.agentKey;
}

// Rules come only from the owner's own turns: the person writes directly, or an
// agent relays a correction its owner just gave it in a direct turn
// (source "owner_direct"). Anything learned from room content, tool output, web,
// email or another agent is refused.
export function proposeRule(store, auth, roomId, data) {
  const db = ensureAgentMemory(store.db), owner = ownerOf(store, auth, roomId), now = store.now();
  const requestId = requestIdOf(data);
  const source = owner.person ? (data.source === "room_message" ? "room_message" : "owner") : data.source;
  if (!owner.person && source !== "owner_direct") fail(403, "rule_provenance", "Rules come only from your owner's own corrections. Save what you learned from room content, tools or other agents as a note");
  const prior = db.prepare("SELECT * FROM agent_rules WHERE account_id=? AND request_id=?").get(owner.accountId, requestId);
  if (prior) return { action: "noop", rule: ruleView(prior, now) };
  const text = cleanText(data.text, LIMITS.ruleMaxChars, "invalid_rule");
  if (text.split(/[.;!?](?:\s+|$)/).filter(s => s.trim()).length > 1) fail(422, "one_instruction", "A rule holds one instruction; write each as its own rule");
  const trigger = typeof data.trigger === "string" && data.trigger.trim() ? data.trigger.trim().slice(0, 120) : null;
  if (vague(text, trigger)) fail(422, "vague_rule", "Name the trigger and the action, for example: When deploying, smoke-check prod and roll back on failure");
  const scope = data.scope ?? "global";
  if (!scopeOk(scope)) fail(422, "invalid_scope", "scope is global, room:<id>, tool:<name> or path:<glob>");
  if (data.hard === true) requireOwner(owner);
  const agentKey = ruleTarget(store, owner, roomId, data);
  const author = owner.person ? auth.member.id : `owner-via:${auth.member.id}`;

  // Top 5 neighbours in the same scope, one decision for this one candidate.
  const neighbours = rulesOf(db, owner.accountId, ["active", "proposed"]).filter(r => r.scope === scope && (r.agent_key === agentKey || r.agent_key === "*" || agentKey === "*"))
    .map(r => ({ r, sim: similarity(text, r.text) })).sort((a, b) => (a.r.status === "active" ? 0 : 1) - (b.r.status === "active" ? 0 : 1) || b.sim - a.sim).slice(0, 5);
  let decision = { kind: "add" };
  for (const { r } of neighbours) { const rel = relation(text, r.text); if (rel) { decision = { kind: rel, with: r }; break; } }

  if (decision.kind === "duplicate") {
    const r = decision.with;
    if (r.status === "proposed") {
      // The same correction a second time activates the proposal.
      db.prepare("UPDATE agent_rules SET corrections=corrections+1 WHERE id=?").run(r.id);
      return { ...activate(store, owner.accountId, getRule(db, owner.accountId, r.id), now, data.replaceId), reason: "repeated_correction" };
    }
    // Re-issued while active: the rule did not stop the mistake.
    db.prepare("UPDATE agent_rules SET harmful=harmful+1, corrections=corrections+1 WHERE id=?").run(r.id);
    return { action: "noop", reason: "already_active_violation_recorded", rule: ruleView(getRule(db, owner.accountId, r.id), now) };
  }
  const id = `rule_${randomUUID()}`;
  const pending = decision.kind === "merge" ? { type: "merge", with: decision.with.id, mergedText: `${decision.with.text.replace(/[.\s]+$/, "")}; ${text}`.slice(0, LIMITS.ruleMaxChars) }
    : decision.kind === "conflict" ? { type: "conflict", with: decision.with.id } : null;
  db.prepare(`INSERT INTO agent_rules(id,account_id,text,trigger,scope,agent_key,hard,status,pending,author_id,source_turn,request_id,created_at)
    VALUES(?,?,?,?,?,?,?,'proposed',?,?,?,?,?)`).run(id, owner.accountId, text, trigger, scope, agentKey, data.hard === true ? 1 : 0,
    pending ? JSON.stringify(pending) : null, author, source, requestId, now);
  const row = getRule(db, owner.accountId, id);
  if (decision.kind === "conflict" && decision.with.author_id === author && decision.with.scope === scope) {
    // Newest wins only for the same author and scope; the old rule is invalidated, not deleted.
    db.prepare("UPDATE agent_rules SET pending=NULL WHERE id=?").run(id);
    const wasActive = decision.with.status === "active";
    db.prepare("UPDATE agent_rules SET status='superseded', invalid_at=?, superseded_by=? WHERE id=?").run(now, id, decision.with.id);
    if (wasActive) return { ...activate(store, owner.accountId, getRule(db, owner.accountId, id), now), reason: "newest_wins", superseded: decision.with.id };
    return { action: "proposed", reason: "newest_wins", superseded: decision.with.id, rule: ruleView(getRule(db, owner.accountId, id), now) };
  }
  if (pending) return { action: decision.kind === "merge" ? "merge_proposed" : "conflict", needs: "owner", rule: ruleView(row, now), with: ruleView(decision.with, now) };
  // The owner writing directly with confirm:true is the confirmation.
  if (owner.person && data.confirm === true) return activate(store, owner.accountId, row, now, data.replaceId);
  return { action: "proposed", rule: ruleView(row, now) };
}

// Rules for this turn. Hard constraints first, then scoped matches by helpful
// minus harmful, then recency; at most 12 rules and 600 tokens.
export function rulesForTurn(store, auth, roomId, { tool = null, paths = [], budget = LIMITS.injectTokens } = {}) {
  let owner; try { owner = ownerOf(store, auth, roomId); } catch { return null; }
  ingestCorrections(store, roomId);
  const db = store.db, now = store.now();
  const matches = r => r.scope === "global" || r.scope === `room:${roomId}` || (tool && r.scope === `tool:${tool}`)
    || (r.scope.startsWith("path:") && paths.some(p => globMatch(r.scope.slice(5), p)));
  const pool = rulesOf(db, owner.accountId, ["active"]).filter(r => (r.agent_key === "*" || r.agent_key === owner.agentKey) && matches(r));
  const triggered = pool.filter(r => r.scope.startsWith("tool:") || r.scope.startsWith("path:"));
  for (const r of triggered) db.prepare("UPDATE agent_rules SET last_triggered_at=? WHERE id=?").run(now, r.id);
  const live = pool.filter(r => !isDormant(r, now) || triggered.includes(r));
  live.sort((a, b) => (b.hard - a.hard) || ((b.scope !== "global") - (a.scope !== "global")) || ((b.helpful - b.harmful) - (a.helpful - a.harmful)) || (b.valid_at - a.valid_at));
  const out = []; let used = 0, omitted = 0;
  for (const r of live) {
    const line = r.trigger ? `${r.trigger}: ${r.text}` : r.text, cost = tokens(line);
    if (out.length >= LIMITS.injectRules || used + cost > budget) { omitted++; continue; }
    used += cost; out.push({ id: r.id, text: line, hard: !!r.hard, scope: r.scope });
  }
  return { heading: "Your owner's standing rules", rules: out, tokens: used, budget, omitted, dormant: pool.length - live.length };
}
function globMatch(glob, path) {
  const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".")}$`);
  return typeof path === "string" && re.test(path);
}

// The agent reports a turn hit a rule's trigger, and whether the rule helped.
export function recordRuleUse(store, auth, roomId, { usedIds = [], harmfulIds = [] } = {}) {
  const db = ensureAgentMemory(store.db), owner = ownerOf(store, auth, roomId), now = store.now();
  for (const id of (Array.isArray(usedIds) ? usedIds : []).slice(0, 50)) db.prepare("UPDATE agent_rules SET helpful=helpful+1, last_triggered_at=? WHERE account_id=? AND id=? AND status='active'").run(now, owner.accountId, id);
  for (const id of (Array.isArray(harmfulIds) ? harmfulIds : []).slice(0, 50)) db.prepare("UPDATE agent_rules SET harmful=harmful+1, last_triggered_at=? WHERE account_id=? AND id=? AND status='active'").run(now, owner.accountId, id);
  return { recorded: true };
}

// Owner review in one call: counts, proposals, conflicts, dormant and flagged rules.
export function listRules(store, auth, roomId) {
  const db = ensureAgentMemory(store.db), owner = ownerOf(store, auth, roomId), now = store.now();
  const rows = db.prepare("SELECT * FROM agent_rules WHERE account_id=? ORDER BY status, created_at DESC").all(owner.accountId)
    .filter(r => owner.person || r.agent_key === "*" || r.agent_key === owner.agentKey).map(r => ruleView(r, now));
  const active = rows.filter(r => r.status === "active");
  return { counts: { active: active.length, proposed: rows.filter(r => r.status === "proposed").length, conflicts: rows.filter(r => r.pending?.type === "conflict").length,
    merges: rows.filter(r => r.pending?.type === "merge").length, dormant: active.filter(r => r.dormant).length, flagged: active.filter(r => r.flagged).length,
    superseded: rows.filter(r => r.status === "superseded").length, notes: db.prepare("SELECT COUNT(*) n FROM agent_memories WHERE account_id=? AND invalid_at IS NULL").get(owner.accountId).n },
  limits: LIMITS, rules: rows };
}

// confirm: activate proposals (merges and conflicts resolve here); keep: reset dormancy;
// prune: retire (never hard-deletes history); undo: revert a merge or a supersede.
export function manageRules(store, auth, roomId, { confirmIds = [], keepIds = [], pruneIds = [], undoIds = [], replaceId } = {}) {
  const db = ensureAgentMemory(store.db), owner = ownerOf(store, auth, roomId), now = store.now();
  requireOwner(owner);
  const results = [];
  const each = (ids, fn) => { for (const id of (Array.isArray(ids) ? ids : []).slice(0, 50)) { const r = getRule(db, owner.accountId, id); results.push(r ? fn(r) : { id, action: "not_found" }); } };
  each(confirmIds, r => {
    if (r.status !== "proposed") return { id: r.id, action: "noop" };
    const pending = r.pending ? JSON.parse(r.pending) : null;
    if (pending?.type === "merge") {
      const target = getRule(db, owner.accountId, pending.with);
      db.prepare("UPDATE agent_rules SET prev_text=text, text=? WHERE id=?").run(pending.mergedText, target.id);
      db.prepare("UPDATE agent_rules SET status='superseded', invalid_at=?, superseded_by=?, pending=NULL WHERE id=?").run(now, target.id, r.id);
      return { id: r.id, action: "merged", into: ruleView(getRule(db, owner.accountId, target.id), now) };
    }
    if (pending?.type === "conflict") db.prepare("UPDATE agent_rules SET status='superseded', invalid_at=?, superseded_by=? WHERE id=? AND status!='superseded'").run(now, r.id, pending.with);
    return { id: r.id, ...activate(store, owner.accountId, getRule(db, owner.accountId, r.id), now, replaceId) };
  });
  each(keepIds, r => { db.prepare("UPDATE agent_rules SET last_triggered_at=? WHERE id=?").run(now, r.id); return { id: r.id, action: "kept" }; });
  each(pruneIds, r => { db.prepare("UPDATE agent_rules SET status='superseded', invalid_at=?, pending=NULL WHERE id=?").run(now, r.id); return { id: r.id, action: "retired" }; });
  each(undoIds, r => {
    if (r.prev_text) { db.prepare("UPDATE agent_rules SET text=prev_text, prev_text=NULL WHERE id=?").run(r.id); return { id: r.id, action: "unmerged" }; }
    if (r.status === "superseded") {
      if (r.superseded_by) db.prepare("UPDATE agent_rules SET status='superseded', invalid_at=? WHERE id=? AND status='active'").run(now, r.superseded_by);
      db.prepare("UPDATE agent_rules SET status='active', invalid_at=NULL, superseded_by=NULL, valid_at=? WHERE id=?").run(now, r.id);
      return { id: r.id, action: "restored" };
    }
    return { id: r.id, action: "noop" };
  });
  return { results, ...listRules(store, auth, roomId) };
}

// A person's own room message starting "rule:" or "correction:" becomes a
// proposed rule for their agents named with @, or for all their agents.
// Messages from anyone else, agents included, never create rules.
const MARKER = /^\s*(?:rule|correction)\s*:\s*/i;
export function ingestCorrections(store, roomId) {
  const db = ensureAgentMemory(store.db);
  const last = db.prepare("SELECT last_seq FROM agent_memory_scans WHERE room_id=?").get(roomId)?.last_seq ?? 0;
  const rows = db.prepare("SELECT sequence, body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 500").all(roomId, last);
  let seq = last;
  for (const row of rows) {
    seq = row.sequence;
    let event; try { event = JSON.parse(row.body); } catch { continue; }
    const body = event?.type === "message.posted" ? event.data?.body : null;
    if (typeof body !== "string" || !MARKER.test(body)) continue;
    const member = ownMember(store.room?.(roomId)?.state?.members ?? {}, event.actorId);
    if (!member || member.kind === "agent") continue;
    if (!db.prepare("SELECT 1 FROM member_accounts WHERE room_id=? AND member_id=?").get(roomId, event.actorId)) continue;
    const auth = { member: { id: event.actorId, kind: member.kind } };
    const mentions = [...body.matchAll(/@([A-Za-z0-9_.-]+)/g)].map(m => m[1]);
    const text = body.replace(MARKER, "").replace(/@[A-Za-z0-9_.-]+/g, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.ruleMaxChars);
    for (const agentId of mentions.length ? mentions : [null]) {
      try { proposeRule(store, auth, roomId, { requestId: `msg:${event.id}:${agentId ?? "*"}`, text, source: "room_message", ...(agentId ? { agentId } : {}) }); } catch { /* not their agent, vague or too long: skip */ }
    }
  }
  db.prepare("INSERT INTO agent_memory_scans(room_id,last_seq) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET last_seq=excluded.last_seq").run(roomId, seq);
}

// Onboarding for a newly connected agent: active rules plus the most important
// notes, each tagged with its source, within 400 tokens.
export function memoryOnboarding(store, auth, roomId) {
  let owner; try { owner = ownerOf(store, auth, roomId); } catch { return null; }
  const db = ensureAgentMemory(store.db), rules = rulesForTurn(store, auth, roomId);
  const budget = LIMITS.onboardingTokens; let used = 0;
  const items = [];
  for (const r of rules.rules) { const line = `[rule, owner] ${r.text}`; if (used + tokens(line) > budget) break; used += tokens(line); items.push(line); }
  const notes = liveNotes(db, owner.accountId).filter(visible(store, roomId, owner, auth.member.id)).sort((a, b) => b.importance - a.importance || b.valid_at - a.valid_at);
  for (const n of notes) {
    const body = n.text.length > 160 ? `${n.text.slice(0, 157)}...` : n.text;
    const line = `[note, ${n.source}] ${n.trust === "low" ? fence(body) : body}`;
    if (used + tokens(line) > budget) break; used += tokens(line); items.push(line);
  }
  return { notes: notes.length, rules: rules.rules.length, summary: items, tokens: used, next: "room_memory_search finds more notes; room_memory_write saves a note or relays your owner's correction" };
}

// MCP dispatch for room_memory_* and room_rules.
export function callMemoryTool(store, auth, name, roomId, args) {
  const { roomId: _r, ...data } = args;
  if (name === "room_memory_search") return { roomId, ...searchMemory(store, auth, roomId, data) };
  if (name === "room_memory_write") return { roomId, ...(data.kind === "rule" ? proposeRule(store, auth, roomId, data) : writeNote(store, auth, roomId, data)) };
  if (name === "room_memory_forget") return { roomId, ...forgetMemory(store, auth, roomId, data.memoryId) };
  if (name === "room_rules") {
    const action = data.action ?? "active";
    if (action === "list") return { roomId, ...listRules(store, auth, roomId) };
    if (action === "manage") return { roomId, ...manageRules(store, auth, roomId, data) };
    if (action === "used") return { roomId, ...recordRuleUse(store, auth, roomId, data) };
    ownerOf(store, auth, roomId);
    return { roomId, ...rulesForTurn(store, auth, roomId, { tool: data.tool ?? null, paths: Array.isArray(data.paths) ? data.paths : [] }) };
  }
  return fail(404, "unknown_tool", "Unknown memory tool");
}
