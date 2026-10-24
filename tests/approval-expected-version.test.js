// Exact-version approval (docs/HUMAN-APPROVAL-CONTRACT.md, gap 1): a verdict
// that names the version the human saw is refused once the draft moved on.
// Omitting expectedVersion keeps the existing behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createApprovalQueue } from "../server/inbox-approval.mjs";

const agent = { kind: "agent", id: "claude", label: "Claude" };
const john = { kind: "human", id: "john", label: "John" };
const draft = body => ({ subject: "Re: kickoff", body });

test("queue: stale expectedVersion is refused for approve, edit and reject", () => {
  const q = createApprovalQueue({ clock: () => 1000, id: (() => { let n = 0; return () => `p${++n}`; })() });
  const p = q.propose("thread:1", { draft: draft("v1"), byAgent: agent, channel: "email" });
  q.requestEdits(p.proposalId, { by: john, edits: "shorter", expectedVersion: 1 });
  q.resubmit(p.proposalId, { draft: draft("v2"), byAgent: agent });
  for (const call of [
    () => q.approve(p.proposalId, { by: john, expectedVersion: 1 }),
    () => q.reject(p.proposalId, { by: john, reason: "no", expectedVersion: 1 }),
    () => q.requestEdits(p.proposalId, { by: john, edits: "again", expectedVersion: 1 })])
    assert.throws(call, { code: "approval_version_changed" });
  assert.equal(q.get(p.proposalId).status, "pending");
  assert.throws(() => q.approve(p.proposalId, { by: john, expectedVersion: 0 }), { code: "approval_invalid" });
  assert.throws(() => q.approve(p.proposalId, { by: john, expectedVersion: "2" }), { code: "approval_invalid" });
  assert.equal(q.approve(p.proposalId, { by: john, expectedVersion: 2 }).status, "approved");
  // Omitted keeps the existing behavior.
  const other = q.propose("thread:2", { draft: draft("v1"), byAgent: agent, channel: "email" });
  assert.equal(q.approve(other.proposalId, { by: john }).status, "approved");
});

test("http: 409 approval_version_changed, and the recorded verdict replays after reopen", async t => {
  const directory = mkdtempSync(join(tmpdir(), "approval-version-"));
  const dbFile = join(directory, "room.sqlite");
  let store = new RoomStore(dbFile);
  store.initialize(initialRoom("commons"));
  const humanKey = store.issueAccessKey("commons", "owner");
  const bot = store.identities.create("Draft Agent");
  store.identities.link(humanKey, "commons", { identityId: bot.identityId, displayName: "Draft Agent", permissions: ["accept_work"] });
  let server, origin;
  const serve = async () => {
    server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = "http://127.0.0.1:" + server.address().port;
  };
  const close = async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); };
  t.after(async () => { await close().catch(() => {}); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (path, token, body) => fetch(origin + path, { method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await serve();
  const base = "/api/rooms/commons/collab/approvals";
  const { proposal } = await (await post(base, bot.secret, { threadId: "thread-v", draft: draft("v1"), channel: "email" })).json();
  const id = proposal.proposalId;
  assert.equal((await post(`${base}/${id}/decide`, humanKey, { decision: "edit", editedBody: "shorter", expectedVersion: 1 })).status, 200);
  assert.equal((await post(`${base}/${id}/resubmit`, bot.secret, { draft: draft("v2") })).status, 200);
  const stale = await post(`${base}/${id}/decide`, humanKey, { decision: "approve", expectedVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "approval_version_changed");
  const ok = await post(`${base}/${id}/decide`, humanKey, { decision: "approve", expectedVersion: 2 });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).proposal.version, 2);
  await close(); store.close();
  store = new RoomStore(dbFile);
  await serve();
  const again = await post(`${base}/${id}/decide`, humanKey, { decision: "reject", note: "late" });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, "approval_transition");
});
