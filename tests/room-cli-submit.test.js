import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { workspaceArtifactLink } from "../src/workspace-artifact-link.js";
import { exactResultHref } from "../src/record-link.js";
import { main } from "../cli/main.mjs";
import { connectionHome, connectionsRoot, loadConnection, writePointer, writeProject } from "../cli/paths.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { readWorkSelection } from "../client/work-preparation.mjs";
import { mcpCallError } from "../server/mcp-arg-errors.mjs";
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

for (const representation of ["legacy", "normalized-current-v1"])
test(`coworker pickup through a stale draft, corrected revision and exact acceptance (${representation})`, async t => {
  const { store, owner, producer, reviewer, cli, home, env, origin, reviewerProject } = await fixture(t, representation);
  const workItemId = "coworker-patch";
  const write = (key, type, data) => store.command(key, "commons", { id: crypto.randomUUID(), type, data });
  write(owner, "work.proposed", {
    workItemId, title: "Update reconnect handling", definitionOfDone: "Cover reconnect without duplicate replies",
    accountableMemberId: producer.identityId, verifierMemberId: reviewer.identityId,
    independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner", mode: "read"
  });
  const read = async (args, cwd, input) => {
    const selected = await cli(args, input, cwd);
    assert.equal(selected.code, 0, JSON.stringify(selected.value));
    return selected.value;
  };
  const assigned = await read(["next"]);
  assert.equal(assigned.viewerId, producer.identityId);
  const pointer = assigned.work.items.find(item => item.id === workItemId).nextRead.command;
  const received = await read(pointer.slice(1));
  assert.equal((await read(["begin", "--from", "-"], home, received)).working, true);
  const originalBasis = await read(["work", workItemId]);
  const submit = (operation, basis, body) => cli(["submit", workItemId, "--operation", operation], {
    body, producerId: producer.identityId, summary: "Ready for review", nextAction: "Check the reconnect case",
    expectedRevision: basis.revision
  });
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const repo = join(home, "project"), reviewRepo = join(reviewerProject, "project");
  git(home, "init", "-q", repo);
  const commit = (cwd, body, message) => {
    writeFileSync(join(cwd, "adapter.js"), body);
    git(cwd, "add", "adapter.js");
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const base = commit(repo, "export const reconnect = () => false;\n", "base");
  git(reviewerProject, "clone", "-q", "--no-local", repo, reviewRepo);
  writeProject(repo, { connection: "producer" });
  writeProject(reviewRepo, { connection: "reviewer" });
  const worktree = join(home, "reconnect-attempt");
  const workUrl = origin + "/?room=commons#pr-record/work/" + workItemId;
  const launch = await read(["workspace", "start", "--path", worktree, "--base", base, "--from-work", workUrl], repo);
  const publish = async (body, message) => {
    const head = commit(worktree, body, message);
    writeFileSync(join(worktree, "preview.html"), "<p>Reconnect fixture</p>");
    const published = await read(["workspace", "publish", "--id", launch.id, "--title", "Reconnect",
      "--base", base, "--file", "preview.html", "--include-changes", "yes", "--share-with", reviewer.identityId], worktree);
    assert.equal(published.head, head);
    assert.equal(published.base, base);
    assert.equal(published.workThread.workItemId, workItemId);
    return published;
  };
  const patchA = await publish("export const reconnect = () => true;\n", "reconnect");
  const first = await submit("first-patch", originalBasis, "Patch A reconnects the adapter.\n" + patchA.links.changes);
  assert.equal(first.code, 0, JSON.stringify(first.value));
  const firstCompletion = first.value.next.arguments.completionEventId;
  assert.deepEqual(first.value.next.command, ["room", "--connection", "producer", "result", workItemId, "--completion", firstCompletion]);
  const followed = await read(first.value.next.command.slice(1), reviewerProject);
  assert.equal(followed.viewerId, producer.identityId);
  assert.equal(followed.result.receipt.eventId, firstCompletion);
  const firstReview = await read(["work", workItemId, "--result"], reviewerProject);
  assert.equal(firstReview.cliBasis.memberId, reviewer.identityId);
  assert.equal(firstReview.review.result.receipt.eventId, firstCompletion);
  const [earlierDiff] = firstReview.review.workspaceArtifacts ?? [];
  assert.ok(earlierDiff, "the Workspace publisher's normal Changes link is directly usable in review");
  assert.equal(earlierDiff.file, undefined);
  const filesA = await read(earlierDiff.command.slice(1), reviewRepo);
  assert.equal(filesA.head, patchA.head);
  assert.deepEqual(filesA.files.map(file => file.path), ["adapter.js"]);
  await read(["review", "--from", "-", "--fail", "--summary", "Cover reconnect without duplicate replies."], reviewerProject, firstReview);

  const beforeStale = store.headSequence("commons");
  const stale = await submit("obsolete-patch", originalBasis, "Stale local draft must stay local.");
  assert.equal(stale.code, 1, JSON.stringify(stale.value));
  assert.equal(store.headSequence("commons"), beforeStale, "the stale attempt must create neither draft nor completion");
  assert.equal((await read(["receipt", "obsolete-patch", "--draft"])).status, "not_recorded");

  const corrected = await read(["work", workItemId]);
  assert.match(JSON.stringify(corrected), /Cover reconnect without duplicate replies/);
  await read(["resolve", "--from", "-", "--resolution", "Added a reconnect deduplication check."], home, corrected);
  assert.equal((await read(["begin", "--from", "-"], home, await read(["work", workItemId]))).working, true);
  const correctedCode = "export const reconnect = (alreadyReplied) => !alreadyReplied;\n";
  const patchB = await publish(correctedCode, "guard duplicate reconnect");
  const revisedBody = "Patch B reconnects the adapter and deduplicates repeated replies.\n" + patchB.links.changes;
  const revised = await submit("corrected-patch", await read(["work", workItemId]), revisedBody);
  assert.equal(revised.code, 0, JSON.stringify(revised.value));
  const completionEventId = revised.value.next.arguments.completionEventId;
  assert.notEqual(completionEventId, firstCompletion);
  const secondReview = await read(["work", workItemId, "--result"], reviewerProject);
  assert.equal(secondReview.review.result.text.body, revisedBody);
  assert.equal(secondReview.review.result.receipt.eventId, completionEventId);
  const [correctedDiff] = secondReview.review.workspaceArtifacts;
  const filesB = await read(correctedDiff.command.slice(1), reviewRepo);
  assert.equal(filesB.head, patchB.head);
  assert.equal(filesB.base, base);
  const selectedFile = await read([...correctedDiff.command.slice(1), "--file", "adapter.js"], reviewRepo);
  assert.equal(selectedFile.head, patchB.head);
  assert.equal(selectedFile.file.hunks[0].changes.at(-1).content, correctedCode.trim());
  assert.notEqual(filesB.head, filesA.head);
  assert.deepEqual(filesB.files.map(file => file.path), ["adapter.js"]);
  const selectedPatch = new URL(patchB.links.changes);
  const forbiddenPatch = new URL("/api/rooms/commons/workspace-previews", origin);
  forbiddenPatch.search = new URLSearchParams({ id: patchB.id, changes: "1", view: "summary", artifact: selectedPatch.hash });
  const denied = await fetch(forbiddenPatch, { headers: { Authorization: "Bearer " + owner } });
  assert.equal(denied.status, 404, "the result does not widen the directed patch audience");
  await assert.rejects(() => read([...earlierDiff.command.slice(1), "--file", "adapter.js"], reviewRepo), { status: 409 });
  await read(["review", "--from", "-", "--pass", "--summary", "The reconnect fixture is covered."], reviewerProject, secondReview);
  const approvedWork = store.workContext(producer.secret, "commons", workItemId).work;
  const sourceMessageId = "accepted-reconnect-note";
  write(owner, "message.posted", { messageId: sourceMessageId, body: "Approved the patch with the reconnect check." });
  const decision = write(owner, "owner.decision_recorded", {
    workItemId, expectedRevision: approvedWork.revision, decision: "approved", sourceMessageId,
    reason: "The reconnect check covers the failure.", completionEventId, evidenceVersion: textVersion(revisedBody)
  });

  const resultUrl = exactResultHref({ roomId: "commons", workItemId, completionEventId }, new URL(origin));
  const cold = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../bin/room.mjs", import.meta.url)), "result", resultUrl], { cwd: reviewerProject, env });
  const reopened = JSON.parse(cold.stdout);
  assert.equal(reopened.viewerId, reviewer.identityId);
  assert.equal(reopened.result.receipt.eventId, completionEventId);
  assert.equal(reopened.result.text.body, revisedBody);
  assert.equal(reopened.workThread.decisionSource.decisionEventId, decision.event.id);
  assert.equal(reopened.workThread.decisionSource.messageId, sourceMessageId);
  assert.deepEqual(reopened.workspaceArtifacts, [correctedDiff]);
  const continuation = await read(["workspace", "continue", "--link", patchB.links.changes,
    "--path", join(home, "reviewed-reconnect"), "--fetch-from", "origin"], reviewRepo);
  assert.equal(continuation.base, patchB.head);
  assert.equal(git(continuation.path, "show", "HEAD:adapter.js"), correctedCode.trim());
  assert.equal(git(reviewRepo, "rev-parse", "HEAD"), base);
  t.diagnostic(JSON.stringify({ representation, gitBase: base, firstGitHead: patchA.head,
    acceptedGitHead: patchB.head, completionEventId, approvalEventId: decision.event.id }));
});

for (const representation of ["legacy", "normalized-current-v1"])
test(`a document reviewer receives the exact earlier finding with the revision (${representation})`, async t => {
  const { store, owner, cli, home, origin, producer, reviewer, reviewerProject } = await fixture(t, representation);
  const workItemId = "handover-document";
  const readWork = ["work", workItemId];
  store.command(owner, "commons", { id: "handover-proposed", type: "work.proposed", data: {
    workItemId, title: "Update the handover brief", definitionOfDone: "Name the escalation owner",
    accountableMemberId: producer.identityId, verifierMemberId: reviewer.identityId,
    independentVerificationRequired: true, mode: "read",
  } });
  const command = async (argv, input, cwd = home) => {
    const { code, value } = await cli(argv, input, cwd, (url, options) => {
      assert.equal(new URL(url).origin, origin, "the reviewer uses only their Room connection");
      return fetch(url, options);
    });
    assert.equal(code, 0, JSON.stringify(value));
    return value;
  };
  const submit = async (operation, body) => command(["submit", workItemId, "--operation", operation], {
    body, producerId: producer.identityId, summary: "Handover excerpt", nextAction: "Check the escalation owner",
    expectedRevision: (await command(readWork)).revision,
  });
  await command(["begin", "--from", "-"], await command(readWork));
  const source = "https://docs.example.test/handover";
  const original = await submit("handover-original", `Escalate urgent issues. Source: ${source}`);
  const originalId = original.next.arguments.completionEventId;
  const review = () => command([...readWork, "--result"], undefined, reviewerProject);
  const first = await review();
  assert.equal(first.review.correction, undefined);
  const finding = "Name the escalation owner in the submitted excerpt.";
  await command(["review", "--from", "-", "--fail", "--summary", finding], first, reviewerProject);
  await command(["resolve", "--from", "-", "--resolution", "Named the support lead."], await command(readWork));
  await command(["begin", "--from", "-"], await command(readWork));
  const revisedBody = `The support lead owns urgent escalations. Source: ${source}`;
  const revision = await submit("handover-revision", revisedBody);
  const revisedId = revision.next.arguments.completionEventId;
  const packet = await review();
  assert.equal(packet.cliBasis.memberId, reviewer.identityId);
  assert.equal(packet.review.result.text.body, revisedBody);
  assert.equal(packet.review.completionEventId, revisedId);
  assert.equal(packet.review.correction?.summary, finding);
  assert.equal(packet.review.correction?.completionEventId, originalId);
  assert.equal(packet.review.correction?.nextRead.arguments.completionEventId, originalId);
  await command(["review", "--from", "-", "--pass", "--summary", "The excerpt names the support lead."], packet, reviewerProject);
  const reviewerClient = new RoomAgentClient({ origin, roomId: "commons", memberId: reviewer.identityId, token: reviewer.secret });
  const readResult = reviewerClient.workResult.bind(reviewerClient);
  reviewerClient.workResult = async (...args) => {
    const result = await readResult(...args);
    assert.equal(result.workThread.correction?.summary, finding);
    store.command(owner, "commons", { id: "remove-superseded-excerpt", type: "message.deleted",
      data: { messageId: first.review.result.text.messageId, expectedMessageRevision: 0 } });
    return result;
  };
  const duringRemoval = await readWorkSelection(reviewerClient, { workItemId, includeResult: true });
  assert.equal(duringRemoval.review.result.text.body, revisedBody);
  assert.equal(duringRemoval.review.correction, undefined);
  const afterRemoval = await review();
  assert.equal(afterRemoval.review.result.text.body, revisedBody);
  assert.equal(afterRemoval.review.correction, undefined);
});

for (const representation of ["legacy", "normalized-current-v1"])
test(`an invitation redeems into the first exact assignment and accepted result (${representation})`, async t => {
  const { cli, env, origin, owner, producer, reviewer, reviewerProject, rpc, save, store } = await fixture(t, representation);
  const mint = await fetch(`${origin}/api/rooms/commons/agent-invites`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${owner}` },
    body: JSON.stringify({ profile: "contribute", displayName: "New coworker" }),
  });
  assert.equal(mint.status, 201);
  const invitation = (await mint.json()).code;
  const lines = [];
  let redeemCalls = 0;
  let redeemStatus;
  const join = () => main(["join", `${origin}/join/${invitation}`, "--name", "New coworker", "--no-setup"], {
    env, out: line => lines.push(line),
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, origin);
      const response = await fetch(url, options);
      if (target.pathname === "/api/agent-invites/redeem" && ++redeemCalls === 1) {
        redeemStatus = response.status;
        await response.body.cancel();
        throw new Error("Redemption response was lost");
      }
      return response;
    },
  });
  await assert.rejects(join(), /Could not complete the request/);
  assert.equal(redeemStatus, 201);
  const afterRedemption = store.headSequence("commons");
  assert.equal(await join(), 0, lines.join("\n"));
  assert.equal(redeemCalls, 1);
  assert.equal(store.headSequence("commons"), afterRedemption, "resume must reuse the already redeemed membership");
  assert.ok(lines.every(line => !line.includes(invitation)), "successful join never echoes the invitation");
  const { config: saved } = loadConnection({ name: "new-coworker", env });
  assert.notEqual(saved.memberId, producer.identityId);
  setTier(store.db, "commons", saved.memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const send = (type, data) => store.command(owner, "commons", { id: crypto.randomUUID(), type, data });
  const source = "Use Friday's release brief at https://docs.example.test/release.";
  send("message.posted", { messageId: "coworker-first-source", toMemberId: saved.memberId, body: source });
  const workItemId = "first-coworker-task";
  send("work.proposed", { workItemId, title: "Update the release brief", definitionOfDone: "Name the date and the release owner",
    accountableMemberId: saved.memberId, verifierMemberId: reviewer.identityId, independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: "owner", sourceMessageId: "coworker-first-source", mode: "read" });

  const before = store.headSequence("commons");
  lines.length = 0;
  assert.equal(await join(), 0, lines.join("\n"));
  assert.ok(lines.every(line => !line.includes(invitation)), "resuming join never echoes the invitation");
  assert.equal(loadConnection({ name: "new-coworker", env }).config.memberId, saved.memberId);
  assert.equal(store.headSequence("commons"), before, "redemption resume does not create another membership");
  const prefix = ["--connection", "new-coworker"];
  assert.ok(lines.some(line => line.includes(`${prefix.join(" ")} next`)), lines.join("\n"));
  const command = async (argv, input, cwd) => {
    const result = await cli(argv, input, cwd, (url, options) => {
      assert.equal(new URL(url).origin, origin, "source reads must stay on the saved Room origin");
      return fetch(url, options);
    });
    assert.equal(result.code, 0, JSON.stringify(result.value));
    return result.value;
  };
  const pickup = await command([...prefix, "next"]);
  assert.equal(pickup.viewerId, saved.memberId);
  assert.deepEqual(pickup.nextRead.command, ["room", ...prefix, "work", "first-coworker-task"]);
  const selected = await command(pickup.nextRead.command.slice(1));
  assert.doesNotMatch(JSON.stringify(selected), /docs.example.test/);
  assert.deepEqual(selected.sourceRead.command, ["room", ...prefix, "work", "first-coworker-task", "--include-source"]);
  const packet = await command(selected.sourceRead.command.slice(1));
  assert.equal(packet.viewerId, saved.memberId);
  assert.equal(packet.context.source.message.body, source);
  assert.equal(store.headSequence("commons"), before, "pickup and source selection only read Room state");

  const defaultPickup = await command(["next"]);
  assert.equal(defaultPickup.viewerId, producer.identityId);
  assert.doesNotMatch(JSON.stringify(defaultPickup), /coworker-first-source|docs.example.test/);
  const defaultSource = await command(["work", workItemId, "--include-source"]);
  assert.equal(defaultSource.context.source.message, null);
  const action = [...prefix, "begin", "--from", "-"];
  assert.deepEqual(selected.continuation.command, ["room", ...action.slice(0, -1)]);
  let unexpectedCalls = 0;
  const wrongMember = await cli(["begin", "--from", "-"], selected, undefined, () => {
    unexpectedCalls++;
    throw new Error("Unexpected call");
  });
  assert.equal(wrongMember.code, 1);
  assert.equal(unexpectedCalls, 0, "another connection refuses the coworker's saved basis before making a request");
  const started = await cli(action, selected);
  assert.equal(started.code, 0, JSON.stringify(started.value));
  assert.equal(started.value.working, true);

  const readWork = () => command([...prefix, "work", workItemId]);
  const initialBasis = await readWork();
  const submission = body => ({ body, producerId: saved.memberId, summary: "Release brief excerpt", nextAction: "Review the release details" });
  const submitFrom = (basis, operation, body) => command([
    ...basis.submitCommand.slice(1), save(`${operation}.json`, basis), "--operation", operation
  ], submission(body));
  const first = await submitFrom(initialBasis, "brief-original", "Release date: Friday.");
  const firstId = first.next.arguments.completionEventId;
  assert.deepEqual(first.next.command, ["room", ...prefix, "result", workItemId, "--completion", firstId]);
  const ownResult = await command(first.next.command.slice(1));
  assert.equal(ownResult.viewerId, saved.memberId);
  assert.equal(ownResult.result.receipt.eventId, firstId);
  const readForReview = () => command(["work", workItemId, "--result"], undefined, reviewerProject);
  const beforeCorrection = await readForReview();
  assert.equal(beforeCorrection.cliBasis.memberId, reviewer.identityId);
  assert.equal(beforeCorrection.review.completionEventId, firstId);
  const finding = "Name the release owner in the excerpt.";
  await command(["review", "--from", "-", "--fail", "--summary", finding], beforeCorrection, reviewerProject);
  const corrected = await readWork();
  assert.match(corrected.brief, /Name the release owner in the excerpt/);
  await command([...corrected.continuation.command.slice(1), "-", "--resolution", "Named the release lead."], corrected);
  const ready = await readWork();
  await command([...ready.continuation.command.slice(1), "-"], ready);
  const newBasis = await readWork();
  const revisedBody = "Release date: Friday. Release owner: Maya.";
  const second = await submitFrom(newBasis, "brief-revised", revisedBody);
  const revisedId = second.next.arguments.completionEventId;
  assert.notEqual(revisedId, firstId);
  const beforeReplay = store.headSequence("commons");
  const replayed = await submitFrom(initialBasis, "brief-original", "Release date: Friday.");
  assert.equal(replayed.duplicate, true);
  assert.equal(replayed.currentStateVerified, false);
  assert.deepEqual(replayed.next.command, first.next.command);
  const earlier = await command(replayed.next.command.slice(1));
  assert.equal(earlier.result.receipt.eventId, firstId);
  assert.equal(earlier.selection.status, "historical");
  assert.equal(earlier.current.completionEventId, revisedId);
  assert.equal(earlier.cliBasis?.actions?.review, undefined);
  assert.equal(store.headSequence("commons"), beforeReplay, "recovering the old receipt adds no result or review event");
  const revised = await readForReview();
  assert.equal(revised.review.completionEventId, revisedId);
  assert.equal(revised.review.correction.completionEventId, firstId);
  assert.equal(revised.review.correction.summary, finding);
  await command(["review", "--from", "-", "--pass", "--summary", "The excerpt names Maya and Friday."], revised, reviewerProject);
  const decisionSourceId = "invite-journey-decision";
  send("message.posted", { messageId: decisionSourceId, body: "Accepted Maya's Friday release brief." });
  const approved = send("owner.decision_recorded", {
    workItemId, expectedRevision: (await readWork()).revision, decision: "approved", completionEventId: revisedId,
    sourceMessageId: decisionSourceId, evidenceVersion: textVersion(revisedBody), reason: "The reviewed brief names the owner."
  });
  const resultLink = exactResultHref({ roomId: "commons", workItemId, completionEventId: revisedId }, new URL(origin));
  const acceptedMessageId = (await command(second.next.command.slice(1))).result.text.messageId;
  assert.ok(acceptedMessageId);
  const firstMessageId = ownResult.result.text.messageId;
  send("message.posted", { messageId: "old-brief-discussion", replyToId: firstMessageId, body: "This comment belongs to the earlier result." });
  const continuation = await rpc("room_post_message", {
    id: "accepted-brief-discussion", replyToId: acceptedMessageId, body: "Use this accepted version for the release notes.", compact: true,
  }, reviewer);
  send("message.posted", { messageId: "private-brief-discussion", replyToId: acceptedMessageId,
    toMemberId: saved.memberId, body: "Private context for the author." });
  send("message.posted", { messageId: "later-room-chat", body: "This newer message belongs to the room timeline." });
  const beforeReturn = store.headSequence("commons");
  const cold = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../bin/room.mjs", import.meta.url)), "result", resultLink, "--discussion"], { cwd: reviewerProject, env });
  const reopened = JSON.parse(cold.stdout);
  assert.equal(reopened.viewerId, reviewer.identityId);
  assert.equal(reopened.result.receipt.eventId, revisedId);
  assert.equal(reopened.result.text.body, revisedBody);
  assert.equal(reopened.workThread.decisionSource.decisionEventId, approved.event.id);
  assert.equal(reopened.discussion.messageId, acceptedMessageId);
  assert.deepEqual(reopened.discussion.replies.map(reply => reply.id), [continuation.messageId]);
  const connector = await rpc(reopened.discussionRead.tool, reopened.discussionRead.arguments, reviewer);
  assert.equal(connector.completionEventId, revisedId);
  assert.deepEqual(connector.discussion, reopened.discussion);
  assert.doesNotMatch(JSON.stringify(reopened), /Private context for the author/);
  assert.equal(store.headSequence("commons"), beforeReturn, "return reads do not write");
  t.diagnostic(JSON.stringify({ representation, workItemId, originalCompletion: firstId,
    acceptedCompletion: revisedId, acceptedMessage: acceptedMessageId, acceptanceDecision: approved.event.id,
    visibleReplies: [continuation.messageId], privateDiscussionVisible: false, returnWrites: 0 }));

  store.identities.unlink(owner, "commons", saved.memberId);
  const revoked = await cli([...prefix, "work", "first-coworker-task", "--include-source", "--from", "-"], packet);
  assert.equal(revoked.code, 1);
  assert.doesNotMatch(JSON.stringify(revoked.value), /docs.example.test|not_modified/);
  assert.equal((await command(["next"])).viewerId, producer.identityId);
});

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
  const { store, owner, producer, reviewer, reviewerProject, origin, cli } = await fixture(t, representation);
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
  const read = await cli(brief.value.sourceRead.command.slice(1), undefined, undefined, async (url, options) => {
    assert.equal(new URL(url).origin, origin, "the Room read must never open the external document");
    return fetch(url, options);
  });
  assert.equal(read.code, 0, JSON.stringify(read));
  assert.equal(read.value.viewerId, producer.identityId);
  assert.equal(read.value.context.source.message.body, body);
  assert.match(read.value.context.source.guidance, /external link.*own account.*request access/i);
  assert.doesNotMatch(JSON.stringify(read), /Unrelated project discussion/);
  const refresh = ["work", workItemId, "--include-source", "--from", "-"];
  assert.deepEqual(read.value.context.source.cliRefresh.command, ["room", ...refresh]);
  const unchanged = await cli(refresh, read.value);
  assert.equal(unchanged.code, 0, JSON.stringify(unchanged));
  assert.equal(unchanged.value.context.source.status, "not_modified");
  assert.equal(unchanged.value.context.source.message, null);
  assert.doesNotMatch(JSON.stringify(unchanged), /docs.example.test/);
  const interrupted = await cli(refresh, read.value, undefined, async (_url, { body: request }) =>
    Response.json({ jsonrpc: "2.0", id: JSON.parse(request).id, result: { isError: true, structuredContent: {
      stopped: "unknown", roomId: "another-room", viewerId: "another-member", body: "unverified source",
    } } }));
  assert.deepEqual(interrupted, { code: 1, value: { status: "unavailable", code: "room_read_unavailable" } });
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
  const privateId = "private-assignment-reference";
  const privateBody = "Restricted reference at https://docs.example.test/reviewers-only.";
  store.command(owner, "commons", { id: privateId, type: "message.posted",
    data: { messageId: privateId, toMemberId: reviewer.identityId, body: privateBody } });
  const hiddenWorkId = "hidden-assignment";
  store.command(owner, "commons", { id: "hidden-proposal", type: "work.proposed", data: {
    workItemId: hiddenWorkId, title: "Review the fallback", definitionOfDone: "Use an accessible reference",
    accountableMemberId: producer.identityId, sourceMessageId: privateId, mode: "read",
  } });
  const hidden = await cli(["work", hiddenWorkId, "--include-source"]);
  assert.equal(hidden.code, 0, JSON.stringify(hidden));
  assert.equal(hidden.value.context.source.message, null);
  assert.equal(hidden.value.context.source.observation, null);
  assert.equal(hidden.value.context.source.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(hidden), /reviewers-only/);
  const hiddenBrief = await cli(["work", hiddenWorkId]);
  assert.equal(hiddenBrief.value.sourceRead, undefined);
  assert.ok(hiddenBrief.value.brief.includes(hidden.value.context.source.guidance));
  assert.match(hiddenBrief.value.brief, /Review the fallback/);
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
  assert.match(updated.value.brief, /assignment brief is still available.*accessible reference/i);
  assert.doesNotMatch(JSON.stringify(updated), /docs.example.test|Use the new document/);
  const retainedWithoutSource = await cli(["work", workItemId, "--since", updated.value.briefVersion]);
  assert.equal(retainedWithoutSource.value.briefUnchanged, true);
  assert.equal(retainedWithoutSource.value.sourceRead, undefined);
  assert.match(retainedWithoutSource.value.guidance, /assignment brief is still available.*accessible reference/i);
  assert.doesNotMatch(retainedWithoutSource.value.guidance, /Follow sourceRead/i);
  const deleted = await cli(refresh, changed.value);
  assert.equal(deleted.code, 0);
  assert.equal(deleted.value.context.source.status, "unavailable");
  assert.equal(deleted.value.context.source.cliRefresh, undefined);
  assert.ok(updated.value.brief.includes(deleted.value.context.source.guidance));
  assert.equal(deleted.value.context.source.guidance, hidden.value.context.source.guidance);
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
  assert.equal(shared.value.discussionRead.tool, exact.discussionRead.tool);
  assert.deepEqual(shared.value.discussionRead.arguments, exact.discussionRead.arguments);
  for (const offered of [undefined, {
    ...exact.discussionRead, arguments: { ...exact.discussionRead.arguments, completionEventId: "some-other-completion" },
  }]) {
    const fallback = await cli(["result", sharedUrl], undefined, reviewerProject, async (url, init) => {
      const response = await fetch(url, init);
      const wire = await response.json();
      wire.result.structuredContent.discussionRead = offered;
      return Response.json(wire);
    });
    assert.equal(fallback.code, 0);
    assert.equal(fallback.value.discussionRead.tool, undefined);
    assert.equal(fallback.value.discussionRead.path, shared.value.discussionRead.path);
    assert.deepEqual(fallback.value.discussionRead.command, shared.value.discussionRead.command);
  }
  const connectorRead = await rpc(shared.value.discussionRead.tool, shared.value.discussionRead.arguments);
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
  assert.deepEqual(review.value.review.workspaceArtifacts, [file]);
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
  const currentReview = await cli(["work", workItemId, "--result"], undefined, reviewerProject);
  assert.equal(currentReview.value.review.workspaceArtifacts, undefined, "no prior file joins the revised review");
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
  const acceptedReview = await cli(["work", workItemId, "--result"], undefined, reviewerProject);
  assert.equal((await cli(["review", "--from", "-", "--pass", "--summary", "The restored brief is ready."],
    acceptedReview.value, reviewerProject)).code, 0);
  const acceptedUrl = exactResultHref({ roomId: "commons", workItemId, completionEventId: reused.event.id }, new URL(origin));
  const accepted = await cli(["result", acceptedUrl, "--discussion"], undefined, reviewerProject);
  assert.equal(accepted.code, 0);
  assert.equal(accepted.value.review, undefined);
  const read = accepted.value.discussionRead;
  assert.deepEqual(read.arguments, { roomId: "commons", workItemId, completionEventId: reused.event.id });
  const thread = await rpc(read.tool, read.arguments, reviewer);
  assert.equal(thread.completionEventId, reused.event.id);
  assert.equal(thread.discussion.messageId, source.messageId);

  assert.equal(accepted.value.workThread.verdict.result, "pass");
  const continuation = { id: "accepted-brief-continuation", replyToId: thread.discussion.messageId,
    body: "I will cross-check the accepted brief against the repository notes.", compact: true };
  const posted = await rpc("room_post_message", continuation, reviewer);
  const repeated = await rpc("room_post_message", continuation, reviewer);
  assert.equal(posted.replyToId, source.messageId);
  assert.equal(posted.actorId, reviewer.identityId);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.eventId, posted.eventId);
  const reread = await rpc(read.tool, read.arguments, reviewer);
  assert.equal(reread.discussion.replies.filter(reply => reply.id === posted.messageId).length, 1);
  const afterReply = await cli(["result", acceptedUrl], undefined, reviewerProject);
  assert.deepEqual(afterReply.value.workThread.verdict, accepted.value.workThread.verdict);
  assert.deepEqual(afterReply.value.result.receipt, accepted.value.result.receipt);
  assert.equal(afterReply.value.current.workRevision, accepted.value.current.workRevision, "continuation only posts chat");

  for (const other of [sharedUrl.replace("room=commons", "room=other"), sharedUrl.replace(origin, "https://other.example")]) {
    let calls = 0;
    const refused = await cli(["result", other], undefined, reviewerProject, () => { calls++; throw new Error("unexpected call"); });
    assert.equal(refused.value.code, "room_selection_mismatch");
    assert.equal(calls, 0);
  }
  store.command(producer.secret, "commons", { id: "withdraw-accepted-source", type: "message.deleted",
    data: { messageId: source.messageId, expectedMessageRevision: 0 } });
  const withdrawn = await cli(["result", acceptedUrl], undefined, reviewerProject);
  assert.equal(withdrawn.value.discussionRead, undefined);
  const unavailable = await cli(read.command.slice(1), undefined, reviewerProject);
  assert.equal(unavailable.value.code, "result_discussion_unavailable");
  assert.equal(unavailable.value.discussion, undefined);
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
  const { origin, home, env, store, owner, producer, reviewer, reviewerProject, rpc, save, cli } = await fixture(t, representation);
  const prepare = async (workItemId, review = false) => {
    store.command(owner, "commons", { id: "propose-" + workItemId, type: "work.proposed", data: {
      workItemId, title: "Review the evidence", definitionOfDone: "Test the exact pickup",
      accountableMemberId: producer.identityId, mode: "read",
      independentVerificationRequired: review, ownerDecisionRequired: review,
      ...(review ? { verifierMemberId: reviewer.identityId, humanDecisionMakerId: "owner" } : {})
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
  const nativeReviewAction = async token => {
    const response = await fetch(`${origin}/api/rooms/commons/needs-me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    return (await response.json()).items.find(item => item.id === "needs-review")?.reviewAction;
  };
  if (representation !== "legacy") assert.equal(await nativeReviewAction(reviewer.secret), "verify");
  const followup = await cli(["work", "needs-review", "--result"], undefined, reviewerProject);
  const accepted = await cli(["review", "--from", "-", "--pass", "--summary", "Includes reconnect instructions"],
    followup.value, reviewerProject);
  assert.equal(accepted.code, 0, JSON.stringify(accepted));
  if (representation !== "legacy") {
    assert.equal(await nativeReviewAction(reviewer.secret), undefined);
    assert.equal(await nativeReviewAction(owner), "decide");
  }

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

test(`${representation} a newly attempted stale or closed submit is refused before any draft is posted`, async t => {
  const { home, env, store, owner, producer, rpc, cli } = await fixture(t, representation);

  const propose = workItemId => store.command(owner, "commons", { id: "propose-" + workItemId, type: "work.proposed", data: {
    workItemId, title: "Ship the fix", definitionOfDone: "Land the patch",
    accountableMemberId: producer.identityId, mode: "read",
    independentVerificationRequired: false, ownerDecisionRequired: false
  } });
  const begin = async workItemId => {
    propose(workItemId);
    const selected = (await cli(["work", workItemId])).value;
    assert.equal((await cli(["begin", "--from", "-"], selected)).value.working, true);
    return (await cli(["work", workItemId])).value;
  };
  const attempt = async (workItemId, operation, expectedRevision, fetchImpl = fetch) => {
    const calls = [];
    const outputs = [];
    const code = await main(["submit", workItemId, "--operation", operation], {
      cwd: home, env, out: value => outputs.push(JSON.parse(value)),
      stdin: Readable.from([JSON.stringify({ body: "Late contribution.", summary: "Did the work",
        nextAction: "Review it", producerId: producer.identityId, expectedRevision })]),
      fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body).params.name); return fetchImpl(url, init); }
    });
    assert.equal(outputs.length, 1);
    return { code, output: outputs[0], calls };
  };

  // Stale: a different operation (room_block_work) moves the item on after
  // this attempt's basis was read. The never-before-posted draft must be
  // refused, not recorded, and not left around for later reconciliation.
  const stale = await begin("stale-new-op");
  await rpc("room_block_work", { workItemId: "stale-new-op", reason: "Scope changed", nextAction: "Re-plan" });
  const beforeStale = store.headSequence("commons");
  const staleAttempt = await attempt("stale-new-op", "stale-new-op-attempt", stale.revision);
  assert.equal(staleAttempt.code, 1, JSON.stringify(staleAttempt));
  assert.equal(staleAttempt.output.status, "refused");
  assert.equal(staleAttempt.output.code, "stale_revision");
  assert.deepEqual(staleAttempt.calls, ["room_post_message"]);
  assert.equal(store.headSequence("commons"), beforeStale, "a stale new draft must not be recorded");
  assert.equal((await cli(["receipt", "stale-new-op-attempt", "--draft"])).value.status, "not_recorded");

  // Lost response: retrying the identical stale attempt (as if the first
  // reply never arrived) must stay refused on both storage backends, never
  // posting a draft merely because the client retried.
  const lostReplyStale = await attempt("stale-new-op", "stale-new-op-attempt", stale.revision,
    async (url, init) => { const response = await fetch(url, init); await response.arrayBuffer();
      throw new Error("simulated lost reply after server handled request"); });
  assert.equal(lostReplyStale.output.status, "unknown");
  assert.equal(store.headSequence("commons"), beforeStale, "the uncertain stale attempt recorded nothing either");
  const recoveredStale = await attempt("stale-new-op", "stale-new-op-attempt", stale.revision);
  assert.equal(recoveredStale.output.status, "refused");
  assert.equal(recoveredStale.output.code, "stale_revision");
  assert.equal(store.headSequence("commons"), beforeStale, "the retried stale attempt still recorded nothing");

  // Closed: a different, already-recorded operation completes the item
  // first. A second, brand-new operation holding the pre-completion
  // revision is a newly attempted result against a closed item, and must
  // not post a draft either.
  const closed = await begin("closed-new-op");
  const finishedFirst = await attempt("closed-new-op", "closed-new-op-first", closed.revision);
  assert.equal(finishedFirst.code, 0, JSON.stringify(finishedFirst));
  assert.deepEqual(finishedFirst.calls, ["room_post_message", "room_submit_text_result"]);
  const beforeClosed = store.headSequence("commons");
  const closedAttempt = await attempt("closed-new-op", "closed-new-op-second", closed.revision);
  assert.equal(closedAttempt.output.status, "refused");
  assert.equal(closedAttempt.output.code, "stale_revision");
  assert.deepEqual(closedAttempt.calls, ["room_post_message"]);
  assert.equal(store.headSequence("commons"), beforeClosed, "a closed item must not accept a fresh draft");
  assert.equal((await cli(["receipt", "closed-new-op-second", "--draft"])).value.status, "not_recorded");

  const upgraded = await begin("upgrade-during-retry");
  const lostLegacyPost = await attempt("upgrade-during-retry", "legacy-retry", upgraded.revision, async (url, init) => {
    const request = JSON.parse(init.body);
    delete request.params.arguments.expectedRevision;
    const response = await fetch(url, { ...init, body: JSON.stringify(request) });
    await response.arrayBuffer();
    throw new Error("Lost legacy draft receipt");
  });
  assert.equal(lostLegacyPost.output.status, "unknown");
  const originalPost = (await cli(["receipt", "legacy-retry", "--draft"])).value;
  assert.equal(originalPost.status, "recorded");
  const resumed = await attempt("upgrade-during-retry", "legacy-retry", upgraded.revision);
  assert.equal(resumed.output.status, "recorded");
  assert.deepEqual(resumed.calls, ["room_post_message", "room_read_result", "room_submit_text_result"]);
  assert.equal((await cli(["receipt", "legacy-retry", "--draft"])).value.eventId, originalPost.eventId);

  const legacy = await begin("previous-room");
  const oldServer = async (url, init) => {
    const frame = JSON.parse(init.body);
    if (frame.params.name === "room_post_message" && frame.params.arguments.expectedRevision !== undefined)
      return Response.json(mcpCallError(frame.id, { tool: frame.params.name, reason: "invalid_arguments", unexpected: ["expectedRevision"] }));
    return fetch(url, init);
  };
  const beforeAmbiguous = store.headSequence("commons");
  const ambiguous = await attempt("previous-room", "ambiguous-frame", legacy.revision, async (url, init) => {
    const frame = await (await oldServer(url, init)).json();
    return Response.json({ ...frame, result: { structuredContent: { contractVersion: 1, status: "posted" } } });
  });
  assert.equal(ambiguous.output.status, "unknown");
  assert.deepEqual(ambiguous.calls, ["room_post_message"]);
  assert.equal(store.headSequence("commons"), beforeAmbiguous);

  const oldValid = await attempt("previous-room", "old-valid", legacy.revision, oldServer);
  assert.equal(oldValid.output.status, "recorded", JSON.stringify(oldValid));
  const oldHead = store.headSequence("commons");
  const oldStale = await attempt("previous-room", "old-stale", legacy.revision, oldServer);
  assert.equal(oldStale.output.code, "result_draft_unavailable");
  assert.equal(store.headSequence("commons"), oldHead);

  const currentClosed = (await cli(["work", "closed-new-op"])).value;
  const beforeLate = store.headSequence("commons");
  const late = await attempt("closed-new-op", "closed-at-current", currentClosed.revision);
  assert.equal(late.output.status, "refused");
  assert.equal(store.headSequence("commons"), beforeLate, JSON.stringify(late.output));
  assert.equal((await cli(["receipt", "closed-at-current", "--draft"])).value.status, "not_recorded");

  // Ordinary room chat (no workItemId, so no expectedRevision applies) keeps
  // posting normally, even right after the refusals above.
  const chat = await rpc("room_post_message", { id: "plain-chat-1", body: "Status update for everyone." });
  assert.equal(chat.status, "posted");
  assert.equal(chat.event.data.workItemId, undefined);
});

