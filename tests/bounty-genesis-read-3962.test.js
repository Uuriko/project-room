// #3962: fresh-room members read 0.00 credits until the first escrow
// write. Genesis issuance is lazy and the SERVED ledger read paths —
// the HTTP escrow routes and the bounty_read_* MCP tools — never
// provisioned it, so a fresh room read as unfunded/broken until
// someone happened to post a bounty.
//
// The fix provisions at the served layer, deliberately NOT inside
// BountyEscrow.balances()/history(): those stay write-free (the
// cold-isolate read contract, tests/bounty-ensure-readonly.test.js)
// and lazy at the unit level (Option B pins balances-before-
// ensureGenesis at 0, tests/bounty-first-shift-option-b.test.js).
// The escrow gains a pure-read genesisOutstanding() check; the routes
// and MCP read tools run ensureGenesis (per-member idempotent) when
// it reports outstanding, then read.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";
import { handleBountyEscrow } from "../server/bounty-escrow-routes.mjs";

const ROOM = "room-3962";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const OWNER = "owner-human";

class HttpReject extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const helpers = {
  json: (res, status, value) => { res.statusCode = status; res.body = value; },
  reject: (status, code, message) => { throw new HttpReject(status, code, message); },
  body: async req => req._body,
};

function makeRouteStore() {
  const db = new DatabaseSync(":memory:");
  ensureAutonomyTiersSchema(db);
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_3962");
    try { const out = fn(); db.exec("RELEASE escrow_3962"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_3962"); db.exec("RELEASE escrow_3962"); throw error; }
  };
  const members = {
    [JILL]: { kind: "agent", active: true },
    [GROK]: { kind: "agent", active: true },
    [OWNER]: { kind: "human", active: true },
  };
  const store = { db, transaction, readTransaction: transaction,
    roomAuthority: () => ({ ownerId: OWNER, members }),
    agentPlugin: { fanoutRoomEvent: () => {} } };
  store.bountyEscrow = new BountyEscrow(store, { now: () => Date.now() });
  return { store, db };
}

const call = async (store, { method = "GET", route, authId, identity }) => {
  const req = { method, headers: {}, _body: {} };
  const res = { statusCode: null, body: null };
  const auth = { member: { id: authId, kind: authId.startsWith("id:agent/") ? "agent" : "human" } };
  try {
    await handleBountyEscrow({ req, res, url: new URL(`http://localhost/api/rooms/${ROOM}/x`),
      store, roomId: ROOM, auth, escrowRoute: route, bountyId: null, identity, sybilFlagId: null,
      reauthorize: () => auth, helpers });
  } catch (error) {
    if (error instanceof HttpReject) { res.statusCode = error.status; res.body = { code: error.code, message: error.message }; }
    else throw error;
  }
  return res;
};

const genesisRows = db => {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bounty_journal'").get();
  if (!table) return 0; // the escrow schema is created lazily by the first escrow call
  return db.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=? AND kind='genesis'").get(ROOM).n;
};

test("#3962: GET balances on a fresh room serves the genesis issuance with no prior write", async () => {
  const { store, db } = makeRouteStore();
  assert.equal(genesisRows(db), 0, "no escrow write has happened");
  const res = await call(store, { route: "balances", authId: JILL, identity: JILL });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.balances.payable, 100);
  assert.equal(res.body.balances.total, 100);
  assert.equal(genesisRows(db), 3, "the read provisioned every member exactly once");
  // Idempotent: a second read issues nothing new.
  const again = await call(store, { route: "balances", authId: GROK, identity: GROK });
  assert.equal(again.body.balances.payable, 100);
  assert.equal(genesisRows(db), 3);
  assert.equal(store.bountyEscrow.verifyConservation(ROOM).ok, true);
});

test("#3962: GET history on a fresh room serves the genesis movement", async () => {
  const { store, db } = makeRouteStore();
  const res = await call(store, { route: "history", authId: GROK, identity: GROK });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.receipts.length >= 1, "the genesis issuance is on the worker's history");
  assert.equal(genesisRows(db), 3);
});

test("#3962: the escrow core stays lazy — the layering is deliberate", t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons", "owner"));
  t.after(() => store.close());
  const escrow = store.bountyEscrow;
  assert.equal(escrow.genesisOutstanding("commons"), true, "a fresh room has genesis outstanding");
  assert.equal(escrow.balances("commons", "owner").total, 0,
    "balances() itself does not provision (cold-isolate + Option B contracts)");
  escrow.ensureGenesis("commons");
  assert.equal(escrow.genesisOutstanding("commons"), false);
  assert.equal(escrow.balances("commons", "owner").total, 100);
});
