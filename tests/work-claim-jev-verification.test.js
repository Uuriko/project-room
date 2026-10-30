// D1: a verified claim must not carry a contradictory unqualified Jev
// verdict. The Jev receipt scorer is shadow measurement (never enforced,
// docs in server/jev-receipts.mjs): its full decision belongs in the
// owner-only shadow journal, not on the verification fact (#3546), where
// `jev:{verdict:"request-changes"}` beside `state:"verified"` reads as the
// platform requesting changes on work it stamps verified.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { workOf } from "../server/work-claims.mjs";

const SHA = "c".repeat(64);
const bundle = { artifact: { kind: "text", ref: "room://artifacts/d1", sha256: SHA },
  checks: [{ name: "unit", result: "pass" }],
  criteria: [{ criterion: "A one-line result is delivered", status: "met" }] };
const auth = (id, kind, permissions) => ({ member: { id, kind, permissions } });
const OWNER = auth("owner", "human", ["manage_claims"]);
const WORKER = auth("worker", "agent", ["accept_work", "complete_work"]);
const REVIEWER = auth("reviewer", "agent", ["verify"]);

async function room(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, kind, permissions) => store.command(ownerKey, "commons",
    { id: `add-${id}`, type: "member.added", data: { memberId: id, displayName: id, kind, permissions } });
  add("worker", "agent", ["accept_work", "complete_work"]);
  add("reviewer", "agent", ["verify"]);
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body, extra = {}) => handleWorkClaims({
    req: { method: route === "read" || route === "receipts" ? "GET" : "POST", body },
    res: {}, url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons", auth: extra.auth ?? OWNER,
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
  });
  return { store, call };
}

test("verified claim read carries no jev verdict; the shadow journal keeps the full decision", async t => {
  const { store, call } = await room(t);
  const id = "d1-verified";
  await call("create", null, { id, title: "D1 verified work",
    acceptanceCriteria: ["A one-line result is delivered"], reviewPolicy: "distinct_member" });
  await call("claim", id, {}, { auth: WORKER });
  await call("update", id, { state: "in_progress" }, { auth: WORKER });
  await call("update", id, { state: "delivered", delivery: bundle,
    note: "One-line result: golden path summarised." }, { auth: WORKER });
  await call("review", id, { verdict: "approve", summary: "Bundle verified against criteria" }, { auth: REVIEWER });
  const done = (await call("update", id, { state: "done", note: "Accepted — matches criteria" }, { auth: REVIEWER })).value;
  assert.equal(done.state, "done");
  assert.equal(done.verification.state, "verified");
  assert.ok(done.verification.executedChecks.every(entry => entry.result === "pass"));
  assert.equal("jev" in done.verification, false,
    `verified claim must not carry a jev verdict, got ${JSON.stringify(done.verification.jev)}`);

  const read = (await call("read", id, undefined, { auth: REVIEWER })).value;
  assert.equal(read.verification.state, "verified");
  assert.equal("jev" in read.verification, false,
    `claim read must not carry a jev verdict, got ${JSON.stringify(read.verification.jev)}`);

  // Not hidden: the scored shadow decision is still journaled in full,
  // readable only through the owner-only shadow surface.
  const entry = store.jevShadow.list({ roomId: "commons", gate: "receipt" }).find(e => e.subject === id);
  assert.ok(entry, "shadow receipt decision must still be journaled");
  assert.ok(["accept", "request-changes", "escalate"].includes(entry.decision));
  assert.ok(typeof entry.score === "number");
  assert.ok(Array.isArray(entry.signals) && entry.signals.length > 0);
});

test("a stored verification fact carrying a legacy jev entry reads back without it", async t => {
  const { call } = await room(t);
  const id = "d1-legacy";
  await call("create", null, { id, title: "D1 legacy work",
    acceptanceCriteria: ["A one-line result is delivered"], reviewPolicy: "distinct_member" });
  await call("claim", id, {}, { auth: WORKER });
  await call("update", id, { state: "in_progress" }, { auth: WORKER });
  await call("update", id, { state: "delivered", delivery: bundle }, { auth: WORKER });
  await call("review", id, { verdict: "approve", summary: "ok" }, { auth: REVIEWER });
  const done = (await call("update", id, { state: "done", note: "Accepted" }, { auth: REVIEWER })).value;
  // Simulate a fact stored before the cure, with jev frozen onto it.
  const legacy = workOf({ ...done,
    verification: { ...done.verification, jev: { verdict: "request-changes", score: 0.4225 } } });
  assert.equal(legacy.verification.state, "verified");
  assert.equal("jev" in legacy.verification, false,
    `legacy jev must be dropped on canonicalisation, got ${JSON.stringify(legacy.verification.jev)}`);
});
