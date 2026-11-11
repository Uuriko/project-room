// Property-based tests for the event kernel (src/events.js) — the room
// projection as a pure fold over an event log.
//
// Agent-codebase audit Practice 3 (library-level DST over the event kernel).
//
// APPROACH (honest): fast-check generates random event STREAMS — a legal
// room lifecycle (create, members, messages, receipt cards, spend
// allowance/pricing, work proposals, policy, trust, archive) mutated with
// exact duplicates inserted at later positions — and drives them through
// the REAL kernel: sequential `applyEvent`, the `replay` reduce, and the
// journal-owning `replayEvents`. No model port of the reducer: assertions
// pin invariants directly on the kernel's own state and error contract.
//
// PROPERTIES:
//   P1 replay equivalence — replay-from-scratch (both folds) deep-equals
//      sequential application, and exact duplicates inserted anywhere
//      after their original change nothing (no double-apply).
//   P1b reorder — independent message posts commute: permuting them
//      yields the same state modulo message/log order.
//   P2 money conservation (kernel units are CENTS) — the cents recorded
//      in state are exactly the cents carried by accepted events:
//      receipt-card spent/cap totals and counts match the accepted
//      receipt events one-for-one, and the spend allowance always equals
//      the last accepted owner set, its revision counting accepted sets.
//      Nothing is minted, dropped, or double-counted by the fold.
//   P3 conflicting reuse is ALWAYS rejected — reusing an event id with
//      different data throws "Conflicting reuse of event id"; reusing an
//      idempotency key under a different id throws "Conflicting reuse of
//      idempotency key" EVEN with an otherwise identical payload (the
//      fingerprint covers the whole envelope, id included). A rejected
//      event leaves the state untouched.
//   P4 no illegal state reachable — every prefix of a legal stream keeps
//      the kernel's structural invariants (log/seen-map agreement, owner
//      membership, work states in the catalogue, money fields in range),
//      and the room preconditions hold at the boundary: nothing applies
//      before room.created, to a different room, or after room.archived
//      (exact duplicates excepted — they are no-ops by the seen-check).
//
// COVERAGE LIMITS (what these tests do NOT prove):
//   - the server store (server/store.mjs) and its command validation —
//     this suite pins the pure reducer the store replays through;
//   - arbitrary reordering: causal order is the log's contract, so only
//     independent (message-post) commutation is pinned, in P1b;
//   - event types outside the generated lifecycle (sessions, DMs, bonds,
//     polls, claims) — the fold-equivalence argument is structural, but
//     only the generated types are exercised here.
//
// Fixed default seed (repo convention, cf. tests/claims-state-machine
// .property.test.js); PROPERTY_TEST_SEED shifts the exploration for an
// extra run. The default shrinker is kept: a failure reduces to a
// minimal stream.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  EVENT_TYPES as T, PERMISSIONS, WORK_STATES, SPEND_ALLOWANCE_LIMITS,
  emptyRoomState, applyEvent, replay, replayEvents, spendAllowance,
} from "../src/events.js";

const seed = Number(process.env.PROPERTY_TEST_SEED ?? 20261026);

const ROOM = "room-dst";
const MEMBERS = ["owner", "ada", "bot"];
const BASE_MS = Date.UTC(2026, 9, 26, 0, 0, 0);
const isoTick = (tick) => new Date(BASE_MS + tick * 1000).toISOString();
const BODIES = ["hello room", "status: working", "receipt attached", "note for the log", "x"];
const ALLOWANCES = [0, 1, 499, 5000, SPEND_ALLOWANCE_LIMITS.allowanceCents];
const WORK_STATE_VALUES = new Set(Object.values(WORK_STATES));

