// server/settlement-router.mjs — custody-vs-record-only settlement router.
//
// RECORD-ONLY: this router ALWAYS returns the record-only route. Custody
// (holding client funds, collecting fees, paying out talent) is unimplemented
// BY DESIGN in this build. Collection needs John's funding tap.
//
// What John must approve before CUSTODY_ENABLED may flip to true:
//   1. funded pool — a real, funded settlement pool exists with a named
//      custodian and published account/rail details;
//   2. collection authority — John's explicit tap authorizing the room to
//      collect fees from clients;
//   3. payout authority — John's explicit tap authorizing the room to pay
//      talent and providers out of the pool.
//
// Flipping the flag is a POLICY CHANGE, not a rewrite: routeSettlement
// branches on CUSTODY_ENABLED, and the custody branch below is already
// shaped. Nothing at the call sites changes.

export const CUSTODY_ENABLED = false;

export const CUSTODY_REQUIREMENTS = Object.freeze([
  "funded pool: a real, funded settlement pool with a named custodian",
  "collection authority: John's explicit tap authorizing fee collection",
  "payout authority: John's explicit tap authorizing talent/provider payouts",
]);

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string, got ${String(value)}`);
  }
  return value;
}

function minorString(value, name) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TypeError(`${name} must be a decimal string of minor units, got ${String(value)}`);
  }
  return value;
}

/**
 * RECORD-ONLY: routes a settlement. Always returns { route: "record-only",
 * reason } while CUSTODY_ENABLED is false. Callers record the settlement;
 * nobody moves money on the back of this return value.
 */
export function routeSettlement({ venue, amountMinor, rail } = {}) {
  nonEmptyString(venue, "venue");
  minorString(amountMinor, "amountMinor");
  nonEmptyString(rail, "rail");

  if (!CUSTODY_ENABLED) {
    return {
      route: "record-only",
      reason:
        "CUSTODY_ENABLED is false: no funded settlement pool, no collection " +
        "authority, and no payout authority have been approved, so this " +
        "settlement is recorded only. Enabling custody is a policy change " +
        "requiring John's explicit approval of all three.",
      venue,
      amountMinor,
      rail,
      custodyEnabled: false,
    };
  }

  // Unreachable while CUSTODY_ENABLED is false. Kept so that enabling custody
  // is a policy change (flip the flag once the three approvals above exist),
  // not a rewrite of every call site.
  return {
    route: "custody",
    reason: "CUSTODY_ENABLED is true and all custody requirements are satisfied.",
    venue,
    amountMinor,
    rail,
    custodyEnabled: true,
  };
}
