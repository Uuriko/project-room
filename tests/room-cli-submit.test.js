import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workspaceArtifactLink } from "../src/workspace-artifact-link.js";
import { exactResultHref } from "../src/record-link.js";
import { main } from "../cli/main.mjs";
import { connectionHome, connectionsRoot, loadConnection, writePointer, writeProject } from "../cli/paths.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { mcpCallError } from "../server/mcp-arg-errors.mjs";
import { textVersion } from "../server/text-results.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event, EVENT_TYPES as T } from "../src/events.js";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

async function fixture(t, representation, { sinceJoin = false, serverSource } = {}) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "room-submit-"));
  const env = { HOME: home, PROJECT_ROOM_KEYCHAIN: "0" };
  const Storage = serverSource
    ? (await import(pathToFileURL(join(serverSource, "server/store.mjs")).href)).RoomStore : RoomStore;
  const makeServer = serverSource
    ? (await import(pathToFileURL(join(serverSource, "server/http.mjs")).href)).createRoomServer : createRoomServer;
  const store = new Storage(join(home, "fixture.sqlite"));
  const seed = initialRoom();
  if (sinceJoin) seed.push(event({ type: T.ROOM_HISTORY_VISIBILITY_SET, actorId: "owner", roomId: "commons",
    data: { historyVisibility: "since_join" } }));
  store.initialize(seed, representation === "legacy" ? {} : { representation });
  const owner = store.issueAccessKey("commons", "owner");
  const producer = store.identities.create("Producer");
  linkWithProof(store, owner, "commons", producer, {
    displayName: "Producer", permissions: ["accept_work", "complete_work"]
  });
  setTier(store.db, "commons", producer.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const server = makeServer({ store });
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
      cwd, env, fetchImpl, fetch: fetchImpl, stdin: Readable.from(input === undefined ? [] : [JSON.stringify(input)]),
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
test(`${representation} a coworker joins despite conflicting Codex settings and opens their first assignment`, async t => {
  const { cli, env, home, origin, owner, reviewer, reviewerProject, save, store } = await fixture(t, representation);
  const mint = await fetch(`${origin}/api/rooms/commons/agent-invites`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${owner}` },
    body: JSON.stringify({ profile: "contribute", displayName: "New coworker" })
  });
  assert.equal(mint.status, 201);
  const { code: invitation } = await mint.json();
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome);
  const config = join(codexHome, "config.toml");
  const originalConfig = '[mcp_servers.project-room]\nurl = "https://original.example/mcp"\n';
  writeFileSync(config, originalConfig);
  const joinArgs = ["join", `${origin}/join/${invitation}`, "--name", "New coworker", "--tool", "codex"];
  const beforeConflict = store.headSequence("commons");
  const lines = [];
  let networkCalls = 0;
  await assert.rejects(main(joinArgs, { env, cwd: reviewerProject, out: line => lines.push(line),
    fetchImpl: async () => { networkCalls++; throw new Error("Unexpected preflight request"); } }), error => {
    assert.match(error.message, /repeat your join command with --no-setup/i);
    assert.equal(error.message.includes(invitation), false);
    return true;
  });
  assert.equal(networkCalls, 0);
  assert.equal(store.headSequence("commons"), beforeConflict);

  let redeemCalls = 0, redeemStatus;
  const joinWithoutSetup = () => main([...joinArgs, "--no-setup"], {
    env, cwd: reviewerProject, out: line => lines.push(line),
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
    }
  });
  await assert.rejects(joinWithoutSetup(), /Could not complete the request/);
  assert.equal(redeemStatus, 201);
  const afterRedemption = store.headSequence("commons");
  assert.equal(await joinWithoutSetup(), 0);
  assert.equal(redeemCalls, 1);
  assert.equal(store.headSequence("commons"), afterRedemption);
  assert.equal(readFileSync(config, "utf8"), originalConfig);
  assert.ok(lines.every(line => !line.includes(invitation)));
  const printed = lines.map(line => line.match(/project-room --connection ([a-z-]+) next and follow nextRead\.command\./)).find(Boolean);
  assert.ok(printed);
  const { config: saved } = loadConnection({ name: printed[1], env });
  assert.notEqual(saved.memberId, reviewer.identityId);
  setTier(store.db, "commons", saved.memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const send = (type, data) => store.command(owner, "commons", { id: crypto.randomUUID(), type, data });
  const body = "Use Friday’s release brief at https://docs.example.test/release.";
  const sourceMessageId = "first-brief-source", workItemId = "first-brief-assignment";
  send("message.posted", { messageId: sourceMessageId, toMemberId: saved.memberId, body });
  send("work.proposed", { workItemId, sourceMessageId, title: "Update the release brief", definitionOfDone: "Name the release owner",
    accountableMemberId: saved.memberId, verifierMemberId: reviewer.identityId, independentVerificationRequired: true, mode: "read" });
  const command = async (argv, input) => {
    const result = await cli(argv, input, reviewerProject, (url, options) => {
      assert.equal(new URL(url).origin, origin);
      return fetch(url, options);
    });
    assert.equal(result.code, 0, JSON.stringify(result.value));
    return result.value;
  };
  const explicit = ["--connection", printed[1]];
  const next = await command([...explicit, "next"]);
  assert.equal(next.viewerId, saved.memberId);
  assert.deepEqual(next.nextRead.command, ["room", ...explicit, "work", workItemId]);
  const brief = await command(next.nextRead.command.slice(1));
  const evidence = await command(brief.sourceRead.command.slice(1));
  assert.equal(evidence.context.source.message.body, body);
  assert.equal((await command(["next"])).viewerId, reviewer.identityId);
  assert.equal((await command(["work", workItemId, "--include-source"])).context.source.message, null);

  await command([...brief.continuation.command.slice(1), "-"], brief);
  const working = await command([...explicit, "work", workItemId]);
  const result = await command([...explicit, "submit", "--from", save("first-brief.json", working), "--operation", "first-brief-result"], {
    body: "Maya owns Friday’s release.", producerId: saved.memberId, summary: "Named the owner", nextAction: "Review the brief" });
  const review = await command(["work", workItemId, "--result"]);
  await command(["review", "--from", "-", "--pass", "--summary", "Confirmed the owner"], review);
  const receipt = await command([...explicit, "receipt", "first-brief-result", "--submit"]);
  assert.equal(receipt.eventId, result.completionEventId);
  const reopened = await command(receipt.nextRead.command.slice(1));
  assert.equal(reopened.workThread.verdict.completionEventId, receipt.eventId);
  assert.equal(reopened.workThread.verdict.result, "pass");
});

test(`${representation} a configured join prints a pickup read for the same agent from another checkout`, async t => {
  const { cli, env, home, origin, owner, reviewer, reviewerProject, store } = await fixture(t, representation);
  const invite = await fetch(`${origin}/api/rooms/commons/agent-invites`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${owner}` },
    body: JSON.stringify({ profile: "contribute", displayName: "Phone release helper" })
  });
  assert.equal(invite.status, 201);
  const { code } = await invite.json();
  const project = join(home, "release project");
  mkdirSync(project);
  const lines = [];
  const joined = await main(["join", `${origin}/join/${code}`, "--name", "Phone release helper", "--tool", "generic", "--project", project],
    { cwd: reviewerProject, env, out: line => lines.push(line), err: line => lines.push(line) });
  assert.equal(joined, 0);
  const alias = "phone-release-helper";
  const config = loadConnection({ project, env });
  assert.equal(config.name, alias);
  assert.notEqual(config.config.memberId, reviewer.identityId);
  const pickup = lines.map(line => line.match(/project-room --connection ([a-z-]+) next and follow nextRead\.command/)).find(Boolean);
  assert.equal(pickup?.[1], alias);
  assert.ok(lines.every(line => !line.includes(code)));
  const exactConnection = ["--connection", pickup[1]];
  setTier(store.db, "commons", config.config.memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const joinedThrough = store.headSequence("commons");
  const waiting = await cli([...exactConnection, "next"], undefined, reviewerProject);
  assert.equal(waiting.value.viewerId, config.config.memberId);
  assert.equal(waiting.value.work.items.length, 0);
  assert.equal(store.headSequence("commons"), joinedThrough);

  const workItemId = "phone-release-note";
  store.command(owner, "commons", { id: "assign-release-note", type: T.WORK_PROPOSED, data: {
    workItemId, title: "Write Friday’s release note", definitionOfDone: "Name the owner",
    accountableMemberId: config.config.memberId, mode: "read"
  } });
  const assignedThrough = store.headSequence("commons");
  const next = await cli([...exactConnection, "next"], undefined, reviewerProject);
  assert.equal(next.value.viewerId, config.config.memberId);
  assert.deepEqual(next.value.nextRead.command, ["room", ...exactConnection, "work", workItemId]);
  const work = await cli(next.value.nextRead.command.slice(1), undefined, reviewerProject);
  assert.equal(work.value.continuation.action, "accept");
  assert.equal(store.headSequence("commons"), assignedThrough, "the first assignment read does not start work");
  const started = await cli([...work.value.continuation.command.slice(1), "-"], work.value, reviewerProject);
  assert.equal(started.value.working, true);
  assert.equal((await cli(["next"], undefined, reviewerProject)).value.viewerId, reviewer.identityId);
});