// --- stream builder ---------------------------------------------------------
// Deterministic rendering of generated ops into a legal event stream.
// Legality is by construction (the shapes mirror tests/events.test.js and
// the invariants harness fixtures): owner bootstraps membership, only the
// owner sets allowance/policy/trust, proposals name the owner accountable
// (plus a verifier while a policy demands independent review), and the
// stream ends at room.archived. The model tracks exactly what the fold
// must conserve.
function buildStream(ops) {
  const events = [];
  let tick = 0;
  let seq = 0;
  const push = (type, actorId, data) => {
    const e = {
      id: `e${seq}`, idempotencyKey: `k${seq}`, roomId: ROOM, type,
      actorId, at: isoTick(tick), causationId: null, data,
    };
    seq += 1;
    tick += 1;
    events.push(e);
    return e;
  };

  push(T.ROOM_CREATED, "owner", { roomId: ROOM, title: "DST Room", purpose: "property suite room", ownerId: "owner" });
  push(T.MEMBER_ADDED, "owner", { memberId: "owner", displayName: "Owner", kind: "human", permissions: [...PERMISSIONS] });
  push(T.MEMBER_ADDED, "owner", { memberId: "ada", displayName: "Ada", kind: "human", permissions: ["steer", "accept_work", "complete_work", "verify"] });
  push(T.MEMBER_ADDED, "owner", { memberId: "bot", displayName: "Bot", kind: "agent", permissions: ["steer", "accept_work", "complete_work", "verify"] });

  const model = {
    receiptCount: 0, spentTotal: 0, capTotal: 0,
    allowanceSets: 0, allowanceCurrent: undefined, allowanceSetAt: null,
    proposed: 0, archived: false,
  };
  let policyIndependent = false;

  for (const op of ops) {
    if (model.archived) break;
    switch (op.kind) {
      case "post": {
        const data = { body: BODIES[op.a % BODIES.length] };
        if (op.flag && model.proposed > 0) data.workItemId = `w${1 + (op.a % model.proposed)}`;
        push(T.MESSAGE_POSTED, MEMBERS[op.actor], data);
        break;
      }
      case "receipt": {
        const spent = op.a;
        const cap = op.b % 3 === 0 ? null : op.a + op.b;
        model.receiptCount += 1;
        push(T.MESSAGE_POSTED, MEMBERS[op.actor], {
          kind: "receipt_card",
          body: "work receipt",
          claimId: `claim-${model.receiptCount}`,
          title: "Receipt card",
          closedBy: MEMBERS[op.actor],
          deliveryMode: "result",
          evidence: "evidence text",
          cost: { spentCents: spent, capCents: cap, model: op.a % 2 ? "dst-model" : null },
        });
        model.spentTotal += spent;
        model.capTotal += cap ?? 0;
        break;
      }
      case "allowance": {
        if (op.flag) {
          push(T.ROOM_SPEND_ALLOWANCE_SET, "owner", { allowanceCents: null });
          model.allowanceCurrent = null;
        } else {
          const allowanceCents = ALLOWANCES[op.a % ALLOWANCES.length];
          const periodDays = 1 + (op.b % SPEND_ALLOWANCE_LIMITS.periodDays);
          push(T.ROOM_SPEND_ALLOWANCE_SET, "owner", { allowanceCents, periodDays });
          model.allowanceCurrent = { allowanceCents, periodDays };
        }
        model.allowanceSets += 1;
        model.allowanceSetAt = events[events.length - 1].at;
        break;
      }
      case "pricing":
        push(T.ROOM_SPEND_PRICING_SET, "owner", { enabled: op.flag });
        break;
      case "propose": {
        model.proposed += 1;
        const data = {
          workItemId: `w${model.proposed}`,
          title: `Task ${model.proposed}`,
          definitionOfDone: "the property holds",
          accountableMemberId: "owner",
          mode: op.flag ? "write" : "read",
        };
        if (policyIndependent) data.verifierMemberId = "ada";
        push(T.WORK_PROPOSED, "owner", data);
        break;
      }
      case "policy":
        policyIndependent = op.flag;
        push(T.ROOM_POLICY_SET, "owner", {
          requireIndependentReview: op.flag,
          requireOwnerDecision: op.a % 2 === 0,
        });
        break;
      case "trust":
        push(T.ROOM_TRUST_SET, "owner", { enabled: op.flag });
        break;
      case "archive":
        push(T.ROOM_ARCHIVED, "owner", {});
        model.archived = true;
        break;
      default:
        throw new Error(`unknown op ${op.kind}`);
    }
  }
  return { events, model };
}

const opArb = fc.record({
  kind: fc.constantFrom("post", "post", "receipt", "allowance", "pricing", "propose", "policy", "trust", "archive"),
  actor: fc.integer({ min: 0, max: 2 }),
  a: fc.integer({ min: 0, max: 100000 }),
  b: fc.integer({ min: 0, max: 365 }),
  flag: fc.boolean(),
});
const streamArb = fc.record({ ops: fc.array(opArb, { minLength: 4, maxLength: 22 }) });

const foldSequential = (events) => events.reduce((state, e) => applyEvent(state, e), emptyRoomState());

// Insert exact duplicates of earlier events at later positions — the
// retry shape. The first occurrence always precedes its duplicate, so a
// correct kernel applies each envelope exactly once.
function insertDuplicates(events, dups) {
  const out = [...events];
  for (const dup of dups) {
    const src = dup.src % out.length;
    const at = src + 1 + (dup.gap % (out.length - src));
    out.splice(at, 0, out[src]);
  }
  return out;
}
const dupsArb = fc.array(fc.record({ src: fc.nat(), gap: fc.nat() }), { maxLength: 4 });

