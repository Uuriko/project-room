// Replay-matrix adapters — #3676 PR-2. One adapter per ROWS entry in
// harness.mjs, each driving the surface's REAL entry point:
//   rows 1-2: handleWorkClaims over a real work-claim registry (the same
//             shape tests/work-claim-idempotency.test.js pins);
//   row 3:    AgentInvites.create/redeem on a PR-0 conformance store;
//   row 4:    GuestInvites.mint on a PR-0 conformance store (issue is the
//             journaled operation; redeem is single-use by code, keyed by
//             the code itself, and is pinned by the guest-invite suites);
//   row 5:    BuyerSignoff.request — the executeOnce journal entry point
//             every sign-off operation (create/submit/review/cancel) runs
//             through; the effect is a row in a harness-owned table
//             written by the action INSIDE the same transaction, so R5/R6
//             count real persisted effects, not closure counters;
//   row 6:    Attention.mutate on a PR-0 conformance store;
//   row 7:    BountyEscrow.idemExecute — the routes' own idempotency
//             boundary (server/bounty-escrow-routes.mjs calls it for every
//             escrow write; its 409 mapping of the pinned codes lives at
//             bounty-escrow-routes.mjs:88 and is mirrored in `caught`);
//   row 8:    issueSpendGrantRoute from server/spend-grants.mjs (the
//             function server/routes/spend-grants.mjs dispatches to).
//
// PR-3 adds R6 to every adapter: reopen() over the same durable state and
// crashAttempt() running the operation inside the store's transaction and
// throwing before commit. Rows 1-2 get dedicated R6 adapters (below)
// because their PR-2 adapters drive the in-memory registry fixture,
// which by construction cannot be reopened or rolled back; the R6
// adapters drive the PRODUCTION shape — the durable SQLite registry
// (server/work-claim-sqlite.mjs) that RoomStore owns — over a PR-0
// conformance store, with the crash reached through a registry whose
// transaction runner throws after the handler's writes, before commit.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkClaimRegistry, handleWorkClaims } from "../../server/work-claim-routes.mjs";
import { createDurableWorkClaimRegistry } from "../../server/work-claim-sqlite.mjs";
import { BountyEscrow } from "../../server/bounty-escrow.mjs";
import { issueSpendGrantRoute } from "../../server/spend-grants.mjs";
import { createConformanceFixture } from "../helpers/conformance-fixture.mjs";

const caught = (error, conflictCodes = []) => ({
  status: error?.status ?? (conflictCodes.includes(error?.code) ? 409 : 500),
  code: error?.code ?? "unknown_error",
  body: undefined,
});

// ---------------------------------------------------------------- work claims
const WC_MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};
const wcHelpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => {
    const error = new Error(message);
    error.status = status; error.code = code; error.body = { error: { code, message } };
    throw error;
  },
  body: async req => req.body,
};
function wcCall(registry, room, memberId, route, id, body) {
  return handleWorkClaims({
    req: { method: "POST", body }, res: {},
    url: new URL(`https://room.example/api/rooms/${room}/work-claims`),
    store: { roomAuthority: () => ({ ownerId: "owner", members: WC_MEMBERS }), room: () => ({ state: { messages: [] } }) },
    roomId: room,
    auth: { member: { id: memberId, kind: WC_MEMBERS[memberId].kind, permissions: WC_MEMBERS[memberId].permissions } },
    workClaimRoute: route, workClaimId: id, helpers: wcHelpers, registry,
  }).then(res => ({ status: res.status, code: res.value?.error?.code, body: res.value }));
}

export const workClaimCreateAdapter = {
  name: "work-claim-create",
  async setup() { return { registry: createWorkClaimRegistry(), room: "room1" }; },
  async setupForeign(_t, primary) { return { registry: primary.registry, room: "room2" }; },
  async submit(ctx, { key, payload, actor }) {
    const member = actor === "second" ? "holder" : "owner";
    const body = key === null ? { title: "Matrix claim" }
      : { id: key, title: payload === "different" ? "DIFFERENT TITLE" : "Matrix claim" };
    return wcCall(ctx.registry, ctx.room, member, "create", null, body);
  },
  async failAttempt(ctx, { key }) {
    return wcCall(ctx.registry, ctx.room, "owner", "create", null, { id: key, bogusField: 1 });
  },
  async effectCount(ctx, { key }) {
    return key && ctx.registry.has(ctx.room, key) ? 1 : 0;
  },
  normalize: body => body,
};