test(`${representation} a denied document read leads to one private request and returns its answer on the original assignment`, async t => {
  const { store, owner, producer, reviewer, reviewerProject, env, origin, rpc, cli } = await fixture(t, representation);
  const providerReads = [];
  const docs = createServer((request, response) => {
    providerReads.push(request.headers.authorization);
    if (request.url === "/shared/revision/7" && request.headers.authorization === "Bearer coworker-docs-fixture") {
      response.writeHead(200).end("Release note revision 7");
      return;
    }
    response.writeHead(403).end();
  });
  await new Promise(resolve => docs.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => docs.close(resolve)));
  const url = `http://127.0.0.1:${docs.address().port}/revision/7`;
  const workItemId = "document-review";
  const sourceId = "document-source";
  const send = (id, type, data) => store.command(owner, "commons", { id, type, data });
  send("document-link", T.MESSAGE_POSTED, { messageId: sourceId, body: `Review ${url}`, toMemberId: producer.identityId });
  send("document-assignment", T.WORK_PROPOSED, {
    workItemId, title: "Review the release note", definitionOfDone: "Verify the date",
    sourceMessageId: sourceId, accountableMemberId: producer.identityId, verifierMemberId: reviewer.identityId, mode: "read"
  });
  const head = store.headSequence("commons");
  const next = await rpc("room_next", { view: "pickup" });
  const brief = await rpc(next.nextRead.tool, next.nextRead.arguments);
  const read = () => rpc(brief.sourceRead.tool, brief.sourceRead.arguments);
  const work = await read();
  assert.equal(work.context.source.message.body, `Review ${url}`);
  assert.deepEqual(providerReads, []);
  const response = await fetch(url, { headers: { Authorization: "Bearer coworker-docs-fixture" } });
  assert.equal(response.status, 403);
  assert.deepEqual(providerReads, ["Bearer coworker-docs-fixture"]);
  const action = work.context.source.referenceRequest;
  assert.equal(action?.tool, "room_request_reply");
  assert.deepEqual(action.arguments, {
    roomId: "commons", workItemId, toMemberId: "owner", assignmentSource: { messageId: sourceId, revision: 0 }
  });
  const local = await cli(["work", workItemId, "--include-source"]);
  assert.deepEqual(local.value.context.source.referenceRequest.arguments, action.arguments);
  assert.equal(store.headSequence("commons"), head);
  assert.equal((await rpc("room_read_work", { workItemId, includeSource: true }, reviewer)).context.source.referenceRequest, undefined);

  send("document-update", T.MESSAGE_EDITED, { messageId: sourceId, expectedMessageRevision: 0, body: `Review revision 7 at ${url}` });
  const editedThrough = store.headSequence("commons");
  const body = "My document account cannot open revision 7. Could you share an accessible reference?";
  const stale = await fetch(`${origin}/mcp`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${producer.secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: action.tool, arguments: { ...action.arguments, body, requestId: "stale-document-access" }
    } })
  });
  assert.match(JSON.stringify(await stale.json()), /source_reference_changed/);
  assert.equal(store.headSequence("commons"), editedThrough);

  const updated = (await read()).context.source.referenceRequest;
  assert.equal(updated.arguments.assignmentSource.revision, 1);
  const args = { ...updated.arguments, body, requestId: "document-access" };
  const sent = await rpc(updated.tool, args);
  assert.equal(sent.status, "recorded");
  send("document-permissions-note", T.MESSAGE_EDITED, { messageId: sourceId, expectedMessageRevision: 1, body: `Still review ${url}` });
  const retryThrough = store.headSequence("commons");
  const retry = await rpc(updated.tool, args);
  assert.equal(retry.requestMessageId, sent.requestMessageId);
  assert.equal(retry.duplicate, true);
  assert.equal(store.headSequence("commons"), retryThrough);
  const query = new URLSearchParams({ requestMessageId: sent.requestMessageId, view: "full" });
  const requestPath = new URL("/api/rooms/commons/reply-context", origin);
  requestPath.search = query;
  const readRequest = secret => fetch(requestPath, { headers: { Authorization: `Bearer ${secret}` } });
  const assignerRead = await readRequest(owner);
  assert.equal(assignerRead.status, 200);
  const exchange = await assignerRead.json();
  assert.equal(exchange.request.workItemId, workItemId);
  assert.equal(exchange.request.requesterId, producer.identityId);
  assert.equal(exchange.request.recipientId, "owner");
  assert.match(JSON.stringify(exchange), /My document account cannot open revision 7/);
  assert.doesNotMatch(JSON.stringify(exchange), /coworker-docs-fixture/);
  assert.equal((await readRequest(reviewer.secret)).status, 404);
  assert.deepEqual(providerReads, ["Bearer coworker-docs-fixture"]);
  const after = await rpc("room_read_work", { workItemId });
  assert.equal(after.continuation.action, "accept");
  assert.equal(after.work.receipt, null);
  assert.equal(after.replyRequestContext.latestAnswer, undefined);
  const cachedBeforeAnswer = await cli(["work", workItemId]);

  const history = async ({ checkpoint } = {}) => {
    const items = [];
    let cursor;
    do {
      const { page } = await rpc("room_request_history", { direction: "outgoing", limit: 1,
        ...(cursor ? { cursor } : checkpoint ? { checkpoint } : {}) });
      items.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) return { items, checkpoint: page.completedCheckpoint };
    } while (cursor);
  };
  const beforeOffline = await history();
  assert.ok(beforeOffline.checkpoint);
  send("offline-unrelated-note", T.MESSAGE_POSTED, { messageId: "offline-unrelated-note", body: "Unrelated note" });
  const responseBasis = exchange.current.answerBasis;
  const replacement = new URL("/shared/revision/7", url).href;
  const answer = send("share-accessible-reference", T.MESSAGE_POSTED, {
    messageId: "accessible-document", body: `Use the accessible copy of revision 7 at ${replacement}`,
    replyToId: sent.requestMessageId, responseToRequestId: sent.requestMessageId,
    responseOutcome: "answered", expectedRequestRevision: responseBasis.expectedRequestRevision,
    contextEventId: responseBasis.contextEventId, contextSequence: responseBasis.contextSequence,
    toMemberId: producer.identityId, workItemId
  });
  assert.deepEqual(answer.wakeDelivery, [{ memberId: producer.identityId, status: "queued" }]);
  const authorization = { Authorization: `Bearer ${producer.secret}` };
  const hostId = "returning-coworker";
  const registration = await fetch(`${origin}/api/agent-heartbeats`, { method: "POST",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ hostId, mode: "pull-only", listenerLease: { roomId: "commons" } })
  });
  assert.equal(registration.status, 200);
  assert.equal((await registration.json()).listener.acquired, true);
  const poll = await fetch(`${origin}/api/agent-wakes/poll?hostId=${hostId}&roomId=commons&waitMs=0`, { headers: authorization });
  assert.equal(poll.status, 200);
  const { pendingWakes } = await poll.json();
  const returnedWakes = pendingWakes.filter(wake => wake.messageId === "accessible-document");
  assert.deepEqual(returnedWakes.map(wake => wake.kind), ["dm"]);
  const answeredThrough = store.headSequence("commons");
  const replayed = await history({ checkpoint: beforeOffline.checkpoint });
  assert.deepEqual(replayed.items.map(row => [row.kind, row.requestMessageId, row.workItemId]),
    [["answered", sent.requestMessageId, workItemId]]);
  assert.deepEqual((await history({ checkpoint: replayed.checkpoint })).items, []);
  const recovered = await rpc("room_read_request", { requestMessageId: replayed.items[0].requestMessageId });
  assert.equal(recovered.request.responseMessageId, "accessible-document");
  assert.equal(recovered.current.answerBasis, null);
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../bin/room.mjs", import.meta.url)), "--connection", "producer", "work", workItemId], { cwd: reviewerProject, env });
  const reopened = JSON.parse(stdout);
  const returned = reopened.latestAnswer;
  assert.notEqual(reopened.briefVersion, cachedBeforeAnswer.value.briefVersion);
  assert.deepEqual(returned?.nextRead, { tool: "room_read_request",
    arguments: { roomId: "commons", requestMessageId: sent.requestMessageId } });
  assert.equal(returned.recipientId, "owner");
  assert.doesNotMatch(stdout, /accessible copy of revision 7|\/shared\/revision\/7/);
  const unchanged = await cli(["work", workItemId, "--since", reopened.briefVersion]);
  assert.equal(unchanged.value.briefUnchanged, true);
  assert.deepEqual(unchanged.value.latestAnswer, returned);
  const supplied = await rpc(returned.nextRead.tool, returned.nextRead.arguments);
  assert.equal(supplied.request.status, "answered");
  assert.equal(supplied.request.workItemId, workItemId);
  assert.equal(supplied.request.responseMessageId, "accessible-document");
  assert.ok(JSON.stringify(supplied).includes(replacement));
  const external = await fetch(replacement, { headers: { Authorization: "Bearer coworker-docs-fixture" } });
  assert.equal(await external.text(), "Release note revision 7");
  assert.deepEqual(providerReads, ["Bearer coworker-docs-fixture", "Bearer coworker-docs-fixture"]);
  const currentWork = await rpc("room_read_work", { workItemId, includeSource: true });
  assert.equal(currentWork.continuation.action, "accept");
  assert.equal(currentWork.context.source.message.body, `Still review ${url}`);
  assert.equal(currentWork.work.receipt, null);
  assert.equal((await rpc("room_read_work", { workItemId }, reviewer)).replyRequestContext.latestAnswer, undefined);
  assert.equal(store.headSequence("commons"), answeredThrough);
});

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
  const { env, origin, store, owner, producer, reviewer, reviewerProject, cli, rpc } = await fixture(t, representation, { sinceJoin: true });
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
  assert.deepEqual(file.command, ["room", "workspace", "changes", "--link", fileLink, "--connection", "reviewer", "--viewer", reviewer.identityId]);
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
  assert.deepEqual(lateFile.command, ["room", "workspace", "changes", "--link", lateLink, "--connection", "reviewer", "--viewer", reviewer.identityId]);
  const lateChanges = await cli(lateFile.command.slice(1), undefined, reviewerProject);
  assert.equal(lateChanges.value.file.hunks[0].changes.at(-1).content, "replaced");
  const otherRoom = await fixture(t, representation);
  const otherDirectory = connectionHome("other-room", env);
  const otherCheckout = join(reviewerProject, "other-checkout");
  saveAgentConnection(otherDirectory, { version: 1, origin: otherRoom.origin, roomId: "commons",
    memberId: otherRoom.reviewer.identityId, token: otherRoom.reviewer.secret });
  writePointer("other-room", otherDirectory, env);
  writeProject(otherCheckout, { connection: "other-room" });
  const defaultPickup = await cli(["next"], undefined, otherCheckout);
  assert.equal(defaultPickup.value.viewerId, otherRoom.reviewer.identityId);
  const sourceId = "follow-up-evidence", taskId = "follow-up-review";
  store.command(owner, "commons", { id: "follow-up-note", type: "message.posted", data: {
    messageId: sourceId, toMemberId: reviewer.identityId,
    body: ["Compare the revised document with the code.", lateLink, revisedUrl, revisedUrl,
      revisedUrl.replace(origin, otherRoom.origin), "https://docs.example.test/appendix"].join("\n") } });
  store.command(owner, "commons", { id: "follow-up-assignment", type: "work.proposed", data: {
    workItemId: taskId, title: "Cross-check the revision", definitionOfDone: "Compare the file and document",
    accountableMemberId: reviewer.identityId, sourceMessageId: sourceId, mode: "read" } });
  const signedRead = (argv, stdin) => cli(argv, stdin, otherCheckout, (url, options) => {
    assert.equal(new URL(url).origin, origin, "the selected connection must stay on its original host");
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer " + reviewer.secret);
    return fetch(url, options);
  });
  const explicit = ["--connection", "reviewer"];
  const pickup = await signedRead([...explicit, "next"]);
  const row = pickup.value.work.items.find(item => item.id === taskId);
  assert.deepEqual(row.nextRead.command, ["room", ...explicit, "work", taskId]);
  const brief = await signedRead(row.nextRead.command.slice(1));
  const assignment = await signedRead(brief.value.sourceRead.command.slice(1));
  const linked = assignment.value.context.source;
  assert.equal(linked.message.id, sourceId);
  assert.deepEqual(linked.workspaceArtifacts, [{ ...lateFile, messageId: sourceId }]);
  assert.deepEqual(linked.resultLinks.map(entry => entry.href), [revisedUrl]);
  assert.equal((await signedRead(linked.workspaceArtifacts[0].command.slice(1))).value.file.hunks[0].changes.at(-1).content, "replaced");
  await assert.rejects(() => cli(linked.workspaceArtifacts[0].command.slice(1), undefined, otherCheckout, async (url, options) => {
    const response = await fetch(url, options);
    return Response.json({ ...await response.json(), viewerId: producer.identityId });
  }), /different viewer/);
  writePointer("reviewer", connectionHome("producer", env), env);
  try {
    await assert.rejects(() => cli(linked.workspaceArtifacts[0].command.slice(1), undefined, otherCheckout,
      () => assert.fail("a changed local viewer must be refused before network access")), /named viewer/);
  } finally {
    writePointer("reviewer", connectionHome("reviewer", env), env);
  }
  const pinnedDoc = await signedRead(linked.resultLinks[0].command.slice(1));
  assert.equal(pinnedDoc.value.result.receipt.eventId, current.value.result.receipt.eventId);
  const returnToReply = await signedRead(pinnedDoc.value.discussionRead.command.slice(1));
  assert.deepEqual(returnToReply.value.discussion.replies.map(reply => reply.id), ["late-file"]);
  const refreshed = await signedRead(linked.cliRefresh.command.slice(1), assignment.value);
  assert.equal(refreshed.value.context.source.status, "not_modified");
  assert.equal(refreshed.value.context.source.resultLinks, undefined);
  const wrongOrigin = await cli([...explicit, "result", revisedUrl.replace(origin, otherRoom.origin)], undefined, otherCheckout,
    () => assert.fail("a foreign result link must be refused before network access"));
  assert.equal(wrongOrigin.value.code, "room_selection_mismatch");
  store.command(owner, "commons", { id: "withdraw-follow-up", type: "message.deleted", data: {
    messageId: sourceId, expectedMessageRevision: 0 } });
  const withdrawn = await signedRead(linked.cliRefresh.command.slice(1), assignment.value);
  assert.equal(withdrawn.value.context.source.status, "unavailable");
  assert.equal(withdrawn.value.context.source.workspaceArtifacts, undefined);
  assert.equal(withdrawn.value.context.source.resultLinks, undefined);
  assert.equal((await cli(["next"], undefined, otherCheckout)).value.viewerId, otherRoom.reviewer.identityId);
  await publish(updated.revision, patch.replace("+submitted", "+latest"));
  await assert.rejects(() => cli(lateFile.command.slice(1), undefined, reviewerProject), error => error.status === 409);
  await assert.rejects(() => signedRead(linked.workspaceArtifacts[0].command.slice(1)), error => error.status === 409);
  const earlier = await cli(["result", sharedUrl, "--discussion"], undefined, reviewerProject);
  assert.equal(earlier.value.discussion.replies[0].body, quoted);
  assert.equal(earlier.value.selection.status, "historical");
  const originalReceipt = (await cli(["receipt", "handoff-result", "--submit"])).value;
  assert.equal(originalReceipt.nextRead.arguments.completionEventId, completionEventId);
  assert.equal((await cli(originalReceipt.nextRead.command.slice(1))).value.selection.status, "historical");
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
  for (const active of [false, true]) {
    const member = store.roomAuthority("commons", { memberId: producer.identityId }).members[producer.identityId];
    store.command(owner, "commons", { id: `restore-producer-${active}`, type: "member.access_changed", data: {
      memberId: producer.identityId, active, expectedMemberRevision: member.revision, permissions: member.permissions } });
  }
  const afterRejoin = (await cli(["receipt", "handoff-result", "--submit"])).value;
  assert.equal(afterRejoin.status, "recorded");
  assert.equal(afterRejoin.eventId, completionEventId);
  assert.equal(afterRejoin.nextRead, undefined);
  assert.equal((await cli(originalReceipt.nextRead.command.slice(1))).code, 1);
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
  assert.equal(draftReceipt.value.nextRead, undefined);
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
  const otherActor = await cli(["receipt", completionReceipt.value.operationId], undefined, reviewerProject);
  assert.equal(otherActor.value.status, "not_recorded");
  assert.equal(otherActor.value.checkedThrough, recordedThrough);
  assert.equal(Object.hasOwn(otherActor.value, "eventId"), false);
  assert.equal(otherActor.value.nextRead, undefined);
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

