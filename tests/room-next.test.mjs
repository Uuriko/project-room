import Ajv from "ajv";
import servingOutput from "./fixtures/room-next-output-888831fe.json" with { type: "json" };
import { hostedRoomTools } from "../server/mcp-hosted-tools.mjs";
import { textVersion } from "../server/text-results.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../cli/main.mjs";
import { connectionHome, writePointer, writeProject } from "../cli/paths.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { mcpOAuthToolAllowed } from "../server/mcp-oauth.mjs";
import { privateMarkers, privateWorkFixture } from "./helpers/private-work-fixture.mjs";

// Validate actual MCP structuredContent against the deployed cached contract
// and the catalog emitted by the current checkout.
const ajv = new Ajv({ extendRefs: true });
const pickupSchemas = [servingOutput, hostedRoomTools.find(tool => tool.name === "room_next").outputSchema].map(schema => ajv.compile(schema));
function validatePickup(value) {
  for (const validate of pickupSchemas) assert.ok(validate(value), JSON.stringify(validate.errors));
  return value;
}
const preferredRead = packet => packet.nextRead ?? packet.ifIdle?.discoveryReview?.nextRead ?? packet.ifIdle?.investigation?.nextRead;

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`room next selects one eligible invitation and honors the Room pause (${representation})`, async t => {
    const f = await privateWorkFixture(t, representation);
    const active = await f.mcp(f.triage, "room_next", { view: "pickup" });
    assert.equal(active.ok, true, active.text);
    const original = await f.mcp(f.triage, "room_next");
    assert.equal(original.ok, true, original.text);
    const { nextRead, ifIdle, ...oldPacket } = active.value;
    assert.deepEqual(original.value, oldPacket, "the original input returns only the original output fields");
    const invalid = await f.mcp(f.triage, "room_next", { view: "invalid" });
    assert.equal(invalid.ok, false);
    assert.equal(active.value.nextRead, null);
    validatePickup(active.value);
    const { investigation, ...invitationState } = ifIdle;
    assert.equal(preferredRead(active.value), investigation.nextRead);
    assert.deepEqual(invitationState, representation === "legacy"
      ? { status: "no_invitation" }
      : { status: "unavailable", reason: "current_help_index_unavailable" });

    if (representation === "legacy") {
      for (const workItemId of ["secret", "open"]) {
        f.send(f.producer.key, "work.help_updated", { workItemId, expectedRevision: f.rev(workItemId),
          expectedHelpRevision: 0, status: "open", scope: "Check one existing issue",
          expiresAt: new Date(Date.now() + 3600000).toISOString() });
      }
      for (let n = 0; n < 18; n++) {
        f.send(f.owner, "work.proposed", { workItemId: `a-unrelated-${n}`, title: "Unrelated work",
          definitionOfDone: "Leave this to the assignee", accountableMemberId: f.observer.id, mode: "read" });
      }
      const before = f.stored();
      const old = await f.mcp(f.triage, "room_list_work", { focus: "help_wanted", limit: 1 });
      const selected = await f.mcp(f.triage, "room_next", { view: "pickup" });
      assert.equal(selected.ok, true, selected.text);
      assert.equal(selected.value.work.coverage, "complete");
      assert.equal(selected.value.ifIdle.status, "invitation");
      assert.equal(selected.value.ifIdle.workItemId, "open");
      assert.equal(selected.value.ifIdle.helpEventId, old.value.work[0].help.eventId);
      assert.deepEqual(selected.value.nextRead, { ...old.value.work[0].nextRead,
        arguments: { roomId: "commons", ...old.value.work[0].nextRead.arguments } });
      assert.deepEqual(selected.value.nextRead, selected.value.ifIdle.nextRead);
      const selectedWork = await f.mcp(f.triage, selected.value.nextRead.tool, selected.value.nextRead.arguments);
      assert.equal(selectedWork.ok, true, selectedWork.text);
      assert.equal(selectedWork.value.help.canOffer, true);
      assert.equal(f.stored(), before);

      f.send(f.producer.key, "work.help_updated", { workItemId: "open", expectedRevision: f.rev("open"),
        expectedHelpRevision: 1, status: "withdrawn" });
      const stale = await f.mcp(f.triage, selected.value.nextRead.tool, selected.value.nextRead.arguments);
      assert.equal(stale.value.help.canOffer, false);
      assert.equal((await f.mcp(f.triage, "room_next", { view: "pickup" })).value.ifIdle.status, "no_invitation");
    }

    f.store.wakeQueue.pause(f.owner, "commons", { requestId: "pause-triage-invitations", reason: null },
      null, { memberId: f.triage.id });
    const paused = await f.mcp(f.triage, "room_next", { view: "pickup" });
    assert.deepEqual(paused.value.ifIdle, { status: "paused" });
    assert.equal(paused.value.nextRead, null);
    const addressed = await f.mcp(f.producer, "room_next", { view: "pickup" });
    assert.equal(addressed.value.ifIdle, undefined);
    assert.deepEqual(addressed.value.nextRead, addressed.value.work.items.find(item => item.reason === "revise").nextRead);
    assert.ok(addressed.value.requests.items.length);
  });

  test(`room next uses the same private-view boundary through MCP and CLI (${representation})`, async t => {
    const f = await privateWorkFixture(t, representation);
    for (let n = 0; n < 4; n++) {
      f.send(f.owner, "work.proposed", { workItemId: `a-decoy-${n}`, title: "Unrelated work",
        definitionOfDone: "Out of scope", accountableMemberId: f.observer.id, verifierMemberId: f.producer.id,
        independentVerificationRequired: true, mode: "read" });
    }
    f.send(f.producer.key, "reply_request.progressed", { requestMessageId: "private-ask",
      expectedRequestRevision: 0, progress: "acknowledged", note: "zq-private-progress-note-zq" });
    if (representation === "legacy") {
      f.send(f.owner, "work.proposed", { workItemId: "private-role-work", title: "zq-private-role-zq",
        definitionOfDone: "Review the evidence", accountableMemberId: f.broad.id, mode: "read" });
      f.store.dmConsents.request("commons", "owner", f.observer.id, "fixture");
      f.store.dmConsents.decide("commons", f.observer.id, "owner", "approve");
      f.send(f.owner, "message.posted", { messageId: "closed-private-ask", toMemberId: f.observer.id,
        workItemId: "private-role-work", requestKind: "reply", body: "zq-private-terminal-zq" });
      f.send(f.owner, "reply_request.cancelled", { requestMessageId: "closed-private-ask",
        expectedRequestRevision: 0, reason: "The evidence is already available." });
      for (let n = 0; n < 5; n++) {
        f.send(f.owner, "work.proposed", { workItemId: `z-producer-${n}`, title: "Producer follow-up",
          definitionOfDone: "Review one item", accountableMemberId: f.producer.id, mode: "read" });
      }
      // Room-wide request history may be large even when the viewer has only one open ask.
      f.store.db.prepare(`UPDATE rooms SET projection=json_set(projection,
        '$.replyRequests.unrelated_history',json(?)) WHERE id=?`).run(JSON.stringify({
        requesterId: f.triage.id, recipientId: f.observer.id, status: "answered", progressNote: "x".repeat(1100 * 1024)
      }), "commons");
    }
    const before = f.stored();
    const room = f.store.room;
    f.store.room = () => { throw new Error("room next hydrated the whole Room"); };
    t.after(() => { f.store.room = room; });
    const owner = await f.mcp(f.producer, "room_next");
    assert.equal(owner.ok, true, owner.text);
    assert.equal(owner.value.viewerId, f.producer.id);
    assert.ok(owner.value.goal);
    const correction = owner.value.work.items.find(item => item.id === "secret");
    assert.equal(correction?.reason, "revise");
    assert.equal(correction.correction.truncated, false);
    assert.ok(privateMarkers(correction.correction.reason).length);
    assert.equal(correction.nextRead.arguments.includeDiscussion, false);
    assert.deepEqual(owner.value.requests.items.map(item => item.id), ["private-ask"]);
    const [ask] = owner.value.requests.items;
    assert.ok(Date.parse(ask.savedAt) <= Date.parse(ask.latestRecipientProgress.at));
    assert.equal(ask.latestRecipientProgress.state, "acknowledged");
    assert.equal(ask.nextRead.arguments.requestMessageId, "private-ask");
    assert.equal(ask.nextRead.arguments.view, "compact");
    assert.ok(!owner.text.includes("zq-private-progress-note-zq"));
    assert.ok(!owner.text.includes("zq-private-request-zq"));

    const observer = await f.mcp(f.triage, "room_next");
    assert.equal(observer.ok, true, observer.text);
    assert.deepEqual(observer.value.work.items, []);
    assert.deepEqual(observer.value.requests.items, []);
    assert.deepEqual(privateMarkers(observer.text), []);
    assert.ok(!observer.text.includes("private-ask"));
    assert.ok(!observer.text.includes('"secret"'));

    if (representation === "legacy") {
      const parties = f.store.privateWorkParties("commons", { workIds: ["private-role-work"] });
      assert.deepEqual(parties, new Map([["private-role-work", new Set(["owner", f.observer.id])]]));
      const roleHolder = await f.mcp(f.broad, "room_next");
      assert.equal(roleHolder.ok, true, roleHolder.text);
      assert.ok(roleHolder.value.work.items.some(item => item.id === "private-role-work" && item.reason === "accept"));
      assert.ok(!roleHolder.text.includes("closed-private-ask"));
      assert.ok(!observer.text.includes("private-role-work"));

      assert.equal(owner.value.work.coverage, "partial");
      const args = owner.value.work.nextRead.arguments;
      const continued = await f.mcp(f.producer, "room_next", args);
      assert.equal(continued.ok, true, continued.text);
      assert.ok(continued.value.work.items.length > 0);
      const wrongViewer = await f.mcp(f.triage, "room_next", args);
      assert.equal(wrongViewer.ok, true, wrongViewer.text);
      assert.equal(wrongViewer.value.work.reason, "cursor_changed");
      assert.deepEqual(wrongViewer.value.work.items, []);
      assert.deepEqual(wrongViewer.value.work.nextRead,
        { tool: "room_next", arguments: { roomId: "commons", source: "work" } });
      assert.ok(!wrongViewer.text.includes('"secret"'));
      assert.deepEqual(privateMarkers(wrongViewer.text), []);
    }

    const directory = await mkdtemp(join(tmpdir(), "room-next-cli-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const env = { HOME: directory, PROJECT_ROOM_KEYCHAIN: "0" };
    const parent = connectionHome("producer", env);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const configDir = join(parent, "connection");
    saveAgentConnection(configDir, {
      version: 1, origin: f.origin, roomId: "commons", memberId: f.producer.id, token: f.producer.secret
    });
    writePointer("producer", configDir, env);
    writeProject(directory, { connection: "producer" });
    const output = [];
    const errors = [];
    const code = await main(["next"], {
      cwd: directory, env, out: value => output.push(value), err: value => errors.push(value)
    });
    assert.equal(code, 0, errors.join("\n"));
    const cli = JSON.parse(output[0]);
    // Opaque continuations intentionally differ on fresh issuance.
    for (const [source, command] of [["work", "work"], ["requests", "read"]]) {
      assert.deepEqual(cli[source].items.map(row => {
        const { command: actual, ...nextRead } = row.nextRead;
        assert.deepEqual(actual, ["room", command, row.id]);
        return { ...row, nextRead };
      }), owner.value[source].items);
    }
    assert.equal(cli.requests.coverage, owner.value.requests.coverage);
    const dryParent = connectionHome("triage", env);
    await mkdir(dryParent, { recursive: true, mode: 0o700 });
    const dryConnection = join(dryParent, "connection");
    saveAgentConnection(dryConnection, {
      version: 1, origin: f.origin, roomId: "commons", memberId: f.triage.id, token: f.triage.secret
    });
    writePointer("triage", dryConnection, env);
    writeProject(directory, { connection: "triage" });
    const dryOutput = [];
    assert.equal(await main(["next"], { cwd: directory, env, out: value => dryOutput.push(value), err: value => errors.push(value) }), 0);
    const dry = JSON.parse(dryOutput[0]);
    assert.deepEqual(dry.nextRead, dry.ifIdle.investigation.nextRead);
    assert.ok((await f.mcp(f.triage, dry.nextRead.tool, dry.nextRead.arguments)).ok);
    assert.equal(f.stored(), before, "neither adapter writes or acknowledges");
  });
}

test("Room Next skips a long legacy history and preserves the addressed work continuation", async t => {
  const f = await privateWorkFixture(t, "legacy");
  for (let i = 0; i < 54; i++) {
    const id = `a-${String(i).padStart(2, "0")}`;
    f.send(f.owner, "work.proposed", {
      workItemId: id, title: id, definitionOfDone: "Save a result", accountableMemberId: f.observer.id,
      verifierMemberId: f.reviewer.id, independentVerificationRequired: true
    });
  }
  for (let i = 0; i < 6; i++) {
    const id = `z-assigned-${i}`;
    f.send(f.owner, "work.proposed", {
      workItemId: id, title: id, definitionOfDone: "Save a result", accountableMemberId: f.reviewer.id, mode: "read"
    });
  }
  const first = await f.mcp(f.reviewer, "room_next", { view: "pickup" });
  assert.equal(first.ok, true, first.text);
  assert.deepEqual(first.value.work.items.map(item => item.id), [0, 1, 2, 3].map(i => `z-assigned-${i}`));
  assert.equal(first.value.work.coverage, "partial");
  const second = await f.mcp(f.reviewer, "room_next", first.value.work.nextRead.arguments);
  assert.equal(second.ok, true, second.text);
  assert.deepEqual(second.value.work.items.map(item => item.id), [4, 5].map(i => `z-assigned-${i}`));
  assert.equal(second.value.work.coverage, "complete");
});

test("an empty work page advances, keeps ongoing work, and invalidates stale authority", async t => {
  const f = await privateWorkFixture(t, "normalized-current-v1");
  for (let i = 0; i < 16; i++) {
    const id = `a-${String(i).padStart(2, "0")}`;
    f.send(f.owner, "work.proposed", {
      workItemId: id, title: id, definitionOfDone: "Save a result", accountableMemberId: f.observer.id,
      verifierMemberId: f.reviewer.id, independentVerificationRequired: true
    });
  }
  const { member } = f.store.authenticate(f.reviewer.key, "commons");
  f.send(f.owner, "member.access_changed", {
    memberId: member.id, expectedMemberRevision: member.revision,
    permissions: ["verify", "accept_work"], active: true
  });
  const id = "z-ongoing";
  f.send(f.owner, "work.proposed", {
    workItemId: id, title: id, definitionOfDone: "Save a result", accountableMemberId: f.reviewer.id, mode: "read"
  });
  f.send(f.reviewer.key, "work.accepted", { workItemId: id, expectedRevision: f.rev(id) });
  f.send(f.reviewer.key, "work.started", { workItemId: id, expectedRevision: f.rev(id) });
  const indexed = await f.mcp(f.reviewer, "room_next", { view: "pickup" });
  assert.equal(indexed.value.work.coverage, "complete");
  assert.equal(indexed.value.work.items.find(item => item.id === id)?.reason, "in_progress");
  // Exercise an adapter without native SQL functions as well.
  Object.defineProperty(f.store.db, "function", { value: undefined, configurable: true });
  t.after(() => delete f.store.db.function);
  const first = await f.mcp(f.reviewer, "room_next", { view: "pickup" });
  assert.equal(first.ok, true, first.text);
  assert.equal(first.value.work.coverage, "partial");
  assert.deepEqual(first.value.work.items, []);
  assert.deepEqual(first.value.nextRead, first.value.work.nextRead);
  assert.equal(first.value.ifIdle, undefined);
  const args = first.value.work.nextRead.arguments;
  const second = await f.mcp(f.reviewer, "room_next", args);
  assert.equal(second.ok, true, second.text);
  assert.equal(second.value.work.items.find(item => item.id === id)?.reason, "in_progress");
  assert.equal(second.value.requests, undefined);

  const wrong = await f.mcp(f.observer, "room_next", args);
  assert.equal(wrong.value.work.reason, "cursor_changed");
  assert.deepEqual(wrong.value.work.items, []);

  const changedMember = f.store.authenticate(f.reviewer.key, "commons").member;
  f.send(f.owner, "member.access_changed", {
    memberId: changedMember.id, expectedMemberRevision: changedMember.revision, permissions: ["verify"], active: true
  });
  const changed = await f.mcp(f.reviewer, "room_next", args);
  assert.equal(changed.value.work.reason, "cursor_changed");
  assert.deepEqual(changed.value.work.items, []);
  const invalid = await f.mcp(f.reviewer, "room_next", { cursor: args.cursor });
  assert.equal(invalid.ok, false);
});

test("composite OAuth scope admits only the combined read grant", () => {
  const scopes = ["rooms:read", "work:read", "chat:read"];
  assert.equal(mcpOAuthToolAllowed("room_next", scopes), true);
  for (const omitted of scopes) {
    assert.equal(mcpOAuthToolAllowed("room_next", scopes.filter(scope => scope !== omitted)), false, omitted);
  }
});

async function checkFormalRequestRecovery(t, representation) {
  const f = await privateWorkFixture(t, representation);
  f.store.dmConsents.request("commons", "owner", f.observer.id, "fixture");
  f.store.dmConsents.decide("commons", f.observer.id, "owner", "approve");
  for (let i = 0; i < 19; i++) {
    f.send(f.owner, "message.posted", {
      messageId: `request-${String(i).padStart(2, "0")}`, toMemberId: f.observer.id, requestKind: "reply",
      body: "Inspect the original release result."
    });
  }
  const requestMessageId = "request-18";
  const correction = f.send(f.owner, "message.posted", {
    messageId: "corrected-input", replyToId: requestMessageId, toMemberId: f.observer.id,
    body: "Inspect the corrected release result and use its new candidate."
  });
  f.send(f.observer.key, "reply_request.progressed", {
    requestMessageId, expectedRequestRevision: 0, ifCurrentContextEventId: correction.event.id,
    progress: "error", note: "Receiver failed during preparation."
  });

  const args = { source: "requests" };
  const ordinary = await f.mcp(f.observer, "room_next", args);
  const pickup = await f.mcp(f.observer, "room_next", { ...args, view: "pickup" });
  assert.equal(pickup.ok, true, pickup.text);
  assert.deepEqual(pickup.value.requests.items, ordinary.value.requests.items);
  assert.equal(pickup.value.requests.coverage, ordinary.value.requests.coverage);
  const [ordinaryPage, pickupPage] = await Promise.all([ordinary, pickup].map(result => {
    const next = result.value.requests.nextRead;
    return f.mcp(f.observer, next.tool, next.arguments);
  }));
  assert.deepEqual(pickupPage.value.requests.items, ordinaryPage.value.requests.items);
  assert.ok(!pickup.value.requests.items.some(row => row.id === requestMessageId));
  assert.equal(pickup.value.nextRead.arguments.requestMessageId, requestMessageId);
  const pointer = pickup.value.nextRead;
  const exact = await f.mcp(f.observer, pointer.tool, pointer.arguments);
  assert.equal(exact.ok, true, exact.text);
  assert.equal(exact.value.current.answerBasis.contextEventId, correction.event.id);
  assert.equal(exact.value.page.items.find(item => item.kind === "context").message.id, "corrected-input");

  const observer = await f.mcp(f.triage, "room_next", { ...args, view: "pickup" });
  assert.notEqual(observer.value.nextRead?.arguments?.requestMessageId, requestMessageId);
  f.send(f.owner, "reply_request.cancelled", { requestMessageId, expectedRequestRevision: 0, reason: "Resolved separately." });
  const closed = await f.mcp(f.observer, pointer.tool, pointer.arguments);
  assert.deepEqual(closed.value.responseActions, []);
  const after = await f.mcp(f.observer, "room_next", { ...args, view: "pickup" });
  assert.notEqual(after.value.nextRead?.arguments?.requestMessageId, requestMessageId);
}

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`pickup finds a failed formal request outside the first page without changing continuation (${representation})`,
    t => checkFormalRequestRecovery(t, representation));
}