export const workClaimCloseAdapter = {
  name: "work-claim-close",
  async setup() { return { registry: createWorkClaimRegistry(), room: "room1" }; },
  async setupForeign(_t, primary) { return { registry: primary.registry, room: "room2" }; },
  async ensureClaim(ctx, key) {
    if (!ctx.registry.has(ctx.room, key)) {
      const created = await wcCall(ctx.registry, ctx.room, "owner", "create", null, { id: key, title: "Matrix claim" });
      if (created.status !== 201 && created.status !== 409) throw new Error(`close adapter setup create failed: ${created.status}`);
    }
  },
  async submit(ctx, { key, payload, actor }) {
    await this.ensureClaim(ctx, key);
    const member = actor === "second" ? "holder" : "owner";
    const verb = payload === "different" ? "cancel" : "close";
    return wcCall(ctx.registry, ctx.room, member, verb, key, {});
  },
  async failAttempt(ctx, { key }) {
    await this.ensureClaim(ctx, key);
    return wcCall(ctx.registry, ctx.room, "holder", "close", key, {});
  },
  async effectCount(ctx, { key }) {
    const item = key ? ctx.registry.get(ctx.room, key) : null;
    return item?.state === "closed" ? 1 : 0;
  },
  normalize: body => body,
};

// ------------------------------------------------- work claims, R6 (PR-3)
// The durable shape: a PR-0 conformance store, its own workClaims registry
// (createDurableWorkClaimRegistry over the store's db, driven by the
// store's transaction — exactly how RoomStore constructs it), and the
// real handleWorkClaims with the real store (claim commits also append
// the work_claim.updated room event inside the same transaction, so the
// rollback crash is observed on effect + event together).
async function wcCallDurable(ctx, memberId, route, id, body, registry) {
  try {
    const res = await handleWorkClaims({
      req: { method: "POST", body }, res: {},
      url: new URL(`https://room.example/api/rooms/${ctx.room}/work-claims`),
      store: ctx.store, roomId: ctx.room,
      auth: { member: { id: memberId, kind: WC_MEMBERS[memberId].kind, permissions: WC_MEMBERS[memberId].permissions } },
      workClaimRoute: route, workClaimId: id, helpers: wcHelpers, registry: registry ?? ctx.registry,
    });
    return { status: res.status, code: res.value?.error?.code, body: res.value };
  } catch (error) {
    return { status: error?.status ?? 500, code: error?.code ?? "simulated_crash", body: undefined };
  }
}
function wcDurableCtx(t) {
  const fixture = createConformanceFixture(t);
  return { fixture, store: fixture.store, registry: fixture.store.workClaims, room: fixture.fixture.roomId };
}
// A registry over the same db whose transaction runner executes the
// handler's writes and then throws before the store transaction commits:
// the §A.4 crash point, reached through the registry seam handleWorkClaims
// itself uses (`registry.transaction ? registry.transaction(run) : run()`).
function wcCrashRegistry(ctx) {
  return createDurableWorkClaimRegistry(ctx.store.db, {
    transaction: fn => ctx.store.transaction(() => {
      const out = fn();
      throw new Error("simulated crash between execute and persist");
    }),
  });
}
export const workClaimCreateR6Adapter = {
  name: "work-claim-create-r6",
  async setup(t) { return wcDurableCtx(t); },
  async submit(ctx, { key, payload }) {
    const body = key === null ? { title: "Matrix claim" }
      : { id: key, title: payload === "different" ? "DIFFERENT TITLE" : "Matrix claim" };
    return wcCallDurable(ctx, "owner", "create", null, body);
  },
  async crashAttempt(ctx, { key }) {
    return wcCallDurable(ctx, "owner", "create", null, { id: key, title: "Matrix claim" }, wcCrashRegistry(ctx));
  },
  async reopen(ctx) {
    ctx.fixture.reopen();
    ctx.store = ctx.fixture.store;
    ctx.registry = ctx.fixture.store.workClaims;
  },
  async effectCount(ctx, { key }) {
    return key && ctx.registry.has(ctx.room, key) ? 1 : 0;
  },
  normalize: body => body,
};
export const workClaimCloseR6Adapter = {
  name: "work-claim-close-r6",
  async setup(t) { return wcDurableCtx(t); },
  async ensureClaim(ctx, key) {
    if (!ctx.registry.has(ctx.room, key)) {
      const created = await wcCallDurable(ctx, "owner", "create", null, { id: key, title: "Matrix claim" });
      if (created.status !== 201 && created.status !== 409) throw new Error(`close R6 setup create failed: ${created.status}`);
    }
  },
  async submit(ctx, { key, payload }) {
    await this.ensureClaim(ctx, key);
    const verb = payload === "different" ? "cancel" : "close";
    return wcCallDurable(ctx, "owner", verb, key, {});
  },
  async crashAttempt(ctx, { key }) {
    await this.ensureClaim(ctx, key);
    return wcCallDurable(ctx, "owner", "close", key, {}, wcCrashRegistry(ctx));
  },
  async reopen(ctx) {
    ctx.fixture.reopen();
    ctx.store = ctx.fixture.store;
    ctx.registry = ctx.fixture.store.workClaims;
  },
  async effectCount(ctx, { key }) {
    const item = key ? ctx.registry.get(ctx.room, key) : null;
    return item?.state === "closed" ? 1 : 0;
  },
  normalize: body => body,
};

