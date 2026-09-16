// Inbox triage decision engine (B005). A pure decider: given a message, its
// spam score (A029), and the matched inbox rules (A012), it returns a single
// ranked action with human-readable reasons. Actions: quarantine (spam),
// file (rule), snooze (rule), flag (rule/important), needs_human (uncertain),
// inbox (default). The decider never moves anything — execution is a later
// slice. Pure, dependency-free, deterministic; frozen outputs.
const ACTIONS = ["quarantine", "file", "snooze", "flag", "needs_human", "inbox"];
class TriageError extends Error { constructor(code, message) { super(message); this.name = "TriageError"; this.code = code; } }
const fail = (code, message) => { throw new TriageError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_triage_input", message); };

const messageOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "message must be an object");
  check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512, "message id must be 1..512 characters");
  return value;
};
const spamOf = value => {
  if (value === undefined || value === null) return null;
  check(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100, "spamScore must be 0..100");
  return value;
};
const rulesOf = value => {
  if (value === undefined || value === null) return [];
  check(Array.isArray(value), "matchedRules must be a list");
  return value.map(rule => {
    check(rule !== null && typeof rule === "object", "matched rules must be objects");
    check(typeof rule.ruleId === "string", "matched rule needs a ruleId");
    check(Array.isArray(rule.actions), "matched rule needs actions");
    return rule;
  });
};
// Decide the single best action for a message. Precedence:
//  1. spamScore >= 60 → quarantine (A029 threshold)
//  2. rule actions in order: skip_inbox → file, snooze, flag
//  3. spamScore >= 30 → needs_human (uncertain)
//  4. otherwise → inbox
export function triageMessage(message, { spamScore, matchedRules } = {}) {
  const msg = messageOf(message);
  const spam = spamOf(spamScore);
  const rules = rulesOf(matchedRules);
  const reasons = [];
  if (spam !== null && spam >= 60) {
    reasons.push(`spam score ${spam} meets the quarantine threshold (60)`);
    return decision(msg, "quarantine", reasons, null);
  }
  for (const rule of rules) {
    for (const action of rule.actions) {
      if (action.type === "skip_inbox" || action.type === "file") {
        reasons.push(`rule "${rule.ruleId}" files it${action.folder ? ` to ${action.folder}` : ""}`);
        return decision(msg, "file", reasons, action.folder ?? null);
      }
      if (action.type === "snooze") {
        reasons.push(`rule "${rule.ruleId}" snoozes it for ${action.delay}`);
        return decision(msg, "snooze", reasons, action.delay ?? null);
      }
      if (action.type === "flag") {
        reasons.push(`rule "${rule.ruleId}" flags it (${action.label})`);
        return decision(msg, "flag", reasons, action.label ?? null);
      }
    }
  }
  if (spam !== null && spam >= 30) {
    reasons.push(`spam score ${spam} is uncertain — a human should look`);
    return decision(msg, "needs_human", reasons, null);
  }
  reasons.push("no rule matched and spam score is low");
  return decision(msg, "inbox", reasons, null);
}
const decision = (message, action, reasons, detail) =>
  Object.freeze({ messageId: message.id, action, detail, reasons: Object.freeze([...reasons]) });
// Batch: triage a list, returning decisions grouped by action.
export function triageBatch(items) {
  check(Array.isArray(items) && items.length <= 10000, "items must be a list of at most 10000");
  const decisions = items.map(item => {
    check(item !== null && typeof item === "object", "batch items must be objects");
    return triageMessage(item.message, { spamScore: item.spamScore, matchedRules: item.matchedRules });
  });
  const byAction = Object.fromEntries(ACTIONS.map(action => [action, []]));
  for (const decision of decisions) byAction[decision.action].push(decision);
  return Object.freeze({ decisions: Object.freeze(decisions),
    byAction: Object.freeze(Object.fromEntries(Object.entries(byAction).map(([k, v]) => [k, Object.freeze(v)]))) });
}
export { TriageError, ACTIONS };
