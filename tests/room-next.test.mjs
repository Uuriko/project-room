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

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`room next uses the same private-view boundary through MCP and CLI (${representation})`, async t => {
    const f = await privateWorkFixture(t, representation);
    for (let n = 0; n < 4; n++) {
      f.send(f.owner, "work.proposed", { workItemId: `a-decoy-${n}`, title: "Unrelated work",
        definitionOfDone: "Out of scope", accountableMemberId: f.observer.id, verifierMemberId: f.producer.id,
        independentVerificationRequired: true, mode: "read" });
    }
    f.send(f.producer.key, "reply_request.progressed", { requestMessageId: "private-ask",
      expectedRequestRevision: 0, progress: "acknowledged", note: "zq-private-progress-note-zq" });
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
    assert.ok(!owner.text.includes("zq-private-progress-note-zq"));
    assert.ok(!owner.text.includes("zq-private-request-zq"));

    const observer = await f.mcp(f.triage, "room_next");
    assert.equal(observer.ok, true, observer.text);
    assert.deepEqual(observer.value.work.items, []);
    assert.deepEqual(observer.value.requests.items, []);
    assert.deepEqual(privateMarkers(observer.text), []);
    assert.ok(!observer.text.includes("private-ask"));

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
    if (representation === "legacy") {
      const inputs = [];
      output.length = 0;
      const fallbackCode = await main(["next", "--source", "requests"], {
        cwd: directory, env, out: value => output.push(value), err: value => errors.push(value),
        fetchImpl: async (url, init) => {
          const { id, params } = JSON.parse(init.body);
          inputs.push(params.name);
          if (params.name !== "room_next") return fetch(url, init);
          return Response.json({ jsonrpc: "2.0", id, result: { structuredContent: {
            contractVersion: 1, roomId: "commons", viewerId: f.producer.id,
            requests: { coverage: "unavailable", reason: "legacy_projection_budget", items: [],
              nextRead: { tool: "room_list_requests", arguments: { roomId: "commons", direction: "incoming", status: "open" } } }
          } } });
        }
      });
      assert.equal(fallbackCode, 0, errors.join("\n"));
      const pickedUp = JSON.parse(output[0]).requests;
      assert.equal(pickedUp.coverage, "complete");
      assert.deepEqual(pickedUp.items.map(row => row.nextRead.command), [["room", "read", "private-ask"]]);
      assert.deepEqual(inputs, ["room_next", "room_list_requests"]);
    }
    assert.equal(f.stored(), before, "neither adapter writes or acknowledges");
  });
}

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
  const first = await f.mcp(f.reviewer, "room_next");
  assert.equal(first.ok, true, first.text);
  assert.equal(first.value.work.coverage, "partial");
  assert.deepEqual(first.value.work.items, []);
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
  assert.equal(compact.value.requests.coverage, calls[2].value.page.hasMore ? "partial" : "complete");
  t.diagnostic(JSON.stringify({
    control: { calls: calls.length, wireBytes: calls.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0) },
    next: { calls: 1, wireBytes: Buffer.byteLength(compact.text) }
  }));
});
