import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-funnel-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const cmd = (token, type, data) => request("/api/rooms/commons/commands", {
    method: "POST", token, data: { id: randomUUID(), type, data }
  });
  return { request, cmd, ownerKey, agentKey };
}

test("onboarding funnel tracks provision -> claim -> result", async t => {
  const { request, cmd, ownerKey, agentKey } = await serve(t);

  // Provisioned but idle: funnel shows provisionedAt only.
  let funnel = await (await request("/api/rooms/commons/onboarding-funnel", { token: ownerKey })).json();
  assert.equal(funnel.members.length, 1);
  assert.equal(funnel.members[0].memberId, "agent");
  assert.ok(funnel.members[0].provisionedAt);
  assert.equal(funnel.members[0].firstClaimAt, null);
  assert.equal(funnel.members[0].firstResultAt, null);
  assert.equal(funnel.members[0].minutesToFirstClaim, null);

  // Owner proposes work accountable to the agent; agent accepts (claims).
  const workItemId = randomUUID();
  await cmd(ownerKey, T.WORK_PROPOSED, { workItemId, title: "Do the thing",
    definitionOfDone: "Done when done.", accountableMemberId: "agent",
    independentVerificationRequired: false, ownerDecisionRequired: false });
  const revision = (await request("/api/rooms/commons", { token: agentKey }).then(r => r.json())).state.workItems[workItemId].revision;
  await cmd(agentKey, T.WORK_ACCEPTED, { workItemId, expectedRevision: revision });

  funnel = await (await request("/api/rooms/commons/onboarding-funnel", { token: ownerKey })).json();
  assert.ok(funnel.members[0].firstClaimAt);
  assert.ok(funnel.members[0].minutesToFirstClaim >= 0);
  assert.equal(funnel.members[0].firstResultAt, null);

  // Agent completes with URL evidence.
  const revision2 = (await request("/api/rooms/commons", { token: agentKey }).then(r => r.json())).state.workItems[workItemId].revision;
  const completed = await cmd(agentKey, T.WORK_COMPLETED, { workItemId, expectedRevision: revision2,
    summary: "Did it.", evidenceUrl: "https://example.com/evidence", evidenceVersion: "1", nextAction: "none" });
  assert.equal(completed.status, 201);

  funnel = await (await request("/api/rooms/commons/onboarding-funnel", { token: ownerKey })).json();
  assert.ok(funnel.members[0].firstResultAt);
  assert.ok(funnel.members[0].minutesToFirstResult >= 0);
});