// ---------------------------------------------------------------- agent invites
function agentInviteCtx(t, overrides = {}) {
  const fixture = createConformanceFixture(t, overrides);
  const store = fixture.store;
  const room = fixture.fixture.roomId;
  const ownerKey = store.issueAccessKey(room, "owner");
  return { fixture, store, room, ownerKey, codes: new Map(), secondIdentity: null };
}
// Invite codes are single-use, so every scenario key mints its own code
// (per payload variant); the requestId under test is the client's key,
// independent of which code it first redeems.
function agentCode(ctx, tag, displayName, permissions) {
  if (!ctx.codes.has(tag)) {
    ctx.codes.set(tag, ctx.store.invites.create(ctx.ownerKey, ctx.room,
      { permissions, expiresInMinutes: 60, displayName }).code);
  }
  return ctx.codes.get(tag);
}
export const agentInviteAdapter = {
  name: "agent-invite-redeem",
  async setup(t) { return agentInviteCtx(t); },
  async setupForeign(t) { return agentInviteCtx(t, { roomId: "other-room" }); },
  async submit(ctx, { key, payload, actor }) {
    try {
      if (key === null) {
        const res = ctx.store.invites.redeem(agentCode(ctx, "keyless", "Keyless Bot", ["accept_work"]), { displayName: "Keyless Bot" });
        return { status: 200, body: res };
      }
      if (actor === "second") {
        ctx.secondIdentity ??= ctx.store.identities.create("Matrix Second");
        const res = ctx.store.invites.redeem(agentCode(ctx, `${key}:same`, "Matrix Bot", ["accept_work", "complete_work"]),
          { displayName: "Matrix Bot", requestId: key, identitySecret: ctx.secondIdentity.secret });
        return { status: 200, body: res };
      }
      if (payload === "different") {
        const res = ctx.store.invites.redeem(agentCode(ctx, `${key}:diff`, "Other Bot", ["accept_work"]), { displayName: "Other Bot", requestId: key });
        return { status: 200, body: res };
      }
      const res = ctx.store.invites.redeem(agentCode(ctx, `${key}:same`, "Matrix Bot", ["accept_work", "complete_work"]), { displayName: "Matrix Bot", requestId: key });
      return { status: 200, body: res };
    } catch (error) { return caught(error); }
  },
  async failAttempt(ctx, { key }) {
    try {
      ctx.store.invites.redeem(agentCode(ctx, `${key}:same`, "Matrix Bot", ["accept_work", "complete_work"]), { displayName: "x".repeat(100), requestId: key });
      return { status: 200 };
    } catch (error) { return caught(error); }
  },
  // R6 (PR-3): redeem() journals its receipt in the same store transaction
  // as the code burn, so wrapping it in an outer transaction and throwing
  // before commit rolls back burn + receipt + membership together.
  async crashAttempt(ctx, { key }) {
    // The code is minted BEFORE the crash transaction opens: the crash
    // rolls back the redeem, not the pre-existing invite it targets.
    const code = agentCode(ctx, `${key}:same`, "Matrix Bot", ["accept_work", "complete_work"]);
    try {
      ctx.store.transaction(() => {
        ctx.store.invites.redeem(code, { displayName: "Matrix Bot", requestId: key });
        throw new Error("simulated crash between execute and persist");
      });
      return { status: 200 };
    } catch (error) { return { status: 500, code: "simulated_crash" }; }
  },
  async reopen(ctx) {
    ctx.fixture.reopen();
    ctx.store = ctx.fixture.store;
    ctx.ownerKey = ctx.store.issueAccessKey(ctx.room, "owner");
  },
  async effectCount(ctx, { key }) {
    if (!key) return 0;
    return ctx.store.db.prepare("SELECT count(*) n FROM agent_invite_redeem_receipts WHERE request_id=?").get(key).n;
  },
  normalize: body => ({ memberId: body?.memberId, identityId: body?.identityId }),
};

