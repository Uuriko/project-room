// Follow-ups to shared memory (docs/agent-memory.md): the "why" trail, markdown
// export and import, the weekly cleanup card and the repeat-correction rate.
import { createHash, randomUUID } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { LIMITS, SECRET, ensureAgentMemory, listRules, manageRules, ownerOf, proposeRule, writeNote } from "./agent-memory.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const DAY = 24 * 3600 * 1000;
const CARD_SCHEMA = `CREATE TABLE IF NOT EXISTS agent_memory_cleanup_cards (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, room_id TEXT NOT NULL, member_id TEXT NOT NULL,
  rule_ids TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','done')), created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_memory_cleanup_open ON agent_memory_cleanup_cards(room_id, member_id, state)`;
const ready = new WeakSet();
export function ensureMemoryExtras(db) { ensureAgentMemory(db); if (!ready.has(db)) { db.exec(CARD_SCHEMA); ready.add(db); } return db; }
const personOwner = (store, auth, roomId) => { const owner = ownerOf(store, auth, roomId); if (!owner.person) fail(403, "owner_required", "Only the owner does this"); return owner; };
const split = text => text ? text.split(",").filter(Boolean) : [];

// ---- why ------------------------------------------------------------------
// ref is a message id or event id in this room. Returns the rules and memories
// the posting agent was given since its previous post, plus any it reported
// using for that ref.
export function whyFor(store, auth, roomId, ref) {
  const db = ensureMemoryExtras(store.db), owner = personOwner(store, auth, roomId);
  if (typeof ref !== "string" || !ref || ref.length > 128) fail(422, "invalid_ref", "Supply ref, a message id or event id");
  const row = db.prepare(`SELECT sequence, body FROM events WHERE room_id=? AND (json_extract(body,'$.id')=? OR json_extract(body,'$.data.messageId')=?) ORDER BY sequence LIMIT 1`).get(roomId, ref, ref);
  const explicit = db.prepare("SELECT * FROM agent_memory_trail WHERE account_id=? AND room_id=? AND ref=? ORDER BY seq").all(owner.accountId, roomId, ref);
  let event = null; try { event = row ? JSON.parse(row.body) : null; } catch { event = null; }
  if (!event && !explicit.length) fail(404, "ref_not_found", "No message or action with that id here");
  const actorId = event?.actorId ?? explicit[0]?.member_id;
  // Only your own agents' actions have a trail you can read.
  const mine = (() => { try { return ownerOf(store, { member: { id: actorId, kind: "agent" } }, roomId).accountId === owner.accountId; } catch { return false; } })();
  if (!mine && !explicit.length) fail(404, "ref_not_found", "No action by one of your agents with that id here");
  let window = [];
  if (event) {
    const at = Date.parse(event.at) || store.now();
    const prev = db.prepare(`SELECT body FROM events WHERE room_id=? AND sequence<? AND json_extract(body,'$.actorId')=? ORDER BY sequence DESC LIMIT 1`).get(roomId, row.sequence, actorId);
    const since = prev ? (Date.parse(JSON.parse(prev.body).at) || 0) : 0;
    const q = "SELECT * FROM agent_memory_trail WHERE account_id=? AND room_id=? AND member_id=? AND kind IN ('injected','used') AND ref IS NULL";
    window = db.prepare(`${q} AND at>? AND at<=? ORDER BY seq`).all(owner.accountId, roomId, actorId, since, at);
    // The injection can predate the previous post when nothing changed since.
    if (!window.length) window = db.prepare(`${q} AND at<=? ORDER BY seq DESC LIMIT 2`).all(owner.accountId, roomId, actorId, at);
  }
  const rows = [...window, ...explicit];
  const ruleIds = [...new Set(rows.flatMap(r => split(r.rule_ids)))], memoryIds = [...new Set(rows.flatMap(r => split(r.memory_ids)))];
  const usedRules = new Set(rows.filter(r => r.kind === "used").flatMap(r => split(r.rule_ids)));
  const usedNotes = new Set(rows.filter(r => r.kind === "used").flatMap(r => split(r.memory_ids)));
  const rule = id => db.prepare("SELECT id, text, scope, status FROM agent_rules WHERE account_id=? AND id=?").get(owner.accountId, id);
  const note = id => db.prepare("SELECT id, text, source, invalid_at FROM agent_memories WHERE account_id=? AND id=?").get(owner.accountId, id);
  return { ref, actorId: actorId ?? null,
    rules: ruleIds.map(rule).filter(Boolean).map(r => ({ id: r.id, text: r.text, scope: r.scope, status: r.status, used: usedRules.has(r.id) })),
    memories: memoryIds.map(note).filter(Boolean).map(n => ({ id: n.id, text: n.text, source: n.source, forgotten: n.invalid_at != null, used: usedNotes.has(n.id) })) };
}

