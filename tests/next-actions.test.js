// RC-2026-09-25-911: ranked per-agent next actions.
// Test-audit gate (repo AGENTS.md): each test names (1) the observable
// behavior it protects, (2) the credible regression that makes it fail, (3)
// why existing coverage doesn't catch it. New module — no existing coverage.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { buildNextActions, capabilityOverlap, NextActionsError, nextActionsSchema } from "../server/next-actions.mjs";

const HOUR = 3600000;
const AT = "2026-09-25T20:30:00.000Z";
const AT_MS = Date.parse(AT);
const AGENT = { id: "agent-jill" };

const richSnapshots = () => ({
  workClaims: [{ id: "wc1", title: "Fix thing", state: "claimed", leaseExpiresAtMs: AT_MS + 60 * 60000 }],
  bounties: [
    { bountyId: "b1", title: "Write python linter plugin", criteria: "python ast rules", amountMillis: 5000, deadlineMs: AT_MS + 3 * 24 * HOUR },
    { bountyId: "b2", title: "Unrelated docs review", criteria: "proofread handbook", amountMillis: 1000, deadlineMs: null },
  ],
  newcomers: [{ memberId: "agent-new", displayName: "New", joinedAtMs: AT_MS - 2 * HOUR }],
  card: { capabilities: ["python", "linting", "ast"], skills: [], description: "a helpful agent" },
});
const build = (overrides = {}) => buildNextActions({
  agent: AGENT, snapshots: richSnapshots(), now: AT, roomId: "commons", ...overrides,
});

// (1) Wire contract: the response shape agents parse. (2) Regression: a field
// dropped/renamed breaks every consumer silently. (3) New module, no coverage.
test("next-actions response carries the room-next-actions/1 contract shape", () => {
  const out = build();
  assert.equal(out.schema, "room-next-actions/1");
  assert.equal(out.agentId, "agent-jill");
  assert.equal(out.evaluatedAt, AT);
  assert.equal(out.personalised, true);
  assert.ok(Array.isArray(out.items));
  assert.equal(typeof out.dismissedCount, "number");
  assert.equal(typeof out.suppressedCount, "number");
  assert.equal(out.limits.maxItems, 50);
  for (const item of out.items) {
    assert.match(item.id, /^na_[0-9a-f]{16}$/);
    assert.equal(typeof item.kind, "string");
    assert.equal(typeof item.title, "string");
    assert.equal(typeof item.reason, "string");
    assert.equal(typeof item.scoreReason, "string");
    assert.equal(typeof item.score, "number");
    assert.ok(["high", "normal", "low"].includes(item.urgency));
    assert.ok(typeof item.dismissable === "boolean");
  }
});

// (1) The scoring table is the product: heartbeat-due > bounty-match >
// newcomer-welcome > profile-gap. (2) Regression: a scoring constant drift
// silently reorders the list. (3) New module.
test("next-actions ranks heartbeat-due above bounty-match above newcomer-welcome", () => {
  const out = build();
  const kinds = out.items.map(i => i.kind);
  assert.ok(kinds.indexOf("heartbeat-due") < kinds.indexOf("bounty-match"), "lease renewal outranks bounty match");
  assert.ok(kinds.indexOf("bounty-match") < kinds.indexOf("newcomer-welcome"), "bounty match outranks welcome");
  const hb = out.items.find(i => i.kind === "heartbeat-due");
  assert.equal(hb.urgency, "high");
  assert.equal(hb.score, 0.95);
});

// (1) Every item explains itself: reason + scoreReason are the trust contract.
// (2) Regression: a new kind lands without explanation and clients can't show
// why. (3) New module.
test("every next-action item carries reason and scoreReason", () => {
  for (const item of build().items) {
    assert.ok(item.reason.length > 0, `${item.kind} has a reason`);
    assert.ok(item.scoreReason.length > 0, `${item.kind} has a scoreReason`);
  }
});

