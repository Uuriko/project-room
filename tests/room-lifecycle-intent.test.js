// Fail-first characterization of the optional starter fields on room creation
// (intent / start / templateSlug in server/room-lifecycle.mjs). Locks the
// validation order and error codes so the needOpt elegance restructure cannot
// silently change behavior. Each case also holds on the un-refactored code.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";

function accountRoom(t, withStarter) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "admin", displayName: "Avery", kind: "human", permissions: ["manage_members"] } });
  f.store.createAccount("admin-account");
  f.store.bindHumanAccount("commons", "admin", "admin-account");
  const slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey("admin-account"), 0);
  return { f, token: slot.token, binding: session.sessionBinding,
    request: (overrides = {}) => ({ roomId: "room-" + randomUUID().slice(0, 8), title: "Alpha",
      purpose: "Plan the pilot", kind: "personal", displayName: "Admin", ...overrides }) };
}

test("createAccountRoom starter fields: invalid intent/start/templateSlug are 422, validation order preserved", t => {
  const { f, token, binding, request } = accountRoom(t);
  const create = r => f.store.createAccountRoom(token, binding, r);
  for (const [overrides, message] of [
    [{ intent: "x".repeat(81) }, "intent over 80 chars"],
    [{ intent: "   " }, "intent blank"],
    [{ intent: 7 }, "intent non-string"],
    [{ start: "yes" }, "start string"],
    [{ start: 2 }, "start 2"],
    [{ start: 0 }, "start 0"],
    [{ templateSlug: "no-such-template" }, "templateSlug unknown"],
    [{ templateSlug: 7 }, "templateSlug non-string"],
    [{ intent: "ok", start: "yes" }, "intent valid but start invalid: start still checked second"],
    [{ start: 1, templateSlug: "nope" }, "start valid but templateSlug invalid: templateSlug still checked third"],
  ]) {
    assert.throws(() => create(request(overrides)), { status: 422, code: "invalid_room_request" }, message);
  }
});

test("createAccountRoom starter fields: intent trims, start accepts 1/true, templateSlug names a real template", t => {
  const { f, token, binding, request } = accountRoom(t);
  const create = r => f.store.createAccountRoom(token, binding, r);
  const withIntent = create(request({ intent: "  bug  " }));
  assert.equal(f.store.room(withIntent.room.id).state.room.title, "Fix a bug", "intent trims and maps through starterTitleForIntent");
  const welcome = f.store.room(withIntent.room.id).state.messages.find(m => m.id === "gw-" + withIntent.room.id);
  assert.ok(welcome, "intent seeds Room Guide with the welcome message");
  const withStart = create(request({ start: 1 }));
  assert.ok(f.store.room(withStart.room.id).state.messages.some(m => m.id === "gw-" + withStart.room.id), "start=1 seeds the guide");
  const withTemplate = create(request({ templateSlug: "agent-pair" }));
  assert.ok(withTemplate.room.id, "a real template slug is accepted");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 4, "no room created for failed validations");
});