// ---- export / import --------------------------------------------------------
// Markdown that drops into CLAUDE.md or AGENTS.md: a Rules section of bullets
// and a Notes section. Low-trust notes stay out, since an instructions file
// would turn them into instructions.
export function exportMemory(store, auth, roomId) {
  const db = ensureMemoryExtras(store.db), owner = personOwner(store, auth, roomId);
  const rules = db.prepare("SELECT * FROM agent_rules WHERE account_id=? AND status='active' ORDER BY hard DESC, created_at").all(owner.accountId);
  const notes = db.prepare("SELECT * FROM agent_memories WHERE account_id=? AND invalid_at IS NULL AND trust!='low' ORDER BY importance DESC, valid_at").all(owner.accountId);
  const ruleLine = r => `- ${r.trigger ? `${r.trigger}: ` : ""}${r.text}${r.scope !== "global" ? ` (scope: ${r.scope})` : ""}`;
  const markdown = ["# Project Room memory", "", "## Rules", "", ...(rules.length ? rules.map(ruleLine) : ["- (none)"]), "",
    "## Notes", "", ...(notes.length ? notes.map(n => `- ${n.text}`) : ["- (none)"]), ""].join("\n");
  return { markdown, rules: rules.length, notes: notes.length };
}

const IMPORT_MAX_CHARS = 20000, IMPORT_MAX_ITEMS = 100;
export function parseMemoryMarkdown(markdown) {
  const items = []; let section = "notes";
  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { section = /\b(rules?|instructions?|guidelines?|conventions?)\b/i.test(heading[1]) ? "rules" : "notes"; continue; }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!bullet || !bullet[1].trim() || /^\(none\)$/i.test(bullet[1].trim())) continue;
    let text = bullet[1].trim(), scope = "global";
    const scoped = /\s*\(scope:\s*([^)]+)\)\s*$/i.exec(text);
    if (scoped) { scope = scoped[1].trim(); text = text.slice(0, scoped.index).trim(); }
    items.push({ kind: section === "rules" ? "rule" : "note", text, scope });
  }
  return items;
}

// Every imported rule goes through the normal proposal path and stays proposed.
// One secret anywhere refuses the whole file before anything is written.
export function importMemory(store, auth, roomId, { markdown } = {}) {
  ensureMemoryExtras(store.db); personOwner(store, auth, roomId);
  if (typeof markdown !== "string" || !markdown.trim() || markdown.length > IMPORT_MAX_CHARS) fail(422, "invalid_import", `markdown is 1 to ${IMPORT_MAX_CHARS} characters`);
  if (SECRET.test(markdown)) fail(422, "secret_in_memory", "That file holds something that looks like a secret or token; nothing was imported");
  const items = parseMemoryMarkdown(markdown);
  if (items.length > IMPORT_MAX_ITEMS) fail(422, "invalid_import", `At most ${IMPORT_MAX_ITEMS} bullets per import`);
  const results = [];
  for (const item of items) {
    const requestId = `import:${createHash("sha256").update(`${item.kind}|${item.scope}|${item.text}`).digest("hex").slice(0, 32)}`;
    try {
      const out = item.kind === "rule"
        ? proposeRule(store, auth, roomId, { requestId, text: item.text, scope: item.scope, viaImport: true })
        : writeNote(store, auth, roomId, { requestId, text: item.text });
      results.push({ kind: item.kind, text: item.text, action: out.action, reason: out.reason ?? null, id: out.rule?.id ?? out.memory?.id ?? null });
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      results.push({ kind: item.kind, text: item.text, action: "skipped", reason: error.code });
    }
  }
  const count = action => results.filter(r => r.action === action).length;
  return { proposed: results.filter(r => r.kind === "rule" && r.action !== "noop" && r.action !== "skipped").length,
    notes: results.filter(r => r.kind === "note" && r.action === "added").length, skipped: count("skipped"), unchanged: count("noop"), results,
    next: "Imported rules stay proposed until you confirm them in the rule list" };
}

