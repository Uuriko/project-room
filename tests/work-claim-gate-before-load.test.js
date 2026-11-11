// FUNNEL-FIXES pack 2, cure C2 (lane-02 PACK §4 C2 + §6 T4–T8, as amended by
// PACK-REVISION §3, PACK-REVISION-2 §1.1/§1.4/§1.6/§1.7/§2, PACK-REVISION-3
// §2.1): claim-route error semantics — gate before load, no existence oracle.
//
// Contract: for a caller who may NOT write claims, every POST work-claims
// route answers 403 work_claims_not_permitted with the gate next[], byte-
// identical across a real claim id / a native work-item id / an invented id.
// Authority-gated routes (release/reassign/delegate/premise-invalid/approval)
// collapse to one generic 403 work_not_owner for non-authority callers,
// identical for existent and nonexistent ids, naming no holder. For a writer,
// a native work-item id on the claim route returns the enriched 404
// (kind: "work_item_not_board_claim"); a garbage id keeps the plain 404.
// Non-member/revoked refusals (T6), base-member write refusals (T7) and guest
// exclusion (T8) keep their shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { agentErrorAx } from "../src/agent-error.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  base: { id: "base", kind: "agent", active: true, permissions: [] },
  writer: { id: "writer", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  heldby: { id: "heldby", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  other: { id: "other", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  verifyHuman: { id: "verifyHuman", kind: "human", active: true, permissions: ["verify"] },
  revoked: { id: "revoked", kind: "agent", active: false, permissions: ["accept_work", "complete_work"] },
  "guest-agent-1": { id: "guest-agent-1", kind: "agent", active: true, permissions: [] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const call = async (registry, memberId, route, id, body) => {
  const member = MEMBERS[memberId] ?? { id: memberId, kind: "agent", permissions: [] };
  try {
    return await handleWorkClaims({
      req: { method: "POST", body },
      res: {},
      url: new URL("https://room.example/api/rooms/room1/work-claims"),
      store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
      roomId: "room1",
      auth: { member: { id: memberId, kind: member.kind, permissions: member.permissions } },
      workClaimRoute: route,
      workClaimId: id,
      helpers,
      registry,
    });
  } catch (error) {
    if (Number.isInteger(error?.status) && error.code) {
      return { status: error.status, value: error.body ?? { error: { code: error.code, message: error.message } } };
    }
    throw error;
  }
};

const seed = () => {
  const registry = createWorkClaimRegistry();
  registry.set("room1", { id: "open-claim", state: "unclaimed", owner: null, history: [] });
  registry.set("room1", { id: "held-claim", state: "claimed", owner: "heldby", claimedAt: "2026-11-01T00:00:00.000Z", history: [{ action: "created" }, { action: "claimed" }] });
  registry.set("room1", { id: "linked-proposed", state: "unclaimed", owner: null, workItemId: "native-1", history: [] });
  return registry;
};


// The generic authority messages echo the caller-supplied id (which
// discloses nothing — the caller sent it). Collapse equality is therefore
// judged after removing that echo.
const stripEcho = (value, id) => JSON.parse(JSON.stringify(value).split(id).join("<id>"));

const gateShape = result => {
  assert.equal(result.status, 403, JSON.stringify(result));
  assert.equal(result.value.error.code, "work_claims_not_permitted");
  const next = result.value.next ?? [];
  assert.ok(next.some(step => /contribute invite/i.test(step.command ?? "")), "gate next[] names the contribute invite");
  assert.ok(next.some(step => (step.permissions ?? []).includes("accept_work") && (step.permissions ?? []).includes("complete_work")), "gate next[] names the requestable tokens");
  assert.ok(next.some(step => step.expiresUndecidedAfterDays === 7 || /7 days/.test(step.command ?? "")), "gate next[] states the 7-day expiry");
  assert.ok(next.some(step => step.endpoint === "/api/public-work/match" || /public-work\/match/.test(step.command ?? "")), "gate next[] names the public-work match");
  return result.value;
};

// T5 (rewritten, behaviour-change): a base member cannot distinguish id kinds
// on the claim route — real / work-item / invented / linked-proposed ids all
// return the identical 403 gate body.
test("T5: base member claim responses are identical across id kinds", async () => {
  const registry = seed();
  const bodies = [];
  for (const id of ["open-claim", "native-1", "invented-zzz", "linked-proposed", "held-claim"]) {
    bodies.push(gateShape(await call(registry, "base", "claim", id, {})));
  }
  for (const body of bodies.slice(1)) assert.deepEqual(body, bodies[0]);
  // Malformed body: the gate precedes shape validation (normative ordering).
  assert.deepEqual(gateShape(await call(registry, "base", "claim", "open-claim", { bogus: 1 })), bodies[0]);
  assert.equal(registry.get("room1", "open-claim").state, "unclaimed");
  assert.equal(registry.get("room1", "held-claim").owner, "heldby");
});

// T5-renew: identical gate refusal for every id kind; writer rows unchanged.
test("T5-renew: non-writer renew is one identical 403; writer rows unchanged", async () => {
  const registry = seed();
  const bodies = [];
  for (const id of ["open-claim", "held-claim", "invented-zzz"]) {
    bodies.push(gateShape(await call(registry, "base", "renew", id, {})));
  }
  // A non-writer who is the assigned holder (create-with-assignee shape):
  registry.set("room1", { id: "base-held", state: "claimed", owner: "base", claimedAt: "2026-11-01T00:00:00.000Z", history: [{ action: "claimed" }] });
  bodies.push(gateShape(await call(registry, "base", "renew", "base-held", {})));
  for (const body of bodies.slice(1)) assert.deepEqual(body, bodies[0]);
  // Writer rows: nonexistent → plain 404; unclaimed → 409 claim_lease_lapsed;
  // another's → 403 work_not_owner naming the holder (post-gate, unchanged).
  const missing = await call(registry, "writer", "renew", "invented-zzz", {});
  assert.equal(missing.status, 404); assert.equal(missing.value.error.code, "work_claim_not_found");
  const unclaimed = await call(registry, "writer", "renew", "open-claim", {});
  assert.equal(unclaimed.status, 409); assert.equal(unclaimed.value.error.code, "claim_lease_lapsed");
  const others = await call(registry, "writer", "renew", "held-claim", {});
  assert.equal(others.status, 403); assert.equal(others.value.error.code, "work_not_owner");
  assert.match(others.value.error.message, /heldby/);
});

// T5-update: non-writer non-reviewer identical 403; the verify-only human's
// lawful reviewer transition still reaches the per-item logic.
test("T5-update: coarse gate is identical across ids; reviewer exception survives", async () => {
  const registry = seed();
  const a = gateShape(await call(registry, "base", "update", "held-claim", { state: "in_progress" }));
  const b = gateShape(await call(registry, "base", "update", "invented-zzz", { state: "in_progress" }));
  assert.deepEqual(a, b);
  // Malformed body from a non-writer: gate first, not 422.
  gateShape(await call(registry, "base", "update", "held-claim", { bogus: 1 }));
  // Writer on a nonexistent id still gets the plain 404 (post-gate).
  const missing = await call(registry, "writer", "update", "invented-zzz", { state: "in_progress" });
  assert.equal(missing.status, 404); assert.equal(missing.value.error.code, "work_claim_not_found");
  // Reviewer exception: a verify-only human's delivered->done transition is
  // NOT stopped by the coarse gate — it reaches the per-item reviewer logic
  // (whatever that logic then decides, it is not the gate refusal).
  registry.set("room1", { id: "delivered-claim", state: "delivered", owner: "heldby", claimedAt: "2026-11-01T00:00:00.000Z", history: [{ action: "claimed" }] });
  const verify = await call(registry, "verifyHuman", "update", "delivered-claim", { state: "done" });
  assert.notEqual(verify.value.error?.code, "work_claims_not_permitted", JSON.stringify(verify));
});

// T5-close/cancel + review sub-branches: gate before the linked-item block.
test("T5-close/review: non-writer refusals precede any existence-dependent answer", async () => {
  const registry = seed();
  for (const route of ["close", "cancel"]) {
    const a = gateShape(await call(registry, "base", route, "linked-proposed", {}));
    const b = gateShape(await call(registry, "base", route, "invented-zzz", {}));
    assert.deepEqual(a, b);
  }
  // Review, verdict-shaped body from a non-reviewer.
  const v1 = gateShape(await call(registry, "base", "review", "held-claim", { verdict: "approve", summary: "x" }));
  const v2 = gateShape(await call(registry, "base", "review", "invented-zzz", { verdict: "approve", summary: "x" }));
  assert.deepEqual(v1, v2);
  // Review, note-shaped body from a non-attester: the attest refusal, identical.
  const n1 = await call(registry, "base", "review", "held-claim", { note: "hi" });
  const n2 = await call(registry, "base", "review", "invented-zzz", { note: "hi" });
  assert.equal(n1.status, 403); assert.deepEqual(n1.value, n2.value);
  assert.equal(n1.value.error.code, "work_claims_not_permitted");
});

// T5-release/reassign/premise-invalid: authority collapse — one generic
// work_not_owner body for existent and nonexistent ids, naming no holder.
test("T5-authority: release, reassign and premise-invalid collapse for non-authority callers", async () => {
  const registry = seed();
  const generic = async (route, id, body) => {
    const result = await call(registry, "other", route, id, body);
    assert.equal(result.status, 403, `${route} ${id}: ${JSON.stringify(result)}`);
    assert.equal(result.value.error.code, "work_not_owner");
    assert.ok(!result.value.error.message.includes("heldby"), "generic body names no holder");
    return result.value;
  };
  const round = { expectedClaimedAt: "2026-11-01T00:00:00.000Z", expectedHistoryLength: 2 };
  assert.deepEqual(stripEcho(await generic("release", "held-claim", { ...round }), "held-claim"), stripEcho(await generic("release", "invented-zzz", { ...round }), "invented-zzz"));
  assert.deepEqual(stripEcho(await generic("reassign", "held-claim", { newOwner: "writer", ...round }), "held-claim"), stripEcho(await generic("reassign", "invented-zzz", { newOwner: "writer", ...round }), "invented-zzz"));
  assert.deepEqual(stripEcho(await generic("premise-invalid", "held-claim", { reason: "bad premise" }), "held-claim"), stripEcho(await generic("premise-invalid", "invented-zzz", { reason: "bad premise" }), "invented-zzz"));
  // The holder's own release still proceeds past authority (round check next).
  const holderStale = await call(registry, "heldby", "release", "held-claim", { expectedClaimedAt: "2020-01-01T00:00:00.000Z", expectedHistoryLength: 0 });
  assert.equal(holderStale.status, 409);
  assert.equal(holderStale.value.error.code, "work_claim_conflict");
});

// T5-approval: flag off → one identical 404 for every id; flag on → generic
// 403 for callers with no approval relationship; authorised flows unchanged.
test("T5-approval: flag and authority precede existence", async t => {
  const registry = seed();
  const off = [];
  for (const id of ["held-claim", "invented-zzz", "linked-proposed"]) {
    const result = await call(registry, "other", "approval", id, { action: "approve" });
    assert.equal(result.status, 404); assert.equal(result.value.error.code, "not_found");
    off.push(result.value);
  }
  for (const body of off.slice(1)) assert.deepEqual(body, off[0]);

  process.env.ROOM_APPROVAL_HOLD = "1";
  t.after(() => { delete process.env.ROOM_APPROVAL_HOLD; });
  const a = await call(registry, "other", "approval", "held-claim", { action: "approve" });
  const b = await call(registry, "other", "approval", "invented-zzz", { action: "approve" });
  assert.equal(a.status, 403); assert.equal(a.value.error.code, "work_not_owner");
  assert.deepEqual(stripEcho(a.value, "held-claim"), stripEcho(b.value, "invented-zzz"));
  assert.ok(!a.value.error.message.includes("heldby"));
  // The room owner with no approval relationship gets the same generic 403
  // (deliberate refusal-code change from the post-load 422, Rev-2 §1.1).
  const ownerResult = await call(registry, "owner", "approval", "held-claim", { action: "request", approver: "writer", step: "x" });
  assert.equal(ownerResult.status, 403); assert.equal(ownerResult.value.error.code, "work_not_owner");
});

// T5-delegate: flag off → identical 404 pre-block; flag on → collapse.
test("T5-delegate: flag check precedes existence; non-authority collapses", async t => {
  const registry = seed();
  const offA = await call(registry, "other", "delegate", "held-claim", { delegate: "writer" });
  const offB = await call(registry, "other", "delegate", "invented-zzz", { delegate: "writer" });
  assert.equal(offA.status, 404); assert.deepEqual(offA.value, offB.value);

  process.env.ROOM_CLAIM_DELEGATE = "1";
  t.after(() => { delete process.env.ROOM_CLAIM_DELEGATE; });
  const a = await call(registry, "other", "delegate", "held-claim", { delegate: "writer" });
  const b = await call(registry, "other", "delegate", "invented-zzz", { delegate: "writer" });
  assert.equal(a.status, 403); assert.equal(a.value.error.code, "work_not_owner");
  assert.deepEqual(stripEcho(a.value, "held-claim"), stripEcho(b.value, "invented-zzz"));
});

// T7 (negative control): a base member's create/claim/renew/update are all
// the gate 403 and the board is unchanged.
test("T7: base member writes all refuse with the gate 403; board unchanged", async () => {
  const registry = seed();
  const before = structuredClone(registry.list("room1"));
  gateShape(await call(registry, "base", "create", null, { id: "base-item" }));
  gateShape(await call(registry, "base", "claim", "open-claim", {}));
  gateShape(await call(registry, "base", "renew", "held-claim", {}));
  gateShape(await call(registry, "base", "update", "held-claim", { state: "in_progress" }));
  assert.equal(registry.has("room1", "base-item"), false);
  assert.deepEqual(registry.list("room1"), before);
});

// T6 (negative control): non-member and revoked callers get no existence
// signal either — the same gate refusal for existent and invented ids (the
// production membership/auth refusal upstream is unchanged by C2).
test("T6: non-member and revoked callers distinguish nothing", async () => {
  const registry = seed();
  for (const who of ["stranger", "revoked"]) {
    const a = await call(registry, who, "claim", "held-claim", {});
    const b = await call(registry, who, "claim", "invented-zzz", {});
    assert.equal(a.status, 403, who);
    assert.deepEqual(a.value, b.value);
  }
});

// T8: guest exclusion unchanged — a guest-agent member's Board writes are
// refused exactly as at the pin (gate 403 at this handler; the HTTP layer's
// guest_scope_denied runs before this handler and is untouched).
test("T8: guest-agent member writes keep the pin's refusal shape", async () => {
  const registry = seed();
  gateShape(await call(registry, "guest-agent-1", "create", null, { id: "guest-item" }));
  gateShape(await call(registry, "guest-agent-1", "claim", "open-claim", {}));
  assert.equal(registry.has("room1", "guest-item"), false);
  assert.equal(registry.get("room1", "open-claim").state, "unclaimed");
});

// Append variant pin: linkWorkClaimPullRequest gates before loading.
test("appendPullRequest variant: non-writer refused before any 404", async () => {
  const registry = seed();
  const result = await call(registry, "base", "update", "invented-zzz",
    { appendPullRequest: { url: "https://github.com/Uuriko/project-room/pull/1" }, expectedClaimedAt: null, expectedHistoryLength: 0 });
  gateShape(result);
});

// MCP parity (task point 3): the core-MCP room_claim refusal rendering for
// work_claims_not_permitted carries the same gate legs as REST.
test("MCP room_claim refusal carries the gate next legs", () => {
  const ax = agentErrorAx({ httpStatus: 403, code: "work_claims_not_permitted",
    message: "Creating, claiming, renewing, or updating work claims needs a contribute, review, or collaborate profile." });
  assert.equal(ax.reason, "work_claims_not_permitted");
  const flat = JSON.stringify(ax.next ?? []);
  assert.match(flat, /contribute/);
  assert.match(flat, /accept_work/);
  assert.match(flat, /7 days/);
  assert.match(flat, /public-work\/match/);
});

// T4 (writer + native work-item id): the 404 must become actionable — kind,
// the item's state, its accountable member, and next[] to the work-context
// read (plus the correct verb for its state). A garbage id keeps the plain
// 404 with the re-read-the-board next. Uses a real RoomStore so the work
// item is read through the same readWorkItem path the handler uses.
test("T4: writer claiming a native work-item id gets the enriched 404; garbage stays plain", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, kind, permissions) => store.command(ownerKey, "commons",
    { id: `add-${id}`, type: "member.added", data: { memberId: id, displayName: id, kind, permissions } });
  add("writer2", "agent", ["accept_work", "complete_work"]);
  add("base2", "agent", []);
  store.command(ownerKey, "commons", { id: "propose-native", type: "work.proposed",
    data: { workItemId: "native-task", title: "Native task", definitionOfDone: "A saved result", accountableMemberId: "owner" } });

  const callStore = async (memberId, permissions, route, id, body) => {
    try {
      return await handleWorkClaims({
        req: { method: "POST", body }, res: {},
        url: new URL("https://room.example/api/rooms/commons/work-claims"),
        store, roomId: "commons",
        auth: { member: { id: memberId, kind: "agent", permissions } },
        workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
      });
    } catch (error) {
      if (Number.isInteger(error?.status) && error.code) {
        return { status: error.status, value: error.body ?? { error: { code: error.code, message: error.message } } };
      }
      throw error;
    }
  };

  // Writer + work-item id → enriched 404.
  const enriched = await callStore("writer2", ["accept_work", "complete_work"], "claim", "native-task", {});
  assert.equal(enriched.status, 404, JSON.stringify(enriched));
  assert.equal(enriched.value.error.code, "work_claim_not_found");
  assert.equal(enriched.value.kind, "work_item_not_board_claim");
  assert.equal(enriched.value.workItemState, "proposed");
  assert.equal(enriched.value.accountableMemberId, "owner");
  const nextPaths = (enriched.value.next ?? []).map(step => step.path ?? step.endpoint ?? "");
  assert.ok(nextPaths.some(path => path.includes("/work-context?workItemId=native-task")), "next[] points at the work-context read");
  assert.ok(nextPaths.some(path => path.endsWith("/work-claims")), "next[] includes re-reading the board");
  // The proposed item's correct verb for its accountable member is named.
  assert.match(JSON.stringify(enriched.value.next), /accept/i);

  // Writer + garbage id → plain 404, no kind, re-read-the-board next.
  const plain = await callStore("writer2", ["accept_work", "complete_work"], "claim", "garbage-zzz", {});
  assert.equal(plain.status, 404);
  assert.equal(plain.value.error.code, "work_claim_not_found");
  assert.equal(plain.value.kind, undefined);
  assert.ok((plain.value.next ?? []).some(step => (step.path ?? "").endsWith("/work-claims")));

  // Base member + the same work-item id → the gate 403, NOT the enriched 404
  // (no existence information to non-writers).
  const gated = await callStore("base2", [], "claim", "native-task", {});
  assert.equal(gated.status, 403);
  assert.equal(gated.value.error.code, "work_claims_not_permitted");
  assert.equal(gated.value.kind, undefined);
});
