// WAVE-500 guild-2 walk-12: literal fresh-agent walk of /SKILL.md steps 1-2.
//
// The skill text itself (deploy/agent-discovery.mjs skillMd) is under Dot's
// active claim jdot-agent-onboarding-docs-20261010, so this file does NOT
// touch it. Instead it locks the TRUE server contracts the skill's steps 1-2
// rely on, as verified against a seeded local server:
//
//   DOC BUG 1 (step 2A claim handoff): the skill says "the claim response
//   gives you taskId, termsVersion, and generation". Reality: the claim
//   envelope is { action, task: { taskId, termsVersion, claim: { generation
//   } } }. A literal follow takes the flat fields (all undefined) and the
//   step-3 finish 422s "Unexpected or missing fields". Reproduced: literal
//   finish -> 422, nested finish -> 200 + receipt.
//   DOC BUG 2 (step 2A contention): the skill says "If claiming returns 409,
//   someone else holds the task". The taught flow (match + autoClaim) never
//   409s: a held task yields 200 with claim:null and empty recommendations.
//   DOC BUG 3 (step 2A recommendation): the skill says recommendations carry
//   "taskId, title, termsVersion, and claim state" flat. Reality: those live
//   nested at rec.task.taskId / rec.task.title / rec.task.termsVersion /
//   rec.task.claim.state; the recommendation envelope is { task, reasons }.
//
// When the skill text is corrected, these tests already describe the
// corrected contract — no test change needed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { skillMd } from "../deploy/agent-discovery.mjs";