test(`${representation} an operation ID alone reopens the recorded exact completion`, async t => {
  const { home, env, origin, store, owner, producer, reviewerProject, rpc, cli } = await fixture(t, representation);
  const workItemId = "lost-completion";
  store.command(owner, "commons", { id: "propose-cold-receipt", type: "work.proposed", data: {
    workItemId, title: "Review the evidence", definitionOfDone: "Record a durable result", accountableMemberId: producer.identityId, mode: "read" } });
  const work = await cli(["work", workItemId]);
  await cli(["begin", "--from", "-"], work.value);
  const current = await cli(["work", workItemId]);
  const completion = { body: "Maya owns the release", summary: "Named the owner", nextAction: "Check the result",
    expectedRevision: current.value.revision, producerId: producer.identityId };
  const uncertain = await cli(["submit", workItemId, "--operation", "lost-completion"], completion, home,
    async (url, init) => {
      const response = await fetch(url, init);
      if (JSON.parse(init.body).params.name !== "room_submit_text_result") return response;
      await response.arrayBuffer();
      throw new Error("simulated lost completion response");
    });
  const completionUnknown = uncertain.value;
  assert.equal(completionUnknown.status, "unknown");
  const recordedThrough = store.headSequence("commons");
  const cold = async args => JSON.parse((await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../bin/room.mjs", import.meta.url)), ...args], { cwd: reviewerProject, env })).stdout);
  const selected = await cold(["--connection", "producer", "receipt", "lost-completion", "--submit"]);
  assert.equal(selected.currentStateVerified, false);
  const next = { tool: "room_read_result", arguments: { roomId: "commons", workItemId: "lost-completion", completionEventId: selected.eventId } };
  assert.deepEqual(selected.nextRead, { ...next,
    command: ["room", "--connection", "producer", "result", "lost-completion", "--completion", selected.eventId] });
  assert.equal((await cold(selected.nextRead.command.slice(1))).result.text.body, completion.body);
  assert.deepEqual((await rpc("room_receipt", { operationId: selected.operationId })).nextRead, next);
  const sdk = new RoomAgentClient({ origin, roomId: "commons", memberId: producer.identityId, token: producer.secret });
  assert.deepEqual((await sdk.operationReceipt(selected.operationId)).nextRead, next);
  const wrongCompletion = await cli(completionUnknown.receiptCommand.slice(1), undefined, home, async (_url, init) =>
    Response.json({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { structuredContent: {
      ...selected, nextRead: { ...next, arguments: { ...next.arguments, completionEventId: "wrong-completion" } }
    } } }));
  assert.equal(wrongCompletion.value.status, "recorded");
  assert.equal(wrongCompletion.value.nextRead, undefined);
  assert.doesNotMatch(JSON.stringify(selected), /Maya owns the release|fingerprint|body/);
  assert.equal(store.headSequence("commons"), recordedThrough);
});

test(`${representation} a saved completion does not suggest reading Work after access is revoked`, async t => {
  const { home, store, owner, producer, cli } = await fixture(t, representation);
  const workItemId = "revoked-submit", operationId = "resume-denied";
  store.command(owner, "commons", { id: "propose-denied-submit", type: "work.proposed", data: {
    workItemId, title: "Review the note", definitionOfDone: "Record the final date", accountableMemberId: producer.identityId, mode: "read",
  } });
  const work = await cli(["work", workItemId]);
  await cli(["begin", "--from", "-"], work.value);
  const selected = await cli(["work", workItemId]);
  const input = { body: "Friday", summary: "Confirmed the date", nextAction: "Review Friday",
    expectedRevision: selected.value.revision, producerId: producer.identityId };
  const args = ["submit", workItemId, "--operation", operationId];
  const interrupted = await cli(args, input, home, (url, init) => {
    if (JSON.parse(init.body).params.name === "room_submit_text_result") throw new Error("completion never sent");
    return fetch(url, init);
  });
  assert.equal(interrupted.value.status, "unknown");
  assert.equal(interrupted.value.stage, "submit");
  const member = store.roomAuthority("commons", { memberId: producer.identityId }).members[producer.identityId];
  store.command(owner, "commons", { id: "revoke-before-completion", type: "member.access_changed", data: {
    memberId: producer.identityId, active: false, expectedMemberRevision: member.revision, permissions: [],
  } });
  const head = store.headSequence("commons"), calls = [];
  const refused = await cli(args, input, home, (url, init) => {
    calls.push(JSON.parse(init.body).params.name);
    return fetch(url, init);
  });
  assert.equal(refused.code, 1);
  assert.equal(refused.value.status, "refused");
  assert.equal(refused.value.stage, "submit");
  assert.equal(refused.value.code, "access_denied");
  assert.equal(refused.value.next, undefined);
  assert.match(refused.value.hint, /Check access/);
  assert.deepEqual(calls, ["room_submit_text_result"]);
  assert.equal(store.headSequence("commons"), head);
});

test(`${representation} a recorded stale draft can be read from another checkout without posting again`, async t => {
  const { origin, store, owner, producer, reviewerProject, rpc, cli } = await fixture(t, representation);
  const id = "changed-after-draft";
  store.command(owner, "commons", { id: "propose-recovery", type: T.WORK_PROPOSED, data: {
    workItemId: id, title: "Write a release note", definitionOfDone: "Name the owner",
    accountableMemberId: producer.identityId, mode: "read"
  } });
  const work = await cli(["work", id]);
  assert.equal((await cli(["begin", "--from", "-"], work.value)).value.working, true);
  const current = await cli(["work", id]);
  const changed = { body: "Draft from the first scope", summary: "Drafted the note", nextAction: "Review",
    producerId: producer.identityId, expectedRevision: current.value.revision };
  const submit = ["submit", id, "--operation", "keep-this-draft"];
  const lost = await cli(submit, changed, undefined, async (url, init) => {
    const response = await fetch(url, init);
    await response.arrayBuffer();
    throw new Error("Draft response was lost");
  });
  assert.equal(lost.value.status, "unknown");
  await rpc("room_block_work", { workItemId: id, reason: "New requirement", nextAction: "Revise the note" });
  const stale = { output: (await cli(submit, changed)).value };
  assert.equal(stale.output.code, "draft_recorded_basis_unavailable");
  const unchangedHead = store.headSequence("commons");
  assert.deepEqual(stale.output.next.command, ["room", "--connection", "producer", "work", "changed-after-draft"]);
  assert.deepEqual(stale.output.draftRead, {
    tool: "room_read_result",
    arguments: { roomId: "commons", workItemId: "changed-after-draft", draftMessageId: stale.output.draftId },
    command: ["room", "--connection", "producer", "result", "changed-after-draft", "--draft", stale.output.draftId]
  });
  const currentWork = await cli(stale.output.next.command.slice(1), undefined, reviewerProject, async (url, init) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + producer.secret);
    return fetch(url, init);
  });
  assert.equal(currentWork.code, 0);
  assert.ok(currentWork.value.revision > changed.expectedRevision);
  const preserved = await cli(stale.output.draftRead.command.slice(1), undefined, reviewerProject);
  assert.equal(preserved.code, 0);
  assert.equal(preserved.value.viewerId, producer.identityId);
  assert.equal(preserved.value.result.kind, "draft");
  assert.equal(preserved.value.selection.draftMessageId, stale.output.draftId);
  assert.equal(preserved.value.result.text.body, changed.body);
  assert.equal(preserved.value.cliBasis, undefined);
  const mismatchedDraft = await cli(stale.output.draftRead.command.slice(1), undefined, reviewerProject,
    async (url, init) => {
      const response = await fetch(url, init);
      const packet = await response.json();
      packet.result.structuredContent.result.text.messageId = "another-draft";
      return Response.json(packet);
    });
  assert.deepEqual(mismatchedDraft, { code: 1, value: { status: "unavailable", code: "room_read_unavailable" } });
  assert.equal(store.headSequence("commons"), unchangedHead, "both recovery routes are reads");
});

