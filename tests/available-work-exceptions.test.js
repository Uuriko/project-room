// Named-exception pins — redesign charter B-2, PR3.
//
// The charter's kill criteria, applied: two discovery surfaces do NOT
// read through the AvailableWork projection, because their semantics
// are not "what work can I take?" — the opportunities feed (invitation
// semantics: help wanted on work in any non-terminal state, plus
// proposed/funded bounties) and room matchmaking (member-declared
// openings, no work-store read). The exceptions are recorded in the
// keystone module header (server/available-work.mjs, NAMED EXCEPTIONS)
// and pinned HERE, so the exception is a tested fact rather than
// drift: if either surface is repointed, or the registry text is
// dropped, this file fails and the change must reckon with the charter.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { buildOpportunitiesFeed } from "../server/opportunities.mjs";
import { AVAILABLE_WORK_SOURCES, availableWorkInRoom } from "../server/available-work.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const ROOM = "commons";
const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..", "server");

let seq = 0;
const cmdId = () => `aw-exc-${++seq}`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "aw-exceptions-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  store.roomDirectory.set(ROOM, "owner", true);
  // An accepted work item with an open help-wanted invitation.
  store.command(ownerKey, ROOM, { id: cmdId(), type: T.WORK_PROPOSED, data: {
    workItemId: "w-held", title: "Held but help-wanted", definitionOfDone: "Done.",
    accountableMemberId: "owner", verifierMemberId: "owner", mode: "write" } });
  store.command(ownerKey, ROOM, { id: cmdId(), type: T.WORK_ACCEPTED, data: { workItemId: "w-held", expectedRevision: 0 } });
  store.command(ownerKey, ROOM, { id: cmdId(), type: T.WORK_HELP_UPDATED, data: {
    workItemId: "w-held", expectedRevision: 1, expectedHelpRevision: 0, status: "open",
    scope: "Need a second pair of hands", expiresAt: new Date(Date.now() + 3600e3).toISOString() } });
  // A funded bounty with a live deadline.
  const now = store.now();
  store.db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, state, state_changed_ms, deadline_ms, label, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "b-open", ROOM, "Bounty: b-open", "Do the thing", 5000, "owner",
    "funded", now, now + 3600e3, "test", new Date(now).toISOString(), new Date(now).toISOString());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store };
}

test("the opportunities exception is semantic: the feed lists held work the projection excludes", t => {
  const { store } = fixture(t);
  // Baseline: while unclaimed, the accepted item IS AvailableWork.
  assert.deepEqual(availableWorkInRoom(store, ROOM).items.map(item => item.id), ["w-held"]);
  // Hold the board row (a reader-level pin: both surfaces under test
  // are pure readers, so the divergence is set up at the row they read).
  const row = store.workClaims.get(ROOM, "w-held");
  store.workClaims.set(ROOM, { ...row, state: "claimed", owner: "owner" });
  // The projection now correctly says: nothing to take here.
  assert.deepEqual(availableWorkInRoom(store, ROOM), { items: [], total: 0 });
  // The feed still lists the item — as an invitation, not as claimable
  // work. That difference is the exception, and it is load-bearing.
  const feed = buildOpportunitiesFeed(store, { now: Date.now() });
  const help = feed.opportunities.find(opp => opp.kind === "help-wanted" && opp.workItemId === "w-held");
  assert.ok(help, "feed lists the held item as help-wanted");
  assert.equal(Object.hasOwn(help, "claimAction"), false);
  // And it lists the funded bounty — a state the projection has no
  // source for at all (its sources are board + publicTask only).
  assert.ok(feed.opportunities.some(opp => opp.kind === "bounty" && opp.bountyId === "b-open"));
  assert.deepEqual(AVAILABLE_WORK_SOURCES, ["board", "publicTask"]);
});

test("the exception registry lives in the keystone and names both surfaces", () => {
  const keystone = readFileSync(join(serverDir, "available-work.mjs"), "utf8");
  assert.match(keystone, /NAMED EXCEPTIONS/);
  assert.match(keystone, /opportunities\.mjs/);
  assert.match(keystone, /work-matchmaking\.mjs/);
  // Neither excepted surface imports the projection: the exception is a
  // fact of the code, not just of the comment. A repoint PR must flip
  // this pin deliberately, together with the registry above.
  for (const file of ["opportunities.mjs", "work-matchmaking.mjs", "matchmaking-routes.mjs"]) {
    assert.doesNotMatch(readFileSync(join(serverDir, file), "utf8"), /available-work/,
      `${file} must stay off the projection while the exception stands`);
  }
});