function seed(store, tag) {
  store.projectOffers.create("commons", "owner", { requestId: `${tag}-create`, offerId: `${tag}-task`,
    reviewerMemberIds: ["owner"],
    terms: { kind: "task", title: "Seeded volunteer task", summary: "onboarding walk fixture",
      acceptanceCriteria: ["One paragraph"], repositoryUrl: "https://github.com/Example/Project",
      reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
  store.projectOffers.transition("commons", "owner", `${tag}-task`, "publish",
    { requestId: `${tag}-publish`, expectedRevision: 1 });
  store.publicWorkClaims.enable("commons", "owner", `${tag}-task`, { requestId: `${tag}-enable`,
    expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["docs/X.md"] });
  store.projectOffers.create("commons", "owner", { requestId: `${tag}-c2`, offerId: `${tag}-offer`,
    reviewerMemberIds: ["owner"],
    terms: { kind: "task", title: "Seeded paid offer", summary: "onboarding walk fixture",
      acceptanceCriteria: ["Ship it"], repositoryUrl: "https://github.com/Example/Project",
      reward: { kind: "cash", unit: "USD", amountMinor: "5000", terms: "Owner tap required." },
      approvalPolicy: { mode: "human" } } });
  store.projectOffers.transition("commons", "owner", `${tag}-offer`, "publish",
    { requestId: `${tag}-c2p`, expectedRevision: 1 });
}

async function fixture(t, tag) {
  const dir = mkdtempSync(join(tmpdir(), "room-onboarding-walk-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  seed(store, tag);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { secret, body } = {}) => {
    const response = await fetch(origin + path, { method, headers: { "User-Agent": "project-room-agent", "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* markdown */ }
    return { status: response.status, json: parsed, text, ctype: response.headers.get("content-type") };
  };
  return { call };
}

// Skill step 1: POST /api/agent-identities { displayName } mints an identity
// returning the three things the skill says to save.
test("step 1: identity mint returns secret, identityId and privateKey", async t => {
  const f = await fixture(t, "s1");
  const r = await f.call("POST", "/api/agent-identities", { body: { displayName: "Walk Agent S1" } });
  assert.equal(r.status, 201, JSON.stringify(r.json ?? r.text).slice(0, 200));
  for (const key of ["secret", "identityId", "privateKey"]) {
    assert.equal(typeof r.json[key], "string", `mint must return a saved ${key}`);
    assert.ok(r.json[key].length > 0, `minted ${key} is non-empty`);
  }
});

// Skill step 2A (anonymous): recommendations carry the task nested, not flat.
test("step 2A: anonymous match returns task nested under rec.task with claim state", async t => {
  const f = await fixture(t, "s2a");
  const r = await f.call("POST", "/api/public-work/match", { body: { interests: ["docs"], limit: 3 } });
  assert.equal(r.status, 200);
  assert.ok(r.json.recommendations.length > 0, "seeded task is recommended");
  const rec = r.json.recommendations[0];
  assert.equal(rec.taskId, undefined, "taskId is not flat on the recommendation (doc bug 3)");
  assert.equal(typeof rec.task.taskId, "string");
  assert.equal(typeof rec.task.title, "string");
  assert.ok(rec.task.termsVersion !== undefined, "rec.task.termsVersion present");
  assert.ok(rec.task.claim && typeof rec.task.claim.state === "string", "rec.task.claim.state present");
});

// Skill step 2A (claim): the taught autoClaim flow's envelope is nested.
// The flat taskId/termsVersion/generation the skill names do not exist;
// the literal follow 422s, the nested follow finishes.
test("step 2A: autoClaim envelope is nested; flat fields are absent", async t => {
  const f = await fixture(t, "s2c");
  const minted = await f.call("POST", "/api/agent-identities", { body: { displayName: "Walk Agent Claim" } });
  const secret = minted.json.secret;
  const r = await f.call("POST", "/api/public-work/match",
    { secret, body: { requestId: "WALK-CLAIM-1", autoClaim: true, interests: ["docs"], leaseHours: 1 } });
  assert.equal(r.status, 200);
  const claim = r.json.claim;
  assert.ok(claim, "autoClaim returns a claim");
  assert.equal(claim.action, "claimed");
  // DOC BUG 1: the skill promises these flat on the claim response.
  assert.equal(claim.taskId, undefined, "flat claim.taskId absent (skill text is wrong)");
  assert.equal(claim.termsVersion, undefined, "flat claim.termsVersion absent (skill text is wrong)");
  assert.equal(claim.generation, undefined, "flat claim.generation absent (skill text is wrong)");
  // The true contract:
  assert.equal(typeof claim.task.taskId, "string");
  assert.ok(claim.task.termsVersion !== undefined);
  assert.ok(Number.isInteger(claim.task.claim.generation), "generation lives at claim.task.claim.generation");
});

test("step 2A->3: literal-follow finish 422s; nested finish submits with receipt", async t => {
  const f = await fixture(t, "s23");
  const minted = await f.call("POST", "/api/agent-identities", { body: { displayName: "Walk Agent Finish" } });
  const secret = minted.json.secret;
  const r = await f.call("POST", "/api/public-work/match",
    { secret, body: { requestId: "WALK-FIN-1", autoClaim: true, interests: ["docs"], leaseHours: 1 } });
  const flat = r.json.claim;
  const taskId = flat.task.taskId;
  const finishPath = `/api/public-work/tasks/${encodeURIComponent(taskId)}/finish`;
  // Literal follow of the skill text: flat fields -> 422.
  const literal = await f.call("POST", finishPath, { secret,
    body: { requestId: "WALK-FIN-LIT", expectedTermsVersion: flat.termsVersion, generation: flat.generation,
      artifactText: "work done.", checksReported: ["walk"] } });
  assert.equal(literal.status, 422, "flat fields from the skill text do not satisfy finish");
  // True contract: nested fields -> submitted with receipt.
  const nested = await f.call("POST", finishPath, { secret,
    body: { requestId: "WALK-FIN-OK", expectedTermsVersion: flat.task.termsVersion,
      generation: flat.task.claim.generation, artifactText: "work done.", checksReported: ["walk"] } });
  assert.equal(nested.status, 200, JSON.stringify(nested.json ?? nested.text).slice(0, 200));
  assert.equal(nested.json.action, "submitted");
  assert.ok(nested.json.receipt && nested.json.receipt.receiptId, "finish returns a receipt");
});

// Skill step 2A contention: the taught flow never 409s; a held task yields
// 200 with claim:null (the skill's 409 sentence describes a different route).
test("step 2A: contended autoClaim returns 200 with claim null, not 409", async t => {
  const f = await fixture(t, "s2x");
  const a = await f.call("POST", "/api/agent-identities", { body: { displayName: "Walk Agent Holder" } });
  await f.call("POST", "/api/public-work/match",
    { secret: a.json.secret, body: { requestId: "WALK-X-1", autoClaim: true, interests: ["docs"], leaseHours: 1 } });
  const b = await f.call("POST", "/api/agent-identities", { body: { displayName: "Walk Agent Late" } });
  const r = await f.call("POST", "/api/public-work/match",
    { secret: b.json.secret, body: { requestId: "WALK-X-2", autoClaim: true, interests: ["docs"], leaseHours: 1 } });
  assert.equal(r.status, 200, "no 409 on the taught match+autoClaim flow");
  assert.equal(r.json.claim, null, "held task surfaces as claim:null");
});

// Skill step 2B: offers list and per-offer brief.md.
test("step 2B: project-offers list and brief.md", async t => {
  const f = await fixture(t, "s2b");
  const list = await f.call("GET", "/api/project-offers");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.offers) && list.json.offers.length > 0, "offers listed");
  const offerId = list.json.offers.find(o => (o.id ?? o.offerId) === "s2b-offer")?.id
    ?? list.json.offers[0].id ?? list.json.offers[0].offerId;
  const brief = await f.call("GET", `/api/project-offers/${offerId}/brief.md`);
  assert.equal(brief.status, 200, "brief.md exists for a published offer");
  assert.ok((brief.ctype ?? "").includes("markdown"), "brief.md is served as markdown");
  assert.match(brief.text, /acceptance/i, "brief carries acceptance criteria");
});

// The skill's steps 1-2 name real routes (guard against doc/route drift).
test("skill text names the real step 1-2 routes", () => {
  const skill = skillMd();
  assert.match(skill, /POST .*\/api\/agent-identities/, "step 1 names POST /api/agent-identities");
  assert.match(skill, /POST .*\/api\/public-work\/match/, "step 2A names POST /api/public-work/match");
  assert.match(skill, /GET .*\/api\/project-offers\b/, "step 2B names GET /api/project-offers");
  assert.match(skill, /\/api\/project-offers\/\{offerId\}\/brief\.md/, "step 2B names the brief.md route");
});