for (const older of [false, true]) {
  const serverSource = older ? process.env.ROOM_PREVIOUS_SUBMIT_SERVER_ROOT : undefined;
  const pairing = older ? "older server" : "updated server";
  test(`${representation} revision changes between eligibility and draft on an ${pairing}`,
    { skip: older && !serverSource }, async t => {
    const { store, owner, producer, cli, rpc } = await fixture(t, representation, { serverSource });
    const id = "revision-turn";
    const operation = "same-submission-attempt";
    store.command(owner, "commons", { id: "propose-revision-turn", type: T.WORK_PROPOSED, data: {
      workItemId: id, title: "Check the repository note", definitionOfDone: "Name the owner",
      accountableMemberId: producer.identityId, mode: "read"
    } });
    const work = await cli(["work", id]);
    assert.equal((await cli(["begin", "--from", "-"], work.value)).value.working, true);
    const selected = (await cli(["work", id])).value;
    const intent = { body: "Text written for the earlier scope.", summary: "Recorded the owner", nextAction: "Review",
      producerId: producer.identityId, expectedRevision: selected.revision };
    const submit = ["submit", id, "--operation", operation];
    const calls = [];
    let conflictHead;
    const changeWork = async () => {
      await rpc("room_block_work", { workItemId: id, reason: "The scope changed", nextAction: "Revisit the note" });
      conflictHead = store.headSequence("commons");
    };
    const result = await cli(submit, intent, undefined, async (url, init) => {
      const frame = JSON.parse(init.body);
      calls.push(frame.params.name);
      if (!older && frame.params.name === "room_post_message") await changeWork();
      const response = await fetch(url, init);
      if (older && frame.params.name === "room_read_work") {
        const observed = (await response.clone().json()).result.structuredContent;
        assert.equal(observed.revision, selected.revision, "the previous server had just confirmed eligibility");
        await changeWork();
      }
      return response;
    });
    assert.equal(result.code, 1);
    assert.equal((await cli(["receipt", operation, "--submit"])).value.status, "not_recorded");
    const draft = (await cli(["receipt", operation, "--draft"])).value;
    const settledHead = store.headSequence("commons");
    if (older) {
      assert.equal(result.value.code, "draft_recorded_basis_unavailable");
      assert.deepEqual(calls, ["room_post_message", "room_read_work", "room_post_message"]);
      assert.equal(draft.status, "recorded");
      assert.equal(settledHead, conflictHead + 1, "only the exact legacy draft was recorded");
      const readable = await cli(result.value.draftRead.command.slice(1));
      assert.equal(readable.value.result.text.body, intent.body);
      assert.match(result.value.hint, /older Room.*before posting/i);
    } else {
      assert.equal(result.value.code, "stale_revision");
      assert.deepEqual(calls, ["room_post_message"]);
      assert.equal(result.value.draftRead, undefined);
      assert.equal(result.value.hint, undefined);
      assert.equal(draft.status, "not_recorded");
      assert.equal(settledHead, conflictHead, "the updated server refused before recording any draft");
    }
    const retry = await cli(submit, intent);
    assert.equal(retry.value.code, result.value.code);
    assert.equal(store.headSequence("commons"), settledHead, "retry adds no draft or completion");
  });
}