// --- P1: replay equivalence ---------------------------------------------------
test("property P1: replay-from-scratch equals sequential application, duplicates change nothing", () => {
  fc.assert(fc.property(streamArb, dupsArb, (gen, dups) => {
    const { events } = buildStream(gen.ops);
    const mutated = insertDuplicates(events, dups);

    const sequential = foldSequential(mutated);
    assert.deepEqual(replayEvents(emptyRoomState(), mutated), sequential, "replayEvents diverged from sequential applyEvent");
    assert.deepEqual(replay(mutated), sequential, "replay diverged from sequential applyEvent");

    const base = foldSequential(events);
    assert.deepEqual(sequential, base, "an exact duplicate changed the state");
    assert.equal(sequential.eventLog.length, events.length, "a duplicate was logged twice");
  }), { numRuns: 100, seed });
});

// --- P1b: independent posts commute --------------------------------------------
test("property P1b: independent message posts commute under permutation", () => {
  const postsArb = fc.array(
    fc.record({ actor: fc.integer({ min: 0, max: 2 }), a: fc.integer({ min: 0, max: 100000 }), key: fc.integer({ min: 0, max: 1000000 }) }),
    { minLength: 2, maxLength: 6 },
  );
  fc.assert(fc.property(postsArb, (posts) => {
    const ops = posts.map((p) => ({ kind: "post", actor: p.actor, a: p.a, b: 0, flag: false }));
    const { events } = buildStream(ops);
    const prefix = events.slice(0, 4);
    const posted = events.slice(4);
    const permuted = [...posted].sort((x, y) => {
      const kx = posts[posted.indexOf(x)].key;
      const ky = posts[posted.indexOf(y)].key;
      return kx - ky;
    });
    const ordered = foldSequential(events);
    const shuffled = foldSequential([...prefix, ...permuted]);
    const canonical = (state) => ({
      ...state,
      messages: [...state.messages].sort((m, n) => (m.id < n.id ? -1 : 1)),
      eventLog: [...state.eventLog].sort((m, n) => (m.id < n.id ? -1 : 1)),
    });
    assert.deepEqual(canonical(shuffled), canonical(ordered), "permuting independent posts changed the state");
  }), { numRuns: 60, seed });
});

// --- P2: money conservation -------------------------------------------------------
test("property P2: recorded cents are exactly the accepted events' cents (conservation)", () => {
  fc.assert(fc.property(streamArb, (gen) => {
    const { events, model } = buildStream(gen.ops);
    const state = foldSequential(events);

    const cards = state.messages.filter((m) => m.kind === "receipt_card");
    assert.equal(cards.length, model.receiptCount, "receipt cards created or dropped by the fold");
    assert.equal(
      cards.reduce((sum, m) => sum + (m.cost?.spentCents ?? 0), 0),
      model.spentTotal,
      "total spentCents in state != total over accepted receipt events",
    );
    assert.equal(
      cards.reduce((sum, m) => sum + (m.cost?.capCents ?? 0), 0),
      model.capTotal,
      "total capCents in state != total over accepted receipt events",
    );

    assert.equal(state.room.spendAllowance?.revision ?? 0, model.allowanceSets, "allowance revision != accepted set count");
    if (model.allowanceCurrent === undefined) {
      assert.equal(state.room.spendAllowance, undefined, "allowance appeared without an accepted set event");
    } else if (model.allowanceCurrent === null) {
      assert.equal(spendAllowance(state), null, "cleared allowance still reads as set");
      assert.equal(state.room.spendAllowance.allowanceCents, null);
    } else {
      assert.deepEqual(spendAllowance(state), {
        ...model.allowanceCurrent,
        revision: model.allowanceSets,
        setById: "owner",
        setAt: model.allowanceSetAt,
      }, "allowance in state is not the last accepted owner set");
    }
  }), { numRuns: 100, seed });
});

// --- P3: conflicting reuse is always rejected --------------------------------------
test("property P3: conflicting id / idempotency-key reuse is always rejected, state untouched", () => {
  fc.assert(fc.property(streamArb, fc.nat(), (gen, pick) => {
    const { events } = buildStream(gen.ops);
    const state = foldSequential(events);
    const before = structuredClone(state);
    const target = events[pick % events.length];

    const conflictId = { ...target, data: { ...target.data, dstMarker: "conflict" } };
    assert.throws(() => applyEvent(state, conflictId), /Conflicting reuse of event id/);

    const conflictKey = { ...target, id: "e-conflict-key", data: { ...target.data, dstMarker: "conflict" } };
    assert.throws(() => applyEvent(state, conflictKey), /Conflicting reuse of idempotency key/);

    // Same key, fresh id, otherwise identical payload: the fingerprint
    // covers the id, so this is a conflict too — never a silent apply.
    const retryNewId = { ...target, id: "e-conflict-retry" };
    assert.throws(() => applyEvent(state, retryNewId), /Conflicting reuse of idempotency key/);

    assert.deepEqual(state, before, "a rejected event mutated the input state");
  }), { numRuns: 80, seed });
});

