// server/demigod-policy-adapter.mjs — Demigod's jobs policy mapped onto the
// room's fee shape.
//
// RECORD-ONLY: every export COMPUTES what a fee would be. Nothing here
// collects, charges, moves, or settles money — collection needs John's
// funding tap. All amounts are decimal STRINGS of minor units (USD cents —
// see DEMIGOD_CURRENCY); math is exact BigInt integer arithmetic, never
// floats.
//
// Demigod's policy (as briefed): a 10% placement fee on placement value.
// Trial work carries a management fee that is creditable against a later
// placement fee (Lemon.io shape).

// Currency pin (#3305): Demigod's currency is USD. Every Demigod record —
// here and in server/fee-credit-ledger.mjs — is denominated in USD minor
// units (cents). Before this pin the currency was a caller-supplied string
// passed through unexamined, so nothing in code stated what the amounts
// were. Records still state their currency explicitly; this constant is
// the one place that names Demigod's.
export const DEMIGOD_CURRENCY = "USD";
export const DEMIGOD_PLACEMENT_FEE_BPS = "1000"; // 10%
export const DEMIGOD_POLICY_VERSION = "demigod-placement/1";

function minorString(value, name) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TypeError(`${name} must be a decimal string of minor units, got ${String(value)}`);
  }
  return BigInt(value);
}

function wholeHours(value, name) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative integer, got ${String(value)}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`${name} must be a non-negative integer, got ${String(value)}`);
}

/**
 * RECORD-ONLY: computes the fee; collection needs John's funding tap.
 *
 * placementFeeBreakdown({ placementValueMinor, currency }) ->
 *   { feeBps: "1000", feeMinor, netToTalentMinor, currency,
 *     policy: "demigod-placement/1" }
 *
 * fee = placementValue * 1000 bps, floored to whole minor units; net is the
 * remainder to talent. fee + net always reconstructs the placement value.
 * Every record states its currency explicitly; Demigod's own records use
 * the pin (DEMIGOD_CURRENCY, "USD").
 */
export function placementFeeBreakdown({ placementValueMinor, currency }) {
  const value = minorString(placementValueMinor, "placementValueMinor");
  if (typeof currency !== "string" || currency.length === 0) {
    throw new TypeError(`currency must be a non-empty string, got ${String(currency)}`);
  }
  const fee = (value * BigInt(DEMIGOD_PLACEMENT_FEE_BPS)) / 10000n;
  return {
    feeBps: DEMIGOD_PLACEMENT_FEE_BPS,
    feeMinor: fee.toString(),
    netToTalentMinor: (value - fee).toString(),
    currency,
    policy: DEMIGOD_POLICY_VERSION,
  };
}

/**
 * RECORD-ONLY: computes the fee; collection needs John's funding tap.
 *
 * trialManagementFee({ trialHoursMax, hourlyRateMinor }) ->
 *   { feeMinor, creditableAgainstPlacement: true }
 *
 * fee = trialHoursMax * hourlyRateMinor. The fee is creditable against a
 * later placement fee for the same client — see server/fee-credit-ledger.mjs.
 */
export function trialManagementFee({ trialHoursMax, hourlyRateMinor }) {
  const hours = wholeHours(trialHoursMax, "trialHoursMax");
  const rate = minorString(hourlyRateMinor, "hourlyRateMinor");
  return {
    feeMinor: (hours * rate).toString(),
    creditableAgainstPlacement: true,
  };
}
