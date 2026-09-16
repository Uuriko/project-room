// Track C slice C9 — Growth alert rules.
//
// Declarative, pure, dependency-free alert rules over C5 summary() outputs
// and C8 compareSummaries() outputs. Rules describe *what to watch for*;
// evaluateAlerts() evaluates them. No timers, no sends, no wiring — those
// belong to a later slice. Outputs are frozen; evaluation is deterministic
// given the same inputs.

import { isKnownEvent } from "./growth-events.js";

export const ALERT_KINDS = Object.freeze([
  "activity-surge",
  "dead-window",
  "mention-spike",
  "engagement-drop"
]);

export const ALERT_SEVERITIES = Object.freeze(["info", "warn", "critical"]);

export const ENGAGEMENT_METRICS = Object.freeze([
  "messages",
  "reactions",
  "pins",
  "mentions",
  "mentionsPerMessage"
]);

const DEFAULT_SEVERITY = Object.freeze({
  "activity-surge": "warn",
  "dead-window": "critical",
  "mention-spike": "info",
  "engagement-drop": "warn"
});

let ruleCounter = 0;

const isPlainObject = value =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value, label) => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`growth-alerts: ${label} must be a non-empty string`);
  return value.trim();
};

const positiveNumber = (value, label, { integer = false, allowZero = false } = {}) => {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new TypeError(`growth-alerts: ${label} must be a finite${integer ? " integer" : ""} number`);
  }
  if (value < 0 || (value === 0 && !allowZero)) {
    throw new TypeError(`growth-alerts: ${label} must be ${allowZero ? ">= 0" : "> 0"}`);
  }
  return value;
};

const checkSeverity = value => {
  if (value === undefined) return undefined;
  if (!ALERT_SEVERITIES.includes(value)) {
    throw new TypeError(`growth-alerts: severity must be one of ${ALERT_SEVERITIES.join(", ")}`);
  }
  return value;
};

const stringArray = (value, label, { nonEmpty = true } = {}) => {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new TypeError(`growth-alerts: ${label} must be a non-empty array`);
  }
  const items = value.map(item => nonEmptyString(item, `${label} entries`));
  return Object.freeze(items);
};

const buildRule = (kind, params, ruleId, severity) => {
  const id = ruleId === undefined ? `${kind}:rule-${++ruleCounter}` : nonEmptyString(ruleId, "ruleId");
  return Object.freeze({
    ruleId: id,
    kind,
    severity: checkSeverity(severity) ?? DEFAULT_SEVERITY[kind],
    params: Object.freeze({ ...params })
  });
};

// activitySurgeRule: triggers when a growth event type's percent change
// (from a C8 comparison) meets or exceeds pctThreshold. A move from zero
// to any positive count counts as a surge.
export function activitySurgeRule({ eventType, pctThreshold, severity, ruleId } = {}) {
  if (!isKnownEvent(eventType)) {
    throw new TypeError("growth-alerts: activitySurgeRule eventType must be a known growth event type");
  }
  positiveNumber(pctThreshold, "pctThreshold", { allowZero: true });
  return buildRule("activity-surge", { eventType, pctThreshold }, ruleId, severity);
}

// deadWindowRule: triggers when every listed type (or every tracked type
// when eventTypes is omitted) has a zero total in the current summary.
export function deadWindowRule({ eventTypes, severity, ruleId } = {}) {
  const types = eventTypes === undefined || eventTypes === null ? null : stringArray(eventTypes, "eventTypes");
  if (types !== null) {
    for (const type of types) {
      if (!isKnownEvent(type)) {
        throw new TypeError(`growth-alerts: deadWindowRule eventType "${type}" is not a known growth event type`);
      }
    }
  }
  return buildRule("dead-window", { eventTypes: types }, ruleId, severity);
}

// mentionSpikeRule: triggers when any watched agent's current mention
// count meets or exceeds countThreshold.
export function mentionSpikeRule({ agentIds, countThreshold, severity, ruleId } = {}) {
  const ids = stringArray(agentIds, "agentIds");
  positiveNumber(countThreshold, "countThreshold", { integer: true });
  return buildRule("mention-spike", { agentIds: ids, countThreshold }, ruleId, severity);
}