// ---------------------------------------------------------------- guest invites
function guestCtx(t, overrides = {}) {
  const fixture = createConformanceFixture(t, overrides);
  const store = fixture.store;
  const room = fixture.fixture.roomId;
  return {
    fixture, store, room,
    ownerKey: store.issueAccessKey(room, "owner"),
    actorKey: store.issueAccessKey(room, "actor-1"),
  };
}
export const guestInviteAdapter = {
  name: "guest-invite-issue",
  async setup(t) { return guestCtx(t); },
  async setupForeign(t) { return guestCtx(t, { roomId: "other-room" }); },
  async submit(ctx, { key, payload, actor }) {
    try {
      const token = actor === "second" ? ctx.actorKey : ctx.ownerKey;
      const details = key === null
        ? { guestLabel: "Matrix Visit", expectedOwnerRevision: 0 }
        : { requestId: key, guestLabel: payload === "different" ? "DIFFERENT LABEL" : "Matrix Visit", expectedOwnerRevision: 0 };
      const res = ctx.store.guestInvites.mint(token, ctx.room, details);
      return { status: 201, body: res };
    } catch (error) { return caught(error); }
  },
  async failAttempt(ctx, { key }) {
    try {
      ctx.store.guestInvites.mint(ctx.ownerKey, ctx.room,
        { requestId: key, guestLabel: "Matrix Visit", expectedOwnerRevision: 99 });
      return { status: 201 };
    } catch (error) { return caught(error); }
  },
  // R6 (PR-3): mint() writes the invite row and its authority row inside
  // one store.transaction; the outer-transaction throw rolls both back.
  async crashAttempt(ctx, { key }) {
    try {
      ctx.store.transaction(() => {
        ctx.store.guestInvites.mint(ctx.ownerKey, ctx.room,
          { requestId: key, guestLabel: "Matrix Visit", expectedOwnerRevision: 0 });
        throw new Error("simulated crash between execute and persist");
      });
      return { status: 201 };
    } catch (error) { return { status: 500, code: "simulated_crash" }; }
  },
  async reopen(ctx) {
    ctx.fixture.reopen();
    ctx.store = ctx.fixture.store;
    ctx.ownerKey = ctx.store.issueAccessKey(ctx.room, "owner");
    ctx.actorKey = ctx.store.issueAccessKey(ctx.room, "actor-1");
  },
  async effectCount(ctx, { key }) {
    if (!key) return 0;
    return ctx.store.db.prepare("SELECT count(*) n FROM guest_invites WHERE issue_request_id=?").get(key).n;
  },
  // The GX code is shown only at mint (see DIVERGENCES): replay comparison
  // is over the invite's identity, not the one-time code.
  normalize: body => ({ inviteId: body?.inviteId, guestLabel: body?.guestLabel, tier: body?.tier }),
};

