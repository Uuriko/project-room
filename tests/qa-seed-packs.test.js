// Smoke tests for the QA wave seed packs (scripts/qa-seeds/): every pack
// builds from empty, loads from a clone, and boots the real server against
// the clone. The manifest's measured contents are checked against fresh
// live reads, so a pack that drifts from its manifest — or a builder that
// drifts from the app — fails here, not inside a QA lane.
//
// Builds use a reduced bulk target (the shipped packs use the builders'
// defaults); everything else is the full pack definition. All scratch
// lives under os.tmpdir() and is removed in after().
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSeedPacks } from "../scripts/qa-seeds/build-seed-packs.mjs";
import { openSeedWorld, SeedClock, measureRoom } from "../scripts/qa-seeds/lib/common.mjs";
import { RoomStore } from "../server/store.mjs";
import { patrolBlocks } from "../server/patrol.mjs";
import { jobByName } from "../server/jobs.mjs";
import { queryPublicReceipts } from "../server/public-read-model.mjs";

const BULK_TARGET = 120_000;
// The keeper-blind census predicate from #4138: rows the settlement keeper
// cannot see. The adversarial pack stages exactly three.
const CENSUS_SQL = `SELECT bounty_id FROM bounty_records WHERE room_id=?
  AND ((state='accepted' AND challenge_ends_ms IS NULL)
    OR (state='disputed' AND (dispute_id IS NULL OR resolution_json IS NOT NULL)))
  ORDER BY bounty_id`;

let root;
let built;
const manifests = {};
const packHashes = {};
const sha256File = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const roomId = (manifest, key) => manifest.rooms.find(room => room.key === key).roomId;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "qa-seed-packs-test-"));
  built = await buildSeedPacks({ out: join(root, "packs"), bulkTargetBytes: BULK_TARGET });
  for (const { pack, dir, manifest } of built) {
    manifests[pack] = manifest;
    packHashes[pack] = sha256File(join(dir, "room.sqlite"));
  }
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// Clones a built pack and boots the real server on the clone, the way a
// QA lane consumes it. The pack itself is never opened.
async function bootClone(pack, storeOptions = {}) {
  const cloneDir = join(root, `clone-${pack}`);
  cpSync(join(root, "packs", pack), cloneDir, { recursive: true });
  const clock = new SeedClock(Date.parse(manifests[pack].packNow));
  const world = await openSeedWorld(join(cloneDir, "room.sqlite"), clock, storeOptions);
  return { world, manifest: manifests[pack] };
}

test("clean pack: boots and reads back genesis state", async () => {
  const { world, manifest } = await bootClone("clean");
  try {
    const id = roomId(manifest, "clean");
    const measured = measureRoom(world.store, id);
    assert.equal(measured.members, manifest.contents.clean.members);
    assert.equal(measured.workClaims, manifest.contents.clean.workClaims);
    assert.deepEqual(measured.claimsByState, manifest.contents.clean.claimsByState);
    assert.equal(measured.bounties, 0);
    for (const identity of manifest.identities) {
      const balance = world.store.bountyEscrow.balances(id, identity.identityId);
      assert.equal(balance.payable, 100, `${identity.role} holds the genesis endowment`);
    }
    const credentials = JSON.parse(readFileSync(join(root, "packs", "clean", "credentials.json"), "utf8"));
    const owner = credentials.identities.find(entry => entry.role === "owner");
    const list = await world.call("GET", "/api/agent-rooms", { secret: owner.secret });
    assert.equal(list.status, 200);
    assert.ok(JSON.stringify(list.body).includes(id), "the HTTP room list includes the pack room");
  } finally {
    await world.close();
  }
});

