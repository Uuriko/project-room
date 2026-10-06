// server/fee-credit-ledger.mjs — Lemon.io-shaped trial-fee credit ledger.
//
// RECORD-ONLY: this ledger RECORDS trial fees and the credits applied against
// placement fees. It never collects, holds, or pays out money — collection
// needs John's funding tap. Pure module, no I/O: the journal lives in memory
// inside the ledger instance created by createFeeCreditLedger.
//
// Shape: a client pays a trial management fee (see
// server/demigod-policy-adapter.mjs trialManagementFee); the fee becomes a
// credit the client can apply against a later placement fee. Credits expire
// (default 180 days); every credit is single-use.
//
// Invariants:
//   - append-only journal; balances are DERIVED from the journal, never stored.
//   - a credit can never exceed the fee paid (per trial fee AND in total).
//   - double-apply of the same trial fee is rejected.
//   - expired credits are not applied and contribute nothing to the balance.
//   - every journal entry is balanced double-entry (debits == credits).
//   - a trial fee's credit is single-use: one application, up to the fee
//     amount; any remainder is forfeited.
//   - all amounts and timestamps are STRINGS (minor units / ISO-8601).

export const CREDIT_EXPIRY_DAYS = 180;

const MS_PER_DAY = 86400000;

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

function isoTimestamp(value, name) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO-8601 timestamp string, got ${String(value)}`);
  }
  return value;
}

function freezeEntry(entry) {
  return Object.freeze({
    ...entry,
    legs: Object.freeze(entry.legs.map((leg) => Object.freeze({ ...leg }))),
  });
}

/**
 * RECORD-ONLY: creates an isolated fee-credit ledger. `now` is an optional
 * clock for tests, `() => epochMillis`; defaults to Date.now.
 */
export function createFeeCreditLedger({ now } = {}) {
  if (now !== undefined && typeof now !== "function") {
    throw new TypeError(`now must be a function returning epoch millis, got ${String(now)}`);
  }
  const clock = now ?? (() => Date.now());
  const journal = [];
  const appliedKeys = new Set(); // "clientId\ntrialTaskId" with a credit applied
  let seq = 0;

  const isoNow = () => new Date(clock()).toISOString();
  const keyOf = (clientId, trialTaskId) => `${clientId}\n${trialTaskId}`;
  const findFee = (clientId, trialTaskId) =>
    journal.find(
      (e) => e.type === "trial-fee" && e.clientId === clientId && e.trialTaskId === trialTaskId,
    );

  function recordTrialFee({ clientId, trialTaskId, feeMinor }) {
    nonEmptyString(clientId, "clientId");
    nonEmptyString(trialTaskId, "trialTaskId");
    minorString(feeMinor, "feeMinor");
    if (findFee(clientId, trialTaskId)) {
      throw new Error(
        `trial fee already recorded for client "${clientId}" trial "${trialTaskId}" (duplicate record rejected)`,
      );
    }
    const recordedAt = isoNow();
    const entry = freezeEntry({
      seq: ++seq,
      type: "trial-fee",
      clientId,
      trialTaskId,
      feeMinor,
      recordedAt,
      expiresAt: new Date(clock() + CREDIT_EXPIRY_DAYS * MS_PER_DAY).toISOString(),
      legs: [
        { account: `client:${clientId}:trial-fees-paid`, dc: "debit", amountMinor: feeMinor },
        { account: `client:${clientId}:placement-credit`, dc: "credit", amountMinor: feeMinor },
      ],
    });
    journal.push(entry);
    return entry;
  }

  function applyCreditToPlacement({ clientId, placementId, trialTaskId, creditMinor, expiresAt }) {
    nonEmptyString(clientId, "clientId");
    nonEmptyString(placementId, "placementId");
    nonEmptyString(trialTaskId, "trialTaskId");
    minorString(creditMinor, "creditMinor");
    if (BigInt(creditMinor) <= 0n) {
      throw new TypeError(`creditMinor must be greater than zero, got "${creditMinor}"`);
    }
    const fee = findFee(clientId, trialTaskId);
    if (!fee) {
      throw new Error(`unknown trial fee for client "${clientId}" trial "${trialTaskId}"`);
    }
    const key = keyOf(clientId, trialTaskId);
    if (appliedKeys.has(key)) {
      throw new Error(
        `trial fee already applied for client "${clientId}" trial "${trialTaskId}" (double-apply rejected)`,
      );
    }
    // An explicit expiresAt may only SHORTEN the credit's life, never extend
    // it past the fee's own expiry.
    const effectiveExpiresAt =
      expiresAt === undefined
        ? fee.expiresAt
        : new Date(
            Math.min(Date.parse(fee.expiresAt), Date.parse(isoTimestamp(expiresAt, "expiresAt"))),
          ).toISOString();
    if (clock() > Date.parse(effectiveExpiresAt)) {
      throw new Error(
        `credit expired for client "${clientId}" trial "${trialTaskId}" (expired credits are not applied)`,
      );
    }
    if (BigInt(creditMinor) > BigInt(fee.feeMinor)) {
      throw new Error(
        `credit "${creditMinor}" exceeds fee paid "${fee.feeMinor}" for client "${clientId}" trial "${trialTaskId}"`,
      );
    }
    appliedKeys.add(key);
    const entry = freezeEntry({
      seq: ++seq,
      type: "credit-applied",
      clientId,
      placementId,
      trialTaskId,
      creditMinor,
      appliedAt: isoNow(),
      expiresAt: effectiveExpiresAt,
      legs: [
        { account: `client:${clientId}:placement-credit`, dc: "debit", amountMinor: creditMinor },
        { account: `placement:${placementId}:credits-redeemed`, dc: "credit", amountMinor: creditMinor },
      ],
    });
    journal.push(entry);
    return entry;
  }

  function creditBalance({ clientId }) {
    nonEmptyString(clientId, "clientId");
    const nowMs = clock();
    let balance = 0n;
    for (const e of journal) {
      if (e.type !== "trial-fee" || e.clientId !== clientId) continue;
      if (appliedKeys.has(keyOf(e.clientId, e.trialTaskId))) continue; // single-use: consumed
      if (nowMs > Date.parse(e.expiresAt)) continue; // expired: unusable
      balance += BigInt(e.feeMinor);
    }
    return balance.toString();
  }

  function entries() {
    return Object.freeze([...journal]);
  }

  return { recordTrialFee, applyCreditToPlacement, creditBalance, entries };
}
