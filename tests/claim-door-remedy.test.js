// B1 claim door (find-fix 2026-11-12, lane 3): a second seat's claim on a
// work item is refused 422 with no remedy named.
//
// The fixture item "test-handoff" is proposed by the owner with
// accountableMemberId "producer" (scripts/acceptance-fixture). The accept
// guard (src/work-reducers.js, acceptWork) admits only that accountable
// member: any other seat — even one holding accept_work, like the owner —
// is refused. Before this fix the HTTP body for that refusal was
// 422 command_rejected with the generic hint "Read current work. Do not
// silently rebase." and no remedy field: the caller was never told who
// CAN accept the work or what to do instead.
//
// The fix keeps the rule and the 422 exactly as they are and adds the
// remedy: a top-level `remedy` string on the error envelope (merged from
// the ServiceError detail in server/http.mjs) naming the accountable
// member and the next action, plus a specific hint/next for this message
// in the agent-error envelope instead of the generic re-read.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { agentErrorAx } from "../src/agent-error.mjs";

async function serve(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port;
}

test("claim door: a second seat's work.accepted is 422 with a named remedy (B1)", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = await serve(t, f);
  const post = (key, command) => fetch(origin + "/api/rooms/commons/commands", { method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(command) });

  // Seat B (the owner) holds accept_work but is NOT the accountable member
  // for "test-handoff" — the accountable member is "producer". B's claim
  // (work.accepted) on A's item is the B1 second-seat refusal.
  const refused = await post(f.keys.owner, { id: "claim-door-b-accept", type: "work.accepted",
    data: { workItemId: "test-handoff", expectedRevision: 0 } });
  assert.equal(refused.status, 422, "status stays 422 — this is an envelope fix, not a rule change");
  const body = await refused.json();
  assert.equal(body.error.code, "command_rejected");
  assert.equal(body.error.message, "Only the accountable member may accept work");

  // The remedy envelope: a machine-readable code (above) plus an actionable
  // remedy string naming who holds the accept right and what to do next.
  assert.equal(typeof body.remedy, "string", "the 422 body must carry a remedy field");
  assert.match(body.remedy, /producer/, "remedy names the accountable member who can accept");
  assert.match(body.remedy, /Ask producer to accept/, "remedy names the concrete next action");
  assert.match(body.remedy, /Do not retry/, "remedy says a retry by the same seat cannot succeed");

  // The existing hint/next envelope convention must carry the same remedy,
  // not the generic command_rejected re-read.
  assert.match(body.hint, /accountable member/);
  assert.doesNotMatch(body.hint, /Do not silently rebase/);

  // The refused claim saved nothing: the item is still proposed.
  assert.equal(f.store.room("commons").state.workItems["test-handoff"].state, "proposed");

  // Seat A (producer, the accountable member) accepts the same item: the
  // door itself works — only the second seat is refused.
  const accepted = await post(f.keys.producer, { id: "claim-door-a-accept", type: "work.accepted",
    data: { workItemId: "test-handoff", expectedRevision: 0 } });
  assert.equal(accepted.status, 201);
  assert.equal(f.store.room("commons").state.workItems["test-handoff"].state, "accepted");
});

test("claim door: agent-error envelope for the accountable-member refusal names the remedy, not the generic re-read", () => {
  const ax = agentErrorAx({ httpStatus: 422, code: "command_rejected",
    message: "Only the accountable member may accept work", roomId: "commons", workItemId: "test-handoff" });
  assert.equal(ax.reason, "command_rejected");
  assert.match(ax.hint, /accountable member/);
  assert.doesNotMatch(ax.hint, /Do not silently rebase/);
  assert.ok(ax.hint.length > 0 && ax.hint.length < 160, "hint stays under the 160-char contract");
  assert.match(JSON.stringify(ax.next), /accountableMemberId/);
});
