import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, WORK_STATES, applyEvent, replay, emptyRoomState } from "../src/events.js";

// Property tests over the command engine.
//
// Two things make this more than decoration. The generator builds each history
// against a live engine, so legal transitions really are legal and work items
// reach completion and verification rather than piling up at "proposed". And the
// suite asserts its own coverage, so if a change ever makes those paths
// unreachable the test says the fuzzing went blind instead of passing quietly.
//
// The sharpest invariant is about refusal: a rejected command must leave the
// caller's state byte for byte as it was.

const seeded = (seed) => () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};

const ROOM = "room-fuzz";
const OWNER = "owner";
const HUMAN_PERMISSIONS = ["steer", "accept_work", "complete_work", "verify"];
const OWNER_PERMISSIONS = ["steer", "decide", "manage_members", "manage_claims", "accept_work", "complete_work", "verify"];
const LEGAL_WORK_STATES = new Set(Object.values(WORK_STATES));

function generate(random, steps) {
  const pick = (values) => values[Math.floor(random() * values.length)];
  const chance = (p) => random() < p;

  const events = [];
  let state = emptyRoomState();
  let counter = 0;
  const humans = [OWNER];
  const agents = [];
  const tracked = new Map();

  // Offer the event to the real engine. Accepted events advance the shared
  // state; refused ones stay in the history on purpose, so the fold under test
  // sees the same mix of accepted and rejected commands.
  const offer = (type, actorId, data) => {
    counter += 1;
    const event = {
      id: `e${counter}`, idempotencyKey: `k${counter}`, roomId: ROOM, type, actorId,
      at: new Date(1_757_000_000_000 + counter * 60_000).toISOString(), causationId: null, data
    };
    events.push(event);
    try {
      state = applyEvent(state, event);
      return event;
    } catch {
      return null;
    }
  };

  offer(EVENT_TYPES.ROOM_CREATED, OWNER, { roomId: ROOM, title: "Fuzz", purpose: "Fuzz", ownerId: OWNER });
  offer(EVENT_TYPES.MEMBER_ADDED, OWNER, { memberId: OWNER, displayName: "Owner", kind: "human", permissions: OWNER_PERMISSIONS });

  for (let step = 0; step < steps; step += 1) {
    const live = [...tracked.values()].filter((item) => state.workItems[item.id]);
    const action = pick([
      "human", "agent", "message", "propose", "advance", "advance", "advance", "advance", "duplicate", "junk"
    ]);

    if (action === "human") {
      const id = `h${step}`;
      if (offer(EVENT_TYPES.MEMBER_ADDED, OWNER, { memberId: id, displayName: id, kind: "human", permissions: HUMAN_PERMISSIONS })) humans.push(id);

    } else if (action === "agent") {
      const id = `a${step}`;
      if (offer(EVENT_TYPES.MEMBER_ADDED, OWNER, { memberId: id, displayName: id, kind: "agent",
        permissions: ["accept_work", "complete_work"], accountableHumanId: pick(humans) })) agents.push(id);

    } else if (action === "message") {
      offer(EVENT_TYPES.MESSAGE_POSTED, pick([...humans, ...agents]), { body: `message ${step}` });

    } else if (action === "propose") {
      const id = `w${step}`;
      const accountable = pick([...humans, ...agents]);
      // Sometimes demand independent verification, which is what drives the
      // deepest part of the state machine.
      const verifiers = humans.filter((human) => human !== accountable);
      const verified = verifiers.length > 0 && chance(0.5);
      const data = { workItemId: id, title: id, definitionOfDone: "done", accountableMemberId: accountable };
      if (verified) Object.assign(data, { independentVerificationRequired: true, verifierMemberId: pick(verifiers) });
      if (offer(EVENT_TYPES.WORK_PROPOSED, OWNER, data)) {
        tracked.set(id, { id, accountable, verifier: verified ? data.verifierMemberId : null, completionEventId: null, evidenceVersion: null });
      }

    } else if (action === "advance" && live.length) {
      const item = pick(live);
      const current = state.workItems[item.id];
      const revision = current.revision;
      // Occasionally send a stale revision on purpose; it must be refused.
      const expectedRevision = chance(0.15) ? revision + 1 : revision;

      if (current.state === WORK_STATES.PROPOSED) {
        offer(EVENT_TYPES.WORK_ACCEPTED, item.accountable, { workItemId: item.id, expectedRevision });

      } else if (current.state === WORK_STATES.ACCEPTED && chance(0.5)) {
        offer(EVENT_TYPES.WORK_STARTED, item.accountable, { workItemId: item.id, expectedRevision });

      } else if (current.state === WORK_STATES.ACCEPTED || current.state === WORK_STATES.WORKING) {
        const evidenceVersion = `v${revision}`;
        const completion = offer(EVENT_TYPES.WORK_COMPLETED, item.accountable, {
          workItemId: item.id, expectedRevision, summary: `did ${item.id}`,
          evidenceUrl: `https://example.invalid/${item.id}`, evidenceVersion, nextAction: "review"
        });
        if (completion) Object.assign(item, { completionEventId: completion.id, evidenceVersion });

      } else if (current.state === WORK_STATES.COMPLETED && item.verifier && item.completionEventId) {
        offer(EVENT_TYPES.VERIFICATION_RECORDED, item.verifier, {
          workItemId: item.id, expectedRevision, result: chance(0.3) ? "fail" : "pass",
          completionEventId: item.completionEventId, evidenceVersion: item.evidenceVersion,
          summary: `checked ${item.id}`
        });
      }

    } else if (action === "duplicate" && events.length) {
      // Re-delivering an event the Room has already seen, byte for byte.
      const repeat = structuredClone(events[Math.floor(random() * events.length)]);
      events.push(repeat);
      try { state = applyEvent(state, repeat); } catch { /* a refusal is a valid outcome */ }

    } else if (action === "junk") {
      offer(pick([EVENT_TYPES.MEMBER_ADDED, EVENT_TYPES.WORK_ACCEPTED, EVENT_TYPES.MESSAGE_POSTED]),
        pick([...humans, ...agents, "nobody"]), { memberId: pick(humans), workItemId: "missing" });
    }
  }

  return { events, expected: state };
}

