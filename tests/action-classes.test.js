// W4-44 H2: observe/draft/act separation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { COMMAND_TYPES } from "../server/store.mjs";
import { ACTION_CLASSES, SURFACE_CLASSES, classifyCommand, surfaceClass, ACT_ONLY_EFFECTS } from "../server/action-classes.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("every command type and every out-of-band surface carries exactly one class", () => {
  const classified = [...ACTION_CLASSES.observe, ...ACTION_CLASSES.draft, ...ACTION_CLASSES.act];
  assert.equal(new Set(classified).size, classified.length, "classes are disjoint");
  assert.deepEqual([...classified].sort(), [...COMMAND_TYPES].sort(), "every accepted command type is classified");
  for (const type of COMMAND_TYPES) assert.ok(classifyCommand(type));
  assert.ok(Object.keys(SURFACE_CLASSES).length >= 8, "out-of-band command surfaces are named");
  for (const name of Object.keys(SURFACE_CLASSES)) assert.ok(surfaceClass(name));
  assert.throws(() => classifyCommand("bogus.type"), /Unclassified/);
  assert.throws(() => surfaceClass("bogus"), /Unclassified/);
});

test("message posts and session launches are act-class; reminder scheduling is draft-class", () => {
  assert.equal(classifyCommand(T.MESSAGE_POSTED), "act");
  assert.equal(classifyCommand(T.SESSION_STARTED), "act");
  assert.equal(classifyCommand(T.CLAIM_ACQUIRED), "act");
  assert.equal(classifyCommand(T.NOTIFICATION_PREFERENCES_SET), "draft");
  assert.equal(surfaceClass("private-reminders"), "draft");
  assert.ok(ACT_ONLY_EFFECTS.includes(T.MESSAGE_POSTED) && ACT_ONLY_EFFECTS.includes(T.SESSION_STARTED));
});

test("the reminder module never imports a send, post, session or spend capability", () => {
  const source = readFileSync(new URL("../server/reminders.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";/gm)].map(m => m[1]);
  assert.deepEqual(imports.sort(), ["../src/events.js", "../src/workflow.js", "./store.mjs", "node:crypto"].sort(),
    "the draft-class reminder path keeps its minimal dependencies");
});

test("done-when: enabling a reminder posts no message and launches no session or paid work", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const before = f.store.snapshot(f.keys.owner, "commons");
  const actCount = () => f.store.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE room_id='commons' AND json_extract(body,'$.type') IN (${ACT_ONLY_EFFECTS.map(() => "?").join(",")})`)
    .all(...ACT_ONLY_EFFECTS)[0].n;
  const actBefore = actCount();
  const enable = f.store.reminders.mutate(f.keys.owner, "commons", {
    requestId: randomUUID(), workItemId: "test-handoff", expectedRevision: 0, action: "schedule", dueAt: Date.now() + 3600000,
  });
  assert.equal(enable.duplicate, false);
  const after = f.store.snapshot(f.keys.owner, "commons");
  assert.equal(after.sequence, before.sequence, "reminder enablement appends no room events at all");
  assert.equal(actCount(), actBefore, "no act-class event (message post, session start, claim) is added by enabling a reminder");
  assert.deepEqual(after.state.workItems["test-handoff"], before.state.workItems["test-handoff"],
    "the work item is untouched: no session, no claim, no lifecycle move");
});
