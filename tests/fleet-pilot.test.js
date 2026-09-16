import test from "node:test";
import assert from "node:assert/strict";
import { runPilot, LANES } from "../scripts/fleet-pilot.mjs";

// The pilot is the evidence behind docs/growth/FLEET-COORDINATION-2026-09-16.md.
// If any of these four journeys stops holding, that proposal is no longer true and
// should be withdrawn rather than left standing.

let result;
test.before(() => { result = runPilot(); });
test.after(() => result?.cleanup());

const rows = (journey) => result.transcript.filter((row) => row.journey === journey);

test("success: every lane holds its own scope at the same time", () => {
  const claimed = rows("success");
  assert.equal(claimed.length, LANES.length);
  assert.ok(claimed.every((row) => row.outcome === "claimed"), JSON.stringify(claimed));
});

test("denied: an overlapping claim is refused with claim_conflict and leaves no trace", () => {
  const [refusal, trace] = rows("denied");
  assert.equal(refusal.outcome, "refused", `expected claim_conflict, got: ${refusal.detail}`);
  assert.match(refusal.detail, /claim_conflict 409/);
  assert.match(refusal.detail, /reserved by work lane-growth/);
  // A refused command must not move the Room. This is the property that makes the
  // mechanism trustworthy as occupancy; an advisory note cannot offer it.
  assert.equal(trace.outcome, "no-trace", "the refusal changed Room state");
});

test("recovery: releasing the scope frees it for the agent who was refused", () => {
  const [released, claimed] = rows("recovery");
  assert.equal(released.outcome, "released");
  assert.equal(claimed.outcome, "claimed");
});

test("stale authority: an expired lease stops protecting the path", () => {
  const [expired] = rows("stale-authority");
  assert.equal(expired.outcome, "claimed", expired.detail);
});

test("expiry is judged on the clock, not on the stored status", () => {
  // The stored status stays "active" until release, so a report that reads status
  // alone shows two holders of one path. The pilot separates them.
  assert.equal(result.held.length, 1, JSON.stringify(result.held));
  assert.ok(result.lapsed.length >= 2, JSON.stringify(result.lapsed));
  const paths = result.held.flatMap((lane) => lane.paths);
  assert.equal(new Set(paths).size, paths.length, "two live claims name the same path");
});

test("the pilot leaves a real store the growth harness can read", async () => {
  const { exportRoom } = await import("../server/room-export.mjs");
  const exported = exportRoom(result.filename);
  assert.equal(exported.roomId, "commons");
  assert.ok(exported.events.length > 10, `only ${exported.events.length} events recorded`);
});