// engagementDropRule: triggers when an engagement metric's percent change
// (from a C8 comparison) drops to -pctThreshold or worse.
export function engagementDropRule({ metric, pctThreshold, severity, ruleId } = {}) {
  if (!ENGAGEMENT_METRICS.includes(metric)) {
    throw new TypeError(`growth-alerts: engagementDropRule metric must be one of ${ENGAGEMENT_METRICS.join(", ")}`);
  }
  positiveNumber(pctThreshold, "pctThreshold");
  return buildRule("engagement-drop", { metric, pctThreshold }, ruleId, severity);
}

// defineRule: validates a kind + params pair and builds the matching rule.
// Throws a clear Error on unknown kinds or bad params.
export function defineRule(kind, params = {}) {
  if (!isPlainObject(params)) throw new TypeError("growth-alerts: defineRule params must be an object");
  switch (kind) {
    case "activity-surge": return activitySurgeRule(params);
    case "dead-window": return deadWindowRule(params);
    case "mention-spike": return mentionSpikeRule(params);
    case "engagement-drop": return engagementDropRule(params);
    default:
      throw new TypeError(`growth-alerts: unknown rule kind "${kind}" (expected one of ${ALERT_KINDS.join(", ")})`);
  }
}

const freezeDeep = value => {
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    return Object.freeze(value);
  }
  return value;
};

const checkSummary = summary => {
  if (!isPlainObject(summary)) throw new TypeError("growth-alerts: summary must be a summary object");
  if (!isPlainObject(summary.totals)) throw new TypeError("growth-alerts: summary.totals must be an object");
  if (!isPlainObject(summary.engagement)) throw new TypeError("growth-alerts: summary.engagement must be an object");
  if (!Array.isArray(summary.topMentionedAgents)) {
    throw new TypeError("growth-alerts: summary.topMentionedAgents must be an array");
  }
  for (const [type, count] of Object.entries(summary.totals)) {
    if (typeof count !== "number" || Number.isNaN(count)) {
      throw new TypeError(`growth-alerts: summary.totals["${type}"] must be a number`);
    }
  }
  for (const entry of summary.topMentionedAgents) {
    if (!isPlainObject(entry) || typeof entry.agentId !== "string" || typeof entry.mentions !== "number") {
      throw new TypeError("growth-alerts: summary.topMentionedAgents entries must be {agentId, mentions}");
    }
  }
  return summary;
};

const checkComparison = comparison => {
  if (comparison === null) return null;
  if (!isPlainObject(comparison)) throw new TypeError("growth-alerts: comparison must be a C8 comparison object or null");
  if (!Array.isArray(comparison.perType)) throw new TypeError("growth-alerts: comparison.perType must be an array");
  if (!isPlainObject(comparison.engagementShift)) {
    throw new TypeError("growth-alerts: comparison.engagementShift must be an object");
  }
  if (!Array.isArray(comparison.topMentionedMovers)) {
    throw new TypeError("growth-alerts: comparison.topMentionedMovers must be an array");
  }
  return comparison;
};

// Re-validate a rule (constructor-built or a plain object with the same
// shape) so evaluateAlerts fail-closes on malformed rules.
const normalizeRule = rule => {
  if (!isPlainObject(rule)) throw new TypeError("growth-alerts: rules must be rule objects");
  if (!ALERT_KINDS.includes(rule.kind)) {
    throw new TypeError(`growth-alerts: unknown rule kind "${rule.kind}"`);
  }
  const rebuilt = defineRule(rule.kind, isPlainObject(rule.params) ? rule.params : {});
  return {
    ruleId: rule.ruleId === undefined ? rebuilt.ruleId : nonEmptyString(rule.ruleId, "ruleId"),
    kind: rebuilt.kind,
    severity: checkSeverity(rule.severity) ?? rebuilt.severity,
    params: rebuilt.params
  };
};

const needsComparison = (ruleId, kind) =>
  ({ ruleId, kind, triggered: false, severity: undefined, detail: "needs comparison" });

const mentionCounts = (summary, comparison) => {
  const counts = new Map(summary.topMentionedAgents.map(entry => [entry.agentId, entry.mentions]));
  if (comparison !== null) {
    for (const mover of comparison.topMentionedMovers) {
      if (!counts.has(mover.agentId)) counts.set(mover.agentId, mover.currentMentions);
    }
  }
  return counts;
};

