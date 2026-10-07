// ACP escrow -> evaluator -> release state machine (lane 9, PROTOTYPE).
//
// Pure logic module: no money movement, no persistence, no network. Amounts
// are abstract units; the machine tracks who is owed what state-wise only.
// A separate settlement layer (out of scope) would act on the terminal
// verdicts this machine produces.
//
// Lifecycle:
//   proposed --fund--> funded --beginEvaluation--> in_evaluation --release--> released
//     funded --refund--> refunded              (payer pull-back before evaluation)
//     in_evaluation --refund--> refunded       (evaluator fail verdict)
//     funded|in_evaluation --dispute--> disputed --resolveDispute--> resolved
//        (outcome: release | refund; resolved is terminal)
//   proposed --(sweep, fundBy passed)--> expired
//     funded --(sweep, evalStartBy passed)--> refunded
//   in_evaluation past evalCompleteBy is NEVER auto-decided by sweep: it is
//   reported as stuck for the arbiter or a dispute instead.
//
// Roles: payer (funds), payee (receives on release), evaluator (verdict on
// work), arbiter (resolves disputes). Guards enforce both the current state
// AND the acting role; violations throw EscrowError with a stable code.
//
// All state is caller-owned only in the sense that the factory owns it:
// createEscrow({ now }) returns the machine; `now` defaults to Date.now and
// is injected in tests for deterministic clocks. Every transition appends an
// event-log entry {seq, at, escrowId, from, to, event, actor, note}. Records
// are frozen.
import { randomUUID } from "node:crypto";

const STATES = Object.freeze([
  "proposed", "funded", "in_evaluation",
  "released", "refunded", "disputed", "resolved", "expired",
]);
const TERMINAL = new Set(["released", "refunded", "resolved", "expired"]);
const DISPUTEABLE = new Set(["funded", "in_evaluation"]);
const DISPUTE_OUTCOMES = Object.freeze(["release", "refund"]);

class EscrowError extends Error {
  constructor(code, message) { super(message); this.name = "EscrowError"; this.code = code; }
}
const fail = (code, message) => { throw new EscrowError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };
const nonEmptyString = (v, what) =>
  check(typeof v === "string" && v.length > 0, "invalid_escrow", `${what} must be a non-empty string`);
const positiveInt = (v, what) =>
  check(Number.isInteger(v) && v > 0, "invalid_escrow", `${what} must be a positive integer`);

export { EscrowError };

