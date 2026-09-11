import { MATRIX } from "./matrix.js";
import { PIN, STAGING } from "./pin.js";

const TOKEN_ENV = "HOSTED_DENIAL_OPERATOR_TOKEN";
const RUN_ENV = "HOSTED_DENIAL_RUN";

/**
 * Opt-in hosted denial stub.
 *
 * Default CI / npm test never probes the live origin.
 * Even when an operator sets env, this stub refuses to send join, cancel,
 * expire, remove-member, or credentialed denial requests. Tokens are never
 * invented. Staging is never attacked.
 */
export function runHostedDenialHarness(env = process.env) {
  const origin = typeof env.HOSTED_DENIAL_ORIGIN === "string" && env.HOSTED_DENIAL_ORIGIN
    ? env.HOSTED_DENIAL_ORIGIN
    : STAGING.origin;
  const run = env[RUN_ENV] === "1";
  const token = typeof env[TOKEN_ENV] === "string" ? env[TOKEN_ENV].trim() : "";

  if (!run) {
    return {
      executed: false,
      status: "skipped",
      reason: `${RUN_ENV} is unset; default tests never contact ${origin}`,
      pin: PIN.sha,
      origin,
      rows: MATRIX.map((row) => ({ id: row.id, result: "skipped" }))
    };
  }

  if (!token) {
    return {
      executed: false,
      status: "skipped",
      reason: `${TOKEN_ENV} missing; never invent tokens; denial probes stay in the operator private .operator folder`,
      pin: PIN.sha,
      origin,
      rows: MATRIX.map((row) => ({ id: row.id, result: "skipped" }))
    };
  }

  return {
    executed: false,
    status: "operator_required",
    reason: "stub will not send hosted denial, join, cancel, or remove-member requests even with a token; extend cloudflare/hosted-check.mjs on the #23 lane or run private operator evidence",
    pin: PIN.sha,
    origin,
    tokenPresent: true,
    tokenValue: null,
    rows: MATRIX.map((row) => ({ id: row.id, result: "not_probed" }))
  };
}

export function publicHealthContract() {
  return {
    origin: STAGING.origin,
    health: { method: "GET", path: STAGING.healthPath, expectedStatus: 200, expectedBodyStatus: "ok" },
    ready: { method: "GET", path: STAGING.readyPath, expectedStatus: 200, expectedBodyStatus: "ready" },
    bareHealth: { method: "GET", path: STAGING.bareHealthPath, expectedStatus: 404, expectedErrorCode: "not_found" },
    observed: STAGING.observed
  };
}