test("formal requests paginate independently with no work, and closed requests cannot be answered", async t => {
  const f = await privateWorkFixture(t, "normalized-current-v1");
  f.store.dmConsents.request("commons", "owner", f.observer.id, "fixture");
  f.store.dmConsents.decide("commons", f.observer.id, "owner", "approve");
  for (let i = 0; i < 6; i++) {
    f.send(f.owner, "message.posted", {
      messageId: `standalone-${i}`, toMemberId: f.observer.id, requestKind: "reply", body: "Inspect this request."
    });
  }
  const first = await f.mcp(f.observer, "room_next");
  assert.equal(first.ok, true, first.text);
  assert.deepEqual(first.value.work.items, []);
  assert.equal(first.value.requests.coverage, "partial");
  assert.ok(first.value.requests.items.every(row => typeof row.savedAt === "string" && !row.latestRecipientProgress));
  const ids = first.value.requests.items.map(row => row.id);
  let pointer = first.value.requests.nextRead;
  for (let page = 0; pointer && page < 10; page++) {
    const result = await f.mcp(f.observer, "room_next", pointer.arguments);
    assert.equal(result.ok, true, result.text);
    assert.equal(result.value.work, undefined);
    assert.notEqual(result.value.requests.coverage, "unavailable");
    ids.push(...result.value.requests.items.map(row => row.id));
    pointer = result.value.requests.nextRead;
  }
  assert.equal(pointer, null);
  assert.deepEqual(ids.sort(), Array.from({ length: 6 }, (_, i) => `standalone-${i}`));

  const requestMessageId = ids[0];
  const selected = await f.mcp(f.observer, "room_read_request", { requestMessageId });
  assert.equal(selected.ok, true, selected.text);
  const reply = selected.value.responseActions[0];
  f.send(f.owner, "reply_request.cancelled", { requestMessageId, expectedRequestRevision: 0, reason: "Resolved elsewhere" });
  const closed = await f.mcp(f.observer, "room_read_request", { requestMessageId });
  assert.equal(closed.value.request.status, "cancelled");
  assert.ok(!closed.value.responseActions?.length);
  const stale = await f.mcp(f.observer, reply.tool, { ...reply.arguments, body: "Read and answered." });
  assert.equal(stale.ok, false);

  const { member } = f.store.authenticate(f.observer.key, "commons");
  f.send(f.owner, "member.access_changed", {
    memberId: member.id, expectedMemberRevision: member.revision, permissions: ["accept_work"], active: true
  });
  const changed = await f.mcp(f.observer, "room_next", first.value.requests.nextRead.arguments);
  assert.equal(changed.ok, true, changed.text);
  assert.equal(changed.value.requests.reason, "cursor_changed");
  assert.deepEqual(changed.value.requests.items, []);
  const restarted = await f.mcp(f.observer, "room_next", changed.value.requests.nextRead.arguments);
  assert.ok(restarted.value.requests.items.length, "the same credential can still make a fresh scoped read");
});