test("grown pack: board census, escrow conservation and public receipts read back", async () => {
  const { world, manifest } = await bootClone("grown");
  try {
    const board = measureRoom(world.store, roomId(manifest, "board"));
    assert.equal(board.workClaims, manifest.contents.board.workClaims);
    assert.deepEqual(board.claimsByState, manifest.contents.board.claimsByState);
    assert.equal(board.claimsByState.closed, 30, "the day-20 sweep closed 30 stale claims");
    for (const state of ["unclaimed", "claimed", "in_progress", "blocked", "delivered", "done", "closed"]) {
      assert.ok(board.claimsByState[state] > 0, `board state ${state} is present`);
    }
    assert.ok(manifest.contents.board.claimedWithExpiredLease > 0, "claimed rows sit past their lease");

    const escrowId = roomId(manifest, "escrow");
    const conservation = world.store.bountyEscrow.verifyConservation(escrowId);
    assert.equal(conservation.ok, true, JSON.stringify(conservation.violations));

    const receipts = queryPublicReceipts(world.store, { limit: 50 });
    assert.equal((receipts.receipts ?? []).length, manifest.contents.publicReceipts.total);
    assert.ok(manifest.contents.publicReceipts.total >= 24, "the published room projects its receipts");
  } finally {
    await world.close();
  }
});

test("corrupt pack: eager open refuses; deferred boot parks the torn rooms", async () => {
  const manifest = manifests.corrupt;
  const eagerDir = join(root, "clone-corrupt-eager");
  cpSync(join(root, "packs", "corrupt"), eagerDir, { recursive: true });
  assert.throws(() => {
    const store = new RoomStore(join(eagerDir, "room.sqlite"), { now: () => Date.now() });
    try {
      store.room(roomId(manifest, "qa-seed-corrupt-torn-plain"));
    } finally {
      store.close();
    }
  });

  const { world } = await bootClone("corrupt", { integrity: "deferred" });
  try {
    await jobByName("patrol").run(world.store, { deadline: Date.now() + 30_000 });
    const blocks = Object.fromEntries(patrolBlocks(world.store).map(block => [block.roomId, block.errorClass]));
    assert.equal(blocks[roomId(manifest, "qa-seed-corrupt-torn-marker")], "Error");
    assert.equal(blocks[roomId(manifest, "qa-seed-corrupt-torn-plain")], "SyntaxError");
    assert.equal(blocks[roomId(manifest, "qa-seed-corrupt-healthy")], undefined, "the control room patrols clean");

    const drop = world.store.room(roomId(manifest, "qa-seed-corrupt-hollow-drop"));
    assert.equal(drop.state.messages.length, 2, "hollow-drop serves 2 of its 3 journaled messages");
    const healthy = world.store.room(roomId(manifest, "qa-seed-corrupt-healthy"));
    assert.equal(healthy.state.messages.length, 2);
  } finally {
    await world.close();
  }
});

test("adversarial pack: census rows, offer cap and escrow shape read back", async () => {
  const { world, manifest } = await bootClone("adversarial");
  try {
    const arena = roomId(manifest, "arena");
    const census = world.store.db.prepare(CENSUS_SQL).all(arena).map(row => row.bounty_id);
    assert.deepEqual(census, manifest.contents.arena.keeperBlindRows);
    assert.equal(census.length, 3);

    const conservation = world.store.bountyEscrow.verifyConservation(arena);
    assert.deepEqual(conservation.violations, manifest.contents.arena.conservationViolations,
      "the only conservation violation is the staged blind row's");

    const measured = measureRoom(world.store, arena);
    assert.deepEqual(measured.bountiesByState, manifest.contents.arena.bountiesByState);
    assert.equal(measured.projectionBytes, manifest.contents.arena.projectionBytes);

    const offers = world.store.db.prepare("SELECT count(*) AS n FROM project_offers WHERE room_id=?")
      .get(roomId(manifest, "cap")).n;
    assert.equal(offers, 100);
    assert.equal(manifest.contents.cap.attempt101.code, "offer_limit");
  } finally {
    await world.close();
  }
});

test("determinism: a second clean build measures identical contents", async () => {
  const again = await buildSeedPacks({ pack: "clean", out: join(root, "packs-again") });
  assert.deepEqual(again[0].manifest.contents, manifests.clean.contents);
  assert.deepEqual(again[0].manifest.rooms.map(room => room.key), manifests.clean.rooms.map(room => room.key));
});

test("loading never mutates the built packs", () => {
  for (const { pack, dir } of built) {
    assert.equal(sha256File(join(dir, "room.sqlite")), packHashes[pack], `${pack} store is byte-identical after the load tests`);
  }
});
