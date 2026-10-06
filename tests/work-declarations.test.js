import test from "node:test";
import assert from "node:assert/strict";
import {
  workDeclarationSchema, rowToSeeker, seekerToRow, rowToOpening, openingsFromRows, isMatchable,
} from "../server/work-declarations.mjs";
import { declareSeeker, matchWork } from "../server/work-matchmaking.mjs";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const clock = () => NOW;

const seekerRow = (over = {}) => ({
  identity_id: "ai_stranger", motives: JSON.stringify(["paid", "fun"]),
  capabilities: JSON.stringify(["javascript"]), appetite_minutes: 120, trust_tier: 1, ...over,
});
const workRow = (over = {}) => ({
  work_id: "w-1", room_id: "muse-room", reward_kind: "paid", reward_amount: 100,
  requires: JSON.stringify(["javascript"]), size_minutes: 60, trust_floor: 0, deadline: null, ...over,
});

test("the schema declares both sides and indexes the board read", () => {
  assert.match(workDeclarationSchema, /CREATE TABLE IF NOT EXISTS seeker_declarations/);
  assert.match(workDeclarationSchema, /CREATE TABLE IF NOT EXISTS work_offer_terms/);
  assert.match(workDeclarationSchema, /work_offer_terms_room/);
  // size and trust floor stay nullable: undeclared work must keep working
  assert.match(workDeclarationSchema, /size_minutes INTEGER,/);
  assert.match(workDeclarationSchema, /trust_floor INTEGER,/);
});

test("a stored declaration round-trips into the seeker the filter takes", () => {
  const seeker = rowToSeeker(seekerRow());
  assert.deepEqual(seeker.motives, ["fun", "paid"]);
  assert.equal(seeker.appetiteMinutes, 120);
  const row = seekerToRow(seeker, { now: clock });
  assert.equal(row.identity_id, "ai_stranger");
  assert.equal(row.updated_at, NOW);
  assert.deepEqual(rowToSeeker(row).capabilities, ["javascript"]);
});

test("no declaration is null rather than an error", () => {
  assert.equal(rowToSeeker(null), null);
  assert.equal(rowToSeeker(undefined), null);
});

test("work that declared nothing is not matchable", () => {
  assert.equal(isMatchable(workRow()), true);
  assert.equal(isMatchable(workRow({ size_minutes: null })), false);
  assert.equal(isMatchable(workRow({ trust_floor: null })), false);
  assert.equal(isMatchable(workRow({ reward_kind: "glory" })), false);
  assert.throws(() => rowToOpening(workRow({ trust_floor: null })), /not matchable/);
});

test("an undeclared row is skipped, never allowed to break the board", () => {
  const { openings, skipped } = openingsFromRows([
    workRow({ work_id: "good" }),
    workRow({ work_id: "bare", size_minutes: null, trust_floor: null }),
    workRow({ work_id: "broken", reward_kind: "fun", reward_amount: 40 }),
  ]);
  assert.deepEqual(openings.map(o => o.openingId), ["good"]);
  assert.deepEqual([...skipped].sort(), ["bare", "broken"]);
});

test("closed work is carried through as closed rather than dropped", () => {
  const { openings } = openingsFromRows([workRow({ work_id: "taken" })], { closed: ["taken"] });
  assert.equal(openings[0].open, false);
  const result = matchWork({ seeker: rowToSeeker(seekerRow()), openings, now: clock });
  assert.equal(result.match, null);
  assert.equal(result.rejected[0].code, "closed");
});

test("titles come from the work, not the terms table", () => {
  const { openings } = openingsFromRows([workRow()], { titles: { "w-1": "Fix the cap" } });
  assert.equal(openings[0].title, "Fix the cap");
  assert.equal(openingsFromRows([workRow()]).openings[0].title, "w-1");
});

test("stored rows feed the filter end to end", () => {
  const { openings } = openingsFromRows([
    workRow({ work_id: "paid-big", reward_amount: 400, size_minutes: 60 }),
    workRow({ work_id: "hobby", reward_kind: "fun", reward_amount: 0, requires: "[]", size_minutes: 20 }),
    workRow({ work_id: "locked", trust_floor: 3 }),
  ]);
  const result = matchWork({ seeker: rowToSeeker(seekerRow()), openings, now: clock });
  assert.equal(result.match.openingId, "paid-big");
  assert.deepEqual(result.alternatives, ["hobby"]);
  assert.equal(result.rejected.find(r => r.openingId === "locked").code, "trust");
});

test("a corrupt capability list degrades to empty instead of throwing", () => {
  assert.deepEqual(rowToSeeker(seekerRow({ capabilities: "not json" })).capabilities, []);
  assert.deepEqual(openingsFromRows([workRow({ requires: "{oops" })]).openings[0].requires, []);
});

test("conversions stay pure: frozen out, clock injected, no status codes", () => {
  const { openings } = openingsFromRows([workRow()]);
  assert.equal(Object.isFrozen(openings), true);
  assert.equal(Object.isFrozen(openings[0]), true);
  assert.throws(() => seekerToRow(declareSeeker({ seekerId: "a", motives: ["fun"], appetiteMinutes: 5 }), {}),
    /now must be a clock function/);
  try { rowToOpening(workRow({ size_minutes: null })); }
  catch (err) { assert.equal(err.code, "not_matchable"); assert.equal("status" in err, false); }
});
