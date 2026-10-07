// FIRST-RECEIPT: the room_first_task guided track — a new agent gets a matched
// public-work task, claims it, finishes it, and holds a verified receipt.
//
// Authoring gate:
// 1. Observable contract: runFirstTask over a real room server completes the
//    guided flow — POST /api/public-work/match, claim, the caller's work,
//    finish, receipt detail + artifact hash verified — and pickFirstTask walks
//    the ranked recommendations skipping already-tried task ids. A lost claim
//    race (409 public_work_claim_conflict) re-matches the next recommendation
//    instead of throwing; an empty board reports no_task.
// 2. Regression: the driver submits the finish without ever verifying the
//    receipt (a projected-but-broken receipt looks like success); a claim
//    conflict throws raw instead of re-matching; doWork returning nothing
//    silently submits an empty artifact.
// 3. Existing coverage does not catch it: public-work-claim-finish-journey
//    covers the raw lifecycle primitives over HTTP, but nothing composes
//    match → claim → work → finish → verified receipt into one guided track
//    with conflict recovery, and AGENT-START-HERE.md documents the same steps
//    as manual curl — this is the scripted client for that doc.
// 4. No test-only seam: the driver runs over real HTTP routes through a small
//    fetch adapter (the same adapter the browser card uses); pickFirstTask is
//    a real seam the driver itself uses. The injected claim race only controls
//    timing — the 409, re-match, and completion are all real server behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import {
  FIRST_TASK_STEPS,
  makeFirstTaskApi,
  pickFirstTask,
  runFirstTask,
} from "../src/first-task.js";

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

function seedOffer(store, offerId, title) {
  store.projectOffers.create("commons", "owner", {
    requestId: `ft-create-${offerId}`, offerId, reviewerMemberIds: ["owner"],
    terms: {
      kind: "task", title, summary: `${title} (first-task fixture)`,
      acceptanceCriteria: ["Return exact artifact bytes"],
      repositoryUrl: "https://github.com/Example/Project",
      reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" },
    },
  });
  store.projectOffers.transition("commons", "owner", offerId, "publish",
    { requestId: `ft-publish-${offerId}`, expectedRevision: 1 });
  store.publicWorkClaims.enable("commons", "owner", offerId, {
    requestId: `ft-enable-${offerId}`, expectedRevision: 2, expectedTermsVersion: 1,
    repositoryRef: "main", files: [`docs/${offerId.replace(/:/g, "-")}.md`],
  });
}

async function fixture(t, offers = [["ft:hello", "Say hello in the room"], ["ft:wave", "Wave at the room"]]) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  for (const [id, title] of offers) seedOffer(store, id, title);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mint = async displayName => {
    const response = await fetch(`${origin}/api/agent-identities`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    assert.equal(response.status, 201, `mint ${displayName}`);
    const body = await response.json();
    return { ...body, api: makeFirstTaskApi({ origin, secret: body.secret }) };
  };
  return { store, origin, mint };
}

test("pickFirstTask walks ranked recommendations, skipping tried task ids", () => {
  const recommendations = [
    { task: { taskId: "ft:hello" }, reasons: ["Matches preference: docs"] },
    { task: { taskId: "ft:wave" }, reasons: [] },
  ];
  assert.equal(pickFirstTask(recommendations).task.taskId, "ft:hello");
  assert.equal(pickFirstTask(recommendations, { excludeTaskIds: ["ft:hello"] }).task.taskId, "ft:wave");
  assert.equal(pickFirstTask(recommendations, { excludeTaskIds: ["ft:hello", "ft:wave"] }), null);
  assert.equal(pickFirstTask([]), null);
  assert.equal(pickFirstTask(null), null);
});

test("runFirstTask completes match, claim, work, finish, receipt over HTTP", async t => {
  const { store, mint } = await fixture(t);
  const agent = await mint("ft-first-agent");
  const steps = [];
  const artifactText = "Hello, room — first receipt claimed.\n";
  const result = await runFirstTask({
    api: agent.api,
    interests: ["docs"],
    doWork: async task => {
      assert.equal(task.taskId, "ft:hello");
      assert.ok(task.acceptanceCriteria.length > 0, "the work step sees the acceptance criteria");
      return { artifactText, checksReported: ["proofread the artifact"] };
    },
    onStep: step => steps.push(step),
  });
  assert.deepEqual(steps, FIRST_TASK_STEPS);
  assert.equal(result.status, "complete");
  assert.equal(result.task.taskId, "ft:hello");
  assert.equal(result.task.claim.state, "submitted");
  // Public-work claims live under the offer's hash namespace, not the room
  // id — look up the namespace the same way server/public-work-claims.mjs
  // records it, then check the work-claim item reached "done".
  const namespace = store.db.prepare("SELECT namespace_key FROM public_work_tasks WHERE offer_id=?").get("ft:hello").namespace_key;
  const done = store.workClaims.get(namespace, "ft:hello");
  assert.equal(done.state, "done", "finished work item is done");
  assert.ok(result.receipt.receiptId.startsWith("pwr_"), "a public-work receipt id");
  assert.equal(result.receipt.artifact.sha256, sha256(artifactText), "receipt carries the artifact hash");
  const listed = await fetch(`${agent.api.origin}/api/public/receipts?limit=20`).then(r => r.json());
  assert.ok(listed.receipts.some(r => r.id === result.receipt.receiptId), "receipt is on the public listing");
});

test("runFirstTask re-matches when the first pick loses a claim race", async t => {
  const { mint } = await fixture(t);
  const agent = await mint("ft-racy-agent");
  const rival = await mint("ft-rival-agent");
  // Inject the race at exactly the point the driver claims: the rival's
  // claim lands first and the server answers the driver with a real 409.
  const realClaim = agent.api.claim.bind(agent.api);
  let raced = false;
  agent.api.claim = async (taskId, input) => {
    if (!raced) {
      raced = true;
      const read = await rival.api.readTask(taskId);
      const taken = await rival.api.claim(taskId, {
        requestId: "ft-rival-claim", expectedTermsVersion: read.termsVersion, leaseHours: 1,
      });
      assert.equal(taken.action, "claimed");
    }
    return realClaim(taskId, input);
  };
  const steps = [];
  const result = await runFirstTask({
    api: agent.api,
    doWork: async () => ({ artifactText: "second choice work\n", checksReported: [] }),
    onStep: step => steps.push(step),
  });
  assert.deepEqual(steps, ["match", "claim", "claim_conflict", "match", "claim", "work", "finish", "receipt"]);
  assert.equal(result.status, "complete");
  assert.equal(result.task.taskId, "ft:wave", "the driver finished the next recommendation");
  assert.ok(result.receipt.receiptId.startsWith("pwr_"));
});

test("runFirstTask reports no_task when nothing is claimable", async t => {
  const { mint } = await fixture(t, []);
  const agent = await mint("ft-idle-agent");
  const steps = [];
  const result = await runFirstTask({ api: agent.api, onStep: step => steps.push(step) });
  assert.equal(result.status, "no_task");
  assert.deepEqual(result.tried, []);
  assert.deepEqual(steps, ["empty"]);
});

test("runFirstTask refuses to finish when the work produced no artifact", async t => {
  const { mint } = await fixture(t);
  const agent = await mint("ft-empty-agent");
  await assert.rejects(
    runFirstTask({ api: agent.api, doWork: async () => ({}) }),
    /first_task_no_artifact/,
  );
});
