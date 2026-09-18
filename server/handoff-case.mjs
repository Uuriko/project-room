// CASE handoff contract (research slice R2). Handoffs are freeform text and
// the receiver re-asks everything; CASE fixes the shape: Customer/auth,
// Aim/urgency, Steps/sources, Escalation/ownership — with an epistemic label
// on every step, so a verified fact never reads the same as a guess.
//
// Pure module: no database, no network, no clock. Validation raises
// ServiceError (422) from ./store.mjs so the same codes read in unit tests
// and through the journal/store layer. Unknown keys and unknown epistemic
// labels are rejected, never silently accepted — an unlabeled step is the
// failure mode this contract exists to kill.
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const check = (condition, code, message) => { if (!condition) fail(422, code, message); };
const CODE = "invalid_handoff_case";

export const caseVersion = 1;
// Epistemic labels mark how each step's claim is known. Every step requires
// one: the receiver must be able to tell verified_fact apart from
// ai_inference without re-asking the customer.
export const epistemicLabels = Object.freeze([
  "verified_fact",
  "customer_statement",
  "ai_inference",
  "recommendation",
]);
const urgencies = Object.freeze(["low", "medium", "high", "critical"]);

const text = (value, max, field) => {
  check(typeof value === "string" && value.isWellFormed() && value.length > 0 && value.length <= max, CODE,
    `${field} must be 1..${max} well-formed characters`);
  return value;
};
const only = (value, allowed, field) => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), CODE, `${field} must be an object`);
  check(Object.keys(value).every(k => allowed.includes(k)), CODE, `${field} carries only ${allowed.join(",")}`);
};
const customerOf = value => {
  only(value, ["id", "auth"], "case.customer");
  return Object.freeze({ id: text(value.id, 512, "case.customer.id"),
    auth: text(value.auth, 128, "case.customer.auth") });
};
const aimOf = value => {
  only(value, ["goal", "urgency"], "case.aim");
  check(urgencies.includes(value.urgency), CODE, `case.aim.urgency must be one of ${urgencies.join(",")}`);
  return Object.freeze({ goal: text(value.goal, 1000, "case.aim.goal"), urgency: value.urgency });
};
const stepOf = (value, i) => {
  only(value, ["action", "source", "epistemic"], `case.steps[${i}]`);
  check(epistemicLabels.includes(value.epistemic), CODE,
    `case.steps[${i}].epistemic must be one of ${epistemicLabels.join(",")}`);
  return Object.freeze({ action: text(value.action, 500, `case.steps[${i}].action`),
    source: text(value.source, 256, `case.steps[${i}].source`),
    epistemic: value.epistemic });
};
const escalationOf = value => {
  only(value, ["owner", "trigger"], "case.escalation");
  return Object.freeze({ owner: text(value.owner, 256, "case.escalation.owner"),
    trigger: text(value.trigger, 1000, "case.escalation.trigger") });
};
// Validate and freeze one CASE block.
export function validateCase(value) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), CODE, "a CASE block must be an object");
  // caseVersion is added by this validator: a block that already carries it
  // re-validates (the journal's verify() checks stored blocks).
  only(value, ["caseVersion", "customer", "aim", "steps", "escalation"], "case");
  check(Array.isArray(value.steps) && value.steps.length >= 1 && value.steps.length <= 20, CODE,
    "case.steps must be a list of 1..20 steps");
  return Object.freeze({ caseVersion, customer: customerOf(value.customer), aim: aimOf(value.aim),
    steps: Object.freeze(value.steps.map((step, i) => stepOf(step, i))),
    escalation: escalationOf(value.escalation) });
}
// The CASE block is optional on a handoff journal entry: absent stays absent
// (backward compat — old entries read as null), present must validate.
export function caseOf(value) {
  if (value === undefined || value === null) return null;
  return validateCase(value);
}