export function createEscrow({ now = () => Date.now() } = {}) {
  const escrows = new Map(); // id -> escrow record (mutable, internal)
  const events = new Map(); // id -> [log entries]
  let seq = 0;

  const append = (id, { event, from, to, actor, note = null, at = now() }) => {
    const entry = Object.freeze({ seq: seq++, at, escrowId: id, from, to, event, actor, note });
    events.get(id).push(entry);
    return entry;
  };
  const get = (id) => {
    nonEmptyString(id, "escrow id");
    const e = escrows.get(id);
    if (!e) fail("invalid_escrow", `escrow "${id}" does not exist`);
    return e;
  };
  const mustState = (e, ...allowed) => {
    if (!allowed.includes(e.state)) {
      fail("invalid_transition", `escrow "${e.id}" is in state ${e.state}; expected one of [${allowed.join(", ")}]`);
    }
  };
  const mustRole = (e, by, ...roles) => {
    const actor = roles.includes("payer") && by === e.payer ? "payer"
      : roles.includes("payee") && by === e.payee ? "payee"
      : roles.includes("evaluator") && by === e.evaluator ? "evaluator"
      : roles.includes("arbiter") && by === e.arbiter ? "arbiter" : null;
    if (!actor) fail("unauthorized", `escrow "${e.id}" action requires one of [${roles.join(", ")}]`);
    return { kind: actor, id: by };
  };
  const transition = (e, to, { event, actor, note }) => {
    const from = e.state;
    e.state = to;
    append(e.id, { event, from, to, actor, note });
    return frozen(e);
  };
  const frozen = (e) => Object.freeze({ ...e });

  return {
    // Create a proposed escrow. Deadlines must order: fundBy <= evalStartBy <= evalCompleteBy.
    create({ id = `esc-${randomUUID().slice(0, 8)}`, payer, payee, evaluator, arbiter, amount,
             fundBy = null, evalStartBy = null, evalCompleteBy = null }) {
      nonEmptyString(id, "escrow id");
      check(!escrows.has(id), "invalid_escrow", `escrow "${id}" already exists`);
      nonEmptyString(payer, "payer");
      nonEmptyString(payee, "payee");
      nonEmptyString(evaluator, "evaluator");
      nonEmptyString(arbiter, "arbiter");
      positiveInt(amount, "amount");
      const t = now();
      for (const [v, name] of [[fundBy, "fundBy"], [evalStartBy, "evalStartBy"], [evalCompleteBy, "evalCompleteBy"]]) {
        check(v === null || (Number.isInteger(v) && v >= t), "invalid_escrow", `${name} must be null or a future timestamp`);
      }
      check(fundBy === null || evalStartBy === null || fundBy <= evalStartBy, "invalid_escrow",
        "fundBy must not be after evalStartBy");
      check(evalStartBy === null || evalCompleteBy === null || evalStartBy <= evalCompleteBy, "invalid_escrow",
        "evalStartBy must not be after evalCompleteBy");
      const e = {
        id, payer, payee, evaluator, arbiter, amount,
        fundBy, evalStartBy, evalCompleteBy,
        state: "proposed", disputeOutcome: null,
      };
      escrows.set(id, e);
      events.set(id, []);
      append(id, { event: "created", from: null, to: "proposed", actor: { kind: "payer", id: payer } });
      return frozen(e);
    },

    fund(id, { by }) {
      const e = get(id);
      mustState(e, "proposed");
      const actor = mustRole(e, by, "payer");
      return transition(e, "funded", { event: "funded", actor });
    },

    beginEvaluation(id, { by }) {
      const e = get(id);
      mustState(e, "funded");
      const actor = mustRole(e, by, "evaluator");
      return transition(e, "in_evaluation", { event: "evaluation_started", actor });
    },

    release(id, { by }) {
      const e = get(id);
      mustState(e, "in_evaluation");
      const actor = mustRole(e, by, "evaluator");
      return transition(e, "released", { event: "released", actor });
    },

    refund(id, { by, reason }) {
      const e = get(id);
      mustState(e, "funded", "in_evaluation");
      const roles = e.state === "funded" ? ["payer", "evaluator"] : ["evaluator"];
      const actor = mustRole(e, by, ...roles);
      nonEmptyString(reason, "reason");
      return transition(e, "refunded", { event: "refunded", actor, note: reason });
    },

    dispute(id, { by, reason }) {
      const e = get(id);
      if (!DISPUTEABLE.has(e.state)) {
        fail("invalid_transition", `escrow "${e.id}" cannot dispute in state ${e.state}`);
      }
      nonEmptyString(reason, "reason");
      const actor = mustRole(e, by, "payer", "payee");
      return transition(e, "disputed", { event: "disputed", actor, note: reason });
    },

    resolveDispute(id, { by, outcome, note }) {
      const e = get(id);
      mustState(e, "disputed");
      check(DISPUTE_OUTCOMES.includes(outcome), "invalid_escrow",
        `outcome must be one of [${DISPUTE_OUTCOMES.join(", ")}]`);
      nonEmptyString(note, "note");
      const actor = mustRole(e, by, "arbiter");
      e.disputeOutcome = outcome;
      return transition(e, "resolved", { event: "dispute_resolved", actor, note: `${outcome}: ${note}` });
    },

    // Timeout/expiry handling. Idempotent: only escrows still in the exact
    // pre-state are moved, so reruns never double-apply or duplicate logs.
    // `at` defaults to the machine clock; callers (e.g. a cron sweep) may pass
    // their own timestamp.
    // Returns { applied: [log entries], stuck: [escrow snapshots] }.
    sweep(at = now()) {
      check(Number.isInteger(at), "invalid_escrow", "sweep timestamp must be an integer");
      const applied = [];
      const stuck = [];
      for (const e of escrows.values()) {
        if (e.state === "proposed" && e.fundBy !== null && at > e.fundBy) {
          applied.push(append(e.id, {
            event: "expired", from: "proposed", to: "expired",
            actor: { kind: "rule", id: "sweep" }, note: "funding deadline passed", at,
          }));
          e.state = "expired";
        } else if (e.state === "funded" && e.evalStartBy !== null && at > e.evalStartBy) {
          applied.push(append(e.id, {
            event: "refunded", from: "funded", to: "refunded",
            actor: { kind: "rule", id: "sweep" }, note: "evaluation-start deadline passed", at,
          }));
          e.state = "refunded";
        } else if (e.state === "in_evaluation" && e.evalCompleteBy !== null && at > e.evalCompleteBy) {
          stuck.push(frozen(e)); // never auto-decided: arbiter or dispute decides
        }
      }
      return { applied: Object.freeze(applied), stuck: Object.freeze(stuck) };
    },

    get(id) { return frozen(get(id)); },
    list() { return Object.freeze([...escrows.values()].map(frozen)); },
    log(id) { get(id); return Object.freeze([...events.get(id)]); },
    states: STATES,
  };
}
