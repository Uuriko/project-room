// server/minor-units.mjs — the one shared minor-unit validator.
//
// Minor units are decimal strings ("200" = 200 minor units of the pinned
// currency). The pattern is /^\d+$/ — at least one digit. An earlier
// duplicated copy in each of settlement-router.mjs and fee-credit-ledger.mjs
// is what let the B1-2 F3 mutation (regex /^\d+$/ → /^\d*$/) survive in
// both files at once: the empty string "" was accepted as a valid amount
// by neither copy's tests. One helper, one pin (tests/demigod-ledger-pins.test.js).

export function minorString(value, name) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TypeError(`${name} must be a decimal string of minor units, got ${String(value)}`);
  }
  return value;
}