test(`${representation} a fresh CLI finds its answered request and file without a saved link`, async t => {
  const { home, env, origin, store, producer, reviewer, reviewerProject, cli, rpc } = await fixture(t, representation);
  const open = id => store.command(reviewer.secret, "commons", { id: `open-${id}`, type: "message.posted",
    data: { messageId: id, toMemberId: producer.identityId, requestKind: "reply", body: "Please share the review." } });
  const target = "z-review-request";
  open(target);
  const read = await rpc("room_read_request", { requestMessageId: target });
  const answer = await rpc("room_respond_to_request", { ...read.responseActions[0].arguments,
    requestId: "review-18", body: "The review is ready." });
  let now = store.now();
  store.now = () => now;
  for (let i = 0; i < 35; i++) {
    now += 3000;
    open(`a-queued-${String(i).padStart(2, "0")}`);
  }
  const bytes = Buffer.from("Review result for the requester.");
  const { attachment } = store.roomAttachments.stage(producer.secret, "commons", {
    id: "review-file", filename: "review.md", mediaType: "text/markdown", data: bytes.toString("base64")
  });
  store.roomAttachments.commit(producer.secret, "commons", { id: attachment.id, messageId: answer.messageId });
  const before = store.headSequence("commons");

  const executable = fileURLToPath(new URL("../bin/room.mjs", import.meta.url));
  const fresh = async (args, cwd = reviewerProject) => {
    const { stdout } = await promisify(execFile)(process.execPath, [executable, ...args],
      { cwd, env, timeout: 5000 });
    return JSON.parse(stdout);
  };
  let page = await fresh(["request", "--answered"]);
  const initial = page;
  if (representation === "normalized-current-v1") {
    assert.deepEqual(page.requests, []);
    assert.equal(page.page.hasMore, true);
    assert.deepEqual(page.nextCommand.slice(0, 4), ["room", "request", "--answered", "--cursor"]);
    const mismatched = await cli(page.nextCommand.slice(1), undefined, home);
    assert.equal(mismatched.code, 1);
    assert.equal(mismatched.value.code, "reply_cursor_identity_changed");
    assert.deepEqual(mismatched.value.restartCommand, ["room", "request", "--answered"]);
  }
  const discoveries = [...page.requests];
  for (let followed = 0; page.nextCommand && followed < 5; followed++) {
    page = await fresh(page.nextCommand.slice(1));
    discoveries.push(...page.requests);
  }
  assert.equal(page.nextCommand, undefined);
  assert.equal(discoveries.length, 1);
  const selected = await fresh(discoveries[0].command.slice(1));
  assert.equal(selected.request.id, target);
  assert.equal(selected.request.responseMessageId, answer.messageId);
  const headers = { Authorization: "Bearer " + reviewer.secret };
  const listing = await fetch(new URL(selected.answerFilesRead.http.path, origin), { headers });
  assert.equal(listing.status, 200);
  const files = (await listing.json()).files;
  assert.deepEqual(files.map(file => [file.messageId, file.sha256]), [[answer.messageId, attachment.sha256]]);
  const file = await fetch(origin + "/api/rooms/commons/files/" + files[0].id, { headers });
  assert.deepEqual(Buffer.from((await file.json()).attachment.data, "base64"), bytes);
  assert.equal(initial.viewerId, reviewer.identityId);

  // Run the returned commands from the producer's checkout with the requester
  // explicitly selected. Losing that selection must not silently switch seats.
  let namedPage = await fresh(["--connection", "reviewer", "request", "--answered"], home);
  const namedDiscoveries = [];
  for (let followed = 0; followed < 6; followed++) {
    assert.equal(namedPage.viewerId, reviewer.identityId);
    namedDiscoveries.push(...namedPage.requests);
    if (!namedPage.nextCommand) break;
    assert.deepEqual(namedPage.nextCommand.slice(0, 3), ["room", "--connection", "reviewer"]);
    namedPage = await fresh(namedPage.nextCommand.slice(1), home);
  }
  assert.equal(namedDiscoveries.length, 1);
  assert.deepEqual(namedDiscoveries[0].command.slice(0, 3), ["room", "--connection", "reviewer"]);
  const namedSelected = await fresh(namedDiscoveries[0].command.slice(1), home);
  assert.equal(namedSelected.answerFilesRead.http.path, selected.answerFilesRead.http.path);
  assert.equal(store.headSequence("commons"), before);
});