test("a selected successor does not disclose a private prerequisite's state", async t => {
  const f = await privateWorkFixture(t, "normalized-current-v1");
  f.send(f.owner, "work.proposed", {
    workItemId: "successor", title: "Successor", definitionOfDone: "Save a result",
    accountableMemberId: f.observer.id, mode: "read", dependsOn: ["secret"]
  });
  f.send(f.observer.key, "work.accepted", { workItemId: "successor", expectedRevision: f.rev("successor") });
  const result = await f.mcp(f.observer, "room_read_work", { workItemId: "successor" });
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(result.value.dependencies, [{ id: "secret", state: "unknown", satisfied: false }]);
  assert.equal(result.value.next.action, "wait_prerequisites");
  assert.deepEqual(privateMarkers(result.text), []);
});

test("compare first useful entry with the existing three reads", async t => {
  const f = await privateWorkFixture(t, "normalized-current-v1");
  const calls = await Promise.all([
    f.mcp(f.producer, "room_activation_pack", { view: "brief" }),
    f.mcp(f.producer, "room_list_work", { focus: "needs_me" }),
    f.mcp(f.producer, "room_list_requests", { direction: "incoming", status: "open" })
  ]);
  assert.ok(calls.every(call => call.ok), calls.map(call => call.text).join("\n"));
  const compact = await f.mcp(f.producer, "room_next");
  assert.equal(compact.ok, true, compact.text);
  assert.deepEqual(compact.value.work.items.map(row => row.id).sort(), calls[1].value.work.map(row => row.id).sort());
  assert.deepEqual(compact.value.requests.items.map(row => row.id), calls[2].value.requests.map(row => row.id));
  assert.equal(compact.value.work.coverage, calls[1].value.page.hasMore ? "partial" : "complete");
  assert.equal(compact.value.requests.coverage, "complete", "the addressed index covers all open incoming requests");
  t.diagnostic(JSON.stringify({
    control: { calls: calls.length, wireBytes: calls.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0) },
    next: { calls: 1, wireBytes: Buffer.byteLength(compact.text) }
  }));
});

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`reviewer pickup returns a private finding read and advances only on explicit consideration (${representation})`, async t => {
    const f = await privateWorkFixture(t, representation);
    const { store, triage, producer, observer } = f;
    function publish(id, submissionUrl) {
      store.projectOffers.create("commons", "owner", { requestId: "create-" + id, offerId: id,
        reviewerMemberIds: ["owner", triage.id, producer.id],
        terms: { kind: "project", title: id, summary: "A scoped project", acceptanceCriteria: ["Cite a check"],
          reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" },
          repositoryUrl: "https://example.com/source", ...(submissionUrl && { submissionUrl }) } });
      store.projectOffers.transition("commons", "owner", id, "publish", { requestId: "publish-" + id, expectedRevision: 1 });
    }
    async function file(id, n) {
      const response = await fetch(f.origin + "/api/project-offers/" + encodeURIComponent(id) + "/discoveries", {
        method: "POST", headers: { Authorization: "Bearer " + observer.secret, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "file-" + n, expectedTermsVersion: 1, expectedRevision: 2,
          sourceUrl: "https://example.com/source", criterion: "Cite a check",
          observation: "reviewer-only-observation-" + n, nextAction: "Repeat the check" }) });
      assert.equal(response.status, 200);
    }
    const pickup = (who, consideredDiscovery) => f.mcp(who, "room_next", { view: "pickup", ...(consideredDiscovery && { consideredDiscovery }) });
    publish("project:a"); publish("project-b");
    await file("project:a", 1); await file("project:a", 2); await file("project-b", 3);
    const first = await pickup(triage);
    assert.ok(first.ok, first.text);
    const lead = first.value.ifIdle?.discoveryReview;
    validatePickup(first.value);
    assert.deepEqual(preferredRead(first.value), lead.nextRead);
    assert.equal(lead.nextRead.arguments.offerId, "project:a");
    assert.equal(lead.path, "/api/rooms/commons/project-offers/project%3Aa/discoveries");
    assert.doesNotMatch(first.text, /reviewer-only-observation|Cite a check|finding-[a-f0-9]{64}/);
    const get = (who, args) => f.mcp(who, lead.nextRead.tool, args);
    const page = await get(triage, { ...lead.nextRead.arguments, limit: 1 });
    assert.ok(page.ok, page.text);
    const secondPage = await get(triage, { ...lead.nextRead.arguments, after: page.value.nextCursor, limit: 1 });
    assert.equal(secondPage.value.nextCursor, null);
    assert.deepEqual([page, secondPage].map(p => p.value.findings[0].finding.observation).sort(),
      ["reviewer-only-observation-1", "reviewer-only-observation-2"]);
    assert.equal((await pickup(producer)).value.ifIdle?.discoveryReview, undefined, "addressed work retains precedence");
    assert.equal((await pickup(observer)).value.ifIdle?.discoveryReview, undefined);
    assert.equal((await get(observer, lead.nextRead.arguments)).ok, false);
    const next = (await pickup(triage, lead.consideredDiscovery)).value.ifIdle?.discoveryReview;
    assert.equal(next.nextRead.arguments.offerId, "project-b");
    assert.equal((await pickup(triage, next.consideredDiscovery)).value.ifIdle?.discoveryReview, undefined);
    await file("project:a", 4);
    const latest = (await pickup(triage, next.consideredDiscovery)).value.ifIdle?.discoveryReview;
    assert.equal(latest.nextRead.arguments.offerId, "project:a");
    assert.equal((await pickup(observer, latest.consideredDiscovery)).ok, false, "checkpoint is bound to the reviewer");
    if (representation === "legacy") {
      f.send(producer.key, "work.help_updated", { workItemId: "open", expectedRevision: f.rev("open"),
        expectedHelpRevision: 0, status: "open", scope: "Help on new work", expiresAt: new Date(Date.now()+3600000).toISOString() });
      const withInvitation = await pickup(triage);
      assert.equal(withInvitation.value.ifIdle.status, "invitation");
      assert.equal(withInvitation.value.nextRead.tool, "room_read_work");
      assert.equal(withInvitation.value.ifIdle?.discoveryReview.nextRead.tool, "room_read_project_discoveries");
    }
    store.projectOffers.transition("commons", "owner", "project:a", "withdraw", { requestId:"withdraw-a", expectedRevision:2 });
    assert.equal((await get(triage, lead.nextRead.arguments)).ok, false);
    assert.equal((await pickup(triage, next.consideredDiscovery)).value.ifIdle?.discoveryReview, undefined);
  });
}

