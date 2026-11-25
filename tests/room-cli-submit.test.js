import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { workspaceArtifactLink } from "../src/workspace-artifact-link.js";
import { exactResultHref } from "../src/record-link.js";
import { main } from "../cli/main.mjs";
import { connectionHome, connectionsRoot, writePointer, writeProject } from "../cli/paths.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { textVersion } from "../server/text-results.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

async function fixture(t, representation) {
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
  return { home, env, origin, store, owner, producer, reviewer, reviewerProject, rpc, save, cli };
}

// Session heartbeats are a legacy writer operation.
test("a returning agent submits from the fresh revision after a heartbeat", async t => {
  const { store, owner, producer, cli } = await fixture(t, "legacy");
  const workItemId = "retained-after-heartbeat";
  store.command(owner, "commons", { id: "propose", type: "work.proposed", data: {
    workItemId, title: "Share the revised document", definitionOfDone: "Post the final text",
    accountableMemberId: producer.identityId, mode: "read",
  } });
  const read = async (...args) => {
    const result = await cli(["work", workItemId, ...args]);
    assert.equal(result.code, 0, JSON.stringify(result));
    return result.value;
  };
  assert.equal((await cli(["begin", "--from", "-"], await read())).code, 0);
  const start = (id, expectedRevision) => store.command(producer.secret, "commons", {
    id, type: "session.started", data: { workItemId, expectedRevision },
  });
  start("first-start", (await read()).revision);
  const saved = await read();
  start("heartbeat", saved.revision);
  const fresh = await read("--since", saved.briefVersion);
  assert.equal(fresh.briefUnchanged, true);
  assert.equal(fresh.brief, undefined);
  assert.ok(fresh.revision > saved.revision);
  assert.equal(fresh.cliBasis.actions.submit.expectedRevision, fresh.revision);
  assert.match(fresh.guidance, /use this response.s revision and continuation/i);
  const submission = await cli(["submit", workItemId, "--operation", "after-heartbeat"], {
    expectedRevision: fresh.cliBasis.actions.submit.expectedRevision, producerId: producer.identityId,
    body: "The revised document.", summary: "Ready for review", nextAction: "Read the revision",
  });
  assert.equal(submission.code, 0, JSON.stringify(submission));
});