test(`${representation} shares one staged file on a recovered CLI answer without posting another answer`, async t => {
  const { home, origin, store, owner, producer, reviewer, reviewerProject, cli, rpc } = await fixture(t, representation);
  const opening = await rpc("room_request_reply", { requestId: "file-question",
    toMemberId: producer.identityId, body: "Please share the decision brief." }, reviewer);
  const basis = await cli(["read", opening.requestMessageId]);
  const text = join(home, "brief-answer.txt");
  writeFileSync(text, "Here is the decision brief.", { mode: 0o600 });
  const answered = await cli(["answer", opening.requestMessageId, "--from", "-", "--body-file", text],
    basis.value, home, async (url, init) => {
      const response = await fetch(url, init);
      if (JSON.parse(init.body).params.name === "room_respond_to_request") {
        await response.arrayBuffer();
        throw new Error("Answer response lost after commit");
      }
      return response;
    });
  assert.equal(answered.code, 0, JSON.stringify(answered));
  assert.equal(answered.value.recoveredFromReceipt, true);
  const answerSequence = store.headSequence("commons");
  const brief = Buffer.from("The steering group accepted the proposal.");
  const { attachment } = store.roomAttachments.stage(producer.secret, "commons", {
    id: "retained-decision-brief", filename: "decision-brief.md", mediaType: "text/markdown", data: brief.toString("base64")
  });
  const share = ["answer", opening.requestMessageId, "--share-staged-file", attachment.id, "--sha256", attachment.sha256];
  const reviewedFile = () => fetch(origin + "/api/rooms/commons/files/" + attachment.id,
    { headers: { Authorization: "Bearer " + reviewer.secret } });
  assert.equal((await reviewedFile()).status, 404);
  let commits = 0;
  const trace = async (url, init) => {
    const target = new URL(url);
    if (init.method === "POST") {
      assert.ok(target.pathname.endsWith("/commit"), "file recovery never writes an answer");
      assert.deepEqual(JSON.parse(init.body), { messageId: answered.value.messageId });
      commits++;
      const response = await fetch(url, init);
      if (commits === 1) {
        await response.arrayBuffer();
        throw new Error("File response lost after commit");
      }
      return response;
    }
    return fetch(url, init);
  };
  const wrongDigest = await cli([...share.slice(0, -1), "0".repeat(64)], undefined, home, trace);
  assert.equal(wrongDigest.value.code, "attachment_digest_mismatch");
  const otherActor = await cli(share, undefined, reviewerProject, trace);
  assert.equal(otherActor.code, 1);
  assert.equal(commits, 0);
  const uncertain = await cli(share, undefined, home, trace);
  assert.equal(uncertain.value.status, "file_pending", JSON.stringify(uncertain));
  assert.equal(uncertain.value.attachment.messageId, answered.value.messageId);
  const finished = await cli(share, undefined, home, trace);
  assert.equal(finished.code, 0, JSON.stringify(finished));
  assert.deepEqual(finished.value.attachment, {
    fileId: attachment.id, messageId: answered.value.messageId, sha256: attachment.sha256, state: "shared"
  });
  assert.equal(commits, 2);
  assert.equal(store.headSequence("commons"), answerSequence);
  const received = await reviewedFile();
  assert.equal(received.status, 200);
  const saved = (await received.json()).attachment;
  assert.equal(saved.messageId, answered.value.messageId);
  assert.equal(saved.sha256, attachment.sha256);
  assert.deepEqual(Buffer.from(saved.data, "base64"), brief);
  const outside = await fetch(origin + "/api/rooms/commons/files/" + attachment.id,
    { headers: { Authorization: "Bearer " + owner } });
  assert.equal(outside.status, 404);

  const { attachment: late } = store.roomAttachments.stage(producer.secret, "commons", {
    id: "brief-after-withdrawal", filename: attachment.filename, mediaType: attachment.mediaType,
    data: brief.toString("base64")
  });
  const refused = await cli(["answer", opening.requestMessageId, "--share-staged-file", late.id, "--sha256", late.sha256],
    undefined, home, (url, init) => {
      if (init.method === "POST") {
        assert.ok(new URL(url).pathname.endsWith("/commit"));
        store.command(producer.secret, "commons", { id: "withdraw-brief-answer", type: "message.deleted",
          data: { messageId: answered.value.messageId, expectedMessageRevision: 0 } });
      }
      return fetch(url, init);
    });
  assert.equal(refused.value.status, "refused");
  assert.equal(refused.value.code, "message_not_found");
  assert.equal(store.roomAttachments.get(producer.secret, "commons", late.id).attachment.state, "staged");
  assert.equal((await reviewedFile()).status, 410);
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