// --- P4: no illegal state reachable ---------------------------------------------------
test("property P4: every prefix of a legal stream keeps the kernel's structural invariants", () => {
  fc.assert(fc.property(streamArb, (gen) => {
    const { events } = buildStream(gen.ops);
    let state = emptyRoomState();
    events.forEach((e, i) => {
      state = applyEvent(state, e);
      assert.equal(state.eventLog.length, i + 1, "eventLog length diverged from applied count");
      assert.equal(Object.keys(state.seenEvents).length, i + 1, "seenEvents diverged from the log");
      assert.equal(Object.keys(state.seenIdempotencyKeys).length, i + 1, "seenIdempotencyKeys diverged from the log");
      for (const eventId of Object.values(state.seenIdempotencyKeys)) {
        assert.ok(Object.hasOwn(state.seenEvents, eventId), "idempotency key points at an unseen event");
      }
      assert.equal(state.room?.id, ROOM, "room identity drifted");
      if (i >= 1) assert.ok(state.members.owner, "bootstrap owner missing after member.added");
      for (const item of Object.values(state.workItems)) {
        assert.ok(WORK_STATE_VALUES.has(item.state), `illegal work state reachable: ${item.state}`);
        assert.ok(Object.hasOwn(state.members, item.accountableMemberId), "work item accountable to a non-member");
      }
      for (const m of state.messages) {
        if (m.kind !== "receipt_card" || !m.cost) continue;
        for (const cents of [m.cost.spentCents, m.cost.capCents]) {
          assert.ok(cents === null || (Number.isSafeInteger(cents) && cents >= 0), `illegal cents in state: ${cents}`);
        }
      }
      const allowance = state.room.spendAllowance;
      if (allowance) {
        assert.ok(
          allowance.allowanceCents === null
            || (Number.isSafeInteger(allowance.allowanceCents) && allowance.allowanceCents >= 0 && allowance.allowanceCents <= SPEND_ALLOWANCE_LIMITS.allowanceCents),
          "allowance cents out of the kernel's range",
        );
        assert.ok(Number.isSafeInteger(allowance.revision) && allowance.revision >= 1, "allowance revision illegal");
      }
      if (state.room.archivedAt) {
        assert.equal(e.type, T.ROOM_ARCHIVED, "archivedAt set by a non-archive event");
        assert.equal(state.room.archivedAt, e.at);
      }
    });
  }), { numRuns: 100, seed });
});

test("property P4b: room preconditions hold at the boundaries (creation, room identity, archive)", () => {
  fc.assert(fc.property(streamArb, fc.nat(), (gen, pick) => {
    const { events, model } = buildStream(gen.ops);
    const fresh = (type, actorId, data, over = {}) => ({
      id: "e-fresh", idempotencyKey: "k-fresh", roomId: ROOM, type,
      actorId, at: isoTick(10000), causationId: null, data, ...over,
    });

    // Nothing applies before room.created.
    const preCreation = events[4] ?? fresh(T.MESSAGE_POSTED, "ada", { body: "too soon" });
    assert.throws(() => applyEvent(emptyRoomState(), preCreation), /Room must be created before other events/);

    const state = foldSequential(events);

    // A second room.created (fresh id and key) is refused, live or archived.
    const secondCreate = fresh(T.ROOM_CREATED, "owner", { roomId: ROOM, title: "Again", purpose: "duplicate room", ownerId: "owner" });
    assert.throws(() => applyEvent(state, secondCreate), /Room already exists/);

    // An event addressed to a different room is refused.
    const wrongRoom = fresh(T.MESSAGE_POSTED, "ada", { body: "wrong room" }, { roomId: "room-elsewhere" });
    assert.throws(() => applyEvent(state, wrongRoom), /different Room|Room must be created/);

    if (!model.archived) return;
    // After archive: every fresh event is refused; exact duplicates of
    // already-applied events remain no-ops (the seen-check runs first).
    const attempts = [
      fresh(T.MESSAGE_POSTED, "ada", { body: "too late" }),
      fresh(T.ROOM_SPEND_ALLOWANCE_SET, "owner", { allowanceCents: 5, periodDays: 5 }),
      fresh(T.ROOM_SPEND_PRICING_SET, "owner", { enabled: true }),
      fresh(T.WORK_PROPOSED, "owner", { workItemId: "w-late", title: "Late", definitionOfDone: "never", accountableMemberId: "owner" }),
      fresh(T.MEMBER_ADDED, "owner", { memberId: "late", displayName: "Late", kind: "human", permissions: [] }),
    ];
    for (const attempt of attempts) {
      assert.throws(() => applyEvent(state, attempt), /Room is archived/);
    }
    const dup = events[pick % events.length];
    assert.deepEqual(applyEvent(state, dup), state, "post-archive duplicate was not a no-op");
  }), { numRuns: 60, seed });
});
