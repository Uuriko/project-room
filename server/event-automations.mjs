// User-defined automations on the room event log (Linear-parity: Linear
// Agent triggers / Asks routing; Anyshift Deployment Monitor for the
// post-deploy template). One source: every rule reads the same
// work_claim.updated event that already feeds wakes, MCP Events webhooks,
// Updates notices and approval holds. No second event bus.
//
// OFF unless ROOM_AUTOMATIONS=1 (routes answer 404, no rule runs). Rules are
// created disabled; the room owner enables each one. A rule is
//   trigger: { actions?: [...], kinds?: [...], states?: [...], tags?: [...] }
//     — every listed field must match the event; omitted fields match any.
//   action:  { type: "wake", member, brief }   — wake one member with a brief
//          | { type: "open_task", title, assignee? } — open a Board task
// Each (rule, event) runs at most once. Events caused by an automation never
// trigger another automation (no loops). An action failure never rolls back
// the claim write that produced the event.
import { createHash, randomBytes } from "node:crypto";
import { WORK_CLAIM_EVENT_ACTIONS, ownMember } from "../src/events.js";

export const AUTOMATION_TABLES = Object.freeze(["room_automations", "room_automation_runs"]);
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS room_automations (rule_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, name TEXT NOT NULL,
    template TEXT, trigger_json TEXT NOT NULL, action_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS room_automation_runs (rule_id TEXT NOT NULL, event_id TEXT NOT NULL, at INTEGER NOT NULL,
    claim_id TEXT, result TEXT NOT NULL, PRIMARY KEY (rule_id, event_id));`;
const ensure = db => db.exec(SCHEMA);
export const automationsEnabled = (env = process.env) => env?.ROOM_AUTOMATIONS === "1";
export const AUTOMATION_TAG = "automation";
const CLAIM_KINDS = ["work", "land", "deploy"];
const STATES = ["unclaimed", "claimed", "in_progress", "blocked", "delivered", "done", "closed"]; // server/work-claims.mjs STATES
const TAG = /^[a-z0-9_-]{1,40}$/;

// First built-in template. A deploy claim reaching done (live revision
// matched, see closeWhenLive) wakes the assigned agent to verify production.
export const POST_DEPLOY_BRIEF = "Post-deploy check: production just reached the deploy claim's revision. "
  + "Run the prod smoke check and the baselines against it. If anything regressed, open a Board task "
  + "tagged post-deploy-regression with the evidence (failing check, baseline vs now, revision, links). "
  + "If all pass, reply on the deploy claim with the results.";
export const AUTOMATION_TEMPLATES = Object.freeze({
  "post-deploy-check": Object.freeze({
    name: "Post-deploy check",
    trigger: Object.freeze({ actions: ["state_changed"], kinds: ["deploy"], states: ["done"] }),
    action: member => ({ type: "wake", member, brief: POST_DEPLOY_BRIEF }),
  }),
});

const list = (v, allowed) => v === undefined ? true
  : Array.isArray(v) && v.length > 0 && v.length <= 12 && v.every(x => typeof x === "string" && (allowed ? allowed.includes(x) : TAG.test(x)));
export function validTrigger(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return false;
  if (Object.keys(t).some(k => !["actions", "kinds", "states", "tags"].includes(k))) return false;
  if (Object.keys(t).length === 0) return false; // a match-everything rule is refused
  return list(t.actions, WORK_CLAIM_EVENT_ACTIONS) && list(t.kinds, CLAIM_KINDS) && list(t.states, STATES) && list(t.tags);
}
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
export function validAction(a, members) {
  if (!a || typeof a !== "object") return false;
  if (a.type === "wake") return Object.keys(a).every(k => ["type", "member", "brief"].includes(k)) && text(a.brief, 1000) && Boolean(activeMember(members, a.member));
  if (a.type === "open_task") return Object.keys(a).every(k => ["type", "title", "assignee"].includes(k)) && text(a.title, 200)
    && (a.assignee === undefined || Boolean(activeMember(members, a.assignee)));
  return false;
}
function activeMember(members, id) {
  const m = typeof id === "string" ? ownMember(members ?? {}, id) : null;
  return m && m.active !== false ? m : null;
}

export function matches(trigger, data, tags = []) {
  const has = (field, value) => trigger[field] === undefined || trigger[field].includes(value);
  return has("actions", data.action) && has("kinds", data.kind ?? "work") && has("states", data.claimState)
    && (trigger.tags === undefined || trigger.tags.some(tag => tags.includes(tag)));
}

export function createRule(db, { roomId, name, trigger, action, template = null, createdBy, now = Date.now() }) {
  ensure(db);
  const ruleId = `au_${randomBytes(9).toString("base64url")}`;
  db.prepare("INSERT INTO room_automations (rule_id, room_id, name, template, trigger_json, action_json, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
    .run(ruleId, roomId, name, template, JSON.stringify(trigger), JSON.stringify(action), createdBy, now);
  return { rule: listRules(db, { roomId }).find(r => r.ruleId === ruleId) };
}
export function setRuleEnabled(db, { roomId, ruleId, enabled }) {
  ensure(db);
  return db.prepare("UPDATE room_automations SET enabled = ? WHERE rule_id = ? AND room_id = ?").run(enabled ? 1 : 0, ruleId, roomId).changes > 0;
}
export function deleteRule(db, { roomId, ruleId }) {
  ensure(db);
  return db.prepare("DELETE FROM room_automations WHERE rule_id = ? AND room_id = ?").run(ruleId, roomId).changes > 0;
}
export function listRules(db, { roomId }) {
  ensure(db);
  return db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM room_automation_runs r WHERE r.rule_id = a.rule_id) AS runs,
      (SELECT MAX(at) FROM room_automation_runs r WHERE r.rule_id = a.rule_id) AS last_run_at
    FROM room_automations a WHERE a.room_id = ? ORDER BY a.created_at`).all(roomId)
    .map(r => ({ ruleId: r.rule_id, name: r.name, template: r.template, trigger: JSON.parse(r.trigger_json), action: JSON.parse(r.action_json),
      enabled: r.enabled === 1, createdBy: r.created_by, createdAt: r.created_at, runs: r.runs, lastRunAt: r.last_run_at ?? null }));
}

