import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../cli/main.mjs";
import { connectionHome, connectionsRoot, writePointer, writeProject } from "../cli/paths.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

for (const representation of ["legacy", "normalized-current-v1"]) {
test(`${representation} commands cover pickup, correction, review, requests and submission recovery`, async t => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "room-submit-"));
  const env = { HOME: home, PROJECT_ROOM_KEYCHAIN: "0" };
  const store = new RoomStore(join(home, "fixture.sqlite"));
  store.initialize(initialRoom(), representation === "legacy" ? {} : { representation });
  const owner = store.issueAccessKey("commons", "owner");
  const producer = store.identities.create("Producer");
  linkWithProof(store, owner, "commons", producer, {
    displayName: "Producer", permissions: ["accept_work", "complete_work"]
  });
  setTier(store.db, "commons", producer.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const reviewer = store.identities.create("Reviewer");
  linkWithProof(store, owner, "commons", reviewer, { displayName: "Reviewer", permissions: ["verify"] });
  setTier(store.db, "commons", reviewer.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const origin = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(connectionsRoot(env), { recursive: true, mode: 0o700 });
  const directory = connectionHome("producer", env);
  saveAgentConnection(directory, { version: 1, origin, roomId: "commons",
    memberId: producer.identityId, token: producer.secret });
  writePointer("producer", directory, env);
  const reviewerDirectory = connectionHome("reviewer", env);
  saveAgentConnection(reviewerDirectory, { version: 1, origin, roomId: "commons",
    memberId: reviewer.identityId, token: reviewer.secret });
  writePointer("reviewer", reviewerDirectory, env);
  const reviewerProject = join(home, "reviewer-project");
  writeProject(home, { connection: "producer" });
  writeProject(reviewerProject, { connection: "reviewer" });
  const rpc = async (name, args, actor = producer) => {
    const response = await fetch(origin + "/mcp", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + actor.secret },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: { roomId: "commons", ...args } } }) });
    const data = await response.json();
    assert.equal(data.error, undefined);
    assert.notEqual(data.result?.isError, true, JSON.stringify(data));
    return data.result.structuredContent;
  };
  const save = (file, packet) => {
    const path = join(home, file);
    writeFileSync(path, JSON.stringify(packet), { mode: 0o600 });
    return path;
  };
  const cli = async (argv, input, cwd = home, fetchImpl = fetch) => {
    const lines = [];
    const code = await main(argv, {
      cwd, env, fetchImpl, stdin: Readable.from(input === undefined ? [] : [JSON.stringify(input)]),
      out: value => lines.push(JSON.parse(value))
    });
    assert.equal(lines.length, 1);
    return { code, value: lines[0] };
  };
  const prepare = async (workItemId, review = false) => {
    store.command(owner, "commons", { id: "propose-" + workItemId, type: "work.proposed", data: {
      workItemId, title: "Review the evidence", definitionOfDone: "Test the exact pickup",
      accountableMemberId: producer.identityId, mode: "read",
      independentVerificationRequired: review, ownerDecisionRequired: false,
      ...(review ? { verifierMemberId: reviewer.identityId } : {})
    } });
    const selected = await cli(["work", workItemId]);
    assert.equal(selected.code, 0, JSON.stringify(selected));
    const step = selected.value.continuation;
    assert.deepEqual(step.command, ["room", "begin", "--from"]);
    const begin = await cli([...step.command.slice(1), "-"], selected.value);
    assert.equal(begin.value.working, true, JSON.stringify(begin));
    const beforeRetry = store.headSequence("commons");
    const staleBegin = await cli([...step.command.slice(1), "-"], selected.value);
    assert.equal(staleBegin.value.stopped, "stale_revision");
    assert.equal(store.headSequence("commons"), beforeRetry);
    const read = await cli(["work", workItemId]);
    return { body: "The exact contribution.", summary: "Checked the evidence", nextAction: "Read the contribution",
      producerId: producer.identityId, expectedRevision: read.value.revision };
  };
  const run = async (workItemId, intent, failAfter = "") => {
    const calls = [];
    const outputs = [];
    const code = await main(["submit", workItemId, "--operation", workItemId], {
      cwd: home, env, stdin: Readable.from([JSON.stringify(intent)]), out: value => outputs.push(JSON.parse(value)),
      fetchImpl: async (url, init) => {
        const name = JSON.parse(init.body).params.name;
        calls.push(name);
        const response = await fetch(url, init);
        if (name === failAfter) {
          await response.arrayBuffer();
          throw new Error("simulated lost reply after server handled request");
        }
        return response;
      }
    });
    assert.equal(outputs.length, 1);
    assert.doesNotMatch(JSON.stringify(outputs[0]), /The exact contribution/);
    return { code, output: outputs[0], calls };
  };

  const normal = await prepare("normal");
  assert.equal((await run("normal", { ...normal, maxCodeUnits: 5 })).output.code, "result_too_large");
  const first = await run("normal", normal);
  assert.equal(first.code, 0, JSON.stringify(first));
  assert.deepEqual(first.calls, ["room_post_message", "room_submit_text_result"]);
  assert.equal(first.output.currentStateVerified, false);
  const observed = await rpc("room_read_result", first.output.next.arguments);
  assert.equal(observed.result.text.body, normal.body);

  const draft = await prepare("lost-draft");
  const draftUnknown = (await run("lost-draft", draft, "room_post_message")).output;
  assert.equal(draftUnknown.status, "unknown");
  assert.deepEqual(draftUnknown.receiptCommand, ["room", "receipt", "lost-draft", "--draft"]);
  const draftHead = store.headSequence("commons");
  const draftReceipt = await cli(draftUnknown.receiptCommand.slice(1));
  assert.equal(draftReceipt.value.status, "recorded");
  assert.equal(draftReceipt.value.eventType, "message.posted");
  assert.equal((await cli(["receipt", "lost-draft", "--submit"])).value.status, "not_recorded");
  assert.equal(store.headSequence("commons"), draftHead);
  const recoveredDraft = await run("lost-draft", draft);
  assert.equal(recoveredDraft.code, 0, JSON.stringify(recoveredDraft));
  assert.deepEqual(recoveredDraft.calls, ["room_post_message", "room_read_result", "room_submit_text_result"]);

  const completion = await prepare("lost-completion");
  const completionUnknown = (await run("lost-completion", completion, "room_submit_text_result")).output;
  assert.equal(completionUnknown.status, "unknown");
  assert.deepEqual(completionUnknown.receiptCommand, ["room", "receipt", "lost-completion", "--submit"]);
  const recordedThrough = store.headSequence("commons");
  const completionReceipt = await cli(completionUnknown.receiptCommand.slice(1));
  assert.equal(completionReceipt.code, 0);
  assert.equal(completionReceipt.value.status, "recorded");
  assert.equal(completionReceipt.value.eventType, "work.completed");
  assert.ok(completionReceipt.value.sequence <= recordedThrough);
  assert.equal(completionReceipt.value.checkedThrough, recordedThrough);
  assert.equal(completionReceipt.value.currentStateVerified, false);
  assert.doesNotMatch(JSON.stringify(completionReceipt), /The exact contribution|fingerprint|body/);
  const otherActor = await cli(["receipt", completionReceipt.value.operationId], undefined, reviewerProject);
  assert.equal(otherActor.value.status, "not_recorded");
  assert.equal(otherActor.value.checkedThrough, recordedThrough);
  assert.equal(Object.hasOwn(otherActor.value, "eventId"), false);
  assert.equal(store.headSequence("commons"), recordedThrough, "lookup adds no event");
  assert.equal((await run("lost-completion", { ...completion, summary: "Changed intent" })).output.code,
    "operation_input_changed");
  const recoveredCompletion = await run("lost-completion", completion);
  assert.equal(recoveredCompletion.code, 0, JSON.stringify(recoveredCompletion));
  assert.deepEqual(recoveredCompletion.calls, ["room_submit_text_result"]);
  assert.equal(recoveredCompletion.output.duplicate, true);
  assert.equal(recoveredCompletion.output.completionEventId, completionReceipt.value.eventId);
  assert.equal(store.headSequence("commons"), recordedThrough);

  const changed = await prepare("changed-after-draft");
  assert.equal((await run("changed-after-draft", changed, "room_post_message")).output.status, "unknown");
  await rpc("room_block_work", { workItemId: "changed-after-draft", reason: "New requirement",
    nextAction: "Revisit the fixture" });
  const stale = await run("changed-after-draft", changed);
  assert.equal(stale.output.code, "draft_recorded_basis_unavailable");
  assert.deepEqual(stale.calls, ["room_post_message", "room_read_result"]);

  const reviewed = await prepare("needs-review", true);
  const { expectedRevision, ...result } = reviewed;
  const inProgress = await cli(["work", "needs-review"]);
  assert.equal(inProgress.value.revision, expectedRevision);
  const workFile = save("work.json", inProgress.value);
  const beforeSize = store.headSequence("commons");
  assert.equal((await cli(["submit", "--from", workFile], { ...result, maxCodeUnits: 5 })).value.code, "result_too_large");
  assert.equal(store.headSequence("commons"), beforeSize);
  const finished = await cli(["submit", "--from", workFile], result);
  assert.equal(finished.code, 0, JSON.stringify(finished));
  const selectedReview = await cli(["work", "needs-review"], undefined, reviewerProject);
  const fetchResult = selectedReview.value.continuation.command;
  assert.deepEqual(fetchResult, ["room", "work", "needs-review", "--result"]);
  const evidence = await cli(fetchResult.slice(1), undefined, reviewerProject);
  assert.equal(evidence.value.review.result.text.body, reviewed.body);
  assert.deepEqual(evidence.value.continuation.command, ["room", "review", "--from"]);
  const reviewFile = save("review.json", evidence.value);
  const review = ["review", "--from", reviewFile, "--fail", "--summary", "Include the reconnect instructions"];
  const beforeBadBasis = store.headSequence("commons");
  const unexpectedFetch = () => assert.fail("Invalid packet should not reach HTTP");
  assert.equal((await cli(review, undefined, home, unexpectedFetch)).value.code, "invalid_action_basis");
  const changedPacket = structuredClone(evidence.value);
  changedPacket.cliBasis.actions.review.expectedRevision--;
  const changedFile = save("changed.json", changedPacket);
  assert.equal((await cli(["review", "--from", changedFile, "--pass", "--summary", "Changed basis"],
    undefined, reviewerProject, unexpectedFetch)).value.code, "invalid_action_basis");
  assert.equal((await cli(["review", "--from", reviewFile, "--summary", "No decision"],
    undefined, reviewerProject, unexpectedFetch)).value.code, "invalid_action_input");
  assert.equal(store.headSequence("commons"), beforeBadBasis);
  const lostReview = await cli(review, undefined, reviewerProject, async (url, init) => {
    const response = await fetch(url, init);
    await response.arrayBuffer();
    throw new Error("lost review reply");
  });
  assert.equal(lostReview.value.status, "unknown");
  assert.deepEqual(lostReview.value.receiptCommand, ["room", "receipt", lostReview.value.requestId]);
  const typedReceipt = await rpc("room_receipt", lostReview.value.receiptRead.arguments, reviewer);
  assert.equal(typedReceipt.status, "recorded");
  assert.equal(typedReceipt.eventType, "verification.recorded");
  const afterReview = store.headSequence("commons");
  const reviewEvents = store.eventsAfter(owner, "commons", beforeBadBasis, 20).events.map(row => row.event ?? row);
  assert.equal(reviewEvents.filter(row => row.type === "verification.recorded").length, 1);
  const correction = await cli(review, undefined, reviewerProject);
  assert.equal(correction.code, 0, JSON.stringify(correction));
  assert.equal(correction.value.duplicate, true);
  assert.equal(correction.value.eventId, reviewEvents.find(row => row.type === "verification.recorded").id);
  assert.equal(typedReceipt.eventId, correction.value.eventId);
  assert.equal(store.headSequence("commons"), afterReview);
  assert.equal((await cli(["review", "--from", reviewFile, "--pass", "--summary", "Stale verdict"],
    undefined, reviewerProject)).code, 1);
  assert.equal(store.headSequence("commons"), afterReview);

  const current = await cli(["work", "needs-review"]);
  assert.deepEqual(current.value.continuation.command, ["room", "resolve", "--from"]);
  const resolve = await cli(["resolve", "--from", "-", "--resolution", "Added the reconnect instructions"], current.value);
  assert.equal(resolve.code, 0, JSON.stringify(resolve));
  const restart = await cli(["work", "needs-review"]);
  assert.equal((await cli(["begin", "--from", "-"], restart.value)).value.working, true);
  const work = await cli(["work", "needs-review"]);
  const replacement = await cli(["submit", "--from", save("replacement.json", work.value)],
    { ...result, body: "The exact contribution with the reconnect instructions." });
  assert.equal(replacement.code, 0, JSON.stringify(replacement));
  const followup = await cli(["work", "needs-review", "--result"], undefined, reviewerProject);
  const accepted = await cli(["review", "--from", "-", "--pass", "--summary", "Includes reconnect instructions"],
    followup.value, reviewerProject);
  assert.equal(accepted.code, 0, JSON.stringify(accepted));

  const requested = await rpc("room_request_reply", { toMemberId: producer.identityId,
    requestId: "fixture-ask", body: "What did the reconnect check show?" }, reviewer);
  const request = await cli(["request", requested.requestMessageId]);
  assert.equal(request.code, 0, JSON.stringify(request));
  assert.equal(Object.hasOwn(request.value, "responseHttpActions"), false);
  assert.deepEqual(request.value.responseActions[0].command, ["room", "respond", "--from"]);
  const answerFile = join(home, "answer.txt");
  writeFileSync(answerFile, "The original operation receipt was recovered.", { mode: 0o600 });
  const respond = ["respond", "--from", "-", "--answer", "--body-file", answerFile];
  const partial = structuredClone(request.value);
  partial.page.hasMore = true;
  assert.equal((await cli(respond, partial, home, unexpectedFetch)).value.code, "invalid_action_basis");
  const answered = await cli(respond, request.value);
  assert.equal(answered.code, 0, JSON.stringify(answered));
  assert.doesNotMatch(JSON.stringify([accepted, answered]), new RegExp(producer.secret));
});
}