// Fold independently of the generator, checking the refusal invariant as it goes.
function fold(events) {
  let state = emptyRoomState();
  const accepted = [];
  let rejected = 0;
  for (const event of events) {
    const before = structuredClone(state);
    let next;
    try {
      next = applyEvent(state, event);
    } catch {
      rejected += 1;
      assert.deepEqual(state, before, "a refused command must leave the caller's state untouched");
      continue;
    }
    assert.deepEqual(state, before, "an accepted command must not mutate the state passed in");
    state = next;
    accepted.push(event);
  }
  return { state, accepted, rejected };
}

test("the engine holds its invariants across randomised histories", () => {
  const seen = { rejected: 0, accepted: 0, byState: {}, verifications: 0, blocked: 0 };

  for (let run = 0; run < 60; run += 1) {
    const seed = 1000 + run;
    const context = `seed ${seed}`;
    const { events, expected } = generate(seeded(seed), 40);
    const { state, accepted, rejected } = fold(events);

    seen.accepted += accepted.length;
    seen.rejected += rejected;

    // The independent fold must land exactly where the generator's live engine did.
    assert.deepEqual(state, expected, `independent fold diverged from the live engine (${context})`);
    assert.deepEqual(replay(accepted), state, `replay of the accepted history diverged (${context})`);
    assert.deepEqual(replay(accepted), replay(accepted), `replay is not deterministic (${context})`);
    assert.equal(state.eventLog.length, new Set(accepted.map((event) => event.id)).size,
      `event log does not match distinct accepted ids (${context})`);

    for (const [id, member] of Object.entries(state.members)) {
      assert.equal(member.id, id, `member keyed under the wrong id (${context})`);
      assert.ok(["human", "agent"].includes(member.kind), `member kind escaped the enum (${context})`);
      if (member.kind === "agent") {
        assert.equal(state.members[member.accountableHumanId]?.kind, "human",
          `agent ${id} is accountable to a non-human (${context})`);
      }
    }

    const owner = state.members[state.room?.ownerId];
    if (owner) {
      assert.equal(owner.active, true, `the owner was deactivated (${context})`);
      assert.ok(owner.permissions.includes("manage_members"), `the owner lost membership administration (${context})`);
    }

    for (const item of Object.values(state.workItems)) {
      assert.ok(LEGAL_WORK_STATES.has(item.state), `${item.id} in illegal state ${item.state} (${context})`);
      assert.ok(state.members[item.accountableMemberId], `${item.id} accountable to a stranger (${context})`);
      assert.ok(Number.isInteger(item.revision) && item.revision >= 0, `${item.id} has revision ${item.revision} (${context})`);
      // A receipt and a verification must always describe the same evidence, or
      // the verification must have been filed as historical.
      if (item.verification && item.receipt) {
        assert.equal(item.verification.evidenceVersion, item.receipt.evidenceVersion,
          `${item.id} has a current verification against different evidence (${context})`);
      }
      seen.byState[item.state] = (seen.byState[item.state] ?? 0) + 1;
      if (item.verification) seen.verifications += 1;
      if (item.state === WORK_STATES.BLOCKED) seen.blocked += 1;
    }
  }

  // Coverage gates. Without these the suite could pass while exercising nothing,
  // which is the usual way a property test rots.
  const report = JSON.stringify(seen);
  assert.ok(seen.rejected > 100, `too few refusals to test the refusal invariant: ${report}`);
  assert.ok(seen.accepted > 500, `too few accepted commands: ${report}`);
  assert.ok((seen.byState.completed ?? 0) > 20, `work never reached completion: ${report}`);
  assert.ok((seen.byState.working ?? 0) > 5, `work never reached working: ${report}`);
  assert.ok(seen.verifications > 10, `verification was never exercised: ${report}`);
  assert.ok(seen.blocked > 0, `a failed verification never blocked an item: ${report}`);
});

