// Inbox rules engine (A012). A pure evaluator: given a list of rules and a
// message, it returns the actions of every enabled rule whose conditions
// match, in rule order (a rule with stopOnMatch halts evaluation). Rules are
// plain data — creation, storage, and the UI are later slices. Pure,
// dependency-free, deterministic; frozen outputs. Malformed rules or
// messages are refused, never half-evaluated.
const FIELDS = ["from", "subject", "body", "channel", "connectionId", "spamScore", "hasAttachment"];
const OPS = ["contains", "equals", "matches", "gte", "lte"];
const ACTION_TYPES = ["file", "mark_read", "mark_unread", "snooze", "flag", "skip_inbox"];
class RuleError extends Error { constructor(code, message) { super(message); this.name = "RuleError"; this.code = code; } }
const fail = (code, message) => { throw new RuleError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_rule", message); };

const fieldValue = (message, field) => {
  switch (field) {
    case "spamScore": {
      check(typeof message.spamScore === "number" && Number.isFinite(message.spamScore), "spamScore must be a finite number for spamScore conditions");
      return message.spamScore;
    }
    case "hasAttachment": return Boolean(message.hasAttachment);
    default: {
      const value = message[field];
      check(typeof value === "string", `${field} must be text`);
      return value;
    }
  }
};
const conditionOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "conditions must be objects");
  check(FIELDS.includes(value.field), `condition field must be one of ${FIELDS.join(", ")}`);
  check(OPS.includes(value.op), `condition op must be one of ${OPS.join(", ")}`);
  if (value.op === "matches") check(typeof value.value === "string" && (() => { try { new RegExp(value.value); return true; } catch { return false; } })(), "matches needs a valid regex");
  else if (value.op === "gte" || value.op === "lte") check(typeof value.value === "number" && Number.isFinite(value.value), `${value.op} needs a finite number`);
  else check(typeof value.value === "string", `${value.op} needs text`);
  return value;
};
const actionOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "actions must be objects");
  check(ACTION_TYPES.includes(value.type), `action type must be one of ${ACTION_TYPES.join(", ")}`);
  if (value.type === "file") check(typeof value.folder === "string" && value.folder.length > 0, "file actions need a folder");
  if (value.type === "snooze") check(typeof value.delay === "string" && /^\d+[mhDw]$/.test(value.delay) === false && /^\d+[mhdw]$/.test(value.delay), "snooze actions need a delay like 2h");
  if (value.type === "flag") check(typeof value.label === "string" && value.label.length > 0, "flag actions need a label");
  return value;
};
const ruleOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "rules must be objects");
  check(typeof value.id === "string" && value.id.length > 0, "rule id must be text");
  check(Array.isArray(value.conditions) && value.conditions.length > 0 && value.conditions.length <= 20, "rules need 1..20 conditions");
  check(Array.isArray(value.actions) && value.actions.length > 0 && value.actions.length <= 20, "rules need 1..20 actions");
  return { id: value.id, name: value.name ?? value.id, enabled: value.enabled !== false,
    stopOnMatch: value.stopOnMatch === true, conditions: value.conditions.map(conditionOf), actions: value.actions.map(actionOf) };
};
const matchesCondition = (message, { field, op, value }) => {
  const actual = fieldValue(message, field);
  switch (op) {
    case "contains": return actual.toLowerCase().includes(value.toLowerCase());
    case "equals": return actual.toLowerCase() === String(value).toLowerCase();
    case "matches": return new RegExp(value).test(actual);
    case "gte": return actual >= value;
    case "lte": return actual <= value;
    default: return false;
  }
};
// Evaluate rules against a message. Returns [{ ruleId, actions }] in rule
// order; stopOnMatch halts after that rule. Disabled rules are skipped.
export function evaluateRules(rules, message) {
  check(Array.isArray(rules) && rules.length <= 200, "rules must be a list of at most 200");
  check(message !== null && typeof message === "object" && !Array.isArray(message), "message must be an object");
  const matched = [];
  for (const rule of rules.map(ruleOf)) {
    if (!rule.enabled) continue;
    if (rule.conditions.every(condition => matchesCondition(message, condition))) {
      matched.push(Object.freeze({ ruleId: rule.id, ruleName: rule.name, actions: Object.freeze(rule.actions.map(action => Object.freeze({ ...action }))) }));
      if (rule.stopOnMatch) break;
    }
  }
  return Object.freeze(matched);
}
// Convenience: flatten all matched actions in order (for the applier).
export const actionsFor = (rules, message) => evaluateRules(rules, message).flatMap(match => match.actions);
export { RuleError, FIELDS, OPS, ACTION_TYPES };