test(`${representation} a newly attempted stale or closed submit is refused before any draft is posted`, async t => {
  const { home, env, store, owner, producer, rpc, cli, origin } = await fixture(t, representation);
  const alternate = await fixture(t, representation);
  const alternateDir = connectionHome("alternate-room", env), alternateCheckout = join(home, "alternate-checkout");
  saveAgentConnection(alternateDir, { version: 1, origin: alternate.origin, roomId: "commons",
    memberId: alternate.reviewer.identityId, token: alternate.reviewer.secret });
  writePointer("alternate-room", alternateDir, env);
  writeProject(alternateCheckout, { connection: "alternate-room" });
  const explicit = ["--connection", "producer"];
  const initialAlternateHead = alternate.store.headSequence("commons");

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
    const code = await main([...explicit, "submit", workItemId, "--operation", operation], {
      cwd: alternateCheckout, env, out: value => outputs.push(JSON.parse(value)),
      stdin: Readable.from([JSON.stringify({ body: "Late contribution.", summary: "Did the work",
        nextAction: "Review it", producerId: producer.identityId, expectedRevision })]),
      fetchImpl: async (url, init) => {
        assert.equal(new URL(url).origin, origin);
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + producer.secret);
        calls.push(JSON.parse(init.body).params.name);
        return fetchImpl(url, init);
      }
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
  assert.deepEqual(staleAttempt.output.next.command, ["room", ...explicit, "work", "stale-new-op"]);
  assert.equal(staleAttempt.output.draftRead, undefined);
  const selectedWork = await cli(staleAttempt.output.next.command.slice(1), undefined, alternateCheckout, async (url, init) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + producer.secret);
    return fetch(url, init);
  });
  assert.equal(selectedWork.code, 0);
  assert.ok(selectedWork.value.revision > stale.revision);
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
  assert.deepEqual(lostReplyStale.output.receiptCommand.slice(0, 3), ["room", ...explicit]);
  const absent = await cli(lostReplyStale.output.receiptCommand.slice(1), undefined, alternateCheckout);
  assert.equal(absent.value.status, "not_recorded");
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
  assert.equal(alternate.store.headSequence("commons"), initialAlternateHead);
  assert.equal((await cli(["next"], undefined, alternateCheckout)).value.viewerId, alternate.reviewer.identityId);
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
