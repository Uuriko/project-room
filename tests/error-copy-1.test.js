// ERROR-COPY-1: refusal-envelope honesty batch (UT-ERRORS rows 4/5/8/11 +
// QA-cards card 7 items a/b/c/d/e/f). Each test pins the NEW refusal shape:
// the refusal names its true cause and the working recovery. Specimens were
// executed live by UT-ERRORS / QA-CARDS-TRIAGE at base 6d84149b.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { agentErrorAx } from "../src/agent-error.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-error-copy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "member-a", displayName: "Member A", kind: "agent", permissions: [] } });
  const memberKey = store.issueAccessKey("commons", "member-a");
  return { store, ownerKey, memberKey };
}

const cmd = (type, data) => ({ id: randomUUID(), type, data });

test("row 4: a wrong-state work transition names the states the command requires", t => {
  const { store, ownerKey } = setup(t);
  store.command(ownerKey, "commons", cmd(T.WORK_PROPOSED,
    { workItemId: "ec-item", title: "Thing", definitionOfDone: "Done", accountableMemberId: "owner" }));
  assert.throws(
    () => store.command(ownerKey, "commons", cmd(T.WORK_COMPLETED,
      { workItemId: "ec-item", summary: "did it", nextAction: "none" })),
    error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "command_rejected");
      assert.match(error.message, /Invalid transition from proposed/);
      // The recovery (accept first) is only learnable if the refusal names
      // the states work.completed requires.
      assert.match(error.message, /accepted/);
      const ax = agentErrorAx({ httpStatus: error.status, code: error.code, message: error.message, roomId: "commons", commandType: T.WORK_COMPLETED });
      assert.notEqual(ax.hint, "Read current work. Do not silently rebase.");
      assert.match(ax.hint, /state/);
      return true;
    });
});

test("row 5: a missing revision token is not called a change; a stale one names the field and current revision", t => {
  const { store, memberKey } = setup(t);
  store.command(memberKey, "commons", cmd(T.MESSAGE_POSTED, { messageId: "ec-msg", body: "hello room" }));
  // Missing token: nothing changed — the refusal must say the field is
  // required instead of asserting a false cause.
  assert.throws(
    () => store.command(memberKey, "commons", cmd(T.MESSAGE_EDITED, { messageId: "ec-msg", body: "edited" })),
    error => {
      assert.equal(error.status, 422);
      assert.equal(error.code, "command_rejected");
      assert.doesNotMatch(error.message, /^Message changed/);
      assert.match(error.message, /expectedMessageRevision is required/);
      const ax = agentErrorAx({ httpStatus: error.status, code: error.code, message: error.message, roomId: "commons", commandType: T.MESSAGE_EDITED });
      assert.match(ax.hint, /expectedMessageRevision/);
      return true;
    });
  // Stale token: the refusal names the field to resend and the revision the
  // message is actually at.
  assert.throws(
    () => store.command(memberKey, "commons", cmd(T.MESSAGE_EDITED,
      { messageId: "ec-msg", body: "edited", expectedMessageRevision: 99 })),
    error => {
      assert.equal(error.status, 422);
      assert.match(error.message, /^Message changed/);
      assert.match(error.message, /expectedMessageRevision/);
      assert.match(error.message, /current revision is 0/);
      const ax = agentErrorAx({ httpStatus: error.status, code: error.code, message: error.message, roomId: "commons", commandType: T.MESSAGE_EDITED });
      assert.match(ax.hint, /expectedMessageRevision/);
      return true;
    });
});

test("row 8: command-path permission refusals are the 403 class, not 422 command_rejected", t => {
  const { store, memberKey } = setup(t);
  assert.throws(
    () => store.command(memberKey, "commons", cmd(T.ROOM_ARCHIVED, { reason: "tidy" })),
    error => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "owner_required");
      assert.match(error.message, /Only the Room owner may archive the room/);
      const ax = agentErrorAx({ httpStatus: error.status, code: error.code, message: error.message, roomId: "commons", commandType: T.ROOM_ARCHIVED });
      assert.equal(ax.reason, "owner_required");
      // The old 403 hint named guest invites whatever the action was.
      assert.doesNotMatch(ax.hint, /guest invite/);
      assert.ok(ax.next.some(step => /owner/.test(step.command ?? "")), "next names asking the owner");
      return true;
    });
  assert.throws(
    () => store.command(memberKey, "commons", cmd(T.MEMBER_ACCESS_CHANGED,
      { memberId: "member-a", permissions: ["decide"] })),
    error => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "access_denied");
      assert.match(error.message, /lacks manage_members/);
      return true;
    });
});

test("row 11: a room route with no credential prescribes an invite, not a self-mint", t => {
  const { store } = setup(t);
  assert.throws(() => store.authenticate(null, "commons"), error => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "unauthenticated");
    assert.match(error.message, /invite/);
    assert.doesNotMatch(error.message, /self-mint an identity at POST/);
    return true;
  });
});

test("card 7 (b): identity create names an unexpected field instead of blaming displayName", async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = data => fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
  });
  const extra = await post({ displayName: "Extra Key Bot", surprise: true });
  assert.equal(extra.status, 422);
  const extraBody = await extra.json();
  assert.equal(extraBody.error.code, "invalid_identity");
  assert.match(extraBody.error.message, /surprise/);
  assert.doesNotMatch(extraBody.error.message, /displayName is required/);
  const missing = await post({ surprise: true });
  assert.equal(missing.status, 422);
  assert.match((await missing.json()).error.message, /displayName is required/);
  const clean = await post({ displayName: "Clean Bot" });
  assert.equal(clean.status, 201);
});
