import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// The store-core lane's repro of the deferred-batch wedge (bug sweep
// findings-01 F1), kept as a regression on the landed isolation design
// (#3544): a malformed quarantine_thread_splits row makes step 5
// (quarantine_splits) throw on every visit. Before isolation, the batch
// cursor persisted only on whole-tick success, so the rotation pinned at
// step 5 forever and the side-effecting identity_expiry behind it never
// ran — a staged stale identity survived indefinitely. The step's failure
// is now recorded by name in integrity_failures, the cursor advances past
// it, later steps keep their cadence, and removing the poison clears the
// record on a later visit.

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-deferred-batch-quarantine-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedStaleIdentity(store, id) {
  store.db.prepare(`INSERT INTO agent_identities (identity_id, secret_hash, display_name, mint_address, activated_at, revoked_at, created_at)
    VALUES (?, ?, ?, 'mint@example', NULL, NULL, 1)`).run(id, `hash-${id}`, `Name ${id}`);
}

const identityAlive = (store, id) => Boolean(
  store.db.prepare("SELECT 1 FROM agent_identities WHERE identity_id=?").get(id)
);

test("a malformed quarantine row is recorded by name and identity_expiry still runs behind it", async t => {
  const store = open(t);

  // Control: in a clean rotation identity_expiry deletes a stale identity
  // and no failures are recorded.
  seedStaleIdentity(store, "stale-control");
  for (let i = 0; i < 8 && identityAlive(store, "stale-control"); i++) {
    const result = await store.runDeferredIntegrityBatch({});
    assert.deepEqual(result.failures, [], "a clean rotation records no failures");
  }
  assert.equal(identityAlive(store, "stale-control"), false, "control: the stale identity expired");

  // Poison step 5 with a quarantine_id that fails the journal's shape rule.
  seedStaleIdentity(store, "stale-poisoned");
  store.db.prepare(`INSERT INTO quarantine_thread_splits (quarantine_id, account_id, source_id, prior_thread, reviewer, reason, split_at)
    VALUES ('bogus-id', 'acct', 'src', 'thread', 'rev', NULL, 123)`).run();

  let named = null;
  for (let i = 0; i < 12; i++) {
    const result = await store.runDeferredIntegrityBatch({});
    const record = result.failures.find(failure => failure.step === "quarantine_splits");
    if (record) named = record;
  }
  assert.ok(named, "the failing step is named in the batch result's failure list");
  assert.equal(named.recordId, "");
  assert.equal(named.code, "quarantine_splits_failed");
  assert.ok(named.failures >= 1, "the record carries the failure count");
  assert.equal(identityAlive(store, "stale-poisoned"), false,
    "identity_expiry (step 7, behind the poisoned step 5) still ran and expired the stale identity");

  // Recovery: remove the poison row and the record clears on a later visit.
  store.db.prepare("DELETE FROM quarantine_thread_splits WHERE quarantine_id='bogus-id'").run();
  let cleared = null;
  for (let i = 0; i < 15 && !cleared; i++) {
    const result = await store.runDeferredIntegrityBatch({});
    if (!result.failures.some(failure => failure.step === "quarantine_splits")) cleared = result;
  }
  assert.ok(cleared, "the recorded failure clears once the step verifies clean again");
});
