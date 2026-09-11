import { DENIAL_CONTRACTS } from "./contracts.js";
import { HOSTED_CHECK_GAP, PIN, STAGING } from "./pin.js";

export const MATRIX = Object.freeze([
  Object.freeze({
    id: "cancelled",
    title: DENIAL_CONTRACTS.cancelled.title,
    expected: `${DENIAL_CONTRACTS.cancelled.status} ${DENIAL_CONTRACTS.cancelled.code}`,
    copy: DENIAL_CONTRACTS.cancelled.message,
    local: DENIAL_CONTRACTS.cancelled.local,
    hostedCheck: "missing",
    security: "Cancellation is final. Existing members keep access. Do not weaken invite-only."
  }),
  Object.freeze({
    id: "expired",
    title: DENIAL_CONTRACTS.expired.title,
    expected: `${DENIAL_CONTRACTS.expired.status} ${DENIAL_CONTRACTS.expired.code}`,
    copy: DENIAL_CONTRACTS.expired.message,
    local: DENIAL_CONTRACTS.expired.local,
    hostedCheck: "missing",
    security: "Expiry is server-clock. A hosted probe must not mint a live invite to expire it."
  }),
  Object.freeze({
    id: "join-cap",
    title: DENIAL_CONTRACTS["join-cap"].title,
    expected: `${DENIAL_CONTRACTS["join-cap"].status} ${DENIAL_CONTRACTS["join-cap"].code}`,
    copy: DENIAL_CONTRACTS["join-cap"].message,
    local: DENIAL_CONTRACTS["join-cap"].local,
    hostedCheck: "missing",
    security: "Join cap is 1–25. Do not consume production/staging guest slots to prove fullness."
  }),
  Object.freeze({
    id: "removed-member",
    title: DENIAL_CONTRACTS["removed-member"].title,
    expected: "403 access_denied (account session) / 401 unauthenticated (revoked room credential)",
    copy: DENIAL_CONTRACTS["removed-member"].accountSession.message,
    local: DENIAL_CONTRACTS["removed-member"].local,
    hostedCheck: "missing",
    security: "Removed membership must stay removed. A link is never recovery for another account."
  }),
  Object.freeze({
    id: "signed-out-401",
    title: DENIAL_CONTRACTS["signed-out-401"].title,
    expected: `${DENIAL_CONTRACTS["signed-out-401"].status} ${DENIAL_CONTRACTS["signed-out-401"].code}`,
    copy: DENIAL_CONTRACTS["signed-out-401"].messages[0],
    local: DENIAL_CONTRACTS["signed-out-401"].local,
    hostedCheck: "operator-once, not encoded",
    security: "Unsigned Room reads stay 401. Do not invent cookies or owner keys."
  })
]);

export const MATRIX_IDS = Object.freeze(MATRIX.map((row) => row.id));

export function matrixReport() {
  return {
    pin: PIN.sha,
    pull: PIN.pull,
    staging: STAGING.origin,
    hostedCheckPath: HOSTED_CHECK_GAP.path,
    hostedCheckCovers: HOSTED_CHECK_GAP.covers,
    rows: MATRIX.map((row) => ({
      id: row.id,
      hostedCheck: row.hostedCheck,
      expected: row.expected
    })),
    gap: HOSTED_CHECK_GAP.missing
  };
}