// ---- weekly cleanup card ---------------------------------------------------
function cleanupItems(store, auth, roomId) {
  const { rules } = listRules(store, auth, roomId);
  const items = [];
  for (const r of rules) {
    const reason = r.status === "active" && r.flagged ? "flagged" : r.status === "active" && r.dormant ? "dormant"
      : r.status === "proposed" && r.pending?.type === "conflict" ? "conflict" : null;
    if (reason) items.push({ id: r.id, text: r.text, scope: r.scope, reason, with: r.pending?.with ?? null, actions: ["keep", "delete"] });
  }
  return items;
}
export function readCleanup(store, auth, roomId) {
  const db = ensureMemoryExtras(store.db), owner = personOwner(store, auth, roomId);
  const card = db.prepare("SELECT id, created_at FROM agent_memory_cleanup_cards WHERE account_id=? AND state='open' ORDER BY created_at DESC LIMIT 1").get(owner.accountId);
  return { cardId: card?.id ?? null, openedAt: card ? new Date(card.created_at).toISOString() : null, items: cleanupItems(store, auth, roomId),
    help: "keep resets a dormant or flagged rule, or confirms the newer side of a conflict; delete retires the rule (history kept)" };
}
export function decideCleanup(store, auth, roomId, { keepIds = [], deleteIds = [] } = {}) {
  const db = ensureMemoryExtras(store.db), owner = personOwner(store, auth, roomId);
  const ids = list => (Array.isArray(list) ? list : []).filter(id => typeof id === "string").slice(0, 50);
  const byId = new Map(cleanupItems(store, auth, roomId).map(i => [i.id, i]));
  const keep = ids(keepIds).filter(id => byId.has(id)), del = ids(deleteIds).filter(id => byId.has(id) && !keep.includes(id));
  const confirmIds = keep.filter(id => byId.get(id).reason === "conflict"), keepActive = keep.filter(id => byId.get(id).reason !== "conflict");
  // keep on a flagged rule also clears the flag by resetting its harmful count.
  for (const id of keepActive) if (byId.get(id).reason === "flagged") db.prepare("UPDATE agent_rules SET harmful=0 WHERE account_id=? AND id=?").run(owner.accountId, id);
  const out = manageRules(store, auth, roomId, { confirmIds, keepIds: keepActive, pruneIds: del });
  const left = cleanupItems(store, auth, roomId);
  if (!left.length) db.prepare("UPDATE agent_memory_cleanup_cards SET state='done' WHERE account_id=? AND state='open'").run(owner.accountId);
  return { results: out.results, remaining: left.length, items: left };
}

// Weekly sweep: one open card per account that has something to review, in the
// first room where that person is a member. Called by the memory-cleanup job.
export function sweepCleanupCards(store, now = store.now()) {
  if (!store?.db?.prepare) return { cards: 0 };
  let accounts; try { accounts = store.db.prepare("SELECT DISTINCT account_id FROM agent_rules WHERE status IN ('active','proposed')").all(); } catch { return { cards: 0 }; }
  const db = ensureMemoryExtras(store.db); let cards = 0;
  for (const { account_id: accountId } of accounts) {
    if (db.prepare("SELECT 1 FROM agent_memory_cleanup_cards WHERE account_id=? AND (state='open' OR created_at>?)").get(accountId, now - 7 * DAY + 3600e3)) continue;
    const home = db.prepare("SELECT room_id, member_id FROM member_accounts WHERE account_id=? ORDER BY room_id LIMIT 1").get(accountId);
    if (!home) continue;
    let items; try { items = cleanupItems(store, { member: { id: home.member_id, kind: "human" } }, home.room_id); } catch { continue; }
    if (!items.length) continue;
    db.prepare("INSERT INTO agent_memory_cleanup_cards VALUES(?,?,?,?,?,'open',?)").run(`mcc_${randomUUID()}`, accountId, home.room_id, home.member_id, items.map(i => i.id).join(","), now);
    cards++;
  }
  return { cards };
}
export function cleanupDue(store) {
  try { return Boolean(store.db.prepare("SELECT 1 hit FROM agent_rules WHERE status IN ('active','proposed') LIMIT 1").get()?.hit); } catch { return false; }
}

// ---- metric -------------------------------------------------------------------
// Share of the owner's corrections that repeated a rule already active: the
// rule should have stopped the mistake and did not. Lower is better.
export function memoryMetrics(store, auth, roomId, { days = 30 } = {}) {
  const db = ensureMemoryExtras(store.db), owner = personOwner(store, auth, roomId);
  const span = Number.isSafeInteger(days) && days >= 1 && days <= 365 ? days : 30, since = store.now() - span * DAY;
  const count = kind => db.prepare("SELECT COUNT(*) n FROM agent_memory_trail WHERE account_id=? AND kind=? AND at>=?").get(owner.accountId, kind, since).n;
  const corrections = count("correction"), repeats = count("repeat");
  const active = db.prepare("SELECT COUNT(*) n FROM agent_rules WHERE account_id=? AND status='active'").get(owner.accountId).n;
  return { days: span, corrections, repeats, repeatCorrectionRate: corrections ? Math.round((repeats / corrections) * 1000) / 1000 : null, activeRules: active, limits: { injectRules: LIMITS.injectRules } };
}