test("replaying a whole history twice is identical, duplicates and refusals included", () => {
  for (let run = 0; run < 20; run += 1) {
    const { events } = generate(seeded(9000 + run), 30);
    const first = fold(events);
    const second = fold(events);
    assert.deepEqual(first.state, second.state, `seed ${9000 + run}`);
    assert.equal(first.rejected, second.rejected, `seed ${9000 + run}`);
  }
});

test("an id reused with different content is refused rather than silently merged", () => {
  const { events } = generate(seeded(7), 10);
  const { state, accepted } = fold(events);
  const clash = { ...accepted.at(-1), data: { ...accepted.at(-1).data, injected: "different content" } };
  const before = structuredClone(state);
  assert.throws(() => applyEvent(state, clash), /Conflicting reuse of event id/);
  assert.deepEqual(state, before, "the refusal left no trace");
});

test("an idempotency key reused by a different event is refused", () => {
  const { events } = generate(seeded(11), 10);
  const { state, accepted } = fold(events);
  const twin = { ...accepted.at(-1), id: "totally-new-id" };
  const before = structuredClone(state);
  assert.throws(() => applyEvent(state, twin), /idempotency/i);
  assert.deepEqual(state, before);
});

test("an exact duplicate is absorbed without changing anything", () => {
  const { events } = generate(seeded(23), 12);
  const { state, accepted } = fold(events);
  const again = applyEvent(state, structuredClone(accepted.at(-1)));
  assert.deepEqual(again, state, "re-delivering the same event must be a no-op");
});