// ---------------------------------------------------------------- buyer signoff (CONTROL)
const ACTOR_IDS = { primary: "actor-1", second: "actor-2" };
function buyerCtx(t, overrides = {}) {
  const fixture = createConformanceFixture(t, overrides);
  const ctx = { fixture, store: fixture.store, room: fixture.fixture.roomId, actionCalls: 0 };
  ctx.store.db.exec("CREATE TABLE IF NOT EXISTS replay_matrix_effects (marker TEXT NOT NULL, actor_id TEXT NOT NULL)");
  return ctx;
}
export const buyerSignoffAdapter = {
  name: "buyer-signoff-request",
  async setup(t) { return buyerCtx(t); },
  async setupForeign(t) { return buyerCtx(t, { roomId: "other-room" }); },
  async submit(ctx, { key, payload, actor }) {
    const actorId = ACTOR_IDS[actor];
    try {
      if (key === null) {
        const res = ctx.store.buyerSignoff.request(ctx.room, actorId, { action: "create" }, () => ({}));
        return { status: 200, body: res };
      }
      const input = { requestId: key, action: "create", loopId: payload === "different" ? "loop-different" : "loop-1" };
      const res = ctx.store.buyerSignoff.request(ctx.room, actorId, input, () => {
        ctx.actionCalls += 1;
        ctx.store.db.prepare("INSERT INTO replay_matrix_effects VALUES(?,?)").run(key, actorId);
        return { loopId: input.loopId, marker: key };
      });
      return { status: 200, body: res };
    } catch (error) { return caught(error); }
  },
  async failAttempt(ctx, { key }) {
    try {
      ctx.store.buyerSignoff.request(ctx.room, ACTOR_IDS.primary, { requestId: key, action: "create", loopId: "loop-1" }, () => {
        ctx.store.db.prepare("INSERT INTO replay_matrix_effects VALUES(?,?)").run(key, ACTOR_IDS.primary);
        throw new Error("execute failed before persist");
      });
      return { status: 200 };
    } catch (error) { return { status: error?.status ?? 500, code: error?.code ?? "execute_failed" }; }
  },
  // R6: the effect + journal commit inside one store.transaction, then the
  // "crash" rolls the transaction back — effect and journal both absent.
  async crashAttempt(ctx, { key }) {
    try {
      ctx.store.transaction(() => {
        ctx.store.buyerSignoff.request(ctx.room, ACTOR_IDS.primary, { requestId: key, action: "create", loopId: "loop-1" }, () => {
          ctx.store.db.prepare("INSERT INTO replay_matrix_effects VALUES(?,?)").run(key, ACTOR_IDS.primary);
          return { loopId: "loop-1", marker: key };
        });
        throw new Error("simulated crash between execute and persist");
      });
      return { status: 200 };
    } catch (error) { return { status: 500, code: "simulated_crash" }; }
  },
  async reopen(ctx) {
    ctx.fixture.reopen();
    ctx.store = ctx.fixture.store;
  },
  async effectCount(ctx, { key, actor }) {
    if (!key) return 0;
    return ctx.store.db.prepare("SELECT count(*) n FROM replay_matrix_effects WHERE marker=? AND actor_id=?")
      .get(key, ACTOR_IDS[actor]).n;
  },
  normalize: body => body,
};

