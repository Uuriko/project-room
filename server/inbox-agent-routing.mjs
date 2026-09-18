// @agent mention routing for the inbox (lane C, inbox-agent-collab). When a
// message or note mentions @agent, this module decides where it goes: direct
// delivery to the named agent, or escalation to a human (or another agent)
// first — per a per-agent policy. Every routing decision is journaled so a
// mention can never vanish silently; escalated records stay open until
// resolved.
//
// extractAgentMentions is the pure parser: "@claude look" → ["claude"].
// Email-style user@host matches are skipped (a mention is not preceded by a
// word character).
//
// Pure, in-memory, dependency-free, deterministic; frozen outputs. Clock and
// id generator are injected so fixtures control time and ids.
import { randomUUID } from "node:crypto";
import { identityOf, threadIdOf } from "./inbox-assign.mjs";

export class RoutingError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new RoutingError(code, message, detail); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export const routingModes = Object.freeze(["direct", "escalate"]);
export const routingStatuses = Object.freeze(["routed", "escalated", "resolved"]);
const transitions = Object.freeze({ routed: ["escalated", "resolved"], escalated: ["resolved"], resolved: [] });

const mentionPattern = /(?<![A-Za-z0-9_.@])@([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})/g;
export function extractAgentMentions(text) {
  check(typeof text === "string" && text.isWellFormed(), "routing_invalid", "text must be a well-formed string");
  check(text.length <= 20000, "routing_invalid", "text must be at most 20000 characters");
  const seen = new Set(), mentions = [];
  for (const match of text.matchAll(mentionPattern)) {
    if (!seen.has(match[1])) { seen.add(match[1]); mentions.push(match[1]); }
  }
  return Object.freeze(mentions);
}

export const defaultPolicy = Object.freeze({ mode: "direct", scopes: Object.freeze([]), escalateTo: null, note: null });
const policyOf = value => {
  if (value === undefined || value === null) return defaultPolicy;
  check(value !== null && typeof value === "object" && !Array.isArray(value), "routing_invalid", "policy must be an object");
  check(Object.keys(value).every(k => ["mode", "scopes", "escalateTo", "note"].includes(k)), "routing_invalid",
    "policy carries only mode/scopes/escalateTo/note");
  check(routingModes.includes(value.mode), "routing_invalid", `policy.mode must be one of ${routingModes.join(",")}`);
  const scopes = value.scopes === undefined || value.scopes === null ? [] : value.scopes;
  check(Array.isArray(scopes) && scopes.every(s => typeof s === "string" && s.length >= 1 && s.length <= 64),
    "routing_invalid", "policy.scopes must be a list of 1..64 character strings");
  const escalateTo = value.escalateTo === undefined || value.escalateTo === null ? null : identity(value.escalateTo, "policy.escalateTo");
  if (value.mode === "escalate") check(escalateTo !== null, "routing_invalid", "an escalate policy names its escalation target");
  const note = value.note === undefined || value.note === null ? null : value.note;
  check(note === null || (typeof note === "string" && note.isWellFormed() && note.length >= 1 && note.length <= 500),
    "routing_invalid", "policy.note must be 1..500 well-formed characters");
  return Object.freeze({ mode: value.mode, scopes: Object.freeze([...scopes]), escalateTo, note });
};
const agentNameOf = value => {
  check(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value), "routing_invalid",
    "agent must be a 1..64 character agent name");
  return value;
};
const isoOf = ms => new Date(ms).toISOString();

// identityOf/threadIdOf come from the assignment module; wrap them so this
// module's public surface throws only RoutingError — one error contract per
// module, one catch for the caller.
const threadOf = value => {
  try { return threadIdOf(value); } catch (error) { fail("routing_invalid", error.message); }
};
const identity = (value, field) => {
  try { return identityOf(value, field); } catch (error) { fail("routing_invalid", error.message); }
};

const freezeRecord = record => Object.freeze({ ...record,
  from: Object.freeze({ ...record.from }),
  escalatedTo: record.escalatedTo ? Object.freeze({ ...record.escalatedTo }) : null,
  policy: Object.freeze({ ...record.policy, scopes: Object.freeze([...record.policy.scopes]),
    escalateTo: record.policy.escalateTo ? Object.freeze({ ...record.policy.escalateTo }) : null }),
  history: Object.freeze(record.history.map(h => Object.freeze({ ...h, by: Object.freeze({ ...h.by }) }))),
});

