import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";

async function previewCli(origin, token, input) {
  const entry = fileURLToPath(new URL("../scripts/agent-inbox.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry, "reply", "preview-route"], {
    env: { ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "peer", ROOM_AGENT_TOKEN: token }
  });
  const closed = once(child, "close");
  const stdout = [];
  child.stdout.setEncoding("utf8").on("data", chunk => stdout.push(chunk));
  child.stderr.resume();
  child.stdin.end(JSON.stringify(input));
  assert.deepEqual(await closed, [0, null]);
  return JSON.parse(stdout.join(""));
}

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`read-only requester preflight uses the active receiver stream (${representation})`, async t => {
    const store = new RoomStore(":memory:");
    const options = representation === "legacy" ? {} : { representation };
    store.initialize(initialRoom(), options);
    store.initialize(initialRoom("other-room"), options);
    const keys = { owner: store.issueAccessKey("commons", "owner") };
    const command = (id, type, data) => store.command(keys.owner, "commons", { id, type, data });
    for (const memberId of ["receiver", "peer"]) {
      command("add-" + memberId, "member.added", { memberId, displayName: memberId, kind: "agent", permissions: [] });
      keys[memberId] = store.issueAccessKey("commons", memberId);
    }
    for (const [workItemId, accountableMemberId] of [["approved-work", "peer"], ["private-work", "owner"]]) {
      command("new-" + workItemId, "work.proposed", {
        workItemId, title: workItemId, definitionOfDone: "Select the exact request route.",
        accountableMemberId, mode: "read",
      });
    }
    store.dmConsents.request("commons", "owner", "receiver", "scope fixture");
    store.dmConsents.decide("commons", "receiver", "owner", "approve");
    command("private-source", "message.posted", {
      messageId: "private-source", toMemberId: "receiver", workItemId: "private-work", requestKind: "reply", body: "Private fixture",
    });
    const sequence = store.headSequence("commons");
    const server = createRoomServer({ store });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      store.close();
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const caller = (memberId, roomId = "commons", token = keys[memberId], fetchImpl) =>
      new RoomAgentClient({ origin, roomId, memberId, token, fetchImpl });
    const owner = caller("owner"), peer = caller("peer");
    const preview = (agent, options = { workItemId: "approved-work" }) => agent.requestRoute("receiver", options);
    const advertised = { requesters: ["owner"], workItems: ["approved-work"], requests: ["private-source"] };
    assert.equal((await preview(owner)).status, "unknown");
    const open = (token, scope) => fetch(origin + "/api/rooms/commons/stream?after=" + sequence, {
      headers: { Authorization: "Bearer " + token, "X-Project-Room-Receiver-Scope": JSON.stringify(scope) }
    });
    assert.equal((await open(keys.owner, advertised)).status, 422);
    assert.equal((await open(keys.receiver, { ...advertised, requesters: ["receiver"] })).status, 422);
    const opened = Promise.withResolvers();
    const receiver = caller("receiver", "commons", keys.receiver, async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).includes("/stream?")) opened.resolve(response.status);
      return response;
    });
    const waiting = receiver.waitForChange(sequence, { requestHints: true, receiverScope: advertised, waitingForWork: true });
    assert.equal(await Promise.race([opened.promise, waiting.then(() => null)]), 200);
    const allowed = await preview(owner);
    const { receiver: availability, ...route } = allowed;
    assert.equal(availability.state, "waiting_for_work");
    assert.ok(Number.isFinite(Date.parse(availability.since)));
    assert.deepEqual(route, {
      contractVersion: 1, roomId: "commons", requesterId: "owner", recipientId: "receiver",
      workItemId: "approved-work", requestMessageId: null, status: "matches_scope", liveness: "unknown",
    });
    const outsider = await preview(peer);
    assert.equal(outsider.status, "outside_scope");
    assert.equal(outsider.receiver, undefined);
    if (representation === "normalized-current-v1") {
      assert.deepEqual(await previewCli(origin, keys.peer, { toMemberId: "receiver", workItemId: "approved-work" }), {
        ...route, requesterId: "peer", status: "outside_scope",
      });
    }
    assert.equal((await preview(owner, {})).status, "outside_scope");
    assert.equal((await preview(owner, { requestMessageId: "private-source" })).status, "matches_scope");
    await assert.rejects(preview(owner, { requestMessageId: "private-source", workItemId: "approved-work" }), { code: "invalid_request_route" });
    await assert.rejects(preview(peer, { requestMessageId: "private-source" }), { code: "reply_request_not_found" });
    await assert.rejects(preview(peer, { workItemId: "private-work" }), { code: "work_private" });
    const otherRoom = caller("owner", "other-room", store.issueAccessKey("other-room", "owner"));
    assert.equal((await preview(otherRoom, {})).status, "unknown");
    const spoofed = await fetch(origin + "/api/rooms/commons/reply-route?toMemberId=receiver&requesterId=owner", {
      headers: { Authorization: "Bearer " + keys.peer },
    });
    assert.equal(spoofed.status, 422);
    server.closeStreams();
    await waiting;
    const closed = await preview(owner);
    assert.equal(closed.status, "unknown");
    assert.equal(closed.receiver, undefined);
    assert.equal(store.headSequence("commons"), sequence);
  });
}
