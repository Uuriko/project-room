import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { deriveNotifications } from "../server/notifications.mjs";
import { getTemplate } from "../server/work-templates.mjs";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "friction-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  send(ownerKey, T.MEMBER_ADDED, { memberId: "reporter", displayName: "Reporter", kind: "agent", permissions: ["steer"] });
  const reporterKey = store.issueAccessKey("commons", "reporter");
  return { directory, store, send, ownerKey, reporterKey,
    cleanup: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("friction template exists with the friction label (RC-2026-09-23)", () => {
  const template = getTemplate("friction");
  assert.equal(template.templateId, "friction");
  assert.ok(template.fields.labels.includes("friction"));
});

test("work.proposed stores labels; friction label is machine-readable (RC-2026-09-23)", () => {
  const { send, reporterKey, store, cleanup } = setup();
  try {
    send(reporterKey, T.WORK_PROPOSED, { workItemId: "f1", title: "Friction: confusing error", definitionOfDone: "Clear message",
      accountableMemberId: "reporter", mode: "read", labels: ["friction"] });
    const item = store.room("commons").state.workItems.f1;
    assert.deepEqual(item.labels, ["friction"]);
    assert.equal(item.proposedById, "reporter");
    // Invalid labels are rejected.
    assert.throws(() => send(reporterKey, T.WORK_PROPOSED, { workItemId: "f2", title: "Bad", definitionOfDone: "Done",
      accountableMemberId: "reporter", mode: "read", labels: ["NOT-A-SLUG!"] }), /labels must be/);
  } finally { cleanup(); }
});

test("completing a friction item notifies the reporter even with work_updates muted (RC-2026-09-23)", () => {
  const { send, ownerKey, reporterKey, store, cleanup } = setup();
  try {
    send(ownerKey, T.MEMBER_ADDED, { memberId: "fixer", displayName: "Fixer", kind: "agent", permissions: ["steer"] });
    send(reporterKey, T.WORK_PROPOSED, { workItemId: "f1", title: "Friction: confusing error", definitionOfDone: "Clear message",
      accountableMemberId: "fixer", mode: "read", labels: ["friction"] });
    // Reporter mutes work updates: the close-loop must still reach them.
    send(reporterKey, T.NOTIFICATION_PREFERENCES_SET, { preferences: { work_updates: "mentions_only" } });
    const state = store.room("commons").state;
    const member = state.members.reporter;
    const completedEvent = { id: randomUUID(), type: T.WORK_COMPLETED, actorId: "fixer",
      at: new Date().toISOString(), data: { workItemId: "f1" } };
    const notifications = deriveNotifications({ events: [{ event: completedEvent, sequence: 1 }], state, member });
    const closeLoop = notifications.find(n => n.kind === "work_update" && n.workItemId === "f1");
    assert.ok(closeLoop, "reporter gets a close-loop notification");
    assert.equal(closeLoop.closeLoop, true);
  } finally { cleanup(); }
});

test("completing a non-friction item does not trigger the close-loop carve-out (RC-2026-09-23)", () => {
  const { send, ownerKey, reporterKey, store, cleanup } = setup();
  try {
    send(ownerKey, T.MEMBER_ADDED, { memberId: "fixer", displayName: "Fixer", kind: "agent", permissions: ["steer"] });
    send(reporterKey, T.WORK_PROPOSED, { workItemId: "w1", title: "Plain work", definitionOfDone: "Done",
      accountableMemberId: "fixer", mode: "read" });
    send(reporterKey, T.NOTIFICATION_PREFERENCES_SET, { preferences: { work_updates: "mentions_only" } });
    const state = store.room("commons").state;
    const member = state.members.reporter;
    const completedEvent = { id: randomUUID(), type: T.WORK_COMPLETED, actorId: "fixer",
      at: new Date().toISOString(), data: { workItemId: "w1" } };
    const notifications = deriveNotifications({ events: [{ event: completedEvent, sequence: 1 }], state, member });
    assert.ok(!notifications.some(n => n.kind === "work_update" && n.workItemId === "w1"));
  } finally { cleanup(); }
});
