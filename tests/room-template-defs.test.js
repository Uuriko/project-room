// K012: room templates. Pure template tests.
import test from "node:test";
import assert from "node:assert/strict";
import { listRoomTemplates, getRoomTemplate, instantiateRoom, RoomTemplateError } from "../server/room-templates.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RoomTemplateError && error.code === code);

test("listRoomTemplates returns all four", () => {
  const templates = listRoomTemplates();
  assert.deepEqual(templates.map(t => t.templateId).sort(), ["hiring", "incident", "sprint", "standup"]);
  assert.ok(Object.isFrozen(templates));
});
test("instantiateRoom fills placeholders", () => {
  const room = instantiateRoom({ templateId: "incident", values: { summary: "API down" } });
  assert.equal(room.name, "Incident: API down");
  assert.deepEqual(room.sections.slice(0, 1), ["Timeline"]);
  assert.ok(Object.isFrozen(room));
  const sprint = instantiateRoom({ templateId: "sprint", values: { team: "Core", sprint: "42" } });
  assert.equal(sprint.name, "Core sprint 42");
});
test("malformed inputs are refused", () => {
  throwsCode(() => getRoomTemplate("nope"), "invalid_room_template");
  throwsCode(() => instantiateRoom({ templateId: "standup", values: {} }), "invalid_room_template");
});