// (1) Frozen outputs: identical inputs produce byte-identical responses.
// (2) Regression: a Date.now() leak or unstable sort breaks caching and the
// dismiss-id stability contract. (3) New module.
test("next-actions build is deterministic across runs", () => {
  const a = JSON.stringify(build());
  const b = JSON.stringify(build());
  assert.equal(a, b);
  // Stable ids: the same underlying object gets the same id next hour.
  const first = build().items.find(i => i.kind === "heartbeat-due").id;
  const second = buildNextActions({ agent: AGENT, snapshots: richSnapshots(), now: "2026-09-25T21:29:00.000Z", roomId: "commons" })
    .items.find(i => i.kind === "heartbeat-due").id;
  assert.equal(first, second);
});

// (1) Cold start: no card means personalised false, still useful items.
// (2) Regression: personalised true with no card, or an empty list that makes
// newcomers think the room is dead. (3) New module.
test("cold start yields personalised false and still-useful items", () => {
  const out = build({ snapshots: { ...richSnapshots(), card: null } });
  assert.equal(out.personalised, false);
  assert.ok(out.items.some(i => i.kind === "bounty-match"), "generic bounty matches still listed");
  assert.ok(out.items.some(i => i.kind === "profile-gap"), "profile-gap prompts the missing card");
});

// (1) Never an unexplained empty list: all-clear when nothing qualifies.
// (2) Regression: empty items array reads as "room is dead". (3) New module.
test("all-clear item appears when nothing else qualifies", () => {
  const out = build({
    snapshots: {
      workClaims: [], bounties: [], newcomers: [],
      card: { capabilities: ["x"], skills: [], description: "done" },
    },
    suppressions: [{ kind: "claim-review" }, { kind: "receipt-verify" }, { kind: "poll-closing" }, { kind: "stale-thread" }],
  });
  const clear = out.items.find(i => i.kind === "all-clear");
  assert.ok(clear, "all-clear present");
  assert.equal(clear.score, 0);
  assert.equal(clear.action, null);
});

// (1) Dormant kinds surface honestly with null action — never a fabricated
// path. (2) Regression: a dormancy slips through with an invented route and
// agents 404 against it. (3) New module.
test("dormant kinds carry action null, never a fabricated route", () => {
  const dormant = build().items.filter(i => ["claim-review", "receipt-verify", "poll-closing", "stale-thread"].includes(i.kind));
  assert.equal(dormant.length, 4);
  for (const item of dormant) {
    assert.equal(item.action, null, `${item.kind} has no action`);
    assert.match(item.reason, /dormant:/, `${item.kind} names its dormancy`);
  }
});

// (1) Every emitted action.api resolves to a real route — the zero-lookup-tax
// claim is falsifiable. (2) Regression: a route renamed/removed while the
// builder still emits it. (3) New module. The route table is an independent
// copy of the room's route surface; a mismatch here names the contract change.
test("every emitted action.api resolves to a real room route", () => {
  const routes = [
    ["POST", /^\/api\/rooms\/[^/]+\/work-claims\/[^/]+\/renew$/],
    ["POST", /^\/api\/rooms\/[^/]+\/bounties\/[^/]+\/claim$/],
    ["POST", /^\/api\/rooms\/[^/]+\/commands$/],
    ["POST", /^\/api\/agent-directory\/cards$/],
  ];
  for (const item of build().items) {
    if (item.action === null) continue;
    const { method, path } = item.action.api;
    assert.ok(routes.some(([m, rx]) => m === method && rx.test(path)),
      `${item.kind} emits unknown route ${method} ${path}`);
  }
});

// (1) Fail-closed parsing: malformed inputs throw NextActionsError.
// (2) Regression: silent acceptance of bad snapshots producing garbage ranks.
// (3) New module.
test("buildNextActions rejects malformed inputs with NextActionsError", () => {
  assert.throws(() => buildNextActions({ agent: {}, snapshots: {}, now: AT }), NextActionsError);
  assert.throws(() => buildNextActions({ agent: AGENT, snapshots: null, now: AT }), NextActionsError);
  assert.throws(() => buildNextActions({ agent: AGENT, snapshots: {}, now: "not-a-date" }), NextActionsError);
  assert.throws(() => buildNextActions({ agent: AGENT, snapshots: {}, dismissals: [{}], now: AT }), NextActionsError);
});