// Called from emitWorkClaimEvent after the event is appended, inside the
// same transaction. Deps are injected to avoid an import cycle with
// work-claim-events.mjs.
let running = false;
export function runAutomations(store, roomId, event, item, deps, env = process.env) {
  if (!automationsEnabled(env) || running || !store?.db) return [];
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  if (tags.includes(AUTOMATION_TAG)) return [];
  ensure(store.db);
  const rules = store.db.prepare("SELECT * FROM room_automations WHERE room_id = ? AND enabled = 1").all(roomId);
  if (rules.length === 0) return [];
  const out = [];
  running = true;
  try {
    for (const rule of rules) {
      const trigger = JSON.parse(rule.trigger_json);
      if (!matches(trigger, event.data ?? {}, tags)) continue;
      const seen = store.db.prepare("INSERT OR IGNORE INTO room_automation_runs (rule_id, event_id, at, result) VALUES (?, ?, ?, 'pending')")
        .run(rule.rule_id, event.id, store.now?.() ?? Date.now());
      if (seen.changes === 0) continue;
      let result, claimId = null;
      try { ({ result, claimId = null } = runAction(store, roomId, rule, JSON.parse(rule.action_json), event, item, deps)); }
      catch (error) { result = `error:${String(error?.code ?? error?.message ?? "failed").slice(0, 80)}`; }
      store.db.prepare("UPDATE room_automation_runs SET result = ?, claim_id = ? WHERE rule_id = ? AND event_id = ?").run(result, claimId, rule.rule_id, event.id);
      out.push({ ruleId: rule.rule_id, result, claimId });
    }
  } finally { running = false; }
  return out;
}

function runAction(store, roomId, rule, action, event, item, deps) {
  const members = store.roomAuthority(roomId).members ?? {};
  const now = store.now?.() ?? Date.now();
  if (action.type === "wake") {
    const member = activeMember(members, action.member);
    if (!member) return { result: "skipped:member_inactive" };
    const wake = deps.enqueueClaimWake(store, roomId, member.id, `work-claim:${item.id}:automation:${rule.rule_id}:${event.id}`,
      { reason: "automation", actorId: rule.created_by });
    return { result: wake?.enqueued === false ? `skipped:${wake.skipped ?? "policy"}` : "woke", claimId: item.id };
  }
  if (action.type === "open_task") {
    const claimId = `au-${createHash("sha256").update(`${rule.rule_id}:${event.id}`).digest("hex").slice(0, 20)}`;
    if (store.workClaims.get(roomId, claimId)) return { result: "duplicate", claimId };
    const assignee = action.assignee ? activeMember(members, action.assignee) : null;
    let task = deps.createWork({ id: claimId, title: action.title.slice(0, 200),
      note: `Opened by automation ${rule.rule_id} (${rule.name}) on ${event.data?.action} of ${item.id}.`,
      tags: [AUTOMATION_TAG] }, { now, agentId: rule.created_by });
    if (assignee) task = deps.claimWork(task, assignee.id, { note: `assigned by automation ${rule.rule_id}`, room: { workClaims: store.workClaims.rawConfig(roomId) }, now });
    store.workClaims.set(roomId, task);
    deps.emitWorkClaimEvent(store, roomId, { actorId: rule.created_by, item: task, action: assignee ? "claimed" : "created", atMs: now,
      ...(assignee ? { attention: "assigned", attentionMemberId: assignee.id } : {}) });
    if (assignee) deps.enqueueClaimWake(store, roomId, assignee.id, `work-claim:${claimId}:assigned:${now}`, { reason: "assigned", actorId: rule.created_by });
    return { result: "opened", claimId };
  }
  return { result: "skipped:unknown_action" };
}
