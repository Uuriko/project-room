// research r41: account deletion planning binds one SQL value per room
// membership (countJournalLegs). The Worker's Durable Object SQL allows 100,
// so an account bound in 100 rooms (the ACCOUNT_ROOM_LIMIT pilot cap) cannot
// plan its own deletion. Run under ROOM_SQL_BIND_LIMIT=100 to enforce the
// Worker's limit in Node (the guard ships in research-r40-node-bind-guard).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { executeAccountDeletion, planAccountDeletion } from "../server/account-deletion.mjs";
import { ACCOUNT_ROOM_LIMIT } from "../server/room-lifecycle.mjs";

const ACCOUNT = "acct-heavy";

// Enforce the Worker's limit for every store this file opens, and prove the
// guard is live so the test cannot pass vacuously on a plain Node build.
process.env.ROOM_SQL_BIND_LIMIT = "100";
test("the Worker bind limit is enforced in this file", (t) => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const values = Array.from({ length: 101 }, (_, i) => i);
  assert.throws(() => store.db.prepare(`SELECT 1 WHERE 1 IN (${values.map(() => "?").join(",")})`).get(...values),
    /too many SQL variables/);
});

function storeWithMemberships(t, rooms) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.createAccount(ACCOUNT);
  for (let i = 0; i < rooms; i++) {
    const roomId = `room-${String(i).padStart(3, "0")}`;
    const owner = `owner-${i}`;
    store.initialize(initialRoom(roomId, owner));
    store.bindHumanAccount(roomId, owner, ACCOUNT);
    // Genesis writes one journal leg per member, so each membership lane
    // holds exactly one leg the deletion inventory must count.
    store.bountyEscrow.ensureGenesis(roomId);
  }
  return store;
}

for (const rooms of [ACCOUNT_ROOM_LIMIT - 1, ACCOUNT_ROOM_LIMIT, ACCOUNT_ROOM_LIMIT + 20]) {
  test(`an account bound in ${rooms} rooms can plan its deletion`, (t) => {
    const store = storeWithMemberships(t, rooms);
    const bound = store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id=?").get(ACCOUNT).n;
    assert.equal(bound, rooms);
    const { plan } = planAccountDeletion(store, ACCOUNT);
    const journal = plan.steps.find(step => step.category === "bounty_journal");
    assert.equal(journal.itemCount, rooms, "every membership lane's journal leg is counted once");
  });
}

test("an account at the room cap can be deleted end to end", (t) => {
  const store = storeWithMemberships(t, ACCOUNT_ROOM_LIMIT);
  const { plan } = planAccountDeletion(store, ACCOUNT);
  executeAccountDeletion(store, plan);
  const left = store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id=?").get(ACCOUNT).n;
  assert.equal(left, 0);
});