// (1) capabilityOverlap is explainable keyword overlap, no ML.
// (2) Regression: a tokenizer change silently re-ranks every bounty.
// (3) New module.
test("capabilityOverlap scores token overlap deterministically", () => {
  const card = { capabilities: ["python", "linting"] };
  assert.equal(capabilityOverlap(card, { title: "x", criteria: "" }), 0);
  const full = capabilityOverlap(card, { title: "python linting", criteria: "" });
  assert.equal(full, 1);
  const partial = capabilityOverlap(card, { title: "python database", criteria: "" });
  assert.equal(partial, 0.5);
});

// --- Store-backed tests: auth boundary, private tables, schema contract. ---

function storeFixture(t, actor = "owner") {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); });
  const token = f.keys[actor];
  const na = f.store.nextActions;
  return { f, token, na };
}

// (1) Dismiss removes the item from the caller's list and survives re-rank;
// re-dismiss is idempotent. (2) Regression: dismiss writes the wrong member's
// row, or re-dismiss 500s. (3) New surface.
test("dismiss hides the item for the caller and is idempotent on retry", t => {
  const { token, na } = storeFixture(t);
  const first = na.list(token, "commons", { limit: 50 });
  const target = first.items.find(i => i.kind === "profile-gap" || i.kind === "bounty-match");
  assert.ok(target, "fixture yields a live dismissable item");
  const dismissed = na.dismiss(token, "commons", target.id, { reason: "handling it" });
  assert.equal(dismissed.dismissed, true);
  assert.equal(dismissed.duplicate, false);
  const second = na.list(token, "commons", { limit: 50 });
  assert.ok(!second.items.some(i => i.id === target.id), "dismissed item gone after re-rank");
  assert.equal(second.dismissedCount, 1);
  const retry = na.dismiss(token, "commons", target.id, {});
  assert.equal(retry.duplicate, true, "re-dismiss is idempotent");
  // Unknown ids 404, not silent success.
  assert.throws(() => na.dismiss(token, "commons", "na_0000000000000000", {}), { code: "unknown_action" });
});

// (1) Owner boundary: one member's dismissals/suppressions never leak to
// another member. (2) Regression: a missing member_id in a query scope leaks
// private state across members. (3) New surface.
test("dismissals and suppressions are private per member", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); });
  const ownerToken = f.keys.owner, guestToken = f.keys.guest, na = f.store.nextActions;
  // Same store, different members: owner dismisses a SHARED-id item
  // (dormant kinds key on the kind, not the viewer), guest unaffected.
  const sharedItem = na.list(ownerToken, "commons", { limit: 50 }).items.find(i => i.kind === "claim-review");
  assert.ok(sharedItem, "fixture yields a shared claim-review item");
  na.dismiss(ownerToken, "commons", sharedItem.id, {});
  na.putSuppressions(ownerToken, "commons", { suppressions: [{ kind: "poll-closing" }] });
  const guestList = na.list(guestToken, "commons", { limit: 50 });
  assert.ok(guestList.items.some(i => i.id === sharedItem.id), "guest still sees the owner's dismissed shared item");
  assert.ok(guestList.items.some(i => i.kind === "poll-closing"), "guest still sees suppressed-for-owner kind");
  assert.equal(guestList.dismissedCount, 0);
  assert.equal(guestList.suppressedCount, 0);
});