const evaluators = {
  "activity-surge"(rule, summary, comparison) {
    if (comparison === null) return needsComparison(rule.ruleId, rule.kind);
    const { eventType, pctThreshold } = rule.params;
    const entry = comparison.perType.find(e => e.type === eventType);
    if (!entry) {
      return { ruleId: rule.ruleId, kind: rule.kind, triggered: false, severity: rule.severity, detail: `${eventType}: absent from comparison` };
    }
    if (entry.fromZero) {
      return {
        ruleId: rule.ruleId,
        kind: rule.kind,
        triggered: entry.current > 0,
        severity: rule.severity,
        detail: `${eventType}: rose from 0 to ${entry.current} (new activity)`
      };
    }
    const triggered = entry.pctChange >= pctThreshold;
    const pct = `${(entry.pctChange * 100).toFixed(1)}%`;
    return {
      ruleId: rule.ruleId,
      kind: rule.kind,
      triggered,
      severity: rule.severity,
      detail: `${eventType}: ${entry.previous} -> ${entry.current} (${entry.pctChange >= 0 ? "+" : ""}${pct}) vs threshold +${(pctThreshold * 100).toFixed(1)}%`
    };
  },
  "dead-window"(rule, summary) {
    const types = rule.params.eventTypes ?? Object.keys(summary.totals);
    const zeroTypes = types.filter(type => (summary.totals[type] ?? 0) === 0);
    const triggered = zeroTypes.length === types.length;
    return {
      ruleId: rule.ruleId,
      kind: rule.kind,
      triggered,
      severity: rule.severity,
      detail: triggered
        ? `no activity in window for: ${types.join(", ")}`
        : `active types: ${types.filter(type => !zeroTypes.includes(type)).join(", ")}`
    };
  },
  "mention-spike"(rule, summary, comparison) {
    const { agentIds, countThreshold } = rule.params;
    const counts = mentionCounts(summary, comparison);
    const spiking = agentIds.filter(id => (counts.get(id) ?? 0) >= countThreshold);
    return {
      ruleId: rule.ruleId,
      kind: rule.kind,
      triggered: spiking.length > 0,
      severity: rule.severity,
      detail: spiking.length > 0
        ? `spiking: ${spiking.map(id => `${id}=${counts.get(id)}`).join(", ")} (threshold ${countThreshold})`
        : `no watched agent reached ${countThreshold} mentions`
    };
  },
  "engagement-drop"(rule, summary, comparison) {
    if (comparison === null) return needsComparison(rule.ruleId, rule.kind);
    const { metric, pctThreshold } = rule.params;
    const shift = comparison.engagementShift[metric];
    if (!shift) {
      return { ruleId: rule.ruleId, kind: rule.kind, triggered: false, severity: rule.severity, detail: `${metric}: absent from comparison` };
    }
    if (shift.pctChange === null) {
      return { ruleId: rule.ruleId, kind: rule.kind, triggered: false, severity: rule.severity, detail: `${metric}: no baseline to compare against` };
    }
    const triggered = shift.pctChange <= -pctThreshold;
    return {
      ruleId: rule.ruleId,
      kind: rule.kind,
      triggered,
      severity: rule.severity,
      detail: `${metric}: ${shift.previous} -> ${shift.current} (${(shift.pctChange * 100).toFixed(1)}%) vs drop threshold -${(pctThreshold * 100).toFixed(1)}%`
    };
  }
};

// evaluateAlerts(rules, { summary, comparison }): evaluate every rule and
// return a frozen array of frozen hits {ruleId, kind, triggered, severity,
// detail} — one entry per rule, triggered or not. comparison may be null;
// rules that need it report triggered:false with detail "needs comparison".
export function evaluateAlerts(rules, { summary, comparison = null } = {}) {
  if (!Array.isArray(rules)) throw new TypeError("growth-alerts: rules must be an array");
  checkSummary(summary);
  const checkedComparison = checkComparison(comparison);
  const hits = rules.map(rule => {
    const normalized = normalizeRule(rule);
    const hit = evaluators[normalized.kind](normalized, summary, checkedComparison);
    return Object.freeze({ ...hit, severity: hit.severity ?? normalized.severity });
  });
  return freezeDeep(hits);
}
