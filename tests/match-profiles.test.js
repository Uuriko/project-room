// Matchmaking P1 — seeker profile store tests (RC-2026-09-30-3616).
//
// Authoring gate (per .agents/skills/test-audit/SKILL.md):
// 1. Each test guards an independent, behavior-level contract of the new
//    module: the (room_id, identity_id) upsert key (one profile per
//    identity — a duplicate would fork the seeker's state), enum validation
//    (junk intents/availability must never reach the DB), the public
//    candidate view's privacy contract (private and paused profiles
//    invisible; reward_floor redacted until mutual opt-in — plan §13), and
//    fail-closed schema provisioning. Credible regressions: a loosened
//    validator, a leaky public list, a double-insert on re-enter.
// 2. No existing coverage: server/match-profiles.mjs is new. The repo-wide
//    writer-fence-unfenced test already guards table registration, so this
//    file does not re-assert it.
// 3. No test-only production seams: db/clock/id are the wiring layer's
//    injection points, needed by production too.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createMatchProfiles,
  matchProfilesSchema,
  MatchProfileError,
  MATCH_PROFILES_TABLE,
  PROFILE_INTENTS,
} from "../server/match-profiles.mjs";

const T0 = 1_750_000_000_000;

function setup(t) {
  const db = new DatabaseSync(":memory:");
  // Test-only DDL: the wiring layer provisions this table in the app DB.
  // The module itself never creates it, so the table stays out of the
  // store's auditRecovery inventory until the wiring task registers it.
  db.exec(matchProfilesSchema);
  t.after(() => db.close());
  let now = T0;
  return { profiles: createMatchProfiles({ db, clock: () => now }), tick: (ms = 1) => { now += ms; } };
}

const base = (overrides = {}) => ({
  roomId: "room-1",
  identityId: "id:agent/jill",
  kind: "agent",
  displayName: "jill",
  intents: ["paid", "fun"],
  ...overrides,
});

const asError = fn => {
  try { fn(); } catch (error) { return error; }
  assert.fail("expected a MatchProfileError");
};

test("createMatchProfiles fails closed when the table is not provisioned", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const error = asError(() => createMatchProfiles({ db }));
  assert.ok(error instanceof MatchProfileError);
  assert.equal(error.code, "schema-not-provisioned");
  assert.match(error.message, new RegExp(MATCH_PROFILES_TABLE));
});

test("upsert creates a profile and a second upsert updates the same row", t => {
  const { profiles } = setup(t);
  const first = profiles.upsert(base());
  assert.equal(first.created, true);
  assert.equal(first.profile.intents.join(","), "paid,fun");
  assert.equal(first.profile.availability, "open");
  assert.equal(first.profile.createdAt, T0);

  const second = profiles.upsert(base({ availability: "busy", intents: ["credits"] }));
  assert.equal(second.created, false);
  assert.equal(second.profile.availability, "busy");
  assert.deepEqual([...second.profile.intents], ["credits"]);
  // Still one row for the key: re-entering never forks the profile.
  assert.equal(second.profile.createdAt, T0);
});

test("upsert keys on (room_id, identity_id): different rooms are separate profiles", t => {
  const { profiles } = setup(t);
  profiles.upsert(base({ roomId: "room-a" }));
  profiles.upsert(base({ roomId: "room-b", intents: ["fun"] }));
  assert.deepEqual([...profiles.get({ roomId: "room-a", identityId: "id:agent/jill" }).intents], ["paid", "fun"]);
  assert.deepEqual([...profiles.get({ roomId: "room-b", identityId: "id:agent/jill" }).intents], ["fun"]);
});

test("upsert rejects invalid enums and shapes with 422-coded errors", t => {
  const { profiles } = setup(t);
  for (const [field, value, code] of [
    ["kind", "bot", "invalid_kind"],
    ["intents", [], "invalid_intents"],
    ["intents", ["paid", "lottery"], "invalid_intents"],
    ["intents", ["paid", "paid"], "invalid_intents"],
    ["availability", "away", "invalid_availability"],
    ["surfaces", [], "invalid_surfaces"],
    ["surfaces", ["metaverse"], "invalid_surfaces"],
    ["discoverable", "friends-only", "invalid_discoverable"],
    ["capabilities", Array.from({ length: 51 }, (_, i) => `tag-${i}`), "invalid_capabilities"],
    ["rewardFloor", { amount: -5, denomination: "USDC" }, "invalid_reward_floor"],
    ["displayName", "", "invalid_display_name"],
  ]) {
    const error = asError(() => profiles.upsert(base({ [field]: value })));
    assert.ok(error instanceof MatchProfileError, `${field} should throw MatchProfileError`);
    assert.equal(error.code, code, `${field} should fail as ${code}`);
    assert.equal(error.status, 422, `${field} should be a 422`);
  }
  assert.ok(PROFILE_INTENTS.includes("paid") && PROFILE_INTENTS.includes("credits") && PROFILE_INTENTS.includes("fun"));
});

test("update changes only the supplied fields; missing profile returns null", t => {
  const { profiles, tick } = setup(t);
  assert.equal(profiles.update({ roomId: "room-1", identityId: "nobody", availability: "paused" }), null);
  profiles.upsert(base({ capabilities: ["rust"], availability: "open" }));
  tick(5);
  const updated = profiles.update({ roomId: "room-1", identityId: "id:agent/jill", availability: "paused" });
  assert.equal(updated.availability, "paused");
  assert.deepEqual([...updated.capabilities], ["rust"], "untouched fields survive a partial update");
  assert.ok(updated.updatedAt > updated.createdAt);
});

test("listPublic hides private and paused profiles and redacts the reward floor", t => {
  const { profiles } = setup(t);
  profiles.upsert(base({ identityId: "seeker-public", discoverable: "public",
    rewardFloor: { amount: 50, denomination: "USDC" } }));
  profiles.upsert(base({ identityId: "seeker-private", discoverable: "private" }));
  profiles.upsert(base({ identityId: "seeker-paused", discoverable: "public", availability: "paused" }));

  const visible = profiles.listPublic({ roomId: "room-1" });
  assert.deepEqual(visible.map(p => p.identityId), ["seeker-public"]);
  assert.equal(visible[0].rewardFloor, null, "reward_floor is redacted until mutual opt-in (plan §13)");

  const own = profiles.get({ roomId: "room-1", identityId: "seeker-public" });
  assert.deepEqual(own.rewardFloor, { amount: 50, denomination: "USDC" },
    "the owner still sees their own floor");
});

test("get returns null for an unknown identity", t => {
  const { profiles } = setup(t);
  assert.equal(profiles.get({ roomId: "room-1", identityId: "ghost" }), null);
});