for (const representation of ["legacy", "normalized-current-v1"]) {
test(`${representation} pickup opens only the linked assignment source with the project connection`, async t => {
  const { store, owner, producer, reviewer, reviewerProject, cli } = await fixture(t, representation);
  const workItemId = "first-assignment", body = "The agreed contract is https://docs.example.test/contract.";
  store.command(owner, "commons", { id: "assignment-source", type: "message.posted",
    data: { messageId: "assignment-source", body } });
  store.command(owner, "commons", { id: "other-message", type: "message.posted",
    data: { messageId: "other-message", body: "Unrelated project discussion." } });
  store.command(owner, "commons", { id: "propose-first", type: "work.proposed", data: {
    workItemId, title: "Implement the client", definitionOfDone: "Use the agreed contract",
    accountableMemberId: producer.identityId, sourceMessageId: "assignment-source", mode: "read",
  } });
  const head = store.headSequence("commons");
  const pickup = await cli(["next"]);
  assert.equal(pickup.code, 0, JSON.stringify(pickup));
  const row = pickup.value.work.items.find(item => item.id === workItemId);
  assert.ok(row, JSON.stringify(pickup));
  const brief = await cli(row.nextRead.command.slice(1));
  assert.equal(brief.code, 0, JSON.stringify(brief));
  assert.doesNotMatch(JSON.stringify(brief), /docs.example.test/);
  assert.deepEqual(brief.value.sourceRead.command, ["room", "work", workItemId, "--include-source"]);
  const retained = await cli(["work", workItemId, "--since", brief.value.briefVersion]);
  assert.equal(retained.value.briefUnchanged, true);
  assert.deepEqual(retained.value.sourceRead, brief.value.sourceRead);
  const read = await cli(brief.value.sourceRead.command.slice(1));
  assert.equal(read.code, 0, JSON.stringify(read));
  assert.equal(read.value.viewerId, producer.identityId);
  assert.equal(read.value.context.source.message.body, body);
  assert.doesNotMatch(JSON.stringify(read), /Unrelated project discussion/);
  const refresh = ["work", workItemId, "--include-source", "--from", "-"];
  assert.deepEqual(read.value.context.source.cliRefresh.command, ["room", ...refresh]);
  const unchanged = await cli(refresh, read.value);
  assert.equal(unchanged.code, 0, JSON.stringify(unchanged));
  assert.equal(unchanged.value.context.source.status, "not_modified");
  assert.equal(unchanged.value.context.source.message, null);
  assert.doesNotMatch(JSON.stringify(unchanged), /docs.example.test/);
  const wrongViewer = await cli(refresh, read.value, reviewerProject, async () => {
    assert.fail("a cached observation may not be sent under another member");
  });
  assert.deepEqual(wrongViewer, { code: 1, value: { status: "refused", code: "source_selection_mismatch" } });
  const wrongOrigin = structuredClone(read.value);
  wrongOrigin.context.source.cliRefresh.origin = "https://other-room.example.test";
  assert.deepEqual(await cli(refresh, wrongOrigin, undefined, async () => {
    assert.fail("a cached observation may not be sent to a different origin");
  }), wrongViewer);
  assert.equal(store.headSequence("commons"), head);
  store.command(owner, "commons", { id: "edit-source", type: "message.edited",
    data: { messageId: "assignment-source", expectedMessageRevision: 0, body: "Use the new document instead." } });
  const retainedAfterEdit = await cli(["work", workItemId, "--since", brief.value.briefVersion]);
  assert.equal(retainedAfterEdit.value.briefUnchanged, true);
  assert.match(retainedAfterEdit.value.guidance, /sourceRead.*linked source/i);
  const changed = await cli(refresh, unchanged.value);
  assert.equal(changed.code, 0, JSON.stringify(changed));
  assert.equal(changed.value.context.source.freshness, "changed");
  assert.equal(changed.value.context.source.message.body, "Use the new document instead.");
  const otherRead = await cli(["work", workItemId, "--include-source"], undefined, reviewerProject);
  assert.equal(otherRead.code, 0, JSON.stringify(otherRead));
  assert.equal(otherRead.value.viewerId, reviewer.identityId);
  store.identities.unlink(owner, "commons", reviewer.identityId);
  const revoked = await cli(refresh, otherRead.value, reviewerProject);
  assert.equal(revoked.code, 1);
  assert.doesNotMatch(JSON.stringify(revoked), /Use the new document|not_modified/);
  const mismatch = await cli(brief.value.sourceRead.command.slice(1), undefined, undefined, async (...args) => {
    const response = await fetch(...args);
    const result = await response.json();
    result.result.structuredContent.viewerId = "another-agent";
    return Response.json(result);
  });
  assert.equal(mismatch.code, 1);
  assert.doesNotMatch(JSON.stringify(mismatch), /docs.example.test|Use the new document/);
  store.command(owner, "commons", { id: "delete-source", type: "message.deleted",
    data: { messageId: "assignment-source", expectedMessageRevision: 1 } });
  const updated = await cli(["work", workItemId, "--since", brief.value.briefVersion]);
  assert.equal(updated.code, 0);
  assert.equal(updated.value.sourceRead, undefined);
  const retainedWithoutSource = await cli(["work", workItemId, "--since", updated.value.briefVersion]);
  assert.equal(retainedWithoutSource.value.briefUnchanged, true);
  assert.equal(retainedWithoutSource.value.sourceRead, undefined);
  assert.doesNotMatch(retainedWithoutSource.value.guidance, /source/i);
  const deleted = await cli(refresh, changed.value);
  assert.equal(deleted.code, 0);
  assert.equal(deleted.value.context.source.status, "unavailable");
  assert.equal(deleted.value.context.source.cliRefresh, undefined);
  assert.doesNotMatch(JSON.stringify(deleted), /docs.example.test|Use the new document/);
});

test(`${representation} a colleague reads an exact shared result URL with their own project connection`, async t => {
  const { env, origin, store, owner, producer, reviewer, reviewerProject, cli, rpc } = await fixture(t, representation);
  const workItemId = "handoff";
  store.command(owner, "commons", { id: "request", type: "work.proposed", data: { workItemId,
    title: "Draft the brief", definitionOfDone: "Share the brief", accountableMemberId: producer.identityId, verifierMemberId: reviewer.identityId, independentVerificationRequired: true, mode: "read" } });
  const selected = (await cli(["work", workItemId])).value;
  assert.equal((await cli(["begin", "--from", "-"], selected)).code, 0);
  const work = (await cli(["work", workItemId])).value;
  const patch = "diff --git a/brief.md b/brief.md\n--- a/brief.md\n+++ b/brief.md\n@@ -1 +1 @@\n-old\n+submitted\n";
  const preview = { id: "a".repeat(32), title: "Brief", base: "b".repeat(40), head: "c".repeat(40),
    html: "<p>Brief</p>", patch, recipientId: reviewer.identityId };
  const publish = async (expectedRevision, patch) => {
    const response = await fetch(origin + "/api/rooms/commons/workspace-previews", { method: "POST",
      headers: { Authorization: "Bearer " + producer.secret, "Content-Type": "application/json" },
      body: JSON.stringify({ ...preview, expectedRevision, patch }) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const fileLink = workspaceArtifactLink(origin, "commons", { ...preview, ...await publish(0, patch) }, "changes", "brief.md");
  const firstBody = "Draft from a colleague.\nChanged file: " + fileLink;
  const submitted = await cli(["submit", workItemId, "--operation", "handoff-result"], {
    body: firstBody, expectedRevision: work.revision, producerId: producer.identityId,
    summary: "Drafted the brief", nextAction: "Review the draft" });
  assert.equal(submitted.code, 0, JSON.stringify(submitted));
  const { completionEventId } = submitted.value.next.arguments;
  const sharedUrl = exactResultHref({ roomId: "commons", workItemId,
    completionEventId }, new URL(origin));
  const shared = await cli(["result", sharedUrl], undefined, reviewerProject);
  assert.equal(shared.code, 0);
  assert.equal(shared.value.result.text.body, firstBody);
  assert.equal(shared.value.result.receipt.eventId, completionEventId);
  const [file] = shared.value.workspaceArtifacts;
  assert.equal(file.messageId, shared.value.result.text.messageId);
  assert.deepEqual(file.command, ["room", "workspace", "changes", "--link", fileLink, "--connection", "reviewer"]);
  Object.assign(env, { ROOM_ORIGIN: origin, ROOM_ID: "commons", PROJECT_ROOM_SECRET: "different-ambient-identity" });
  const changes = await cli(file.command.slice(1), undefined, reviewerProject);
  assert.equal(changes.value.file.hunks[0].changes.at(-1).content, "submitted");
  const updated = await publish(1, patch.replace("+submitted", "+replaced"));
  assert.equal(shared.value.discussion, undefined);
  assert.equal(shared.value.discussionRead.path, `/api/rooms/commons/messages/${shared.value.result.text.messageId}/thread`);
  const quoted = "> Draft from a colleague.\n" + sharedUrl + "\n\nPlease name Maya as the owner.";
  const feedback = store.command(reviewer.secret, "commons", { id: "feedback", type: "message.posted",
    data: { messageId: "quoted-feedback", replyToId: shared.value.result.text.messageId, body: quoted } });
  store.command(reviewer.secret, "commons", { id: "private-feedback", type: "message.posted",
    data: { messageId: "private-feedback", replyToId: shared.value.result.text.messageId, body: "Private aside", toMemberId: "owner" } });
  const exact = await rpc("room_read_result", { workItemId, completionEventId });
  const connectorRead = await rpc(exact.discussionRead.tool, exact.discussionRead.arguments);
  assert.equal(connectorRead.completionEventId, completionEventId);
  assert.equal(connectorRead.discussion.messageId, shared.value.result.text.messageId);
  assert.deepEqual(connectorRead.discussion.replies.map(reply => reply.body), [quoted]);
  assert.equal(connectorRead.discussion.replies[0].untrusted, true);
  const producerRead = await cli(shared.value.discussionRead.command.slice(1));
  assert.equal(producerRead.code, 0, JSON.stringify(producerRead));
  assert.equal(producerRead.value.discussion.replies[0].id, feedback.event.data.messageId);
  assert.equal(producerRead.value.discussion.replies[0].body, quoted);
  assert.equal(producerRead.value.discussion.replies[0].untrusted, true);
  assert.equal(producerRead.value.discussion.replies.length, 1);
  assert.deepEqual(producerRead.value.current.next, shared.value.current.next);
  assert.equal(producerRead.value.result.receipt.eventId, completionEventId);
  assert.equal(producerRead.value.current.workRevision, shared.value.current.workRevision);
  for (const [threadResponse, code] of [
    [() => new Response(null, { status: 413 }), "result_discussion_too_large"],
    [() => Response.json({ roomId: "commons", thread: { id: shared.value.result.text.messageId, workItemId,
      authorId: producer.identityId, body: null, deletedAt: Date.now(), replies: [] } }), "result_discussion_unavailable"]
  ]) {
    const partial = await cli(["result", sharedUrl, "--discussion"], undefined, reviewerProject, (url, options) =>
      options.method === "POST" ? fetch(url, options) : threadResponse());
    assert.equal(partial.code, 1);
    assert.equal(partial.value.code, code);
    assert.equal(partial.value.result, undefined);
  }
  const review = await cli(["work", workItemId, "--result"], undefined, reviewerProject);
  assert.equal((await cli(["review", "--from", "-", "--fail", "--summary", "Name the owner."],
    review.value, reviewerProject)).code, 0);
  const blocked = await cli(["work", workItemId]);
  assert.equal((await cli(["resolve", "--from", "-", "--resolution", "Added the owner."], blocked.value)).code, 0);
  const resumed = await cli(["work", workItemId]);
  assert.equal((await cli(["begin", "--from", "-"], resumed.value)).code, 0);
  const working = await cli(["work", workItemId]);
  const revised = await cli(["submit", workItemId, "--operation", "revised-handoff"], {
    body: "Owner: Maya.", expectedRevision: working.value.revision, producerId: producer.identityId,
    summary: "Named the owner", nextAction: "Check the revised brief" });
  assert.equal(revised.code, 0);
  const revisedUrl = exactResultHref({ roomId: "commons", workItemId,
    completionEventId: revised.value.next.arguments.completionEventId }, new URL(origin));
  const current = await cli(["result", revisedUrl], undefined, reviewerProject);
  assert.equal(current.value.result.text.body, "Owner: Maya.");
  assert.equal(current.value.workThread.correction.summary, "Name the owner.");
  const revisedDiscussion = await cli(["result", revisedUrl, "--discussion"]);
  assert.deepEqual(revisedDiscussion.value.discussion.replies, []);
  const lateLink = workspaceArtifactLink(origin, "commons", { ...preview, ...updated }, "changes", "brief.md");
  const replyToId = current.value.result.text.messageId;
  store.command(producer.secret, "commons", { id: "send-late-file", type: "message.posted",
    data: { messageId: "late-file", replyToId, body: "Here is the revised brief.\n" + lateLink } });
  store.command(producer.secret, "commons", { id: "send-private-file", type: "message.posted",
    data: { messageId: "private-file", replyToId, toMemberId: "owner", body: fileLink } });
  const followUp = await cli(["result", revisedUrl, "--discussion"], undefined, reviewerProject);
  assert.equal(followUp.value.workspaceArtifacts, undefined);
  assert.equal(followUp.value.discussion.replies.length, 1);
  assert.equal(followUp.value.discussion.workspaceArtifacts.length, 1);
  const [lateFile] = followUp.value.discussion.workspaceArtifacts;
  assert.equal(lateFile.messageId, "late-file");
  assert.deepEqual(lateFile.command, ["room", "workspace", "changes", "--link", lateLink, "--connection", "reviewer"]);
  const lateChanges = await cli(lateFile.command.slice(1), undefined, reviewerProject);
  assert.equal(lateChanges.value.file.hunks[0].changes.at(-1).content, "replaced");
  await publish(updated.revision, patch.replace("+submitted", "+latest"));
  await assert.rejects(() => cli(lateFile.command.slice(1), undefined, reviewerProject), error => error.status === 409);
  const earlier = await cli(["result", sharedUrl, "--discussion"], undefined, reviewerProject);
  assert.equal(earlier.value.discussion.replies[0].body, quoted);
  assert.equal(earlier.value.selection.status, "historical");
  assert.equal(earlier.value.result.text.body, firstBody);
  assert.deepEqual(earlier.value.workspaceArtifacts, [file]);
  assert.equal(current.value.workspaceArtifacts, undefined);
  await assert.rejects(() => cli(file.command.slice(1), undefined, reviewerProject), error => error.status === 409);
  // A producer may deliberately cite the very same message in a later receipt.
  const laterReview = await cli(["work", workItemId, "--result"], undefined, reviewerProject);
  assert.equal((await cli(["review", "--from", "-", "--fail", "--summary", "Use the original wording."],
    laterReview.value, reviewerProject)).code, 0);
  assert.equal((await cli(["resolve", "--from", "-", "--resolution", "Reusing the original wording."],
    (await cli(["work", workItemId])).value)).code, 0);
  assert.equal((await cli(["begin", "--from", "-"], (await cli(["work", workItemId])).value)).code, 0);
  const source = shared.value.result.text;
  const reused = store.command(producer.secret, "commons", { id: "cite-original", type: "work.completed", data: {
    workItemId, expectedRevision: (await cli(["work", workItemId])).value.revision, evidenceKind: "room_text",
    evidenceMessageId: source.messageId, evidenceMessageEventId: source.messageEventId, evidenceVersion: source.evidenceVersion,
    previousCompletionEventId: revised.value.next.arguments.completionEventId, producerId: producer.identityId,
    summary: "Restored wording", nextAction: "Review the original wording" } });
  const reusedRead = await cli(["result", workItemId, "--completion", reused.event.id, "--discussion"]);
  assert.equal(reusedRead.code, 0);
  assert.deepEqual(reusedRead.value.discussion, producerRead.value.discussion);
  const quotedSource = reusedRead.value.discussion.replies[0].body.split("\n").find(line => line.startsWith(origin));
  const fromFeedback = await cli(["result", quotedSource]);
  assert.equal(fromFeedback.code, 0);
  assert.equal(fromFeedback.value.result.receipt.eventId, completionEventId);
  assert.equal(fromFeedback.value.selection.status, "historical");
  for (const other of [sharedUrl.replace("room=commons", "room=other"), sharedUrl.replace(origin, "https://other.example")]) {
    let calls = 0;
    const refused = await cli(["result", other], undefined, reviewerProject, () => { calls++; throw new Error("unexpected call"); });
    assert.equal(refused.value.code, "room_selection_mismatch");
    assert.equal(calls, 0);
  }
});

test(`${representation} unavailable shared result gives the reviewer a safe next step`, async t => {
  const { origin, store, owner, producer, reviewer, reviewerProject, cli } = await fixture(t, representation);
  const workItemId = "refused-result", body = "Private reviewer fixture text";
  store.command(owner, "commons", { id: "propose", type: "work.proposed", data: { workItemId,
    title: "Draft a brief", definitionOfDone: "Review the draft", accountableMemberId: producer.identityId,
    verifierMemberId: reviewer.identityId, independentVerificationRequired: true, mode: "read" } });
  const selected = await cli(["work", workItemId]);
  assert.equal((await cli(["begin", "--from", "-"], selected.value)).code, 0);
  const work = await cli(["work", workItemId]);
  const messageId = "private-result-message";
  const posted = store.command(producer.secret, "commons", { id: "post-private", type: "message.posted",
    data: { messageId, workItemId, toMemberId: "owner", body } });
  const receipt = store.command(producer.secret, "commons", { id: "complete-private", type: "work.completed",
    data: { workItemId, expectedRevision: work.value.revision, evidenceKind: "room_text", evidenceMessageId: messageId,
      evidenceMessageEventId: posted.event.id, evidenceVersion: textVersion(body), previousCompletionEventId: null,
      producerId: producer.identityId, summary: "Drafted", nextAction: "Review" } });
  for (const [completionEventId, code] of [[receipt.event.id, "result_unavailable"], ["missing-completion", "result_not_found"]]) {
    const url = exactResultHref({ roomId: "commons", workItemId, completionEventId }, new URL(origin));
    const envelopes = [];
    const refused = await cli(["result", url], undefined, reviewerProject, async (...args) => {
      const response = await fetch(...args);
      envelopes.push((await response.clone().json()).result.structuredContent);
      return response;
    });
    assert.equal(refused.code, 1);
    assert.equal(refused.value.code, code);
    assert.match(refused.value.hint, /ask the sender/i);
    assert.equal(JSON.stringify(refused.value).includes(body), false);
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].reason, code);
    assert.equal(envelopes[0].hint, refused.value.hint);
  }
});

test(`${representation} commands cover pickup, correction, review, requests and submission recovery`, async t => {
  const { home, env, store, owner, producer, reviewer, reviewerProject, rpc, save, cli } = await fixture(t, representation);
  const prepare = async (workItemId, review = false) => {
    store.command(owner, "commons", { id: "propose-" + workItemId, type: "work.proposed", data: {
      workItemId, title: "Review the evidence", definitionOfDone: "Test the exact pickup",
      accountableMemberId: producer.identityId, mode: "read",
      independentVerificationRequired: review, ownerDecisionRequired: false,
      ...(review ? { verifierMemberId: reviewer.identityId } : {})
    } });
    const selected = await cli(["work", workItemId]);
    assert.equal(selected.code, 0, JSON.stringify(selected));
    if (workItemId === "normal") {
      const prior = selected.value;
      const refreshed = (await cli(["work", workItemId, "--since", prior.briefVersion])).value;
      assert.equal(refreshed.briefUnchanged, true);
      assert.match(refreshed.guidance, /use this response.s revision and continuation/i);
      assert.equal(refreshed.briefVersion, prior.briefVersion);
      assert.equal(refreshed.brief, undefined);
      assert.deepEqual(refreshed.continuation, prior.continuation);
      assert.deepEqual(refreshed.cliBasis, prior.cliBasis);
      assert.ok(Buffer.byteLength(JSON.stringify(refreshed)) < Buffer.byteLength(JSON.stringify(prior)));
      const mismatched = await cli(["work", workItemId, "--since", prior.briefVersion], undefined, home,
        async (_url, init) => Response.json({ jsonrpc: "2.0", id: JSON.parse(init.body).id,
          result: { structuredContent: { ...refreshed, briefVersion: "0".repeat(64) } } }));
      assert.deepEqual(mismatched, { code: 1, value: { status: "unavailable", code: "room_read_unavailable" } });
    }
    const step = selected.value.continuation;
    assert.deepEqual(step.command, ["room", "begin", "--from"]);
    const begin = await cli([...step.command.slice(1), "-"], selected.value);
    assert.equal(begin.value.working, true, JSON.stringify(begin));
    const beforeRetry = store.headSequence("commons");
    const recovered = await cli([...step.command.slice(1), "-"], selected.value);
    assert.equal(recovered.code, 0);
    assert.equal(recovered.value.working, true);
    assert.deepEqual(recovered.value.confirmed, begin.value.confirmed);
    assert.equal(store.headSequence("commons"), beforeRetry);
    const read = await cli(workItemId === "normal"
      ? ["work", workItemId, "--since", selected.value.briefVersion] : ["work", workItemId]);
    if (workItemId === "normal") {
      assert.equal(read.code, 0);
      assert.equal(typeof read.value.brief, "string");
      assert.notEqual(read.value.briefVersion, selected.value.briefVersion);
      assert.ok(read.value.revision > selected.value.revision);
      assert.equal(read.value.cliBasis.actions.submit.expectedRevision, read.value.revision);
    }
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

test(`${representation} answers use the saved request, stop at a correction and recover a lost response`, async t => {
  const { home, store, producer, reviewer, rpc, cli } = await fixture(t, representation);
  const requested = await rpc("room_request_reply", { toMemberId: producer.identityId,
    requestId: "fixture-first", body: "What did reconnect show?" }, reviewer);
  const request = await cli(["read", requested.requestMessageId]);
  const answerFile = join(home, "answer.txt");
  writeFileSync(answerFile, "The original operation receipt was recovered.", { mode: 0o600 });
  const answered = await cli(["answer", requested.requestMessageId, "--from", "-", "--body-file", answerFile], request.value);
  assert.equal(answered.code, 0, JSON.stringify(answered));
  const unexpectedFetch = () => assert.fail("Invalid packet should not reach HTTP");

  const follow = await rpc("room_request_reply", { requestId: "fixture-follow",
    toMemberId: producer.identityId, replyToId: answered.value.messageId,
    body: "Use the receipt, then report the reconnect check." }, reviewer);
  const followRead = await cli(["read", follow.requestMessageId]);
  assert.deepEqual(followRead.value.answerCommand, ["room", "answer", follow.requestMessageId, "--from"]);
  assert.equal(followRead.value.preparation.previousExchanges[0].requestMessageId, requested.requestMessageId);
  const progress = await rpc("room_progress_request", { requestMessageId: follow.requestMessageId,
    expectedRequestRevision: followRead.value.request.revision, progress: "acknowledged" });
  assert.equal(progress.appliedRequestRevision, followRead.value.request.revision);

  const answer = ["answer", follow.requestMessageId, "--from", "-", "--body-file", answerFile];
  assert.equal((await cli(answer, request.value, home, unexpectedFetch)).value.code, "request_selection_mismatch");
  await rpc("room_reply", { replyToId: follow.requestMessageId, toMemberId: producer.identityId,
    body: "Correction: confirm the original operation was recovered." }, reviewer);
  const beforeStale = store.headSequence("commons");
  const staleAnswer = await cli(answer, followRead.value);
  assert.equal(staleAnswer.value.status, "refused", JSON.stringify(staleAnswer));
  assert.equal(staleAnswer.value.code, "stale_revision");
  assert.equal(staleAnswer.value.currentRead?.request.id, follow.requestMessageId);
  assert.equal(staleAnswer.value.currentRead?.page.items.at(-1).message.body,
    "Correction: confirm the original operation was recovered.");
  assert.equal(store.headSequence("commons"), beforeStale);

  const operations = [];
  const recovered = await cli(answer, staleAnswer.value.currentRead, home, async (url, init) => {
    const name = JSON.parse(init.body).params.name;
    operations.push(name);
    const response = await fetch(url, init);
    if (name === "room_respond_to_request") {
      await response.arrayBuffer();
      throw new Error("Lost the response after SQLite committed");
    }
    return response;
  });
  assert.equal(recovered.code, 0, JSON.stringify(recovered));
  assert.equal(recovered.value.recoveredFromReceipt, true);
  assert.equal(recovered.value.requestMessageId, follow.requestMessageId);
  assert.deepEqual(operations, ["room_respond_to_request", "room_receipt", "room_read_request"]);
  assert.equal(store.headSequence("commons"), beforeStale + 1);
  const complete = await rpc("room_read_request", { requestMessageId: follow.requestMessageId });
  assert.equal(complete.request.terminalEventId, recovered.value.eventId);
  assert.equal(complete.request.status, "answered");

});
}
