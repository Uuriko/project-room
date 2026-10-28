// fixwave C2 — fail-first tests for the WAVE-500 7th finding
// (server/account-deletion.mjs): deleteWhereIfExists / countWhereIfExists
// must not swallow DB errors as "0 removed". executeAccountDeletion runs
// inside one transaction; a swallowed mid-delete error commits a PARTIAL
// deletion while the receipt reports removed: 0 with no error surfaced.
// The honest behavior: the error propagates, the transaction rolls back,
// and the caller sees a failure instead of a false success receipt.
import test from "node:test";
import assert from "node:assert/strict";
import { executeAccountDeletion } from "../server/account-deletion.mjs";
import { ACTIONS } from "../src/account-deletion.mjs";

// Minimal plan that passes validatePurgePlan: one PURGE category whose
// executor runs deleteWhereIfExists over three oauth tables.
const plan = categories => ({
  accountId: "u-fault",
  categories,
  steps: categories.map(category => ({ category, action: ACTIONS.PURGE, itemCount: 1, dependsOn: [] })),
  rooms: {},
});

// Store double: prepare throws on SQL containing `failOn`; the
// sqlite_master probe reports the table present; DML reports zero changes.
const failingDb = failOn => ({
  prepare(sql) {
    if (sql.includes(failOn)) throw new Error(`disk I/O error (fault injected: ${failOn})`);
    if (sql.includes("sqlite_master")) return { get: () => ({ "1": 1 }) };
    return { get: () => ({ n: 0 }), run: () => ({ changes: 0 }) };
  },
});
const storeWith = db => ({ db, transaction: fn => fn() });

test("a DB error mid-delete aborts the deletion instead of reporting removed: 0", () => {
  const store = storeWith(failingDb("DELETE"));
  assert.throws(
    () => executeAccountDeletion(store, plan(["oauth_tokens"])),
    /fault injected: DELETE/,
    "the real DB error propagates; the transaction rolls back; no false success receipt",
  );
});

test("a DB error in the table-exists probe also aborts instead of reading as 0", () => {
  const store = storeWith(failingDb("sqlite_master"));
  assert.throws(
    () => executeAccountDeletion(store, plan(["oauth_tokens"])),
    /fault injected: sqlite_master/,
    "a failing existence probe must not masquerade as 'table absent'",
  );
});

test("happy path is unchanged: removed counts sum across tables", () => {
  let deleted = 0;
  const db = {
    prepare(sql) {
      if (sql.includes("sqlite_master")) return { get: () => ({ "1": 1 }) };
      return { get: () => ({ n: 3 }), run: () => { deleted += 3; return { changes: 3 }; } };
    },
  };
  const receipt = executeAccountDeletion(storeWith(db), plan(["oauth_tokens"]));
  assert.equal(receipt.accountId, "u-fault");
  assert.equal(receipt.purged.length, 1);
  assert.equal(receipt.purged[0].category, "oauth_tokens");
  assert.equal(receipt.purged[0].removed, 9, "3 oauth tables x 3 rows each");
  assert.equal(deleted, 9);
});

test("a genuinely absent table still purges as 0 without touching the DB", () => {
  let dml = 0;
  const db = {
    prepare(sql) {
      if (sql.includes("sqlite_master")) return { get: () => null }; // table absent
      dml += 1;
      return { get: () => ({ n: 0 }), run: () => ({ changes: 0 }) };
    },
  };
  const receipt = executeAccountDeletion(storeWith(db), plan(["oauth_tokens"]));
  assert.equal(receipt.purged[0].removed, 0);
  assert.equal(dml, 0, "no DELETE is issued for absent tables");
});