// ---------------------------------------------------------------- attention (CONTROL)
function attentionCtx(t, overrides = {}) {
  const fixture = createConformanceFixture(t, overrides);
  const ctx = { fixture, store: fixture.store, room: fixture.fixture.roomId, keys: {} };
  ctx.keys.primary = ctx.store.issueAccessKey(ctx.room, "actor-1");
  ctx.keys.second = ctx.store.issueAccessKey(ctx.room, "actor-2");
  return ctx;
}
const ATT_PREFS = {
  same: { quietStart: 1320, quietEnd: 420, delivery: "immediate", digestHour: null },
  different: { quietStart: 600, quietEnd: 420, delivery: "immediate", digestHour: null },
};
export const attentionAdapter = {
  name: "attention-command",
  async setup(t) { return attentionCtx(t); },
  async setupForeign(t) { return attentionCtx(t, { roomId: "other-room" }); },
  async submit(ctx, { key, payload, actor }) {
    try {
      const request = key === null ? { ...ATT_PREFS.same } : { requestId: key, ...ATT_PREFS[payload] };
      const res = ctx.store.attention.mutate(ctx.keys[actor], ctx.room, request);
      return { status: 200, body: res };
    } catch (error) { return caught(error); }
  },
  async failAttempt(ctx, { key }) {
    try {
      ctx.store.attention.mutate(ctx.keys.primary, ctx.room, { requestId: key, quietStart: 9999, quietEnd: 420, delivery: "immediate", digestHour: null });
      return { status: 200 };
    } catch (error) { return caught(error); }
  },
  async crashAttempt(ctx, { key }) {
    try {
      ctx.store.transaction(() => {
        ctx.store.attention.mutate(ctx.keys.primary, ctx.room, { requestId: key, ...ATT_PREFS.same });
        throw new Error("simulated crash between execute and persist");
      });
      return { status: 200 };
    } catch (error) { return { status: 500, code: "simulated_crash" }; }
  },
  async reopen(ctx) {
    ctx.fixture.reopen();
    ctx.store = ctx.fixture.store;
    ctx.keys.primary = ctx.store.issueAccessKey(ctx.room, "actor-1");
    ctx.keys.second = ctx.store.issueAccessKey(ctx.room, "actor-2");
  },
  async effectCount(ctx, { key, actor }) {
    if (!key) return 0;
    return ctx.store.db.prepare("SELECT count(*) n FROM private_attention_commands WHERE room_id=? AND member_id=? AND request_id=?")
      .get(ctx.room, ACTOR_IDS[actor], key).n;
  },
  // The mutate response wraps the receipt in a live view (evaluatedAt
  // moves); the journaled receipt is the replayed outcome.
  normalize: body => body?.receipt,
};