export function createAgentRouter({ clock = () => Date.now(), id = () => randomUUID(), policy = {} } = {}) {
  check(policy !== null && typeof policy === "object" && !Array.isArray(policy), "routing_invalid", "policy must be an object");
  const policies = new Map(Object.entries(policy).map(([agent, pol]) => [agentNameOf(agent), policyOf(pol)]));
  const records = new Map(); // routingId -> record

  function setPolicy(agent, value) {
    const name = agentNameOf(agent);
    const pol = policyOf(value);
    policies.set(name, pol);
    return pol;
  }
  const policyFor = agent => policies.get(agent) ?? defaultPolicy;

  // Route every @agent mention in a message: direct → routed to the agent;
  // escalate → escalated to the policy's target with the agent named as the
  // intended recipient. Returns one record per mention; no mentions means
  // an empty, frozen records list — never an error.
  function route(threadId, { text, from, context = null } = {}) {
    const tid = threadOf(threadId);
    const who = identity(from, "from");
    if (context !== null && context !== undefined)
      check(typeof context === "string" && context.isWellFormed() && context.length >= 1 && context.length <= 2000,
        "routing_invalid", "context must be 1..2000 well-formed characters");
    const mentions = extractAgentMentions(text);
    const made = mentions.map(agent => {
      const pol = policyFor(agent);
      const escalated = pol.mode === "escalate";
      const record = freezeRecord({ routingId: id(), threadId: tid, agent, mode: pol.mode, policy: pol,
        status: escalated ? "escalated" : "routed", from: who, context,
        escalatedTo: escalated ? pol.escalateTo : null,
        createdAt: isoOf(clock()),
        history: [{ status: escalated ? "escalated" : "routed", at: isoOf(clock()), by: who }] });
      records.set(record.routingId, record);
      return record;
    });
    return Object.freeze({ records: Object.freeze(made), mentions });
  }

  const getRecord = routingId => {
    check(typeof routingId === "string" && routingId.length >= 1, "routing_invalid", "routingId must be a non-empty string");
    const record = records.get(routingId);
    if (!record) fail("routing_not_found", "No such routing record.", { routingId });
    return record;
  };
  const move = (record, status, by, extra = {}) => {
    if (!transitions[record.status].includes(status))
      fail("routing_transition", `A ${record.status} routing cannot move to ${status}.`,
        { from: record.status, to: status });
    const next = freezeRecord({ ...record, status,
      history: [...record.history, { status, at: isoOf(clock()), by, ...extra }] });
    records.set(next.routingId, next);
    return next;
  };

  // Manually escalate a routed mention: something about it needs a human
  // (or a different agent) before the named agent sees it.
  function escalate(routingId, { by, reason, to = null } = {}) {
    const record = getRecord(routingId);
    const who = identity(by, "by");
    const target = to === null || to === undefined ? record.escalatedTo : identity(to, "to");
    const next = move(record, "escalated", who, { reason: (() => {
      check(typeof reason === "string" && reason.isWellFormed() && reason.length >= 1 && reason.length <= 1000,
        "routing_invalid", "reason must be 1..1000 well-formed characters");
      return reason;
    })() });
    return freezeRecord({ ...next, escalatedTo: target ? Object.freeze({ ...target }) : null });
  }

  // Close the loop: the mention was handled, with the outcome on record.
  function resolve(routingId, { by, outcome } = {}) {
    const record = getRecord(routingId);
    const who = identity(by, "by");
    check(typeof outcome === "string" && outcome.isWellFormed() && outcome.length >= 1 && outcome.length <= 1000,
      "routing_invalid", "outcome must be 1..1000 well-formed characters");
    return move(record, "resolved", who, { outcome });
  }

  function get(routingId) { return getRecord(routingId); }
  function list({ status = null, agent = null, threadId = null } = {}) {
    if (status !== null && status !== undefined)
      check(routingStatuses.includes(status), "routing_invalid", `status must be one of ${routingStatuses.join(",")}`);
    let rows = [...records.values()];
    if (status) rows = rows.filter(r => r.status === status);
    if (agent) rows = rows.filter(r => r.agent === agentNameOf(agent));
    if (threadId) rows = rows.filter(r => r.threadId === threadOf(threadId));
    return Object.freeze(rows);
  }
  function openCount() { return [...records.values()].filter(r => r.status !== "resolved").length; }

  return Object.freeze({ route, escalate, resolve, get, list, setPolicy, openCount });
}