test("reviewer pickup drains settled work before offering a finding and honors a later addressed item", async t => {
  const f = await privateWorkFixture(t, "normalized-current-v1");
  for (let i = 0; i < 35; i++) {
    const workItemId = "a-settled-" + String(i).padStart(2, "0");
    f.send(f.owner, "work.proposed", { workItemId, title: workItemId, accountableMemberId: f.triage.id,
      definitionOfDone: "Handled by the replacement", mode: "read" });
    f.send(f.owner, "work.superseded", { workItemId, expectedRevision: f.rev(workItemId),
      supersededByWorkItemId: "open", reason: "Consolidated" });
  }
  f.store.dmConsents.request("commons", "owner", f.observer.id, "fixture");
  f.store.dmConsents.decide("commons", f.observer.id, "owner", "approve");
  for (let i = 0; i < 24; i++) {
    const requestMessageId = `closed-unrelated-${i}`;
    f.send(f.owner, "message.posted", { messageId: requestMessageId, toMemberId: f.observer.id,
      requestKind: "reply", body: "An unrelated request already handled" });
    f.send(f.owner, "reply_request.cancelled", { requestMessageId, expectedRequestRevision: 0, reason: "Already handled." });
  }
  const offerId = "review-after-settled";
  f.store.projectOffers.create("commons", "owner", { requestId: "create-discovery", offerId,
    reviewerMemberIds: ["owner", f.triage.id], terms: { kind: "project", title: "Review a finding", summary: "Check one result",
      acceptanceCriteria: ["Read the source"], reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" },
      repositoryUrl: "https://example.com/repo" } });
  f.store.projectOffers.transition("commons", "owner", offerId, "publish", { requestId:"publish-discovery", expectedRevision:1 });
  const filed = await fetch(f.origin + "/api/project-offers/" + offerId + "/discoveries", {
    method: "POST", headers: { Authorization: "Bearer " + f.observer.secret, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "finding", expectedTermsVersion: 1, expectedRevision: 2,
      criterion: "Read the source", sourceUrl: "https://example.com/source", observation: "Private finding text", nextAction: "Review privately" }) });
  assert.equal(filed.status, 200);

  const follow = (who, pointer) => f.mcp(who, pointer.tool, pointer.arguments);
  const start = () => f.mcp(f.triage, "room_next", { view: "pickup" });
  const indexed = await start();
  assert.ok(indexed.ok, indexed.text);
  validatePickup(indexed.value);
  assert.equal(indexed.value.work.coverage, "complete");
  assert.equal(indexed.value.requests.coverage, "complete");
  assert.deepEqual(indexed.value.work.items, []);
  assert.equal(preferredRead(indexed.value).tool, "room_read_project_discoveries");
  assert.doesNotMatch(indexed.text, /Private finding text/);
  // Preserve coverage of the bounded continuation on adapters without the filter.
  Object.defineProperty(f.store.db, "function", { value: undefined, configurable: true });
  t.after(() => delete f.store.db.function);
  const drain = async () => {
    let page = await start();
    for (let i = 0; i < 2; i++) {
      assert.equal(page.value.work.coverage, "partial");
      assert.deepEqual(page.value.work.items, []);
      assert.equal(page.value.ifIdle?.discoveryReview, undefined);
      assert.doesNotMatch(page.text, /Private finding text|review-after-settled/);
      assert.equal(page.value.nextRead.tool, "room_next");
      assert.equal(page.value.nextRead.arguments.source, "work");
      assert.deepEqual(page.value.work.nextRead, page.value.nextRead);
      page = await follow(f.triage, page.value.nextRead);
      assert.ok(page.ok, page.text);
    }
    return page;
  };
  const initial = await start();
  const wrong = await follow(f.observer, initial.value.nextRead);
  assert.equal(wrong.value.ifIdle?.discoveryReview, undefined);
  const last = await drain();
  assert.equal(last.value.work.coverage, "complete");
  assert.deepEqual(last.value.work.items, []);
  validatePickup(last.value);
  assert.equal(preferredRead(last.value).tool, "room_read_project_discoveries");
  assert.equal(preferredRead(last.value).arguments.offerId, offerId);
  const finding = await follow(f.triage, preferredRead(last.value));
  assert.equal(finding.value.findings[0].finding.observation, "Private finding text");
  const considered = await f.mcp(f.triage, "room_next", { view: "pickup", consideredDiscovery: last.value.ifIdle?.discoveryReview.consideredDiscovery });
  let later = considered;
  while (later.value.nextRead?.tool === "room_next") later = await follow(f.triage, later.value.nextRead);
  assert.equal(later.value.ifIdle?.discoveryReview, undefined, "consumed filings stay consumed throughout the walk");
  assert.equal(later.value.ifIdle?.investigation.basis.projectId, offerId);

  f.send(f.owner, "work.proposed", { workItemId: "z-addressed", title: "Prioritize this", accountableMemberId: f.triage.id,
    definitionOfDone: "Finish this assignment", mode: "read" });
  const stale = await follow(f.triage, initial.value.nextRead);
  assert.equal(stale.value.work.reason, "cursor_changed");
  assert.equal(stale.value.ifIdle?.discoveryReview, undefined);
  const priority = await drain();
  assert.equal(priority.value.nextRead.tool, "room_read_work");
  assert.equal(priority.value.nextRead.arguments.workItemId, "z-addressed");
  assert.equal(priority.value.ifIdle?.discoveryReview, undefined);
});

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`dry pickup gives an executable check and records the basis once (${representation})`, async t => {
    const f = await privateWorkFixture(t, representation);
    const pickup = who => f.mcp(who, "room_next", { view: "pickup" });
    const criterion = "Produce a reproducible checkout experiment";
    f.send(f.owner, "room.charter_updated", { expectedRevision: 0, purpose: "Test the project", outputs: criterion,
      boundaries: null, escalation: null });
    const first = await pickup(f.triage);
    assert.ok(first.ok, first.text);
    const lead = first.value.ifIdle?.investigation;
    assert.equal(lead.criterion, criterion);
    assert.equal(lead.basis.charterRevision, 1);
    const checked = await f.mcp(f.triage, lead.nextRead.tool, lead.nextRead.arguments);
    assert.ok(checked.ok, checked.text);
    const write = lead.record;
    const unrelated = await f.mcp(f.triage, write.tool, { ...write.arguments, body: "Unrelated message" });
    assert.ok(unrelated.ok, unrelated.text);
    const retry = (await pickup(f.triage)).value.ifIdle?.investigation.record;
    assert.notEqual(write.arguments.id, retry.arguments.id);
    assert.equal(write.bodyPrefix, retry.bodyPrefix);
    const args = { ...retry.arguments, body: retry.bodyPrefix + "Read the Room-visible results page; no matching result in the sampled page." };
    const recorded = await f.mcp(f.triage, retry.tool, args);
    assert.ok(recorded.ok, recorded.text);
    assert.equal((await f.mcp(f.triage, retry.tool, args)).value.duplicate, true);
    assert.equal((await pickup(f.broad)).value.ifIdle?.investigation, undefined);
    assert.equal((await pickup(f.triage)).value.nextRead, null);
    f.store.projectOffers.create("commons", "owner", { requestId: "create-dry", offerId: "dry-project",
      reviewerMemberIds: ["owner"], terms: { kind: "project", title: "Public project", summary: "Public terms",
        acceptanceCriteria: ["Check a public source"], reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" },
        repositoryUrl: "https://example.com/source" } });
    f.store.projectOffers.transition("commons", "owner", "dry-project", "publish", { requestId: "publish-dry", expectedRevision: 1 });
    const published = (await pickup(f.triage)).value.ifIdle?.investigation;
    assert.equal(published.criterion, "Check a public source");
    assert.notEqual(published.record.arguments.id, write.arguments.id);
    assert.equal(published.projectPath, "/api/project-offers/dry-project");
    f.store.projectOffers.create("commons", "owner", { requestId: "create-task", offerId: "receipt-task",
      reviewerMemberIds: ["owner"], terms: { kind: "task", title: "Test task", summary: "Check the source",
        acceptanceCriteria: ["Check a public source"], reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" },
        repositoryUrl: "https://example.com/source" } });
    f.store.projectOffers.transition("commons", "owner", "receipt-task", "publish", { requestId: "publish-task", expectedRevision: 1 });
    f.store.publicWorkClaims.enable("commons", "owner", "receipt-task", { requestId: "enable", expectedRevision: 2,
      expectedTermsVersion: 1, repositoryRef: "main", files: ["README.md"] });
    const claimed = f.store.publicWorkClaims.act("receipt-task", f.observer.secret, "claim", { requestId: "claim", expectedTermsVersion: 1 });
    const finished = f.store.publicWorkClaims.act("receipt-task", f.observer.secret, "finish", { requestId: "finish",
      expectedTermsVersion: 1, generation: claimed.task.claim.generation, artifactText: "Public test result", checksReported: [] });
    const receiptPacket = validatePickup((await pickup(f.triage)).value);
    const receipt = receiptPacket.ifIdle.investigation;
    assert.deepEqual(preferredRead(receiptPacket), receipt.nextRead);
    assert.equal(receipt.basis.receiptId, finished.receipt.receiptId);
    assert.notEqual(receipt.record.arguments.id, published.record.arguments.id);
    assert.equal((await fetch(f.origin + receipt.taskPath)).status, 200);
    assert.equal(await (await fetch(f.origin + receipt.artifactPath)).text(), "Public test result");
    const exact = await fetch(f.origin + "/mcp", { method: "POST",
      headers: { Authorization: "Bearer " + f.triage.secret, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: receipt.nextRead.tool, arguments: receipt.nextRead.arguments } }) });
    const rpc = await exact.json();
    assert.equal(rpc.result?.structuredContent?.claim.submittedReceiptId, finished.receipt.receiptId);

    const peerLead = (await pickup(f.broad)).value.ifIdle?.investigation;
    assert.deepEqual(peerLead.record, receipt.record);
    const firstPost = await f.mcp(f.triage, receipt.record.tool, {
      ...receipt.record.arguments, body: receipt.record.bodyPrefix + "Public artifact reproduced."
    });
    assert.ok(firstPost.ok, firstPost.text);
    const secondBody = "The artifact also needs the forwarding citation.";
    const collision = await f.mcp(f.broad, peerLead.record.tool, {
      ...peerLead.record.arguments, body: peerLead.record.bodyPrefix + secondBody
    });
    assert.equal(collision.value.status, 409);
    assert.equal(collision.value.message, "Message already exists");
    const recovery = peerLead.record.onMessageExists;
    const thread = await fetch(f.origin + recovery.readPath, { headers: { Authorization: "Bearer " + f.broad.secret } });
    assert.equal(thread.status, 200);
    assert.match(await thread.text(), /Public artifact reproduced/);
    const replyArgs = { ...recovery.reply.arguments, id: "second-citation-finding", body: secondBody };
    const reply = await f.mcp(f.broad, recovery.reply.tool, replyArgs);
    assert.ok(reply.ok, reply.text);
    assert.equal(reply.value.replyToId, receipt.record.arguments.messageId);
    assert.equal((await f.mcp(f.broad, recovery.reply.tool, replyArgs)).value.duplicate, true);
    assert.equal((await pickup(f.triage)).value.nextRead, null, "both unchanged bases were recorded");
    f.send(f.owner, "work.proposed", { workItemId: "room-proof", title: "Check experiment", definitionOfDone: "Observed result",
      accountableMemberId: f.producer.id, mode: "read" });
    f.send(f.producer.key, "work.accepted", { workItemId: "room-proof", expectedRevision: f.rev("room-proof") });
    f.send(f.producer.key, "work.started", { workItemId: "room-proof", expectedRevision: f.rev("room-proof") });
    const resultMessage = f.send(f.producer.key, "message.posted", { messageId: "room-proof-text", body: "Reproduced experiment", workItemId: "room-proof" });
    f.send(f.producer.key, "work.completed", { workItemId: "room-proof", expectedRevision: f.rev("room-proof"), evidenceKind: "room_text",
      evidenceMessageId: "room-proof-text", evidenceMessageEventId: resultMessage.event.id,
      evidenceVersion: textVersion("Reproduced experiment"),
      previousCompletionEventId: null, producerId: f.producer.id, summary: "Reproduced", nextAction: "None", checksClaimed: ["Experiment"] });
    const roomPacket = validatePickup((await pickup(f.triage)).value);
    const newResult = roomPacket.ifIdle.investigation;
    assert.deepEqual(roomPacket.nextRead, newResult.nextRead);
    assert.equal(newResult.basis.workItemId, "room-proof");
    assert.notEqual(newResult.record.arguments.id, retry.arguments.id);
    assert.ok((await f.mcp(f.triage, newResult.nextRead.tool, newResult.nextRead.arguments)).ok);
    const savedResult = await f.mcp(f.triage, newResult.record.tool, { ...newResult.record.arguments,
      body: newResult.record.bodyPrefix + "The separately selected Room result reproduces." });
    assert.ok(savedResult.ok, savedResult.text);
    assert.equal((await pickup(f.broad)).value.nextRead, null, "recording the changed Room result consumes only its basis");

    assert.equal((await pickup(f.producer)).value.ifIdle?.investigation, undefined);
  });
}