// ---------------------------------------------------------------- bounty escrow (MONEY)
const ESCROW_ROOM = "room-test";
const ESCROW_FOREIGN_ROOM = "room-foreign";
const LANES = { primary: "id:agent/jill", second: "id:agent/grokbot" };
const ESCROW_CONFLICTS = ["idempotency_key_reused", "idempotency_actor_mismatch"];
const NOW_MS = 1_786_000_000_000;
function bountyStore(file) {
  const db = new DatabaseSync(file);
  const transaction = fn => {
    db.exec("SAVEPOINT replay_matrix");
    try { const out = fn(); db.exec("RELEASE replay_matrix"); return out; }
    catch (error) { db.exec("ROLLBACK TO replay_matrix"); db.exec("RELEASE replay_matrix"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => NOW_MS, allowLegacyStringLanes: true });
  return { db, store, escrow };
}
export const bountyEscrowAdapter = {
  name: "bounty-escrow-fund",
  // PR-3: the escrow store is a real file under TMPDIR scratch (never
  // ":memory:") so R6 can close and reopen it — the idempotency journal
  // must survive the reopen exactly as it survives a process restart.
  async setup(t) {
    const directory = mkdtempSync(join(tmpdir(), "replay-matrix-bounty-"));
    const file = join(directory, "bounty.sqlite");
    const { db, store, escrow } = bountyStore(file);
    escrow.ensureGenesis(ESCROW_ROOM);
    escrow.ensureGenesis(ESCROW_FOREIGN_ROOM);
    if (t && typeof t.after === "function") t.after(() => {
      try { db.close(); } catch { /* already closed by reopen */ }
      rmSync(directory, { recursive: true, force: true });
    });
    return { directory, file, db, store, escrow, room: ESCROW_ROOM, bounties: new Map(), fundCounts: new Map(), keylessCount: 0 };
  },
  async reopen(ctx) {
    ctx.db.close();
    const fresh = bountyStore(ctx.file);
    ctx.db = fresh.db; ctx.store = fresh.store; ctx.escrow = fresh.escrow;
  },
  // R6 (PR-3): an outer savepoint around idemExecute (whose own
  // transaction is a nested savepoint) — throwing after the fund +
  // journal insert and rolling back to the outer savepoint removes both.
  // fundCounts is harness bookkeeping for the thunk's executions, not a
  // persisted effect, so the crashed attempt's increment is restored to
  // keep the counter aligned with the rolled-back database state; the
  // persisted journal is asserted separately via journalCount.
  async crashAttempt(ctx, { key }) {
    const bounty = this.bountyFor(ctx, "primary", key);
    const countKey = `${ctx.room}:primary:${key}`;
    const before = ctx.fundCounts.get(countKey) ?? 0;
    try {
      ctx.db.exec("SAVEPOINT rm_crash");
      ctx.escrow.idemExecute(ctx.room, key, "bounty.fund", 200, () => {
        ctx.fundCounts.set(countKey, (ctx.fundCounts.get(countKey) ?? 0) + 1);
        return ctx.escrow.fundBounty(ctx.room, bounty.bountyId, { funder: LANES.primary });
      }, { callerLane: LANES.primary, bountyId: bounty.bountyId, payload: { amount: 10, bountyId: bounty.bountyId } });
      throw new Error("simulated crash between execute and persist");
    } catch (error) {
      try { ctx.db.exec("ROLLBACK TO rm_crash"); ctx.db.exec("RELEASE rm_crash"); } catch { /* already rolled back */ }
      if (before === 0) ctx.fundCounts.delete(countKey); else ctx.fundCounts.set(countKey, before);
      return { status: 500, code: "simulated_crash" };
    }
  },
  async journalCount(ctx, { key }) {
    if (!key) return 0;
    return ctx.db.prepare("SELECT count(*) n FROM bounty_idempotency WHERE idem_key=?").get(key).n;
  },
  async setupForeign(_t, primary) {
    return { ...primary, room: ESCROW_FOREIGN_ROOM, bounties: new Map() };
  },
  bountyFor(ctx, actor, key) {
    const mapKey = `${actor}:${key}`;
    if (!ctx.bounties.has(mapKey)) {
      const bounty = ctx.escrow.postBounty(ctx.room, {
        poster: LANES[actor], title: "Matrix bounty", criteria: "C", amount: 10,
        deadline: new Date(NOW_MS + 3_600_000).toISOString(),
      }).bounty;
      ctx.bounties.set(mapKey, bounty);
    }
    return ctx.bounties.get(mapKey);
  },
  async submit(ctx, { key, payload, actor }) {
    const lane = LANES[actor];
    try {
      if (key === null) {
        const res = ctx.escrow.idemExecute(ctx.room, null, "bounty.fund", 200,
          () => ({ n: ++ctx.keylessCount }), { callerLane: lane, bountyId: "B-KEYLESS" });
        return { status: res.status, body: res.body };
      }
      const bounty = this.bountyFor(ctx, actor, key);
      const scopePayload = { amount: payload === "different" ? 99 : 10, bountyId: bounty.bountyId };
      const countKey = `${ctx.room}:${actor}:${key}`;
      const res = ctx.escrow.idemExecute(ctx.room, key, "bounty.fund", 200, () => {
        ctx.fundCounts.set(countKey, (ctx.fundCounts.get(countKey) ?? 0) + 1);
        return ctx.escrow.fundBounty(ctx.room, bounty.bountyId, { funder: lane });
      }, { callerLane: lane, bountyId: bounty.bountyId, payload: scopePayload });
      return { status: res.status, body: res.body };
    } catch (error) { return caught(error, ESCROW_CONFLICTS); }
  },
  async failAttempt(ctx, { key }) {
    const bounty = this.bountyFor(ctx, "primary", key);
    try {
      ctx.escrow.idemExecute(ctx.room, key, "bounty.fund", 200,
        () => { throw new Error("execute failed before persist"); },
        { callerLane: LANES.primary, bountyId: bounty.bountyId, payload: { amount: 10, bountyId: bounty.bountyId } });
      return { status: 200 };
    } catch (error) { return { status: 500, code: error?.code ?? "execute_failed" }; }
  },
  async effectCount(ctx, { key, actor }) {
    if (!key) return 0;
    return ctx.fundCounts.get(`${ctx.room}:${actor}:${key}`) ?? 0;
  },
  normalize: body => JSON.parse(JSON.stringify(body ?? null)),
};

// ---------------------------------------------------------------- spend grants (money-adjacent)
function spendCtx(t, overrides = {}) {
  const fixture = createConformanceFixture(t, overrides);
  const store = fixture.store;
  const room = fixture.fixture.roomId;
  return {
    fixture, store, room,
    ownerKey: store.issueAccessKey(room, "owner"),
    actorKey: store.issueAccessKey(room, "actor-1"),
  };
}
export const spendGrantAdapter = {
  name: "spend-grant-issue",
  async setup(t) { return spendCtx(t); },
  async setupForeign(t) { return spendCtx(t, { roomId: "other-room" }); },
  async submit(ctx, { payload, actor }) {
    try {
      if (actor === "second") {
        const res = issueSpendGrantRoute(ctx.store, ctx.actorKey, ctx.room, { agentId: "actor-2", capCents: "100", perTxCapCents: "100" });
        return { status: 201, body: res };
      }
      const res = issueSpendGrantRoute(ctx.store, ctx.ownerKey, ctx.room, {
        agentId: "actor-1", capCents: payload === "different" ? "9000" : "5000", perTxCapCents: "1000",
      });
      return { status: 201, body: res };
    } catch (error) { return caught(error); }
  },
  async failAttempt() { throw new Error("spend-grant R5 is declared n/a — the driver must not call failAttempt"); },
  // R6 (PR-3): issueSpendGrantRoute runs in one store.transaction (the
  // capability edge and the terms row commit together); wrapping it in
  // an outer transaction and throwing before commit rolls both back, so
  // a crashed issue leaves no grant at all and the retry executes once.
  async crashAttempt(ctx) {
    try {
      ctx.store.transaction(() => {
        issueSpendGrantRoute(ctx.store, ctx.ownerKey, ctx.room, { agentId: "actor-1", capCents: "5000", perTxCapCents: "1000" });
        throw new Error("simulated crash between execute and persist");
      });
      return { status: 201 };
    } catch (error) { return { status: 500, code: "simulated_crash" }; }
  },
  async reopen(ctx) {
    ctx.fixture.reopen();
    ctx.store = ctx.fixture.store;
    ctx.ownerKey = ctx.store.issueAccessKey(ctx.room, "owner");
    ctx.actorKey = ctx.store.issueAccessKey(ctx.room, "actor-1");
  },
  async effectCount(ctx) {
    return ctx.store.db.prepare("SELECT count(*) n FROM spend_grant_terms WHERE room_id=? AND agent_id='actor-1'").get(ctx.room).n;
  },
  async currentCap(ctx) {
    return ctx.store.db.prepare("SELECT cap_cents FROM spend_grant_terms WHERE room_id=? AND agent_id='actor-1'").get(ctx.room)?.cap_cents;
  },
  normalize: body => body?.spend ?? body,
};

export const ADAPTERS = Object.freeze({
  1: workClaimCreateAdapter,
  2: workClaimCloseAdapter,
  3: agentInviteAdapter,
  4: guestInviteAdapter,
  5: buyerSignoffAdapter,
  6: attentionAdapter,
  7: bountyEscrowAdapter,
  8: spendGrantAdapter,
});

// PR-3: the adapter each non-control row's R6 scenarios drive. Rows 3, 4,
// 7 and 8 reuse their PR-2 adapters (now reopenable); rows 1-2 use the
// dedicated durable-registry adapters, since the PR-2 in-memory registry
// cannot be reopened or rolled back by construction.
export const R6_ADAPTERS = Object.freeze({
  1: workClaimCreateR6Adapter,
  2: workClaimCloseR6Adapter,
  3: agentInviteAdapter,
  4: guestInviteAdapter,
  7: bountyEscrowAdapter,
  8: spendGrantAdapter,
});