// (1) Suppressions are replace-all: one PUT swaps the whole set.
// (2) Regression: merge semantics silently adopted, so a removed kind stays
// suppressed. (3) New surface.
test("suppressions replace the whole set on every PUT", t => {
  const { token, na } = storeFixture(t);
  na.putSuppressions(token, "commons", { suppressions: [{ kind: "bounty-match" }, { kind: "newcomer-welcome" }] });
  assert.equal(na.list(token, "commons", { limit: 50 }).suppressedCount, 2);
  na.putSuppressions(token, "commons", { suppressions: [{ kind: "bounty-match" }] });
  const after = na.list(token, "commons", { limit: 50 });
  assert.equal(after.suppressedCount, 1);
  assert.ok(after.items.some(i => i.kind === "newcomer-welcome" || i.kind === "all-clear" || i.kind === "profile-gap"),
    "removed kind is live again");
  na.putSuppressions(token, "commons", { suppressions: [] });
  assert.equal(na.list(token, "commons", { limit: 50 }).suppressedCount, 0);
});

// (1) Dismissal read-back is auditability: newest-first, lapsed rows included
// with active flags. (2) Regression: lapsed rows hidden, or rows leak across
// members. (3) New surface.
test("dismissal read-back includes lapsed rows newest-first with active flags", t => {
  const { f, token, na } = storeFixture(t);
  const first = na.list(token, "commons", { limit: 50 }).items[0];
  na.dismiss(token, "commons", first.id, { expiresInDays: 1, reason: "later" });
  // A lapsed row inserted directly: read-back must surface it as inactive.
  const me = f.store.authenticate(token, "commons", null).member.id;
  f.store.db.prepare(`INSERT INTO private_next_action_dismissals
    (room_id,member_id,action_id,dismissed_at,expires_at,reason) VALUES(?,?,?,?,?,?)`)
    .run("commons", me, "na_deadbeefdeadbeef", Date.now() - 2 * 24 * HOUR, Date.now() - 24 * HOUR, "old");
  const rows = na.readDismissals(token, "commons").dismissals;
  assert.equal(rows.length, 2);
  assert.ok(rows[0].dismissedAt >= rows[1].dismissedAt, "newest first");
  assert.equal(rows[0].active, true);
  assert.equal(rows[1].active, false);
  assert.equal(rows[1].actionId, "na_deadbeefdeadbeef");
});

// (1) Auth boundary: bad tokens get 401 on every method.
// (2) Regression: a new method skips authenticate. (3) New surface.
test("next-actions methods reject unauthenticated callers with 401", t => {
  const { na } = storeFixture(t);
  for (const call of [
    () => na.list("bad-token", "commons"),
    () => na.dismiss("bad-token", "commons", "na_x"),
    () => na.getSuppressions("bad-token", "commons"),
    () => na.putSuppressions("bad-token", "commons", { suppressions: [] }),
    () => na.readDismissals("bad-token", "commons"),
  ]) {
    assert.throws(call, { status: 401 });
  }
});

// (1) Input validation on the store-backed methods: limit bounds, actionId
// shape, suppression kind shape. (2) Regression: unbounded limit or 64KB
// kind strings accepted. (3) New surface.
test("store-backed next-actions validate their inputs", t => {
  const { token, na } = storeFixture(t);
  assert.throws(() => na.list(token, "commons", { limit: 0 }), { status: 422 });
  assert.throws(() => na.list(token, "commons", { limit: 51 }), { status: 422 });
  assert.throws(() => na.dismiss(token, "commons", "", {}), { status: 422 });
  assert.throws(() => na.putSuppressions(token, "commons", { suppressions: [{ kind: "" }] }), { status: 422 });
  assert.throws(() => na.putSuppressions(token, "commons", { suppressions: "bounty-match" }), { status: 422 });
});

// (1) Schema contract: the next-actions schema is purely additive — it applies
// idempotently and never bumps the schema version. (2) Regression: a schema
// edit that requires migration, or a read-only path that migrates.
// (3) New surface.
test("next-actions schema applies additively and verifies byte-exact", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); });
  assert.equal(f.store.nextActions.verifySchema(), true, "schema present after initialize");
  assert.doesNotThrow(() => f.store.nextActions.verifySchema(), "byte-exact re-verify is stable");
  assert.doesNotThrow(() => f.store.db.exec(nextActionsSchema), "idempotent re-apply");
});
